const { parentPort, workerData } = require("node:worker_threads");
const { imageSize } = require("image-size");

function isAnimation(bytes, type) {
  if (type === "gif") return true;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "webp") {
    for (let offset = 12; offset + 8 <= data.length; ) {
      const size = data.readUInt32LE(offset + 4);
      const chunk = data.toString("ascii", offset, offset + 4);
      if (
        chunk === "ANIM" ||
        (chunk === "VP8X" && size > 0 && offset + 8 < data.length && data[offset + 8] & 2)
      )
        return true;
      offset += 8 + size + (size % 2);
    }
  }
  if (type === "png") {
    for (let offset = 8; offset + 12 <= data.length; ) {
      const size = data.readUInt32BE(offset);
      if (data.toString("ascii", offset + 4, offset + 8) === "acTL") return true;
      offset += 12 + size;
    }
  }
  return false;
}

function run() {
  const bytes = new Uint8Array(workerData.bytes);
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("Image exceeds 20 MiB");
  const info = imageSize(bytes);
  if (!["png", "jpg", "gif", "webp"].includes(info.type))
    throw new Error("Supported images: PNG, JPEG, GIF, WebP");
  if (
    !info.width ||
    !info.height ||
    info.width > 16384 ||
    info.height > 16384 ||
    info.width * info.height > 16 * 1024 * 1024
  ) {
    throw new Error("Image exceeds the 16 megapixel or 16384 pixel side limit");
  }
  const photon = require("@silvia-odwyer/photon-node");
  let source = photon.PhotonImage.new_from_byteslice(bytes);
  const replace = (next) => {
    source.free();
    source = next;
  };
  try {
    // Normalize EXIF orientation before discarding metadata in the re-encode.
    const orientation = info.orientation || 1;
    if ([2, 5, 7].includes(orientation)) photon.fliph(source);
    if (orientation === 4) photon.flipv(source);
    if (orientation === 3) replace(photon.rotate(source, 180));
    if ([5, 8].includes(orientation)) replace(photon.rotate(source, 270));
    if ([6, 7].includes(orientation)) replace(photon.rotate(source, 90));
    const width = source.get_width();
    const height = source.get_height();
    if (width * height > 16 * 1024 * 1024)
      throw new Error("Decoded image dimensions are too large");
    const pixels = source.get_raw_pixels();
    let alpha = false;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) {
        alpha = true;
        break;
      }
    }
    const encode = (maxPixels, maxSide, maxBytes) => {
      let scale = Math.min(
        1,
        Math.sqrt(maxPixels / (width * height)),
        maxSide / width,
        maxSide / height,
      );
      for (let attempt = 0; attempt < 8; attempt++, scale *= 0.8) {
        const w = Math.max(1, Math.floor(width * scale));
        const h = Math.max(1, Math.floor(height * scale));
        const image = photon.resize(source, w, h, photon.SamplingFilter.Lanczos3);
        try {
          if (alpha) {
            const data = image.get_bytes_webp();
            if (data.length <= maxBytes) return { data, mime: "image/webp", width: w, height: h };
          } else {
            for (const quality of [90, 80, 65]) {
              const data = image.get_bytes_jpeg(quality);
              if (data.length <= maxBytes) return { data, mime: "image/jpeg", width: w, height: h };
            }
          }
        } finally {
          image.free();
        }
      }
      throw new Error("Image cannot fit the upload budget");
    };
    if (workerData.mode === "request") {
      return { image: encode(640000, 4096, 1024 * 1024) };
    }
    return {
      image: encode(4 * 1024 * 1024, 8192, 4 * 1024 * 1024),
      thumbnail: encode(320 * 320, 320, 128 * 1024),
      originalWidth: width,
      originalHeight: height,
      staticFrame: isAnimation(bytes, info.type),
    };
  } finally {
    source.free();
  }
}

try {
  parentPort.postMessage({ ok: true, value: run() });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "Invalid image",
  });
}

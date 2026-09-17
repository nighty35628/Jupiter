import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { afterEach, describe, expect, it } from "vitest";
import { encodeImage } from "../src/attachments/codec.js";
import { AttachmentStore, readImageSnapshot } from "../src/attachments/store.js";
import { imageIdFromToken, imageToken } from "../src/attachments/types.js";
import {
  cleanupJupiterStorageWithImages,
  scanJupiterStorageWithImages,
} from "../src/desktop/storage-manager.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function png(width = 32, height = 20, alpha = false): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([245, 40, 80, alpha ? 120 : 255], i);
  const image = new PhotonImage(pixels, width, height);
  try {
    return image.get_bytes();
  } finally {
    image.free();
  }
}

async function fixture(maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "jupiter-image-test-"));
  roots.push(root);
  return { root, store: new AttachmentStore(join(root, "attachments"), maxBytes) };
}

describe("portable image codec", () => {
  it("normalizes opaque and transparent images without blocking the host", async () => {
    const opaque = await encodeImage(png());
    expect(opaque.image).toMatchObject({ mime: "image/jpeg", width: 32, height: 20 });
    expect(opaque.thumbnail!.data.length).toBeGreaterThan(0);
    const transparent = await encodeImage(png(32, 20, true));
    expect(transparent.image.mime).toBe("image/webp");
  });
  it("preserves a long screenshot aspect ratio within the pixel budget", async () => {
    const output = await encodeImage(png(240, 4000), "request");
    expect(output.image.width * output.image.height).toBeLessThanOrEqual(640000);
    expect(output.image.height / output.image.width).toBeCloseTo(4000 / 240, 0);
  });
  it("rejects unsupported bytes and malformed images", async () => {
    await expect(encodeImage(Buffer.from("<svg width='20' height='20'></svg>"))).rejects.toThrow();
    await expect(encodeImage(new Uint8Array(21 * 1024 * 1024))).rejects.toThrow(/20 MiB/);
  });
  it("honors cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(encodeImage(png(), "canonical", controller.signal)).rejects.toThrow();
  });
  it("normalizes EXIF rotation before creating previews", async () => {
    const pixels = new PhotonImage(new Uint8Array(12 * 8 * 4).fill(255), 12, 8);
    const jpeg = pixels.get_bytes_jpeg(90);
    pixels.free();
    const exif = Buffer.from(
      "45786966000049492a0008000000010012010300010000000600000000000000",
      "hex",
    );
    const marker = Buffer.alloc(4);
    marker.writeUInt16BE(0xffe1, 0);
    marker.writeUInt16BE(exif.length + 2, 2);
    const rotated = await encodeImage(
      Buffer.concat([jpeg.slice(0, 2), marker, exif, jpeg.slice(2)]),
    );
    expect(rotated.image).toMatchObject({ width: 8, height: 12 });
  });
  it("flattens a GIF to a labelled static frame", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    expect(await encodeImage(gif)).toMatchObject({
      staticFrame: true,
      image: { width: 1, height: 1 },
    });
  });
});

describe("durable image objects", () => {
  it("deduplicates bytes and survives a new store instance", async () => {
    const { store } = await fixture();
    const first = await store.importBytes(png(), "first.png");
    const second = await store.importBytes(png(), "other.png");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("other.png");
    expect(imageIdFromToken(imageToken(first.id))).toBe(first.id);
    const reopened = new AttachmentStore(store.root);
    expect(await reopened.get(first.id)).toMatchObject({ id: first.id, width: 32 });
    const one = await reopened.requestImage(first.id);
    const two = await reopened.requestImage(first.id);
    expect(Buffer.from(two.data)).toEqual(Buffer.from(one.data));
    expect(JSON.stringify(first)).not.toContain("base64");
  });
  it("rejects corruption and path-shaped object IDs", async () => {
    const { store } = await fixture();
    const image = await store.importBytes(png(), "x.png");
    await writeFile(join(store.root, "objects", image.id, "image"), "changed");
    await expect(store.read(image.id)).rejects.toThrow(/corrupt/);
    await expect(store.get("../../config.json")).rejects.toThrow(/Invalid/);
  });
  it("enforces the persistent storage quota", async () => {
    const { store } = await fixture(1);
    await expect(store.importBytes(png(), "x.png")).rejects.toThrow(/quota/);
  });
  it("retains backup and archived references during garbage collection", async () => {
    const { root, store } = await fixture();
    const referenced = await store.importBytes(png(), "kept.png");
    const orphan = await store.importBytes(png(24, 16), "orphan.png");
    const sessions = join(root, "sessions");
    await mkdir(join(sessions, "archive"), { recursive: true });
    await writeFile(
      join(sessions, "archive", "saved.jsonl.bak"),
      `${JSON.stringify({ role: "user", attachments: [referenced] })}\n`,
    );
    const old = new Date(Date.now() - 40 * 86400000);
    for (const id of [referenced.id, orphan.id])
      await utimes(join(store.root, "objects", id), old, old);
    expect(await store.collectGarbage(sessions)).toBe(1);
    expect((await store.get(referenced.id)).id).toBe(referenced.id);
    await expect(store.get(orphan.id)).rejects.toThrow();
  });
  it("uses authorized snapshots, not changed workspace symlinks", async () => {
    const { root, store } = await fixture();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "outside.png"), png());
    await symlink(join(root, "outside.png"), join(workspace, "escape.png"));
    await expect(readImageSnapshot(join(workspace, "escape.png"), [workspace])).rejects.toThrow(
      /outside/,
    );
    await writeFile(join(workspace, "ok.png"), png());
    const image = await store.importPath(join(workspace, "ok.png"), [workspace]);
    await rm(join(workspace, "ok.png"));
    expect((await store.read(image.id)).bytes.length).toBe(image.bytes);
    expect(
      await readFile(join(store.root, "objects", image.id, "meta.json"), "utf8"),
    ).not.toContain(workspace);
  });
  it("retains offline drafts and rejects stale retention revisions", async () => {
    const { root, store } = await fixture();
    const image = await store.importBytes(png(), "draft.png");
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    const owner = "12345678-1234-1234-1234-123456789abc";
    await store.saveDraftReferences(owner, 20, [image.id]);
    await store.saveDraftReferences(owner, 19, []);
    const old = new Date(Date.now() - 40 * 86400000);
    await utimes(join(store.root, "objects", image.id), old, old);
    expect(await store.collectGarbage(sessions)).toBe(0);
    await store.saveDraftReferences(owner, 21, []);
    expect((await store.inspectGarbage(sessions)).count).toBe(1);
    expect(await store.collectGarbage(sessions)).toBe(1);
  });
  it("exposes only proven orphan bytes to the storage cleanup UI", async () => {
    const { root } = await fixture();
    const store = new AttachmentStore(join(root, "attachments", "v1"));
    await mkdir(join(root, "sessions"));
    const image = await store.importBytes(png(), "old.png");
    const old = new Date(Date.now() - 40 * 86400000);
    await utimes(join(store.root, "objects", image.id), old, old);
    const scan = await scanJupiterStorageWithImages({ jupiterHome: root });
    expect(scan.items.find((item) => item.id === "safe:orphan-images")?.cleanup).toBe("delete");
    await cleanupJupiterStorageWithImages({
      jupiterHome: root,
      itemIds: ["review:image-attachments"],
    });
    expect((await store.inspectGarbage(join(root, "sessions"))).count).toBe(1);
    const result = await cleanupJupiterStorageWithImages({
      jupiterHome: root,
      itemIds: ["safe:orphan-images"],
    });
    expect(result.freedBytes).toBeGreaterThan(0);
    await expect(store.get(image.id)).rejects.toThrow();
  });
});

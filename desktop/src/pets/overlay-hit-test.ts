export type PetAlphaMask = { width: number; height: number; data: Uint8ClampedArray };

export function petFrameHit(
  mask: PetAlphaMask,
  column: number,
  row: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return false;
  const width = mask.width / 8;
  const height = mask.height / 11;
  const px = column * width + Math.floor(x * width);
  const py = row * height + Math.floor(y * height);
  // Ignore transparent padding, soft shadows and glow around the artwork.
  return (mask.data[(py * mask.width + px) * 4 + 3] ?? 0) >= 64;
}

export function loadPetAlphaMask(url: string): Promise<PetAlphaMask | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onerror = () => resolve(null);
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context || !canvas.width || !canvas.height) return resolve(null);
        context.drawImage(image, 0, 0);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height));
      } catch {
        resolve(null);
      }
    };
    image.src = url;
  });
}

export function petOverlayHit(root: HTMLElement, mask: PetAlphaMask | null, x: number, y: number) {
  for (const element of root.querySelectorAll<HTMLElement>(
    ".pet-context-menu, .pet-status-bubble, .pet-activity-tray",
  )) {
    const style = getComputedStyle(element);
    if (style.pointerEvents === "none" || style.visibility === "hidden" || style.opacity === "0")
      continue;
    const rect = element.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return true;
  }
  const sprite = root.querySelector<HTMLElement>(".pet-overlay-sprite");
  if (!sprite || !mask || sprite.dataset.failed) return false;
  const rect = sprite.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const style = getComputedStyle(sprite);
  // Reverse the sprite's CSS animation around its center before sampling the frame.
  const transform = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
  const local = transform.inverse().transformPoint({
    x: x - (rect.left + rect.width / 2),
    y: y - (rect.top + rect.height / 2),
    w: 0,
  });
  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  const column = Math.round(((Number.parseFloat(style.backgroundPositionX) || 0) * 7) / 100);
  const row = Math.round(((Number.parseFloat(style.backgroundPositionY) || 0) * 10) / 100);
  return petFrameHit(mask, column, row, local.x / width + 0.5, local.y / height + 0.5);
}

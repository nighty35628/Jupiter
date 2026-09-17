export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

/** Durable metadata only. Paths, credentials, provider file IDs and pixels never enter history. */
export interface ImageAttachment {
  kind: "image";
  id: string;
  name: string;
  mime: ImageMime;
  bytes: number;
  width: number;
  height: number;
  originalWidth?: number;
  originalHeight?: number;
  staticFrame?: boolean;
}

export interface MessageDraft {
  text: string;
  attachments?: ImageAttachment[];
}

export const IMAGE_ID_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_MESSAGE_IMAGES = 12;
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_INPUT_PIXELS = 16 * 1024 * 1024;
export const MAX_IMAGE_INPUT_SIDE = 16_384;
export const MAX_IMAGE_REQUEST_BYTES = 1024 * 1024;
export const MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_REQUEST_IMAGES = 32;

export function imageToken(id: string): string {
  if (!IMAGE_ID_PATTERN.test(id)) throw new Error("Invalid image attachment id");
  return `jupiter-image:${id}`;
}

export function imageIdFromToken(value: string): string | null {
  const id = value.startsWith("jupiter-image:") ? value.slice(14) : "";
  return IMAGE_ID_PATTERN.test(id) ? id : null;
}

export function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== "object") return false;
  const image = value as ImageAttachment;
  return (
    image.kind === "image" &&
    typeof image.id === "string" &&
    IMAGE_ID_PATTERN.test(image.id) &&
    typeof image.name === "string" &&
    image.name.length <= 240 &&
    ["image/png", "image/jpeg", "image/webp"].includes(image.mime) &&
    Number.isSafeInteger(image.bytes) &&
    image.bytes > 0 &&
    image.bytes <= MAX_IMAGE_INPUT_BYTES &&
    Number.isSafeInteger(image.width) &&
    image.width > 0 &&
    image.width <= MAX_IMAGE_INPUT_SIDE &&
    Number.isSafeInteger(image.height) &&
    image.height > 0 &&
    image.height <= MAX_IMAGE_INPUT_SIDE
  );
}

export function messageImageTokens(message: {
  attachments?: readonly ImageAttachment[];
  sourceAttachments?: readonly ImageAttachment[];
}): number {
  // Conservative V4 bound, never tokenize base64. Actual provider usage is authoritative.
  return (message.attachments?.length ?? 0) * 448 + (message.sourceAttachments?.length ?? 0) * 100;
}

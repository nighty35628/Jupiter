import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";

const FORMAT = "JupiterAndroidConfig";
const ALGORITHM = "aes-256-gcm";
export const CONFIG_ENVELOPE_VERSION = 1;
export const MAX_CONFIG_JSON_BYTES = 1024 * 1024;
const MAX_CIPHERTEXT_BASE64_CHARS = 4 * Math.ceil(MAX_CONFIG_JSON_BYTES / 3);
// Includes the fixed header and a small allowance for envelope whitespace.
export const MAX_CONFIG_ENVELOPE_BYTES = MAX_CIPHERTEXT_BASE64_CHARS + 256;
const AAD = `${FORMAT}:v${CONFIG_ENVELOPE_VERSION}`;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INVALID_CONFIG = "Invalid Android config JSON";
const INVALID_ENVELOPE = "Invalid Android config envelope";

function validateKey(dek: Uint8Array): void {
  if (!(dek instanceof Uint8Array) || dek.byteLength !== 32) {
    throw new Error("Android config encryption requires a 32-byte DEK");
  }
}

function validateText(text: string, maxBytes: number, message: string): void {
  if (
    typeof text !== "string" ||
    text.length > maxBytes ||
    Buffer.byteLength(text, "utf8") > maxBytes
  ) {
    throw new Error(message);
  }
}

function parseObject(text: string, message: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(message);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(message);
  }
  return parsed as Record<string, unknown>;
}

function decodeBase64(value: unknown, minBytes: number, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(maxBytes / 3)) {
    throw new Error(INVALID_ENVELOPE);
  }
  const bytes = Buffer.from(value, "base64");
  // Node's decoder is permissive; require canonical, padded standard Base64.
  if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString("base64") !== value) {
    throw new Error(INVALID_ENVELOPE);
  }
  return bytes;
}

/** Synchronous, I/O-free codec. The caller owns DEK delivery and atomic persistence. */
export function encodeConfigEnvelope(configJson: string, dek: Uint8Array): string {
  validateKey(dek);
  validateText(configJson, MAX_CONFIG_JSON_BYTES, INVALID_CONFIG);
  parseObject(configJson, INVALID_CONFIG);
  const plaintext = Buffer.from(configJson, "utf8");
  // Do not silently replace unpaired UTF-16 surrogates during UTF-8 encoding.
  if (plaintext.toString("utf8") !== configJson) throw new Error(INVALID_CONFIG);

  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, dek, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(AAD, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({
      format: FORMAT,
      version: CONFIG_ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
  } catch {
    throw new Error("Android config encryption failed");
  }
}

/** Returns the original JSON text only after authentication and object validation. */
export function decodeConfigEnvelope(envelopeJson: string, dek: Uint8Array): string {
  validateKey(dek);
  validateText(envelopeJson, MAX_CONFIG_ENVELOPE_BYTES, INVALID_ENVELOPE);
  const envelope = parseObject(envelopeJson, INVALID_ENVELOPE);
  const fields = ["format", "version", "algorithm", "nonce", "ciphertext", "tag"];
  if (
    Object.keys(envelope).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(envelope, field)) ||
    envelope.format !== FORMAT ||
    envelope.algorithm !== ALGORITHM
  ) {
    throw new Error(INVALID_ENVELOPE);
  }
  if (envelope.version !== CONFIG_ENVELOPE_VERSION) {
    throw new Error("Unsupported Android config envelope version");
  }
  const nonce = decodeBase64(envelope.nonce, NONCE_BYTES, NONCE_BYTES);
  const ciphertext = decodeBase64(envelope.ciphertext, 2, MAX_CONFIG_JSON_BYTES);
  const tag = decodeBase64(envelope.tag, TAG_BYTES, TAG_BYTES);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(ALGORITHM, dek, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(AAD, "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Android config authentication failed");
  }

  let configJson: string;
  try {
    configJson = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext);
  } catch {
    throw new Error(INVALID_CONFIG);
  }
  parseObject(configJson, INVALID_CONFIG);
  return configJson;
}

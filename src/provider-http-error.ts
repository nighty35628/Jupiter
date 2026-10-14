import stripAnsi from "strip-ansi";

export const MAX_PROVIDER_ERROR_BODY_BYTES = 16 * 1024;
export const MAX_PROVIDER_ERROR_DETAIL_CHARS = 1024;

const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PREFIXED_KEY_RE = /\b(?:sk|ds|ak|key)-[A-Za-z0-9_-]{8,}\b/gi;
const INLINE_CREDENTIAL_RE =
  /\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|cookie|client[-_ ]?secret|secret|password)\b(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi;
const COOKIE_HEADER_RE =
  /\b((?:set-)?cookie)\b(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi;
const MASKED_FRAGMENT_RE = /\*{2,}[A-Za-z0-9_-]{2,}/g;
const HTML_DOCUMENT_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const DIAGNOSTIC_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const SENSITIVE_QUERY_KEY_RE =
  /^(?:api[-_]?key|key|(?:access|refresh|id)[-_]?token|token|auth(?:orization)?|basic[-_]?auth|cookie|client[-_]?secret|secret|pass(?:word|wd)?|pwd|credential[s]?|signature|sig|x[-_]api[-_]key|x[-_]amz[-_](?:credential|signature|security[-_]token))$/i;

/** Display only: never use this value for requests or dispatcher configuration. */
export function sanitizeDiagnosticUrl(raw: string): string {
  const value = raw.trim();
  if (
    stripControlCharacters(value) !== value ||
    /\s/.test(value) ||
    value.replace(BIDI_CONTROL_RE, "") !== value
  ) {
    return "[invalid URL]";
  }
  try {
    const url = new URL(raw);
    if (!url.host) return "[invalid URL]";
    url.username = "";
    url.password = "";
    url.hash = "";
    const sensitiveKeys = [...url.searchParams.keys()].filter((key) =>
      SENSITIVE_QUERY_KEY_RE.test(key),
    );
    for (const key of sensitiveKeys) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

function redactKnownSecret(text: string, secret: string): string {
  const fullyEncoded = [...new TextEncoder().encode(secret)]
    .map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`)
    .join("");
  let encoded = fullyEncoded;
  try {
    encoded = encodeURIComponent(secret);
  } catch {
    // Malformed Unicode in configuration must not break diagnostic output.
  }
  const lowerEncoded = encoded.replace(/%[\dA-F]{2}/g, (value) => value.toLowerCase());
  const variants = new Set([
    secret,
    stripControlCharacters(stripAnsi(secret).replace(BIDI_CONTROL_RE, "")),
    encoded,
    fullyEncoded,
    encodeURIComponent(encoded),
    encodeURIComponent(lowerEncoded),
    encoded.replace(/%20/g, "+"),
  ]);
  let out = text;
  for (const variant of variants) {
    if (!variant) continue;
    // Escape literal text, allowing either hex case only inside percent escapes.
    const pattern = variant
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(
        /%([\dA-F])([\dA-F])/gi,
        (_match, a: string, b: string) =>
          `%[${a.toUpperCase()}${a.toLowerCase()}][${b.toUpperCase()}${b.toLowerCase()}]`,
      );
    out = out.replace(new RegExp(pattern, "g"), "[redacted]");
  }
  return out;
}

const JSON_DETAIL_PATHS: ReadonlyArray<readonly string[]> = [
  ["error", "message"],
  ["message"],
  ["detail"],
  ["error_description"],
];

export interface LimitedResponseText {
  text: string;
  truncated: boolean;
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes = MAX_PROVIDER_ERROR_BODY_BYTES,
): Promise<LimitedResponseText> {
  if (!response.body || maxBytes <= 0) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (total < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }

    if (total >= maxBytes && !truncated) {
      const next = await reader.read();
      if (!next.done) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

export function redactProviderSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length < 4) continue;
    out = redactKnownSecret(out, secret);
  }
  return out
    .replace(
      COOKIE_HEADER_RE,
      (_match, key: string, separator: string) => `${key}${separator}[redacted]`,
    )
    .replace(DIAGNOSTIC_URL_RE, (url) => sanitizeDiagnosticUrl(url))
    .replace(AUTH_SCHEME_RE, (match, scheme: string) => {
      if (
        scheme.toLowerCase() === "basic" &&
        !Buffer.from(match.slice(scheme.length).trim(), "base64").includes(58)
      ) {
        return match;
      }
      return `${scheme} [redacted]`;
    })
    .replace(JWT_RE, "[redacted]")
    .replace(PREFIXED_KEY_RE, "[redacted]")
    .replace(
      INLINE_CREDENTIAL_RE,
      (_match, key: string, separator: string) => `${key}${separator}[redacted]`,
    )
    .replace(MASKED_FRAGMENT_RE, "[redacted]");
}

export function sanitizeProviderErrorText(
  text: string,
  opts: { knownSecrets?: readonly string[]; maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? MAX_PROVIDER_ERROR_DETAIL_CHARS;
  const cleaned = redactProviderSecrets(
    stripControlCharacters(stripAnsi(text).replace(BIDI_CONTROL_RE, "")),
    opts.knownSecrets,
  )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

function stripControlCharacters(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      continue;
    }
    out += char;
  }
  return out;
}

export function extractProviderErrorDetail(
  rawBody: string,
  opts: { knownSecrets?: readonly string[]; maxChars?: number } = {},
): string {
  const trimmed = rawBody.replace(/^\uFEFF/, "").trim();
  if (!trimmed || HTML_DOCUMENT_RE.test(trimmed)) return "";

  let candidate = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    candidate = "";
    for (const path of JSON_DETAIL_PATHS) {
      const value = readStringPath(parsed, path);
      if (value !== null) {
        candidate = value;
        break;
      }
    }
  } catch {
    // Plain-text relay errors are useful after sanitization.
  }
  return sanitizeProviderErrorText(candidate, opts);
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly providerHost: string;
  readonly retryable: boolean;
  readonly safeDetail: string;

  constructor(input: {
    status: number;
    baseUrl: string;
    rawBody?: string;
    knownSecrets?: readonly string[];
  }) {
    const providerHost = safeHost(input.baseUrl);
    const safeDetail = extractProviderErrorDetail(input.rawBody ?? "", {
      knownSecrets: input.knownSecrets,
    });
    const label = providerHost === "api.deepseek.com" ? "DeepSeek" : `Upstream ${providerHost}`;
    super(`${label} ${input.status}${safeDetail ? `: ${safeDetail}` : ""}`);
    this.name = "ProviderHttpError";
    this.status = input.status;
    this.providerHost = providerHost;
    this.retryable = input.status === 429 || input.status >= 500;
    this.safeDetail = safeDetail;
  }
}

export async function providerHttpErrorFromResponse(
  response: Response,
  input: { baseUrl: string; knownSecrets?: readonly string[] },
): Promise<ProviderHttpError> {
  const body = await readResponseTextLimited(response).catch(() => ({
    text: "",
    truncated: false,
  }));
  return new ProviderHttpError({
    status: response.status,
    baseUrl: input.baseUrl,
    rawBody: body.text,
    knownSecrets: input.knownSecrets,
  });
}

function readStringPath(value: unknown, path: readonly string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "upstream";
  } catch {
    return "upstream";
  }
}

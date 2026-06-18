const SECRET_KEY_RE =
  /(secret|token|password|passphrase|api[-_]?key|authorization|cookie|credential|passwd|pwd)/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const INLINE_SECRET_RE =
  /\b(secret|token|password|passphrase|api[-_]?key|authorization|cookie|credential|passwd|pwd)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,;}]+|[^\s,;}]+)/gi;

export function redactEventValue<T>(value: T): T {
  return redactUnknown(value, null) as T;
}

export function redactEventText(value: string): string {
  return value
    .replace(INLINE_SECRET_RE, (_match, key: string, sep: string) => `${key}${sep}[redacted]`)
    .replace(BEARER_RE, "Bearer [redacted]");
}

export function redactEventJsonString(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(redactEventValue(parsed));
  } catch {
    return redactEventText(value);
  }
}

function redactUnknown(value: unknown, key: string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, null));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactUnknown(childValue, childKey);
    }
    return out;
  }
  if (typeof value === "string") {
    if ((key && SECRET_KEY_RE.test(key)) || /^Bearer\s+/i.test(value)) return "[redacted]";
    return redactEventText(value);
  }
  return value;
}

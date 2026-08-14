export const REDACTED_SECRET = "[REDACTED]";

const SENSITIVE_FIELD =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|APP_?KEY|PRIVATE_?KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PASSWD|COOKIE|CREDENTIALS?|AUTHORIZATION)(?:$|_)/i;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELD.test(key)) {
      out[key] = REDACTED_SECRET;
      continue;
    }
    if (key === "args" && typeof nested === "string") {
      try {
        out[key] = JSON.stringify(redactValue(JSON.parse(nested)));
        continue;
      } catch {
        // Non-JSON args are retained; free-form user text is not treated as a secret container.
      }
    }
    out[key] = redactValue(nested);
  }
  return out;
}

/** Redacts structured credential fields before diagnostic data is persisted. */
export function redactSecretsForPersistence<T>(value: T): T {
  return redactValue(value) as T;
}

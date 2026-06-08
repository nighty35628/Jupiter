import DOMPurify from "dompurify";
import { sanitizeUrl } from "@braintree/sanitize-url";

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "file"]);

function schemeForUrl(value: string): string | null {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return null;
  return /^([a-z][\w+.-]*):/i.exec(value)?.[1]?.toLowerCase() ?? null;
}

export function sanitizeUserUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  const scheme = schemeForUrl(raw);
  if (scheme && !ALLOWED_SCHEMES.has(scheme)) return null;

  const sanitized = sanitizeUrl(raw).trim();
  if (!sanitized || sanitized === "about:blank") return null;

  const sanitizedScheme = schemeForUrl(sanitized);
  if (sanitizedScheme && !ALLOWED_SCHEMES.has(sanitizedScheme)) return null;

  return sanitized;
}

export function sanitizeHtmlFragment(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
}

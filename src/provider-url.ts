import { isIP } from "node:net";

const PRIVATE_IPV4_RANGES = [
  [10, 0, 0, 0, 8],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
] as const;

function ipv4ToNumber(host: string): number {
  return (
    host
      .split(".")
      .map(Number)
      .reduce((value, part) => (value << 8) | part, 0) >>> 0
  );
}

function isPrivateIpv4(host: string): boolean {
  const value = ipv4ToNumber(host);
  return PRIVATE_IPV4_RANGES.some(([a, b, c, d, bits]) => {
    const base = ipv4ToNumber(`${a}.${b}.${c}.${d}`);
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

export function isLocalProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const family = isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) {
    return (
      host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")
    );
  }
  return false;
}

/** Normalize a user-entered Chat Completions base URL without silently changing its authority. */
export function normalizeProviderBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return "https://api.deepseek.com";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Provider base URL is not a valid absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Provider base URL must use HTTPS or HTTP.");
  }
  if (url.username || url.password) {
    throw new Error("Provider base URL must not contain embedded credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Provider base URL must not contain a query string or fragment.");
  }
  if (url.protocol === "http:" && !isLocalProviderHost(url.hostname)) {
    throw new Error("Non-local provider endpoints must use HTTPS.");
  }

  while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString().replace(/\/$/, "");
}

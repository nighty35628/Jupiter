// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { sanitizeHtmlFragment, sanitizeUserUrl } from "./safe-content";

describe("safe-content", () => {
  it("blocks javascript urls", () => {
    expect(sanitizeUserUrl("javascript:alert(1)")).toBe(null);
  });

  it("blocks data urls", () => {
    expect(sanitizeUserUrl("data:text/html,<script>alert(1)</script>")).toBe(null);
  });

  it("allows http, https, mailto, file urls, and relative paths", () => {
    expect(sanitizeUserUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(sanitizeUserUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(sanitizeUserUrl("mailto:test@example.com")).toBe("mailto:test@example.com");
    expect(sanitizeUserUrl("file:///tmp/index.html")).toBe("file:///tmp/index.html");
    expect(sanitizeUserUrl("docs/index.html")).toBe("docs/index.html");
  });

  it("removes script tags and event handlers from html fragments", () => {
    const html = sanitizeHtmlFragment(`<img src="x" onerror="alert(1)"><script>alert(2)</script>`);
    expect(html).toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });
});

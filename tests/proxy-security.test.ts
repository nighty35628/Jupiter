import { ProxyAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, installProxyIfConfigured } from "../src/net/proxy.js";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, ProxyAgent: vi.fn(), setGlobalDispatcher: vi.fn() };
});

describe("proxy diagnostic security", { retry: 0 }, () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _resetForTests();
    vi.mocked(ProxyAgent).mockReset();
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetForTests();
  });

  it("sanitizes success logs without changing dispatcher configuration or result", () => {
    const url =
      "http://syntheticUser:syntheticPass@proxy.example:8080/?api_key=opaqueSynthetic&mode=test#privateSynthetic";
    const result = installProxyIfConfigured({}, { url });
    expect(result?.url).toBe(url);
    expect(ProxyAgent).toHaveBeenCalledWith(url);
    expect(setGlobalDispatcher).toHaveBeenCalled();
    const log = stderr.mock.calls.map(([value]) => String(value)).join("");
    expect(log).toContain("proxy.example:8080");
    expect(log).toContain("mode=test");
    for (const value of ["syntheticUser", "syntheticPass", "opaqueSynthetic", "privateSynthetic"]) {
      expect(log).not.toContain(value);
    }
  });

  it.each(["env", "config"])("does not echo an invalid %s URL", (source) => {
    const url = "http://[invalid:opaqueSynthetic\u001b[31m";
    const result =
      source === "env"
        ? installProxyIfConfigured({ HTTPS_PROXY: url })
        : installProxyIfConfigured({}, { url });
    expect(result).toBeNull();
    const log = stderr.mock.calls.map(([value]) => String(value)).join("");
    expect(log).toContain(`ignoring proxy ${source} value`);
    expect(log).not.toContain("opaqueSynthetic");
    expect(log).not.toContain("\u001b");
  });

  it("sanitizes exception diagnostics even when the exception echoes the raw URL", () => {
    const url =
      "http://syntheticUser:syntheticPass@proxy.example:8080/?token=opaqueSynthetic#privateSynthetic";
    vi.mocked(ProxyAgent).mockImplementationOnce(() => {
      throw new Error(`unsupported proxy ${url}; Basic dXNlcjpTWU5USEVUSUM=`);
    });
    expect(installProxyIfConfigured({}, { url })).toBeNull();
    const log = stderr.mock.calls.map(([value]) => String(value)).join("");
    expect(log).toContain("proxy install failed");
    for (const value of [
      "syntheticUser",
      "syntheticPass",
      "opaqueSynthetic",
      "privateSynthetic",
      "dXNlcjpTWU5USEVUSUM=",
    ]) {
      expect(log).not.toContain(value);
    }
  });
});

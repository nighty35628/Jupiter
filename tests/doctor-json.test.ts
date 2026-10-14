/** `jupiter doctor --json` — structured report shape and exit-code semantics. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DoctorCheck,
  doctorCommand,
  formatDoctorJson,
  runDoctorChecks,
} from "../src/cli/commands/doctor.js";
import * as providerRuntime from "../src/provider-runtime.js";
import { VERSION } from "../src/version.js";

describe("formatDoctorJson", () => {
  it("emits version, summary, and {id,status,message} per check", () => {
    const checks: DoctorCheck[] = [
      { id: "api-key", label: "api key", level: "ok", detail: "set via env" },
      { id: "tokenizer", label: "tokenizer", level: "warn", detail: "fallback" },
      { id: "api-reach", label: "api reach", level: "fail", detail: "boom" },
    ];
    const parsed = JSON.parse(formatDoctorJson(checks, "0.18.1"));

    expect(parsed.version).toBe("0.18.1");
    expect(parsed.summary).toEqual({ ok: 1, warn: 1, fail: 1 });
    expect(parsed.checks).toEqual([
      { id: "api-key", status: "ok", message: "set via env" },
      { id: "tokenizer", status: "warn", message: "fallback" },
      { id: "api-reach", status: "fail", message: "boom" },
    ]);
  });

  it("produces a single-line, jq-parseable document", () => {
    const out = formatDoctorJson(
      [{ id: "api-key", label: "api key", level: "ok", detail: "set" }],
      "1.2.3",
    );
    expect(out).not.toContain("\n");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("counts an empty check list as all zeros", () => {
    const parsed = JSON.parse(formatDoctorJson([], VERSION));
    expect(parsed.summary).toEqual({ ok: 0, warn: 0, fail: 0 });
    expect(parsed.checks).toEqual([]);
  });
});

describe("doctorCommand --json (integration)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tmpHome: string;
  let tmpCwd: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "jupiter-doctor-home-"));
    tmpCwd = mkdtempSync(join(tmpdir(), "jupiter-doctor-cwd-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("USERPROFILE", tmpHome);
    // Ensure no API key so checkApiReach skips the network call.
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("DEEPSEEK_BASE_URL", "");
    vi.stubEnv("DEEPSEEK_API_BASE_URL", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("synthetic offline probe");
      }),
    );
    process.chdir(tmpCwd);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.chdir(origCwd);
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("emits exactly one line of valid JSON when --json is set", async () => {
    await doctorCommand({ json: true });

    // No header, no per-check prints, no summary leak — only the JSON document.
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = String(logSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(out);

    expect(parsed.version).toBe(VERSION);
    expect(parsed.summary).toMatchObject({
      ok: expect.any(Number),
      warn: expect.any(Number),
      fail: expect.any(Number),
    });
    expect(Array.isArray(parsed.checks)).toBe(true);
    for (const c of parsed.checks) {
      expect(typeof c.id).toBe("string");
      expect(["ok", "warn", "fail"]).toContain(c.status);
      expect(typeof c.message).toBe("string");
    }
  });

  it.each([false, true])("redacts configured proxy diagnostics (disabled=%s)", async (disabled) => {
    const configDir = join(tmpHome, ".jupiter");
    mkdirSync(configDir, { recursive: true });
    const url =
      "http://syntheticUser:syntheticPass@proxy.example:8080/?%61pi_key=opaqueSynthetic&mode=test#privateSynthetic";
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ proxy: { url, disabled } }));
    const checks = await runDoctorChecks(tmpCwd);
    const detail = checks.find((c) => c.id === "proxy")!.detail;
    expect(detail).toContain("proxy.example:8080");
    expect(detail).toContain("mode=test");
    for (const value of ["syntheticUser", "syntheticPass", "opaqueSynthetic", "privateSynthetic"]) {
      expect(detail).not.toContain(value);
      expect(formatDoctorJson(checks, VERSION)).not.toContain(value);
    }
  });

  it("does not echo invalid proxy URL values", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://[invalid:opaqueSynthetic");
    const checks = await runDoctorChecks(tmpCwd);
    expect(checks.find((c) => c.id === "proxy")!.detail).not.toContain("opaqueSynthetic");
  });

  it("redacts an opaque endpoint key echoed by a network exception in JSON and terminal output", async () => {
    const secret = "opaque/SYNTHETIC+endpoint=42";
    vi.stubEnv("DEEPSEEK_API_KEY", secret);
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://compat.example/v1");
    vi.spyOn(providerRuntime, "createProviderClient").mockReturnValue({
      listModels: vi.fn(async () => {
        throw new Error(
          `network ${encodeURIComponent(secret)} https://user:syntheticPass@relay.example/?token=opaqueSynthetic#privateSynthetic`,
        );
      }),
    } as unknown as ReturnType<typeof providerRuntime.createProviderClient>);
    const checks = await runDoctorChecks(tmpCwd);
    expect(checks.find((c) => c.id === "api-reach")!.level).toBe("fail");
    expect(checks.find((c) => c.id === "api-reach")!.detail).toContain("network [redacted]");
    await doctorCommand({ json: true });
    await doctorCommand();
    const output = logSpy.mock.calls.map(([value]) => String(value)).join("\n");
    for (const value of [
      secret,
      encodeURIComponent(secret),
      "syntheticPass",
      "opaqueSynthetic",
      "privateSynthetic",
    ]) {
      expect(formatDoctorJson(checks, VERSION)).not.toContain(value);
      expect(output).not.toContain(value);
    }
  });

  it("reports an invalid upstream configuration without echoing or throwing", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "opaqueSyntheticEndpointKey");
    vi.stubEnv("DEEPSEEK_BASE_URL", "http://[invalid:opaqueSyntheticEndpointKey");
    const checks = await runDoctorChecks(tmpCwd);
    expect(checks.find((c) => c.id === "api-reach")!.level).toBe("fail");
    expect(formatDoctorJson(checks, VERSION)).not.toContain("opaqueSyntheticEndpointKey");
  });

  it("exits 1 when the report contains any fail status", async () => {
    // checkApiKey returns `fail` when neither env nor config has a key —
    // our temp HOME has no config, and we deleted DEEPSEEK_API_KEY.
    await doctorCommand({ json: true });

    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    if (parsed.summary.fail > 0) {
      expect(exitSpy).toHaveBeenCalledWith(1);
    } else {
      expect(exitSpy).not.toHaveBeenCalled();
    }
  });

  it("accepts /models as api reach when /user/balance is unavailable", async () => {
    const configDir = join(tmpHome, ".jupiter");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        apiKey: "sk-test",
        baseUrl: "https://compat.example/v1",
      }),
    );
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "deepseek-v4-pro:cloud", object: "model", owned_by: "jupiter" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const checks = await runDoctorChecks(tmpCwd);
    const apiReach = checks.find((c) => c.id === "api-reach");

    expect(apiReach).toMatchObject({
      level: "ok",
      detail: expect.stringContaining("/models ok"),
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://compat.example/v1/models",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(checks.some((c) => c.id.startsWith("optional-"))).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const frame = (patch = {}) =>
  JSON.stringify({
    type: "android-bootstrap",
    version: 1,
    role: "host",
    runId: randomUUID(),
    configPath: "/owned/home/config.json",
    dek: Buffer.alloc(32, 42).toString("base64"),
    ...patch,
  });

describe("private Android bootstrap", { retry: 0 }, () => {
  it("initializes from split frames without consuming queued RPC bytes", async () => {
    vi.resetModules();
    const { readAndroidBootstrap } = await import("../src/mobile/bootstrap.js");
    const { getAndroidRuntimeContext } = await import("../src/mobile/runtime-context.js");
    const input = new PassThrough();
    const payload = frame();
    const reading = readAndroidBootstrap(input);
    input.write(payload.slice(0, 20));
    input.write(`${payload.slice(20)}\n{"cmd":"settings_get"}\n`);
    await reading;
    expect(getAndroidRuntimeContext()?.role).toBe("host");
    expect(input.read()?.toString()).toBe('{"cmd":"settings_get"}\n');
    expect(JSON.stringify(getAndroidRuntimeContext())).not.toContain("dek");
    input.destroy();
  });
  it.each([
    "bad-json",
    "[]",
    frame({ version: 2 }),
    frame({ dek: "no" }),
    frame({ extra: true }),
    frame({ role: "desktop" }),
  ])("rejects malformed or invalid frames without leaking input", async (payload) => {
    vi.resetModules();
    const { readAndroidBootstrap } = await import("../src/mobile/bootstrap.js");
    const input = new PassThrough();
    const reading = readAndroidBootstrap(input);
    input.write(`${payload}\n`);
    await expect(reading).rejects.toThrow("Android bootstrap initialization failed");
    input.destroy();
  });
  it("rejects oversized and ended channels", async () => {
    vi.resetModules();
    const { readAndroidBootstrap } = await import("../src/mobile/bootstrap.js");
    const input = new PassThrough();
    const reading = readAndroidBootstrap(input);
    input.write("x".repeat(8193));
    await expect(reading).rejects.toThrow("initialization failed");
    input.destroy();
    const ended = new PassThrough();
    const next = readAndroidBootstrap(ended);
    ended.end("partial");
    await expect(next).rejects.toThrow("ended before");
  });
  it("times out without initializing", async () => {
    vi.resetModules();
    const { readAndroidBootstrap } = await import("../src/mobile/bootstrap.js");
    const input = new PassThrough();
    await expect(readAndroidBootstrap(input, 5)).rejects.toThrow("timed out");
    input.destroy();
  });
  it("delivers a child frame through a pipe and preserves ordinary non-Android behavior", async () => {
    vi.resetModules();
    const { readAndroidBootstrap, writeAndroidChildBootstrap } = await import(
      "../src/mobile/bootstrap.js"
    );
    let written = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        written += chunk.toString();
        done();
      },
    });
    await writeAndroidChildBootstrap(output, "interactive");
    expect(written).toBe("");
    const input = new PassThrough();
    const init = readAndroidBootstrap(input);
    input.write(`${frame()}\n`);
    await init;
    await writeAndroidChildBootstrap(output, "interactive");
    expect(JSON.parse(written)).toMatchObject({
      role: "interactive",
      type: "android-bootstrap",
      configPath: "/owned/home/config.json",
    });
    expect(Buffer.from(JSON.parse(written).dek, "base64")).toHaveLength(32);
    input.destroy();
    output.end();
  });
});

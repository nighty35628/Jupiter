import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGeneratedDesktopSessionTitle, mintSessionFor } from "../src/cli/commands/desktop.js";
import { loadSessionMeta, sessionPath } from "../src/memory/session.js";

describe("desktop session minting", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jupiter-desktop-session-mint-"));
    vi.stubEnv("HOME", tmp);
    vi.stubEnv("USERPROFILE", tmp);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:34:56.789Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps repeated new chats in the same tab from reusing the previous session", () => {
    const workspace = "/tmp/jupiter-workspace";

    const first = mintSessionFor(workspace);
    const second = mintSessionFor(workspace);

    expect(second).not.toBe(first);
    expect(first).toMatch(/^desktop-\d{17}-\d+-\d+$/);
    expect(second).toMatch(/^desktop-\d{17}-\d+-\d+$/);
    expect(loadSessionMeta(first).workspace).toBe(workspace);
    expect(loadSessionMeta(second).workspace).toBe(workspace);
  });

  it("renames timestamp desktop sessions after model title generation", () => {
    const workspace = "/tmp/jupiter-workspace";
    const session = mintSessionFor(workspace);
    const title = `修复粘贴文件-${tmp.split(/[\\/]/).pop()}`;
    writeFileSync(sessionPath(session), `${JSON.stringify({ role: "user", content: "hi" })}\n`);

    const next = applyGeneratedDesktopSessionTitle({
      sessionName: session,
      title,
      workspace,
    });

    expect(next).toBe(title);
    expect(existsSync(sessionPath(session))).toBe(false);
    expect(existsSync(sessionPath(next))).toBe(true);
    expect(loadSessionMeta(next)).toMatchObject({
      summary: title,
      autoTitleGenerated: true,
      workspace,
    });
  });
});

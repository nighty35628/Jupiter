import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditBlock } from "../src/code/edit-blocks.js";
import {
  clearPendingEdits,
  loadPendingEdits,
  pendingEditsPath,
  savePendingEdits,
} from "../src/code/pending-edits.js";
import { appendSessionMessage, deleteSession, sessionPath } from "../src/memory/session.js";

function block(overrides: Partial<EditBlock> = {}): EditBlock {
  return {
    path: "src/a.ts",
    search: "foo",
    replace: "bar",
    offset: 0,
    ...overrides,
  };
}

describe("pending-edits checkpoint", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jupiter-pending-"));
    vi.stubEnv("USERPROFILE", tmp);
    vi.stubEnv("HOME", tmp);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("pendingEditsPath is a .pending.json sibling of the session file", () => {
    const p = pendingEditsPath("demo");
    expect(p).toContain("sessions");
    expect(p.endsWith("demo.pending.json")).toBe(true);
  });

  it("save → load round-trips the queue", () => {
    const blocks = [block({ path: "a.ts" }), block({ path: "b.ts", search: "x", replace: "y" })];
    savePendingEdits("s1", blocks);
    const loaded = loadPendingEdits("s1");
    expect(loaded).toEqual(blocks);
  });

  it("save with an empty array deletes the file", () => {
    savePendingEdits("s2", [block()]);
    expect(existsSync(pendingEditsPath("s2"))).toBe(true);
    savePendingEdits("s2", []);
    expect(existsSync(pendingEditsPath("s2"))).toBe(false);
  });

  it("load returns null when the file doesn't exist", () => {
    expect(loadPendingEdits("ghost")).toBeNull();
  });

  it("load returns null for a corrupt file rather than throwing", () => {
    // First create a real checkpoint, then trash its contents.
    savePendingEdits("corrupt", [block()]);
    const path = pendingEditsPath("corrupt");
    writeFileSync(path, "{ not json", "utf8");
    expect(loadPendingEdits("corrupt")).toBeNull();
  });

  it("load drops malformed entries but keeps valid neighbors", () => {
    const path = pendingEditsPath("mixed");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify([
        block({ path: "good.ts" }),
        { path: "bad", search: "", replace: "" }, // missing offset
        { totally: "wrong" },
        block({ path: "also-good.ts" }),
      ]),
      "utf8",
    );
    const loaded = loadPendingEdits("mixed");
    expect(loaded?.map((b) => b.path)).toEqual(["good.ts", "also-good.ts"]);
  });

  it("clearPendingEdits removes the checkpoint file", () => {
    savePendingEdits("clr", [block()]);
    expect(existsSync(pendingEditsPath("clr"))).toBe(true);
    clearPendingEdits("clr");
    expect(existsSync(pendingEditsPath("clr"))).toBe(false);
  });

  it("clearPendingEdits is a no-op when the file is already missing", () => {
    expect(() => clearPendingEdits("ghost")).not.toThrow();
  });

  it("save / load / clear are all no-ops when sessionName is null (ephemeral)", () => {
    expect(() => savePendingEdits(null, [block()])).not.toThrow();
    expect(loadPendingEdits(null)).toBeNull();
    expect(() => clearPendingEdits(null)).not.toThrow();
  });

  it("deleteSession removes the pending-edits sidecar too", () => {
    appendSessionMessage("combo", { role: "user", content: "hi" });
    savePendingEdits("combo", [block()]);
    expect(existsSync(pendingEditsPath("combo"))).toBe(true);
    expect(existsSync(sessionPath("combo"))).toBe(true);
    deleteSession("combo");
    expect(existsSync(sessionPath("combo"))).toBe(false);
    expect(existsSync(pendingEditsPath("combo"))).toBe(false);
  });
});

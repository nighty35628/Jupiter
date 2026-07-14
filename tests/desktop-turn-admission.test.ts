import { describe, expect, it } from "vitest";
import { DesktopTurnAdmission } from "../src/desktop/turn-admission.js";

describe("DesktopTurnAdmission", () => {
  it("admits only one turn at a time", () => {
    const admission = new DesktopTurnAdmission();
    const first = admission.begin();

    expect(first).toBe(1);
    expect(admission.running).toBe(true);
    expect(admission.begin()).toBeNull();
  });

  it("releases only the current generation", () => {
    const admission = new DesktopTurnAdmission();
    const first = admission.begin()!;

    expect(admission.finish(first + 1)).toBe(false);
    expect(admission.running).toBe(true);
    expect(admission.finish(first)).toBe(true);
    expect(admission.running).toBe(false);
    expect(admission.begin()).toBeGreaterThan(first);
  });

  it("invalidates stale completion callbacks", () => {
    const admission = new DesktopTurnAdmission();
    const stale = admission.begin()!;
    admission.invalidate();
    const current = admission.begin()!;

    expect(admission.finish(stale)).toBe(false);
    expect(admission.isCurrent(current)).toBe(true);
    expect(admission.finish(current)).toBe(true);
  });
});

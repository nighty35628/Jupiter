import { describe, expect, it } from "vitest";
import { RpcSendFailure, coerceRpcSendFailure, isDefinitelyUnsent } from "./rpc-send";

describe("coerceRpcSendFailure", () => {
  it("preserves structured Tauri failure stages", () => {
    const failure = coerceRpcSendFailure({
      stage: "flush_failed",
      message: "flush: broken pipe",
    });
    expect(failure).toBeInstanceOf(RpcSendFailure);
    expect(failure.stage).toBe("flush_failed");
    expect(failure.message).toContain("broken pipe");
  });

  it("recognizes the legacy not-spawned string as definitely unsent", () => {
    expect(isDefinitelyUnsent("rpc not spawned")).toBe(true);
  });

  it("treats locally blocked follow-up commands as definitely unsent", () => {
    expect(isDefinitelyUnsent(new RpcSendFailure("blocked", "transport is paused"))).toBe(true);
  });

  it("does not treat write, flush, or unknown failures as definitely unsent", () => {
    expect(isDefinitelyUnsent("write: broken pipe")).toBe(false);
    expect(isDefinitelyUnsent("flush: broken pipe")).toBe(false);
    expect(isDefinitelyUnsent(new Error("invoke failed"))).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SessionWriterConflictError,
  SessionWriterLease,
  sessionWriterLockExists,
} from "../src/memory/session-writer-lock.js";

describe("SessionWriterLease", () => {
  it("allows one owner to rebuild while rejecting a second owner", () => {
    const key = `test-${randomUUID()}`;
    const first = SessionWriterLease.acquire({ key, ownerId: "tab-a", label: "alpha" });
    const rebuilt = SessionWriterLease.acquire({ key, ownerId: "tab-a", label: "alpha" });

    expect(sessionWriterLockExists(key)).toBe(true);
    expect(() => SessionWriterLease.acquire({ key, ownerId: "tab-b", label: "alpha" })).toThrow(
      SessionWriterConflictError,
    );

    first.release();
    expect(sessionWriterLockExists(key)).toBe(true);
    rebuilt.release();
    expect(sessionWriterLockExists(key)).toBe(false);
  });

  it("releases ownership idempotently", () => {
    const key = `test-${randomUUID()}`;
    const lease = SessionWriterLease.acquire({ key, ownerId: "tab-a", label: "alpha" });

    lease.release();
    lease.release();

    expect(sessionWriterLockExists(key)).toBe(false);
    const next = SessionWriterLease.acquire({ key, ownerId: "tab-b", label: "alpha" });
    next.release();
  });
});

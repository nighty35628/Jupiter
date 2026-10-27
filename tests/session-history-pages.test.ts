import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLoadedMessages } from "../src/cli/commands/desktop.js";
import {
  SESSION_HISTORY_LIMITS,
  SessionHistoryError,
  getSessionHistoryGeneration,
  invalidateSessionHistory,
  readSessionHistoryPage,
  readSessionHistoryTurn,
} from "../src/memory/session-history.js";
import { sessionPath } from "../src/memory/session.js";
import type { ChatMessage } from "../src/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const jsonl = (records: ChatMessage[], eol = "\n") =>
  records.map((record) => JSON.stringify(record)).join(eol) + eol;
const turns = (n: number, padding = 0): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => [
    { role: "user" as const, content: `q${i + 1}${"x".repeat(padding)}` },
    { role: "assistant" as const, content: `a${i + 1}` },
  ]).flat();

describe("bounded session history pages", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-history-pages-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(dirname(sessionPath("s")), { recursive: true });
  });

  afterEach(() => {
    invalidateSessionHistory("s");
    invalidateSessionHistory("other");
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps an oversized orphan assistant visible with an export refusal", async () => {
    writeFileSync(sessionPath("s"), jsonl([{ role: "assistant", content: "x".repeat(1_100_000) }]));
    const page = await readSessionHistoryPage("s");
    expect(page.totalTurns).toBe(0);
    const visible = buildLoadedMessages(page.records);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      rollbackRef: null,
      historyOmission: { exportRequired: true },
    });
  });

  it("pages backward in complete turns and reports raw user offsets", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(5)));
    const newest = await readSessionHistoryPage("s", { limitTurns: 2 });
    expect(newest).toMatchObject({
      records: turns(5).slice(6),
      startTurn: 3,
      totalTurns: 5,
      hasMore: true,
      sourceSize: Buffer.byteLength(jsonl(turns(5))),
    });
    const middle = await readSessionHistoryPage("s", {
      cursor: newest.beforeCursor,
      limitTurns: 2,
    });
    expect(middle).toMatchObject({ records: turns(5).slice(2, 6), startTurn: 1, hasMore: true });
    const first = await readSessionHistoryPage("s", { cursor: middle.beforeCursor });
    expect(first).toMatchObject({ records: turns(1), startTurn: 0, hasMore: false });
    expect(first.beforeCursor).toBeUndefined();
    expect(await readSessionHistoryTurn("s", 3)).toMatchObject({
      records: turns(5).slice(4, 6),
      startTurn: 2,
      totalTurns: 5,
    });
  });

  it("keeps append cursors valid and updates the final tool chain", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(4)));
    const page = await readSessionHistoryPage("s", { limitTurns: 1 });
    appendFileSync(
      sessionPath("s"),
      jsonl([
        { role: "tool", tool_call_id: "late", content: "result" },
        { role: "user", content: "q5" },
        { role: "assistant", content: "a5" },
      ]),
    );
    const older = await readSessionHistoryPage("s", { cursor: page.beforeCursor, limitTurns: 1 });
    expect(older.generation).toBe(page.generation);
    expect(older.records).toEqual(turns(4).slice(4, 6));
    expect(older.totalTurns).toBe(5);
    expect((await readSessionHistoryTurn("s", 4)).records.at(-1)?.role).toBe("tool");
  });

  it("rejects same-size rewrites with restored mtime, including changes in the middle", async () => {
    const body = jsonl(turns(40, 200));
    writeFileSync(sessionPath("s"), body);
    const first = await readSessionHistoryPage("s", { limitTurns: 1 });
    const before = statSync(sessionPath("s"));
    writeFileSync(sessionPath("s"), body.replace("q20", "z20"));
    utimesSync(sessionPath("s"), before.atime, before.mtime);
    await expect(readSessionHistoryPage("s", { cursor: first.beforeCursor })).rejects.toMatchObject(
      { code: "STALE_CURSOR" },
    );
    const rewritten = await readSessionHistoryPage("s");
    expect(rewritten.generation).not.toBe(first.generation);
    expect((await readSessionHistoryTurn("s", 20)).records[0]?.content).toMatch(/^z20/);
  });

  it("distinguishes rewrite-and-grow from append, replacement, truncation and invalidation", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(4)));
    let page = await readSessionHistoryPage("s", { limitTurns: 1 });
    writeFileSync(sessionPath("s"), jsonl(turns(5)).replace("q2", "z2"));
    await expect(readSessionHistoryPage("s", { cursor: page.beforeCursor })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    page = await readSessionHistoryPage("s", { limitTurns: 1 });
    writeFileSync(`${sessionPath("s")}.replacement`, jsonl(turns(5)));
    renameSync(`${sessionPath("s")}.replacement`, sessionPath("s"));
    await expect(readSessionHistoryPage("s", { cursor: page.beforeCursor })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    page = await readSessionHistoryPage("s", { limitTurns: 1 });
    writeFileSync(sessionPath("s"), jsonl(turns(2)));
    await expect(readSessionHistoryPage("s", { cursor: page.beforeCursor })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
    page = await readSessionHistoryPage("s", { limitTurns: 1 });
    invalidateSessionHistory("s");
    await expect(readSessionHistoryPage("s", { cursor: page.beforeCursor })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
  });

  it("invalidates byte-identical rewrites, but not a newline completing a record", async () => {
    const body = jsonl(turns(4)).trimEnd();
    writeFileSync(sessionPath("s"), body);
    const page = await readSessionHistoryPage("s", { limitTurns: 1 });
    appendFileSync(sessionPath("s"), "\n");
    const completed = await readSessionHistoryPage("s", { limitTurns: 1 });
    expect(completed.generation).toBe(page.generation);
    expect(completed.totalTurns).toBe(4);
    writeFileSync(sessionPath("s"), `${body}\n`);
    await expect(readSessionHistoryPage("s", { cursor: page.beforeCursor })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
  });

  it("invalidates append that destroys an unterminated valid record", async () => {
    const body = jsonl(turns(4)).trimEnd();
    writeFileSync(sessionPath("s"), body);
    const page = await readSessionHistoryPage("s", { limitTurns: 1 });
    appendFileSync(sessionPath("s"), "junk\n");
    await expect(readSessionHistoryPage("s", { cursor: page.beforeCursor })).rejects.toMatchObject({
      code: "STALE_CURSOR",
    });
  });

  it("rejects corrupt, modified, huge and foreign cursors; uses the safe path as identity", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(3)));
    writeFileSync(sessionPath("other"), jsonl(turns(3)));
    const page = await readSessionHistoryPage("s", { limitTurns: 1 });
    for (const cursor of ["garbage", "x".repeat(4096), `${page.beforeCursor}x`]) {
      await expect(readSessionHistoryPage("s", { cursor })).rejects.toBeInstanceOf(
        SessionHistoryError,
      );
    }
    await expect(
      readSessionHistoryPage("other", { cursor: page.beforeCursor }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    writeFileSync(sessionPath("../safe"), jsonl(turns(3)));
    const safe = await readSessionHistoryPage("../safe", { limitTurns: 1 });
    expect((await readSessionHistoryPage("___safe", { cursor: safe.beforeCursor })).startTurn).toBe(
      0,
    );
    invalidateSessionHistory("../safe");
  });

  it("handles Unicode across chunk boundaries, CRLF, malformed lines, preamble and no final newline", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "preamble" },
      { role: "user", content: `${"x".repeat(65500)}你好🌍` },
      { role: "assistant", tool_calls: [{ id: "a", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "你好" },
      { role: "assistant", content: "done" },
      { role: "user", content: "last" },
    ];
    writeFileSync(sessionPath("s"), `bad\r\n{}\r\n${jsonl(messages, "\r\n").trimEnd()}`);
    expect((await readSessionHistoryTurn("s", 1)).records).toEqual(messages.slice(0, 5));
    expect((await readSessionHistoryTurn("s", 2)).startTurn).toBe(1);
    const before = await readSessionHistoryPage("s", { limitTurns: 1 });
    appendFileSync(sessionPath("s"), `\r\n${jsonl([{ role: "assistant", content: "tail" }])}`);
    const after = await readSessionHistoryPage("s", { limitTurns: 1 });
    expect(after.generation).toBe(before.generation);
    expect(after.totalTurns).toBe(2);
    expect(after.records).toEqual([messages[5], { role: "assistant", content: "tail" }]);
  });

  it("respects byte budgets without cutting tool groups, and types oversized turns", async () => {
    const group: ChatMessage[] = [
      { role: "user", content: "question" },
      { role: "assistant", tool_calls: [{ id: "a", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "result" },
      { role: "assistant", content: "answer" },
    ];
    writeFileSync(sessionPath("s"), jsonl([...turns(1), ...group]));
    const budget = Buffer.byteLength(jsonl(group));
    const page = await readSessionHistoryPage("s", { maxBytes: budget });
    expect(page.records).toEqual(group);
    expect(page.startTurn).toBe(1);
    const omitted = await readSessionHistoryPage("s", { maxBytes: budget - 1, limitTurns: 1 });
    expect(omitted.records[0]).toMatchObject({
      role: "user",
      historyOmission: { turn: 2, byteLength: budget, reason: "turn" },
    });
    await expect(readSessionHistoryTurn("s", 2, { maxBytes: budget - 1 })).rejects.toMatchObject({
      code: "TURN_TOO_LARGE",
      turn: 2,
      byteLength: budget,
      maxBytes: budget - 1,
    });
    expect((await readSessionHistoryTurn("s", 1, { maxBytes: budget - 1 })).records).toEqual(
      turns(1),
    );
  });

  it("matches live/backup semantics without exposing stale backup for missing or empty live", async () => {
    writeFileSync(`${sessionPath("s")}.bak`, jsonl(turns(2)));
    expect((await readSessionHistoryPage("s")).records).toEqual([]);
    writeFileSync(sessionPath("s"), " \r\n");
    expect((await readSessionHistoryPage("s")).records).toEqual([]);
    writeFileSync(sessionPath("s"), "not json\n{}\n");
    const backup = await readSessionHistoryPage("s");
    expect(backup.records).toEqual(turns(2));
    expect(backup.sourcePath).toBe(`${sessionPath("s")}.bak`);
    const warmBackup = await readSessionHistoryPage("s", { limitTurns: 1 });
    expect(warmBackup.generation).toBe(backup.generation);
    expect(warmBackup.records).toEqual(turns(2).slice(2));
    writeFileSync(`${sessionPath("s")}.bak`, jsonl(turns(3)).replace("q2", "z2"));
    expect((await readSessionHistoryPage("s")).generation).not.toBe(backup.generation);
    writeFileSync(sessionPath("s"), jsonl(turns(1)));
    expect((await readSessionHistoryPage("s")).records).toEqual(turns(1));
  });

  it("uses backup when an existing live file is unreadable", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(1)));
    writeFileSync(`${sessionPath("s")}.bak`, jsonl(turns(2)));
    const originalOpen = vi.mocked(open).getMockImplementation()!;
    vi.mocked(open).mockImplementation((...args) => {
      if (args[0] === sessionPath("s")) {
        return Promise.reject(Object.assign(new Error("Permission denied"), { code: "EACCES" }));
      }
      return originalOpen(...args);
    });
    try {
      const page = await readSessionHistoryPage("s");
      expect(page.records).toEqual(turns(2));
      expect(await getSessionHistoryGeneration("s")).toBe(page.generation);
    } finally {
      vi.mocked(open).mockImplementation(originalOpen);
    }
    expect((await readSessionHistoryPage("s")).records).toEqual(turns(1));
  });

  it("makes warm page/detail reads proportional to their byte ranges, with read counters", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(500, 2048)));
    const cold = await readSessionHistoryPage("s", { limitTurns: 2 });
    const parse = vi.spyOn(JSON, "parse");
    const warm = await readSessionHistoryPage("s", { limitTurns: 2 });
    const detail = await readSessionHistoryTurn("s", 250);
    expect(await getSessionHistoryGeneration("s")).toBe(cold.generation);
    expect(parse).toHaveBeenCalledTimes(6);
    parse.mockRestore();
    expect(cold.readBytes).toBeGreaterThanOrEqual(cold.sourceSize);
    expect(cold.readCount).toBeGreaterThan(10);
    expect(warm.readBytes).toBeLessThan(16000);
    expect(detail.readBytes).toBeLessThan(12000);
    expect(warm.readCount).toBeLessThan(8);
    expect(detail.readCount).toBeLessThan(8);
  });

  it("coalesces same-file cold reads and isolates cancellation between waiters", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(800, 2048)));
    const controller = new AbortController();
    const cancelled = readSessionHistoryPage("s", { signal: controller.signal });
    const cancelledCheck = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const surviving = readSessionHistoryPage("s", { limitTurns: 1 });
    controller.abort();
    await cancelledCheck;
    const page = await surviving;
    const [a, b] = await Promise.all([
      readSessionHistoryTurn("s", 10),
      readSessionHistoryPage("s", { limitTurns: 1 }),
    ]);
    expect(page.generation).toBe(a.generation);
    expect(a.generation).toBe(b.generation);
    invalidateSessionHistory("s");
    const [coldA, coldB] = await Promise.all([
      readSessionHistoryPage("s", { limitTurns: 1 }),
      readSessionHistoryTurn("s", 10),
    ]);
    expect(coldA.generation).toBe(coldB.generation);
    expect(coldA.readBytes).toBeGreaterThan(coldA.sourceSize);
    expect(coldB.readBytes).toBeGreaterThan(coldB.sourceSize);
    expect(coldA.readBytes - coldB.readBytes).toBeLessThan(4096);
  });

  it("cancels cold builds, yields the event loop, and can rebuild after cancellation", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(1000, 2048)));
    const controller = new AbortController();
    const pending = readSessionHistoryPage("s", { signal: controller.signal });
    const check = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        controller.abort();
        resolve();
      }),
    );
    await check;
    expect((await readSessionHistoryPage("s", { limitTurns: 1 })).totalTurns).toBe(1000);
    const already = new AbortController();
    already.abort();
    await expect(readSessionHistoryPage("s", { signal: already.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("indexes oversized records without parsing bodies and keeps unrelated turns readable", async () => {
    const large = "x".repeat(SESSION_HISTORY_LIMITS.maxRecordBytes * 3);
    writeFileSync(
      sessionPath("s"),
      jsonl([
        ...turns(1),
        { role: "user", content: large },
        { role: "user", content: "small newest" },
      ]),
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      const newest = await readSessionHistoryPage("s", { limitTurns: 1 });
      expect(newest).toMatchObject({
        totalTurns: 3,
        startTurn: 2,
        records: [{ role: "user", content: "small newest" }],
      });
      const omitted = await readSessionHistoryPage("s", {
        cursor: newest.beforeCursor,
        limitTurns: 1,
      });
      expect(omitted.records[0]).toMatchObject({
        role: "user",
        historyOmission: {
          turn: 2,
          byteOffset: Buffer.byteLength(jsonl(turns(1))),
          byteLength: Buffer.byteLength(jsonl([{ role: "user", content: large }])),
          reason: "record",
          exportRequired: true,
        },
      });
      expect(JSON.stringify(omitted.records).length).toBeLessThan(2048);
      expect(omitted.readBytes).toBeLessThan(2048);
      expect((await readSessionHistoryPage("s", { cursor: omitted.beforeCursor })).records).toEqual(
        turns(1),
      );
      await expect(readSessionHistoryTurn("s", 2)).rejects.toMatchObject({
        code: "RECORD_TOO_LARGE",
        turn: 2,
        turnExact: true,
        byteOffset: Buffer.byteLength(jsonl(turns(1))),
      });
      expect(await getSessionHistoryGeneration("s")).toBe(newest.generation);
      expect(
        parse.mock.calls.every(
          ([raw]) => String(raw).length <= SESSION_HISTORY_LIMITS.maxRecordBytes,
        ),
      ).toBe(true);
    } finally {
      parse.mockRestore();
    }
  });

  it(
    "streams late/escaped/duplicate top-level roles and ignores malformed huge lines",
    { timeout: 20000 },
    async () => {
      const large = "x".repeat(SESSION_HISTORY_LIMITS.maxRecordBytes + 50);
      const body = [
        JSON.stringify({ content: large, nested: { role: "user" }, role: "user" }),
        JSON.stringify({ content: large, role: "tool" }),
        `{"content":${JSON.stringify(large)},"ro\\u006ce":"us\\u0065r"}`,
        `{"role":"user","content":${JSON.stringify(large)},"role":"tool"}`,
        `{"role":"user","content":${JSON.stringify(large)},broken}`,
        JSON.stringify({ content: large, nested: { role: "user" } }),
        JSON.stringify({ role: "user", content: "last" }),
      ].join("\r\n");
      writeFileSync(sessionPath("s"), body);
      const newest = await readSessionHistoryPage("s", { limitTurns: 1 });
      expect(newest).toMatchObject({
        totalTurns: 3,
        startTurn: 2,
        records: [{ role: "user", content: "last" }],
      });
      const all = await readSessionHistoryPage("s");
      expect(all.omissions).toHaveLength(2);
      expect(all.records.map((record) => record.role)).toEqual(["user", "user", "user"]);
    },
  );

  it("streams nested grammar, numeric/literal values and chunk-split Unicode/escapes", async () => {
    const large = `${"x".repeat(SESSION_HISTORY_LIMITS.maxRecordBytes)}你好\\\"`;
    const records = [
      JSON.stringify({
        role: "user",
        content: large,
        nested: [0, -1.2e3, true, false, null, {}, [1]],
      }),
      `{"role":"user","content":${JSON.stringify(large)},"bad":[1,]}`,
      `{"role":"user","content":${JSON.stringify(large)},"bad":01}`,
      `{"role":"user","content":${JSON.stringify(large)},"bad":1e}`,
      JSON.stringify({ role: "user", content: "small end" }),
    ];
    writeFileSync(sessionPath("s"), records.join("\n"));
    const page = await readSessionHistoryPage("s");
    expect(page.totalTurns).toBe(2);
    expect(page.omissions).toHaveLength(1);
    expect(page.records.at(-1)?.content).toBe("small end");
    const before = page.generation;
    appendFileSync(sessionPath("s"), `\n${JSON.stringify({ role: "tool", content: large })}\n`);
    const appended = await readSessionHistoryPage("s", { limitTurns: 1 });
    expect(appended.generation).toBe(before);
    expect(appended.totalTurns).toBe(2);
    expect(appended.omissions[0]?.turn).toBe(2);
  });

  it("accepts the exact record limit and keeps preamble-only transcripts available", async () => {
    const overhead = Buffer.byteLength(JSON.stringify({ role: "user", content: "" }));
    const record: ChatMessage = {
      role: "user",
      content: "x".repeat(SESSION_HISTORY_LIMITS.maxRecordBytes - overhead),
    };
    writeFileSync(sessionPath("s"), jsonl([record]));
    expect(
      (await readSessionHistoryPage("s", { maxBytes: SESSION_HISTORY_LIMITS.maxBytes })).records,
    ).toEqual([record]);
    writeFileSync(sessionPath("s"), jsonl([{ role: "system", content: "only preamble" }]));
    expect(await readSessionHistoryPage("s")).toMatchObject({
      records: [{ role: "system", content: "only preamble" }],
      totalTurns: 0,
      startTurn: 0,
      hasMore: false,
    });
  });

  it("caps retained indexes and invalidates evicted cursors", async () => {
    writeFileSync(sessionPath("s"), jsonl(turns(3)));
    const first = await readSessionHistoryPage("s", { limitTurns: 1 });
    for (let i = 0; i < SESSION_HISTORY_LIMITS.maxCachedSessions; i++) {
      const name = `cache-${i}`;
      writeFileSync(sessionPath(name), jsonl(turns(2)));
      await readSessionHistoryPage(name);
    }
    await expect(readSessionHistoryPage("s", { cursor: first.beforeCursor })).rejects.toMatchObject(
      { code: "STALE_CURSOR" },
    );
    for (let i = 0; i < SESSION_HISTORY_LIMITS.maxCachedSessions; i++)
      invalidateSessionHistory(`cache-${i}`);
  });

  it("validates options and missing/out-of-range turns", async () => {
    expect(await readSessionHistoryPage("s")).toMatchObject({
      records: [],
      totalTurns: 0,
      startTurn: 0,
    });
    for (const limitTurns of [0, -1, Number.NaN, 1.5, SESSION_HISTORY_LIMITS.maxTurns + 1]) {
      await expect(readSessionHistoryPage("s", { limitTurns })).rejects.toBeInstanceOf(RangeError);
    }
    for (const maxBytes of [0, Number.POSITIVE_INFINITY, SESSION_HISTORY_LIMITS.maxBytes + 1]) {
      await expect(readSessionHistoryPage("s", { maxBytes })).rejects.toBeInstanceOf(RangeError);
    }
    await expect(readSessionHistoryTurn("s", 0)).rejects.toBeInstanceOf(RangeError);
    await expect(readSessionHistoryTurn("s", 1)).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
  });
});

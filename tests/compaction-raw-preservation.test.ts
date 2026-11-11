import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistentLoopSessionStorage } from "../src/memory/compaction-checkpoint.js";
import { loadSessionMessages, rewriteSession, sessionPath } from "../src/memory/session.js";
import type { ChatMessage } from "../src/types.js";

const fixture = vi.hoisted(() => ({ home: undefined as string | undefined }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => {
      if (!fixture.home) throw new Error("Raw-preservation fixture HOME is not initialized");
      return fixture.home;
    },
  };
});

const raw: ChatMessage[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer", reasoning_content: "first reasoning" },
  { role: "user", content: "inspect synthetic data" },
  {
    role: "assistant",
    content: "",
    reasoning_content: "exact raw tool reasoning",
    tool_calls: [
      {
        id: "raw-call",
        type: "function",
        function: { name: "inspect", arguments: JSON.stringify({ detail: "exact raw arguments" }) },
      },
    ],
  },
  { role: "tool", tool_call_id: "raw-call", name: "inspect", content: "exact raw tool payload" },
  { role: "assistant", content: "inspection complete", reasoning_content: "exact final reasoning" },
  { role: "user", content: "roll this turn back" },
  { role: "assistant", content: "latest answer" },
];

function thin(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const { reasoning_content, ...row } = message;
    if (row.role === "tool") row.content = "[thin tool output]";
    if (row.tool_calls)
      row.tool_calls = row.tool_calls.map((call) => ({
        ...call,
        function: { ...call.function, arguments: "{}" },
      }));
    return row;
  });
}

describe("raw preservation during projected-history rollback", { retry: 0 }, () => {
  let home: string;
  let store: PersistentLoopSessionStorage | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-raw-preservation-"));
    fixture.home = home;
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(sessionPath("synthetic-raw-preservation")).toBe(
      join(home, ".jupiter", "sessions", "synthetic-raw-preservation.jsonl"),
    );
    rewriteSession("synthetic-raw-preservation", raw);
    store = new PersistentLoopSessionStorage("synthetic-raw-preservation");
    store.beginRules("synthetic stable rules");
  });
  afterEach(() => {
    store?.dispose();
    store = undefined;
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    fixture.home = undefined;
  });

  it("restores ordinary healed rows from exact raw sources when rolling back the tail", () => {
    store!.rewriteMessages(thin(store!.loadMessages()), "context");
    store!.rewriteMessages(store!.loadMessages().slice(0, 6), "history");
    expect(loadSessionMessages("synthetic-raw-preservation")).toEqual(raw.slice(0, 6));
    expect(readFileSync(sessionPath("synthetic-raw-preservation"), "utf8")).toBe(
      `${raw
        .slice(0, 6)
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
  });

  it("expands both semantic spans and ordinary healed rows without rewriting their tool content", () => {
    const before = store!.loadMessages();
    const summary: ChatMessage = { role: "assistant", content: "accepted semantic summary" };
    store!.rewriteMessages([summary, ...before.slice(2)], "context");
    expect(store!.recordFold({ before, head: before.slice(0, 2), summary })).toBe(true);
    store!.rewriteMessages(thin(store!.loadMessages()), "context");
    store!.rewriteMessages(store!.loadMessages().slice(0, -2), "history");
    expect(loadSessionMessages("synthetic-raw-preservation")).toEqual(raw.slice(0, 6));
  });

  it("rejects an unknown projected row before any raw rewrite instead of overwriting the kept base", () => {
    const before = readFileSync(sessionPath("synthetic-raw-preservation"));
    store!.rewriteMessages(
      [
        ...thin(store!.loadMessages()).slice(0, 6),
        { role: "assistant", content: "unmapped projection replacement" },
      ],
      "context",
    );
    expect(() => store!.rewriteMessages(store!.loadMessages(), "history")).toThrow(
      /unmapped|source/i,
    );
    expect(readFileSync(sessionPath("synthetic-raw-preservation"))).toEqual(before);
    expect(existsSync(`${sessionPath("synthetic-raw-preservation")}.bak`)).toBe(false);
  });

  it("continues to accept exact raw rows supplied by raw-based rollback callers", () => {
    store!.rewriteMessages(thin(store!.loadMessages()), "context");
    store!.rewriteMessages(raw.slice(0, 6), "history");
    expect(loadSessionMessages("synthetic-raw-preservation")).toEqual(raw.slice(0, 6));
  });

  it("reads original raw history even when the entire model projection is compacted", () => {
    const before = store!.loadMessages();
    const summary: ChatMessage = { role: "assistant", content: "entire history recap" };
    store!.rewriteMessages([summary], "context");
    expect(store!.recordFold({ before, head: before, summary })).toBe(true);
    expect(store!.loadMessages()).toEqual([summary]);
    const loaded = store!.loadRawMessages();
    expect(loaded).toEqual(raw);
    loaded[0]!.content = "caller-owned result";
    expect(store!.loadRawMessages()).toEqual(raw);
    const appended: ChatMessage = { role: "user", content: "new raw tail" };
    store!.appendMessage(appended);
    expect(store!.loadRawMessages()).toEqual([...raw, appended]);
  });
});

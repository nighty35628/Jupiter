import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopOpenTab,
  isDesktopConversationViewId,
  loadDesktopOpenTabs,
  readConfig,
  saveDesktopOpenTabs,
  writeConfig,
} from "../src/config.js";

describe("shared desktop tab configuration", { retry: 0 }, () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jupiter-shared-tabs-"));
    path = join(dir, "config.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(["valid\n", "valid\r\n", "../escape", "a/b", "a\\b", "", "with space", "视角"])(
    "rejects unsafe ID %j",
    (id) => expect(isDesktopConversationViewId(id)).toBe(false),
  );

  it.each(["123e4567-e89b-12d3-a456-426614174000", "view_1", "x".repeat(128)])(
    "accepts safe stable ID %j",
    (id) => expect(isDesktopConversationViewId(id)).toBe(true),
  );

  it("round-trips distinct views of the same workspace and session", () => {
    const tabs = [
      { dir: "/work", session: "shared", conversationViewId: "view-a" },
      { dir: "/work", session: "shared", conversationViewId: "view-b", active: true },
    ];
    saveDesktopOpenTabs(tabs, path);
    expect(loadDesktopOpenTabs(path)).toEqual(tabs);
  });

  it("validates persisted IDs without dropping or merging their tabs", () => {
    writeConfig(
      {
        desktopOpenTabs: [
          { dir: "/a", conversationViewId: "view-a" },
          { dir: "/a", conversationViewId: "view-a" },
          { dir: "/b", conversationViewId: "../escape" },
          { dir: "/c", conversationViewId: 42 },
          { dir: "/d", session: {}, active: "yes" },
        ] as unknown as DesktopOpenTab[],
      },
      path,
    );
    expect(loadDesktopOpenTabs(path)).toEqual([
      { dir: "/a", conversationViewId: "view-a" },
      { dir: "/a" },
      { dir: "/b" },
      { dir: "/c" },
      { dir: "/d" },
    ]);
  });

  it("preserves legacy formats and does not rewrite configuration on read", () => {
    writeConfig(
      { desktopOpenTabs: ["/a", { dir: "/b", session: "old" }] as DesktopOpenTab[] },
      path,
    );
    const before = readFileSync(path, "utf8");
    expect(loadDesktopOpenTabs(path)).toEqual([{ dir: "/a" }, { dir: "/b", session: "old" }]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("accepts a readonly mixture of legacy directories and objects on save", () => {
    const tabs = Object.freeze([
      "/legacy",
      Object.freeze({ dir: "/legacy", session: "same", conversationViewId: "view-one" }),
      Object.freeze({ dir: "/legacy", session: "same", conversationViewId: "view-two" }),
    ]);
    saveDesktopOpenTabs(tabs, path);
    expect(loadDesktopOpenTabs(path)).toEqual([
      { dir: "/legacy" },
      { dir: "/legacy", session: "same", conversationViewId: "view-one" },
      { dir: "/legacy", session: "same", conversationViewId: "view-two" },
    ]);
  });

  it("sanitizes duplicate and unsafe IDs on save and preserves other config", () => {
    writeConfig({ model: "synthetic-model" }, path);
    saveDesktopOpenTabs(
      [
        { dir: "/a", conversationViewId: "valid" },
        { dir: "/a", conversationViewId: "valid" },
        { dir: "/b", conversationViewId: "x".repeat(129) },
      ],
      path,
    );
    expect(readConfig(path).desktopOpenTabs).toEqual([
      { dir: "/a", conversationViewId: "valid" },
      { dir: "/a" },
      { dir: "/b" },
    ]);
    expect(readConfig(path).model).toBe("synthetic-model");
  });

  it("persists generated identities through restore, save, reload and reordering", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    writeConfig({ desktopOpenTabs: ["/work", "/work"] as unknown as DesktopOpenTab[] }, path);
    const plan = planDesktopTabRestore(loadDesktopOpenTabs(path));
    expect(new Set(plan.tabs.map((tab) => tab.conversationViewId)).size).toBe(2);
    saveDesktopOpenTabs(plan.tabs, path);
    const restored = planDesktopTabRestore(loadDesktopOpenTabs(path));
    expect(restored).toEqual(plan);
    saveDesktopOpenTabs([...restored.tabs].reverse(), path);
    expect(
      planDesktopTabRestore(loadDesktopOpenTabs(path)).tabs.map((tab) => tab.conversationViewId),
    ).toEqual([...restored.tabs].reverse().map((tab) => tab.conversationViewId));
  });

  it("repairs duplicate IDs once through the normal restore and persistence flow", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    writeConfig(
      {
        desktopOpenTabs: [
          { dir: "/work", session: "same", conversationViewId: "saved", active: true },
          { dir: "/work", session: "same", conversationViewId: "saved" },
          { dir: "/work", session: "same", conversationViewId: "../bad" },
        ],
      },
      path,
    );
    const plan = planDesktopTabRestore(loadDesktopOpenTabs(path));
    expect(plan.tabs[0].conversationViewId).toBe("saved");
    expect(new Set(plan.tabs.map((tab) => tab.conversationViewId)).size).toBe(3);
    saveDesktopOpenTabs(plan.tabs, path);
    expect(planDesktopTabRestore(loadDesktopOpenTabs(path))).toEqual(plan);
  });
});

describe("planDesktopTabRestore", { retry: 0 }, () => {
  const saved: DesktopOpenTab[] = [
    { dir: "/work/a", session: "a", conversationViewId: "view-a", active: true },
    { dir: "/work/b", session: "b", conversationViewId: "view-b" },
    { dir: "/work/c", session: "c", conversationViewId: "view-c" },
  ];

  it("focuses a non-first --dir match without duplicating or dropping any tab", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    const plan = planDesktopTabRestore(saved, "/work/b");
    expect(plan.tabs.map((tab) => tab.conversationViewId)).toEqual(["view-a", "view-b", "view-c"]);
    expect(plan.activeConversationViewId).toBe("view-b");
    expect(plan.tabs.filter((tab) => tab.active).map((tab) => tab.conversationViewId)).toEqual([
      "view-b",
    ]);
    expect(saved[0].active).toBe(true);
    expect(saved[1].active).toBeUndefined();
  });

  it("matches normalized paths and prefers an already-active matching view", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    const tabs = [
      { dir: "/work/a", session: "same", conversationViewId: "one" },
      { dir: "/work/b", conversationViewId: "other" },
      { dir: "/work/a/.", session: "same", conversationViewId: "two", active: true },
    ];
    const plan = planDesktopTabRestore(tabs, "/work/a/../a");
    expect(plan.tabs.map((tab) => tab.conversationViewId)).toEqual(["one", "other", "two"]);
    expect(plan.activeConversationViewId).toBe("two");
  });

  it("keeps all same-session views and uses the first match when none is active", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    const plan = planDesktopTabRestore(
      [
        { dir: "/work", session: "same", conversationViewId: "first" },
        { dir: "/work", session: "same", conversationViewId: "second" },
      ],
      "/work",
    );
    expect(plan.tabs).toHaveLength(2);
    expect(plan.activeConversationViewId).toBe("first");
  });

  it("adds an unmatched startup directory once and retains saved order", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    const plan = planDesktopTabRestore(saved, "/new");
    expect(plan.tabs.map((tab) => tab.dir)).toEqual([
      resolve("/new"),
      "/work/a",
      "/work/b",
      "/work/c",
    ]);
    expect(plan.activeConversationViewId).toBe(plan.tabs[0].conversationViewId);
    expect(plan.tabs.filter((tab) => tab.active)).toHaveLength(1);
    expect(planDesktopTabRestore(plan.tabs, "/new")).toEqual(plan);
  });

  it("does not change migrated saved identities when prepending a new startup workspace", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    const legacy = [
      { dir: "/work/a", session: "a" },
      { dir: "/work/b", session: "b" },
    ];
    const original = planDesktopTabRestore(legacy);
    const withStartup = planDesktopTabRestore(legacy, "/new");
    expect(withStartup.tabs.slice(1).map((tab) => tab.conversationViewId)).toEqual(
      original.tabs.map((tab) => tab.conversationViewId),
    );
    expect(withStartup.activeConversationViewId).toBe(withStartup.tabs[0].conversationViewId);
    expect(new Set(withStartup.tabs.map((tab) => tab.conversationViewId)).size).toBe(3);
  });

  it("matches Windows directory spelling without adding or merging views", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      const plan = planDesktopTabRestore(
        [
          { dir: "C:\\Elsewhere", conversationViewId: "other", active: true },
          { dir: "C:\\WORK\\App", session: "same", conversationViewId: "one" },
          { dir: "c:\\work\\app\\.", session: "same", conversationViewId: "two" },
        ],
        "c:/work/APP/",
      );
      expect(plan.tabs.map((tab) => tab.conversationViewId)).toEqual(["other", "one", "two"]);
      expect(plan.activeConversationViewId).toBe("one");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores saved focus, otherwise focuses the first tab", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    expect(planDesktopTabRestore([...saved].reverse()).activeConversationViewId).toBe("view-a");
    expect(
      planDesktopTabRestore(saved.map(({ active: _, ...tab }) => tab)).activeConversationViewId,
    ).toBe("view-a");
  });

  it("has deterministic safe unique IDs without taking IDs from later saved tabs", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    const legacy = [
      { dir: "/work", session: "same" },
      { dir: "/work", session: "same" },
    ];
    const first = planDesktopTabRestore(legacy);
    expect(planDesktopTabRestore(legacy)).toEqual(first);
    const reserved = first.tabs[0].conversationViewId;
    const plan = planDesktopTabRestore([
      ...legacy,
      { dir: "/work", conversationViewId: reserved },
      { dir: "/work", conversationViewId: reserved },
      { dir: "/work", conversationViewId: "bad/id" },
    ]);
    expect(plan.tabs[2].conversationViewId).toBe(reserved);
    expect(new Set(plan.tabs.map((tab) => tab.conversationViewId)).size).toBe(5);
    for (const tab of plan.tabs) {
      expect(tab.conversationViewId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
    }
  });

  it("handles empty state and a relative startup directory without filesystem access", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    expect(planDesktopTabRestore([])).toEqual({ tabs: [], activeConversationViewId: undefined });
    const plan = planDesktopTabRestore([], "relative-work");
    expect(plan.tabs).toHaveLength(1);
    expect(plan.tabs[0].dir).toBe(resolve("relative-work"));
    expect(plan.activeConversationViewId).toBe(plan.tabs[0].conversationViewId);
  });

  it("does not mutate frozen saved tabs when repairing identities and focus", async () => {
    const { planDesktopTabRestore } = await import("../src/desktop/tab-restore.js");
    const tabs = Object.freeze([
      Object.freeze({ dir: "/a", conversationViewId: "duplicate", active: true }),
      Object.freeze({ dir: "/b", conversationViewId: "duplicate", active: true }),
    ]);
    const plan = planDesktopTabRestore(tabs, "/b");
    expect(plan.tabs[0].active).toBeUndefined();
    expect(plan.tabs[1].active).toBe(true);
    expect(plan.tabs[0].conversationViewId).not.toBe(plan.tabs[1].conversationViewId);
    expect(tabs[0].active).toBe(true);
    expect(tabs[1].conversationViewId).toBe("duplicate");
  });
});

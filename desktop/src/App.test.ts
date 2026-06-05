import { describe, expect, it, vi } from "vitest";

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
  Toast: () => null,
  buildCommands: vi.fn(() => []),
  useCommandPalette: vi.fn(() => ({ open: false, setOpen: vi.fn() })),
}));
vi.mock("./Markdown", () => ({
  WorkspaceProvider: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("./theme", () => ({
  FONT_FAMILY: "sans-serif",
  FONT_FAMILY_STACK: "sans-serif",
  FONT_SCALE: 1,
  FONT_SCALE_ZOOM: 1,
  THEME: "dark",
  defaultStyleForTheme: vi.fn(() => ({
    bg: "#000",
    surface: "#111",
    border: "#222",
    text: "#fff",
    muted: "#888",
    accent: "#0af",
    danger: "#f00",
    warn: "#fa0",
    success: "#0f0",
    brand: "#0af",
  })),
  isFontFamily: vi.fn(() => true),
  isFontScale: vi.fn(() => true),
  isTheme: vi.fn(() => true),
  isThemeStyle: vi.fn(() => true),
  themeForStyle: vi.fn(() => "dark"),
}));

import {
  canRollbackMessage,
  chatMessageKey,
  pathToFileUrl,
  readWindowExpanded,
  reduce,
  rollbackTargetForMessage,
  shouldShowSettingsChangeToast,
  toggleWindowExpanded,
} from "./App";
import { getThreadMaxWidth, getVisibleContextWidth } from "./ui/thread-layout";

function initialState(): Parameters<typeof reduce>[0] {
  return {
    ready: false,
    needsSetup: false,
    busy: false,
    messages: [],
    pendingConfirms: [],
    pendingPathAccess: [],
    pendingChoices: [],
    pendingPlans: [],
    pendingCheckpoints: [],
    pendingRevisions: [],
    activePlan: null,
    usage: {
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      lastCallCacheHit: null,
      lastCallCacheMiss: null,
      reservedTokens: 0,
      liveLogTokens: 0,
    },
    sessions: [],
    externalImportSources: [],
    settings: null,
    qq: null,
    balance: null,
    mentionResults: null,
    mentionPreview: null,
    mcpSpecs: [],
    mcpBridged: false,
    subagents: [],
    skills: [],
    skillRoots: [],
    sessionFiles: [],
    memory: [],
    memoryDetail: null,
    jobs: [],
    activeSkill: null,
    queuedSends: [],
    sideChats: [],
    retryNonce: 0,
  };
}

function makeShellPrompt(
  command: string,
): import("@jupiter/core-utils").ApprovalPrompt {
  return {
    id: 1,
    kind: "shell",
    tone: "warn",
    title: "Run command",
    subtitle: command,
    preview: command,
    meta: {},
    actions: [
      { id: "run_once", label: "Run once", kind: "allow_once" },
      { id: "always_allow", label: "Always allow", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: command.split(" ")[0] ?? "" },
  };
}

function makePathPrompt(
  path: string,
  intent: "read" | "write",
): import("@jupiter/core-utils").ApprovalPrompt {
  return {
    id: 2,
    kind: "path",
    tone: "warn",
    title: `Access path — ${intent}`,
    subtitle: path,
    preview: `tool → ${path}`,
    meta: { sandboxRoot: "/workspace" },
    actions: [
      {
        id: "run_once",
        label: intent === "write" ? "Allow write" : "Allow read",
        kind: "allow_once",
      },
      { id: "always_allow", label: "Always allow", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: "/workspace", intent },
  };
}

describe("Desktop App reducer — usage", () => {
  it("uses stable transcript keys for virtualized message rendering", () => {
    expect(
      chatMessageKey(
        { kind: "user", text: "hello", clientId: "c-1", turn: 7 },
        0,
      ),
    ).toBe("user-c-1");
    expect(
      chatMessageKey(
        { kind: "assistant", turn: 7, segments: [], pending: false },
        1,
      ),
    ).toBe("assistant-7");
  });

  it("deduplicates local user message echoes by client id", () => {
    const base = initialState();
    const state = {
      ...base,
      busy: true,
      messages: [
        {
          kind: "user" as const,
          text: "make a ppt",
          clientId: "c-local",
          turn: 12,
        },
      ],
    };

    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "user.message",
        id: 99,
        ts: "2026-06-03T00:00:00.000Z",
        turn: 12,
        text: "make a ppt",
        clientId: "c-local",
      },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toEqual({
      kind: "user",
      text: "make a ppt",
      clientId: "c-local",
      turn: 12,
    });
  });

  it("keeps local command echoes from advancing conversation rollback turns", () => {
    const state = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "done" }],
          pending: false,
        },
      ],
    };

    const withCommand = reduce(state, {
      t: "send_user",
      text: "/undo",
      clientId: "slash-1",
      rollbackable: false,
    });

    expect(withCommand.messages.at(-1)).toMatchObject({
      kind: "user",
      turn: 1,
      rollbackable: false,
    });
    expect(canRollbackMessage(withCommand.messages, 2, false)).toBe(false);
    expect(canRollbackMessage(withCommand.messages, 1, false)).toBe(false);

    const withNextUser = reduce(
      { ...withCommand, busy: false },
      { t: "send_user", text: "next real prompt", clientId: "c-2" },
    );

    expect(withNextUser.messages.at(-1)).toMatchObject({
      kind: "user",
      turn: 2,
    });
  });

  it("computes rollback targets from conversation messages instead of stale UI turns", () => {
    const messages = [
      { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
      {
        kind: "assistant" as const,
        turn: 1,
        segments: [{ kind: "text" as const, text: "done" }],
        pending: false,
      },
      { kind: "user" as const, text: "/undo", clientId: "slash-1", turn: 2 },
      { kind: "user" as const, text: "second", clientId: "c-2", turn: 3 },
      {
        kind: "assistant" as const,
        turn: 3,
        segments: [{ kind: "text" as const, text: "done again" }],
        pending: false,
      },
    ];

    expect(rollbackTargetForMessage(messages, 3)).toEqual({
      turn: 2,
      role: "user",
    });
    expect(rollbackTargetForMessage(messages, 4)).toEqual({
      turn: 2,
      role: "assistant",
    });
    expect(rollbackTargetForMessage(messages, 2)).toBeNull();
  });

  it("encodes local html paths as file URLs for sidebar browser preview", () => {
    expect(pathToFileUrl("/Users/me/My Site/index #1.html")).toBe(
      "file:///Users/me/My%20Site/index%20%231.html",
    );
  });

  it("falls back prompt tokens to cache miss tokens when cache fields are absent", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "model.final",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "ok",
        usage: {
          prompt_tokens: 1234,
          completion_tokens: 56,
          total_tokens: 1290,
        },
        costUsd: 0.001,
      },
    });

    expect(next.usage.totalPromptTokens).toBe(1234);
    expect(next.usage.cacheHitTokens).toBe(0);
    expect(next.usage.cacheMissTokens).toBe(1234);
    expect(next.usage.lastCallCacheMiss).toBe(1234);
  });

  it("settles the pending assistant message when an error ends the turn (#1660)", () => {
    const base = initialState();
    const state = {
      ...base,
      busy: true,
      messages: [
        ...base.messages,
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "reasoning" as const, text: "thinking…" }],
          pending: true,
        },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        message: "SSE body read failed: terminated",
        recoverable: false,
      },
    });

    expect(next.busy).toBe(false);
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.pending).toBe(false);
    const error = next.messages.find((m) => m.kind === "error");
    expect(error?.message).toBe("SSE body read failed: terminated");
  });

  it("creates a pending assistant when a live delta arrives before turn started", () => {
    const next = reduce(initialState(), {
      t: "batch_delta",
      items: [
        { turn: 1, channel: "reasoning", text: "thinking" },
        { turn: 1, channel: "reasoning", text: "..." },
        { turn: 1, channel: "content", text: "hello" },
      ],
    });

    expect(next.busy).toBe(true);
    expect(next.messages).toEqual([
      {
        kind: "assistant",
        turn: 1,
        pending: true,
        segments: [
          { kind: "reasoning", text: "thinking..." },
          { kind: "text", text: "hello" },
        ],
      },
    ]);
  });

  it("keeps cumulative usage when live context breakdown refreshes", () => {
    const base = initialState();
    const next = reduce(
      {
        ...base,
        usage: {
          ...base.usage,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          totalPromptTokens: 100,
        },
      },
      {
        t: "incoming",
        event: { type: "$ctx_breakdown", reservedTokens: 10, logTokens: 42 },
      },
    );

    expect(next.usage.cacheHitTokens).toBe(80);
    expect(next.usage.cacheMissTokens).toBe(20);
    expect(next.usage.liveLogTokens).toBe(42);
  });
});

describe("Desktop App reducer — side chat", () => {
  it("renders sidebar btw answers without appending them to the main transcript", () => {
    const pending = reduce(initialState(), {
      t: "side_chat_sent",
      id: "side-1",
      question: "what is a closure?",
    });

    expect(pending.sideChats).toEqual([
      {
        id: "side-1",
        question: "what is a closure?",
        status: "pending",
      },
    ]);

    const answered = reduce(pending, {
      t: "incoming",
      event: {
        type: "$btw_result",
        clientId: "side-1",
        question: "what is a closure?",
        answer: "A closure captures variables from its outer scope.",
      },
    });

    expect(answered.messages).toHaveLength(0);
    expect(answered.sideChats).toEqual([
      {
        id: "side-1",
        question: "what is a closure?",
        answer: "A closure captures variables from its outer scope.",
        status: "done",
      },
    ]);
  });

  it("keeps normal /btw results in the main transcript", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$btw_result",
        question: "quick aside",
        answer: "short answer",
      },
    });

    expect(next.sideChats).toEqual([]);
    expect(next.messages).toEqual([
      { kind: "status", text: "≫ btw\nshort answer" },
    ]);
  });

  it("drops stale sidebar btw answers after their temporary chat is gone", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$btw_result",
        clientId: "side-stale",
        question: "stale",
        answer: "late answer",
      },
    });

    expect(next.sideChats).toEqual([]);
    expect(next.messages).toEqual([]);
  });
});

describe("Desktop App reducer — subagents", () => {
  it("tracks a child session and keeps later updates attached to the same parent session", () => {
    const state = { ...initialState(), currentSession: "desktop-parent" };
    const started = reduce(state, {
      t: "incoming",
      event: {
        type: "$subagent_event",
        kind: "start",
        runId: "sub-1",
        parentSession: "desktop-parent",
        sessionName: "subagent-sub-1-20260531120000",
        task: "Explore renderer",
        skillName: "explorer",
        model: "deepseek-v4-flash",
        iter: 0,
        elapsedMs: 0,
      },
    });
    const done = reduce(started, {
      t: "incoming",
      event: {
        type: "$subagent_event",
        kind: "end",
        runId: "sub-1",
        parentSession: "desktop-parent",
        sessionName: "subagent-sub-1-20260531120000",
        task: "Explore renderer",
        skillName: "explorer",
        elapsedMs: 2000,
        turns: 2,
      },
    });

    expect(done.subagents).toHaveLength(1);
    expect(done.subagents[0]).toMatchObject({
      runId: "sub-1",
      status: "done",
      parentSession: "desktop-parent",
      sessionName: "subagent-sub-1-20260531120000",
      task: "Explore renderer",
      skillName: "explorer",
      turns: 2,
      elapsedMs: 2000,
    });
  });

  it("ignores subagent events from a different parent session", () => {
    const state = { ...initialState(), currentSession: "desktop-current" };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$subagent_event",
        kind: "start",
        runId: "sub-old",
        parentSession: "desktop-old",
        sessionName: "subagent-sub-old",
        task: "old child",
      },
    });

    expect(next.subagents).toEqual([]);
  });
});

describe("Desktop App window controls", () => {
  it("treats macOS zoom state as fullscreen", async () => {
    const win = {
      isFullscreen: vi.fn(async () => true),
      isMaximized: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
    };

    await expect(readWindowExpanded(win, true)).resolves.toBe(true);
    expect(win.isFullscreen).toHaveBeenCalledTimes(1);
    expect(win.isMaximized).not.toHaveBeenCalled();
  });

  it("uses native fullscreen for macOS zoom button", async () => {
    const win = {
      isFullscreen: vi.fn(async () => false),
      isMaximized: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
    };

    await toggleWindowExpanded(win, true, false);
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
    expect(win.toggleMaximize).not.toHaveBeenCalled();
  });

  it("keeps maximize behavior off macOS", async () => {
    const win = {
      isFullscreen: vi.fn(async () => false),
      isMaximized: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
    };

    await toggleWindowExpanded(win, false, false);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.setFullscreen).not.toHaveBeenCalled();
  });
});

describe("Desktop App reducer — ApprovalPrompt integration", () => {
  it("stores shell confirm with prompt on $confirm_required", () => {
    const state = initialState();
    const prompt = makeShellPrompt("git status");
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$confirm_required",
        id: 7,
        kind: "run_command",
        command: "git status",
        prompt,
      },
    });
    expect(next.pendingConfirms).toHaveLength(1);
    expect(next.pendingConfirms[0]).toMatchObject({
      id: 7,
      kind: "run_command",
      command: "git status",
    });
    expect(next.pendingConfirms[0].prompt).toEqual(prompt);
  });

  it("stores path access with prompt on $path_access_required", () => {
    const state = initialState();
    const prompt = makePathPrompt("/etc/passwd", "read");
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$path_access_required",
        id: 8,
        path: "/etc/passwd",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/workspace",
        allowPrefix: "/workspace",
        prompt,
      },
    });
    expect(next.pendingPathAccess).toHaveLength(1);
    expect(next.pendingPathAccess[0]).toMatchObject({
      id: 8,
      path: "/etc/passwd",
      intent: "read",
    });
    expect(next.pendingPathAccess[0].prompt).toEqual(prompt);
  });

  it("removes confirm on resolve_confirm", () => {
    const prompt = makeShellPrompt("ls");
    const state = {
      ...initialState(),
      pendingConfirms: [
        { id: 1, kind: "run_command" as const, command: "ls", prompt },
        {
          id: 2,
          kind: "run_command" as const,
          command: "pwd",
          prompt: { ...prompt, id: 2, subtitle: "pwd" },
        },
      ],
    };
    const next = reduce(state, { t: "resolve_confirm", id: 1 });
    expect(next.pendingConfirms).toHaveLength(1);
    expect(next.pendingConfirms[0].id).toBe(2);
  });

  it("removes path access on resolve_path_access", () => {
    const prompt = makePathPrompt("/tmp", "write");
    const state = {
      ...initialState(),
      pendingPathAccess: [
        {
          id: 3,
          path: "/tmp",
          intent: "write" as const,
          toolName: "write_file",
          sandboxRoot: "/workspace",
          allowPrefix: "/workspace",
          prompt,
        },
      ],
    };
    const next = reduce(state, { t: "resolve_path_access", id: 3 });
    expect(next.pendingPathAccess).toHaveLength(0);
  });

  it("clears all pending on clear action", () => {
    const shellPrompt = makeShellPrompt("echo hi");
    const pathPrompt = makePathPrompt("/x", "read");
    const state = {
      ...initialState(),
      pendingConfirms: [
        {
          id: 1,
          kind: "run_command" as const,
          command: "echo hi",
          prompt: shellPrompt,
        },
      ],
      pendingPathAccess: [
        {
          id: 2,
          path: "/x",
          intent: "read" as const,
          toolName: "read_file",
          sandboxRoot: "/ws",
          allowPrefix: "/ws",
          prompt: pathPrompt,
        },
      ],
    };
    const next = reduce(state, { t: "clear" });
    expect(next.pendingConfirms).toHaveLength(0);
    expect(next.pendingPathAccess).toHaveLength(0);
  });

  it("patches settings optimistically for desktop setting commands", () => {
    const state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      settings: {
        reasoningEffort: "medium",
        editMode: "review",
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    };

    const next = reduce(state, {
      t: "settings_patch",
      patch: { reasoningEffort: "low", editMode: "auto" },
    });

    expect(next.settings?.reasoningEffort).toBe("low");
    expect(next.settings?.editMode).toBe("auto");
  });
});

describe("desktop thread layout", () => {
  it("recomputes the thread cap from the latest viewport width", () => {
    const side = 244;
    const ctx = 320;

    expect(
      getThreadMaxWidth({
        viewportWidth: 1000,
        visibleSide: side,
        visibleCtx: ctx,
      }),
    ).toBe(580);
    expect(
      getThreadMaxWidth({
        viewportWidth: 1400,
        visibleSide: side,
        visibleCtx: ctx,
      }),
    ).toBe(756);
    expect(
      getThreadMaxWidth({
        viewportWidth: 1800,
        visibleSide: side,
        visibleCtx: ctx,
      }),
    ).toBe(1120);
  });

  it("treats the context info panel as occupied right-side width", () => {
    expect(
      getVisibleContextWidth({
        ctxCollapsed: true,
        contextInfoOpen: false,
        ctxWidth: 318,
      }),
    ).toBe(0);
    expect(
      getVisibleContextWidth({
        ctxCollapsed: true,
        contextInfoOpen: true,
        ctxWidth: 318,
      }),
    ).toBe(318);
    expect(
      getVisibleContextWidth({
        ctxCollapsed: false,
        contextInfoOpen: false,
        ctxWidth: 318,
      }),
    ).toBe(318);
  });
});

describe("desktop message rollback availability", () => {
  it("allows rollback only for settled non-latest messages", () => {
    const messages = [
      { kind: "user" as const, text: "one", clientId: "u1", turn: 1 },
      {
        kind: "assistant" as const,
        turn: 1,
        segments: [{ kind: "text" as const, text: "done" }],
        pending: false,
      },
    ];

    expect(canRollbackMessage(messages, 0, false)).toBe(true);
    expect(canRollbackMessage(messages, 1, false)).toBe(false);
    expect(canRollbackMessage(messages, 0, true)).toBe(false);
  });

  it("preserves user turn numbers when loading a prior session", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "demo-session",
        messages: [
          { kind: "user", text: "first" },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "text", text: "done" }],
            pending: false,
          },
          { kind: "user", text: "second" },
          {
            kind: "assistant",
            turn: 2,
            segments: [{ kind: "text", text: "done again" }],
            pending: false,
          },
        ],
        carryover: {
          totalCostUsd: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });

    expect(next.messages).toMatchObject([
      { kind: "user", turn: 1 },
      { kind: "assistant", turn: 1 },
      { kind: "user", turn: 2 },
      { kind: "assistant", turn: 2 },
    ]);
  });
});

describe("settings change notifications", () => {
  it("suppresses right-bottom toast for settings-only changes", () => {
    expect(shouldShowSettingsChangeToast("model")).toBe(false);
    expect(shouldShowSettingsChangeToast("reasoningEffort")).toBe(false);
    expect(shouldShowSettingsChangeToast("editMode")).toBe(false);
    expect(shouldShowSettingsChangeToast("language")).toBe(false);
  });
});

describe("Desktop App reducer — queued sends", () => {
  it("moves a queued send to the front when prioritizing", () => {
    const next = reduce(
      { ...initialState(), queuedSends: ["first", "second", "third"] },
      { t: "prioritize_queued_send", index: 2 },
    );

    expect(next.queuedSends).toEqual(["third", "first", "second"]);
  });
});

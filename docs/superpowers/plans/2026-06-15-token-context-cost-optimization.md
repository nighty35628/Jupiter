# Token Context Cost Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jupiter's high fixed prompt cost visible and then reduce avoidable token spend without removing core coding-agent behavior.

**Architecture:** Extract context/token diagnostics from CLI-only UI code into a shared telemetry module, surface the detailed report only inside Settings, and add a lightweight Ask path for non-agent questions. Actual prompt reduction comes after measurement: first preserve global usage records and show top schema/tool-result contributors, then slim optional tool bundles and old tool-result retention based on measured hot spots.

**Tech Stack:** TypeScript, React desktop UI, existing `CacheFirstLoop`, `ToolRegistry`, `SessionStats`, Vitest, existing tokenizer helpers.

---

## Scope

Included:

- Settings-only context diagnostics under the existing Account/Billing usage area.
- Desktop usage logging parity with CLI.
- Shared context breakdown module reused by CLI and desktop.
- Lightweight Ask mode for simple non-agent questions.
- Conservative tool-result pruning and measured tool-schema slimming.

Excluded:

- No main-screen diagnostic card.
- No cache invalidation warning feature.
- No broad rewrite of the agent loop.
- No automatic hidden model router in the first implementation pass.

## File Structure

- Create `src/telemetry/context-diagnostics.ts`
  - Shared pure functions for token breakdown, memory/summary estimates, top tool-result hot spots, and cache summary formatting.
- Create `src/telemetry/context-diagnostics.test.ts`
  - Unit tests for category counts, top tool hot spots, memory/summary detection, and cache detail fields.
- Modify `src/cli/ui/ctx-breakdown.tsx`
  - Keep Ink rendering here, but import `computeContextDiagnostics()` instead of owning token accounting.
- Modify `src/cli/ui/slash/handlers/observability.ts`
  - Replace local `estimateMemoryTokens()` / `estimateSummaryTokens()` / detail assembly with shared telemetry helpers.
- Modify `desktop/src/protocol.ts`
  - Extend `$ctx_breakdown` with optional detailed fields and add `context_diagnostics_get` RPC.
- Modify `src/cli/commands/desktop.ts`
  - Emit detailed diagnostics for the active tab.
  - Append desktop turn usage to `~/.jupiter/usage.jsonl`.
  - Add lightweight Ask RPC handling.
- Modify `desktop/src/App.tsx`
  - Store diagnostics in app state and request refresh when Settings opens or Billing page is shown.
- Modify `desktop/src/ui/settings.tsx`
  - Render diagnostics inside the Account/Billing page below existing usage cards.
- Modify `desktop/src/i18n/en.ts`, `desktop/src/i18n/zh-CN.ts`, `desktop/src/i18n/ja.ts`, `desktop/src/i18n/de.ts`
  - Add labels for context diagnostics and Ask mode UI.
- Modify `desktop/src/ui/composer.tsx` and related App send plumbing only if a composer one-shot Ask toggle is chosen during execution.
- Modify `src/code/setup.ts`
  - Defer only clearly optional tool registrations after diagnostics prove their cost.
- Modify `src/loop.ts` or `src/context-manager.ts`
  - Add safe old tool-result pruning if existing compaction does not already cover the measured problem.

## Data Model

Use this shared shape for desktop and CLI:

```ts
export interface ContextDiagnostics {
  systemTokens: number;
  toolsTokens: number;
  logTokens: number;
  inputTokens: number;
  memoryTokens: number;
  summaryTokens: number;
  ctxMax: number;
  toolsCount: number;
  logMessages: number;
  topTools: Array<{ name: string; tokens: number; turn: number }>;
  lastPromptTokens: number;
  lastCacheHitTokens: number;
  lastCacheMissTokens: number;
  sessionCacheHitRatio: number;
  totalCostUsd: number;
  turns: number;
}
```

`inputTokens` remains `0` for current-session diagnostics unless estimating a draft prompt.

---

### Task 1: Shared Context Diagnostics

**Files:**

- Create: `src/telemetry/context-diagnostics.ts`
- Create: `src/telemetry/context-diagnostics.test.ts`
- Modify: `src/cli/ui/ctx-breakdown.tsx`
- Modify: `src/cli/ui/slash/handlers/observability.ts`

- [ ] **Step 1: Write failing tests**

Add tests that construct a minimal fake loop input with:

```ts
const input = {
  systemPrompt: [
    "# User memory",
    "prefers concise answers",
    "# Project memory",
    "Jupiter repo",
    "---",
    "normal system text",
  ].join("\n"),
  toolSpecs: [
    { type: "function", function: { name: "read_file", description: "Read files", parameters: { type: "object" } } },
    { type: "function", function: { name: "run_command", description: "Run commands", parameters: { type: "object" } } },
  ],
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "I will inspect it", tool_calls: [{ function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", name: "read_file", content: "large file output ".repeat(200) },
    { role: "assistant", content: "<<<JUPITER_COMPACTION_SUMMARY>>>\nsummary text" },
  ],
  model: "deepseek-v4-flash",
  stats: {
    turns: 1,
    totalCostUsd: 0.001,
    cacheHitRatio: 0.9,
    lastPromptTokens: 15000,
    lastCacheHitTokens: 14000,
    lastCacheMissTokens: 1000,
  },
};
```

Expected assertions:

- `systemTokens > 0`
- `toolsTokens > 0`
- `logTokens > 0`
- `memoryTokens > 0`
- `summaryTokens > 0`
- `topTools[0].name === "read_file"`
- `lastPromptTokens === 15000`
- `sessionCacheHitRatio === 0.9`

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm run test -- src/telemetry/context-diagnostics.test.ts
```

Expected: fails because `src/telemetry/context-diagnostics.ts` does not exist.

- [ ] **Step 3: Implement shared diagnostics**

Create `computeContextDiagnostics(input)` and `computeContextDiagnosticsFromLoop(loop)`.

Implementation requirements:

- Use `countTokensBounded`.
- Use `resolveContextTokens(model)`.
- Count tool schemas with `JSON.stringify(toolSpecs)`.
- Count user, assistant, assistant tool calls, and tool result messages separately, then expose their sum as `logTokens`.
- Detect memory blocks with the same regex currently used in `observability.ts`.
- Detect compaction summaries with `COMPACTION_SUMMARY_MARKER`.
- Sort `topTools` by descending result token count and keep 5 entries.

- [ ] **Step 4: Refactor CLI consumers**

Update `src/cli/ui/ctx-breakdown.tsx` so `computeCtxBreakdown(loop)` wraps `computeContextDiagnosticsFromLoop(loop)` and returns the current `CtxBreakdownData` shape.

Update `src/cli/ui/slash/handlers/observability.ts` so `/status detail` uses shared `memoryTokens`, `summaryTokens`, `topTools`, and cache fields instead of local duplicate helpers.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test -- src/telemetry/context-diagnostics.test.ts
npm run typecheck
```

Expected: both pass.

---

### Task 2: Desktop Settings Diagnostics

**Files:**

- Modify: `desktop/src/protocol.ts`
- Modify: `src/cli/commands/desktop.ts`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/ui/settings.tsx`
- Modify: `desktop/src/i18n/en.ts`
- Modify: `desktop/src/i18n/zh-CN.ts`
- Modify: `desktop/src/i18n/ja.ts`
- Modify: `desktop/src/i18n/de.ts`
- Test: `desktop/src/ui/settings.test.tsx`
- Test: `desktop/src/App.streaming.test.tsx`

- [ ] **Step 1: Write protocol and reducer tests**

Add a test that feeds `$ctx_breakdown` with:

```ts
{
  type: "$ctx_breakdown",
  reservedTokens: 14995,
  logTokens: 100,
  systemTokens: 5516,
  toolsTokens: 9479,
  memoryTokens: 300,
  summaryTokens: 0,
  toolsCount: 46,
  logMessages: 2,
  topTools: [{ name: "run_command", tokens: 430, turn: 1 }],
  lastPromptTokens: 15097,
  lastCacheHitTokens: 0,
  lastCacheMissTokens: 15097,
  sessionCacheHitRatio: 0,
  totalCostUsd: 0.002,
  turns: 1
}
```

Expected state:

- Existing `usage.reservedTokens` still updates.
- New diagnostics object is stored without breaking old `$ctx_breakdown` events.

- [ ] **Step 2: Extend protocol types**

Add optional fields to `CtxBreakdownEvent` rather than replacing the current fields. Add:

```ts
| { cmd: "context_diagnostics_get" }
```

to the desktop RPC command union.

- [ ] **Step 3: Emit detailed diagnostics from desktop backend**

Update `emitCtxBreakdown(tab)` in `src/cli/commands/desktop.ts`:

- Call `computeContextDiagnosticsFromLoop(tab.runtime.loop)`.
- Preserve `reservedTokens: systemTokens + toolsTokens`.
- Include all detailed optional fields.
- Keep existing fallback behavior if diagnostics throws.

Handle `context_diagnostics_get` by calling `emitCtxBreakdown(tab)`.

- [ ] **Step 4: Render Settings-only diagnostics**

In `PageBilling`, add a section below `.bill-grid`:

- Total prompt last turn.
- Cache hit/miss last turn.
- Session cache hit rate.
- Token mix: system, tools, log, memory, summary.
- Tool schema count.
- Top tool-result hot spots.

Do not render this in the main chat screen, sidebar, bottom bar, or status bar.

- [ ] **Step 5: Refresh diagnostics from Settings**

When Settings opens, send:

```ts
sendRpc({ cmd: "context_diagnostics_get" });
```

Optionally send again when the Billing page is selected. Avoid polling.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run test -- desktop/src/ui/settings.test.tsx desktop/src/App.streaming.test.tsx
npm run typecheck
```

Expected: settings renders the diagnostics and older `$ctx_breakdown` tests still pass.

---

### Task 3: Desktop Usage Log Parity

**Files:**

- Modify: `src/cli/commands/desktop.ts`
- Test: add or update desktop backend/event tests if present; otherwise add a pure helper test around the final-event handler.

- [ ] **Step 1: Identify final usage emission point**

Use the existing `model.final` handling path in `src/cli/commands/desktop.ts`. The append must happen once per completed main turn, not for intermediate tool iterations and not for subagent events already logged elsewhere.

- [ ] **Step 2: Append usage**

Import `appendUsage` from `src/telemetry/usage.ts` and call:

```ts
appendUsage({
  session: tab.currentSession ?? null,
  model: ev.stats.model,
  usage: ev.stats.usage,
});
```

Use the actual available final-event variables; if the event exposes model and usage under different names, map them directly. Keep it best-effort and do not block streaming or UI updates.

- [ ] **Step 3: Verify manually with a temp home**

Run a small desktop-command or backend-unit path with `HOME` pointed at a temp directory if feasible. If the desktop command cannot be isolated cheaply, add a helper function and unit-test the helper with a temp usage path.

Expected: one JSONL line is written for one completed desktop turn.

---

### Task 4: Lightweight Ask Mode

**Files:**

- Modify: `src/cli/commands/desktop.ts`
- Modify: `desktop/src/protocol.ts`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/ui/composer.tsx`
- Modify: `desktop/src/i18n/en.ts`
- Modify: `desktop/src/i18n/zh-CN.ts`
- Modify: `desktop/src/i18n/ja.ts`
- Modify: `desktop/src/i18n/de.ts`
- Test: `desktop/src/ui/composer-mode.test.tsx`
- Test: `desktop/src/App.streaming.test.tsx`

- [ ] **Step 1: Define behavior**

Ask mode is explicit and one-shot:

- User toggles Ask for the next send, or sends `/ask <question>`.
- Backend sends one model request with no tools and a short system prompt.
- It does not use `codeSystemPrompt()`.
- It does not include project files, memory, skills, library routing, or tool schemas.
- It may include recent user/assistant prose from the current UI transcript only if the current chat is already an Ask chat; for Agent chats, use only the current Ask text.
- The answer is appended visibly to the conversation, but no tools can run.
- After send, desktop composer returns to Agent mode.

- [ ] **Step 2: Add protocol**

Add:

```ts
| { cmd: "ask_light"; text: string }
```

or add a `mode: "agent" | "ask"` field to the existing send command. Prefer the smallest change that does not disturb normal agent send flow.

- [ ] **Step 3: Implement backend call**

Use `DeepSeekClient` directly with:

```ts
messages: [
  { role: "system", content: "You are Jupiter. Answer directly and concisely. Do not use tools. If the user asks you to inspect or modify files, tell them to use Agent mode." },
  { role: "user", content: text }
],
tools: []
```

Use the current selected model unless it is known to be expensive by default; if the codebase already has a low/flash default, use that.

- [ ] **Step 4: Add UI affordance**

Add a compact one-shot Ask control near the existing composer mode controls. It must be visually distinct from permission modes; do not put it inside Review/Auto/Full Control.

- [ ] **Step 5: Tests**

Tests should assert:

- Ask send dispatches `ask_light`, not normal agent send.
- Ask mode resets after send.
- Permission mode is unchanged.
- The model response appears in transcript.

Run:

```bash
npm run test -- desktop/src/ui/composer-mode.test.tsx desktop/src/App.streaming.test.tsx
npm run typecheck
```

---

### Task 5: Conservative Tool Schema Slimming

**Files:**

- Modify: `src/code/setup.ts`
- Modify: relevant tool registration files under `src/tools/`
- Test: existing tool registration tests or new `src/code/setup-tool-budget.test.ts`

- [ ] **Step 1: Add schema budget test**

Create a test that builds the code toolset and records:

- total tool count
- total schema token estimate
- top 10 tool schemas by token count

The test should not fail on a fixed absolute token number. It should fail only if required core tools disappear.

- [ ] **Step 2: Remove tools from default registration only when safe**

Apply these safe rules:

- If web search is disabled, keep current behavior: do not register web tools.
- If Java source is disabled, keep current behavior: do not register Java source.
- If library retrieval is `off`, do not register `library_search` / `library_read` for the model.
- Keep filesystem, shell, plan, todo, choice, open URL, memory, and code query tools in Agent mode.

- [ ] **Step 3: Slim verbose descriptions**

Only edit descriptions that diagnostics show as top contributors. Preserve behavioral constraints in system prompt or tool implementation when possible.

- [ ] **Step 4: Verify no capability regression**

Run:

```bash
npm run test -- src/code/setup-tool-budget.test.ts
npm run test -- src/tools
npm run typecheck
```

Expected: core tools remain registered and schema token estimate does not increase.

---

### Task 6: Old Tool Result Pruning

**Files:**

- Modify: `src/context-manager.ts` or `src/loop.ts`
- Test: existing context-manager tests or new `src/context-manager.tool-pruning.test.ts`

- [ ] **Step 1: Confirm existing compaction boundary**

Before editing, inspect whether `ContextManager` already prunes old tool results before building messages. If it already does, add diagnostics to show pruned bytes/tokens instead of duplicating the feature.

- [ ] **Step 2: Write failing test**

Construct a log with:

- Recent user turn.
- Old assistant tool call.
- Old tool result over the configured threshold.

Expected after pruning:

- Tool-call pairing remains valid.
- Recent turn is untouched.
- Old large tool result becomes a short marker.
- Full transcript on disk is not deleted.

- [ ] **Step 3: Implement pruning**

Apply pruning only to model-bound messages, not persisted session files. Use a marker like:

```text
[old tool result elided from model context; full output remains in the session log]
```

Do not prune pending tool calls, approval waits, or the current turn.

- [ ] **Step 4: Verify**

Run:

```bash
npm run test -- src/context-manager.tool-pruning.test.ts
npm run typecheck
```

Expected: pairing tests pass and old logs shrink in model-bound context.

---

## Acceptance Criteria

- Settings Account/Billing page shows context diagnostics; main chat UI does not.
- A “你好” sent through Ask mode does not build full code tool schemas.
- A normal Agent task still has filesystem, shell, git/code, memory, and planning capabilities.
- Desktop turns append usage to `~/.jupiter/usage.jsonl`.
- `/context` and `/status detail` still work in CLI.
- Diagnostics show enough detail to explain a 15k prompt: system, tools, log, memory, summary, cache hit/miss, and top tool hot spots.
- No cache invalidation warning is implemented.

## Verification Commands

Run after implementation:

```bash
npm run test -- src/telemetry/context-diagnostics.test.ts
npm run test -- desktop/src/ui/settings.test.tsx desktop/src/App.streaming.test.tsx
npm run test -- desktop/src/ui/composer-mode.test.tsx
npm run typecheck
```

If tool slimming or pruning is implemented in the same branch, also run:

```bash
npm run test -- src/tools
npm run test -- src/context-manager.tool-pruning.test.ts
```

## Implementation Order

1. Task 1 and Task 2 first: observability must land before optimization.
2. Task 3 next: usage records must match what Settings reports.
3. Task 4 next: immediate practical cost reduction for non-agent questions.
4. Task 5 only after diagnostics show which schemas dominate.
5. Task 6 only if logs/tool outputs dominate after real use.

## Self-Review

- Spec coverage: settings-only diagnostics, no main UI, no cache invalidation warning, lightweight Ask, schema slimming, and pruning are all covered.
- Placeholder scan: no task depends on unspecified “later” behavior; optional decisions are guarded by measured diagnostics.
- Type consistency: `ContextDiagnostics` is the shared type across telemetry, protocol, App state, and Settings rendering.

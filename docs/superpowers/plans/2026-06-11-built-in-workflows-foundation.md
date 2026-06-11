# Built-in Workflows Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first executable workflow foundation: shared catalog/types, local run store, mockable runner, CLI workflow commands, and reusable workflow cards.

**Architecture:** Add a shared `src/workflows/` module used by both CLI and desktop. The first runner is deterministic and mockable so the UI and command surfaces can be tested before real multi-agent execution is wired. Desktop gets a reusable Workflow Run Card component; CLI gets slash commands and an Ink card type backed by the same run model.

**Tech Stack:** TypeScript, Vitest, React/Ink for CLI, React DOM for desktop, Node filesystem APIs.

---

### Task 1: Shared Workflow Types And Catalog

**Files:**
- Create: `src/workflows/types.ts`
- Create: `src/workflows/catalog.ts`
- Create: `src/workflows/index.ts`
- Test: `tests/workflow-catalog.test.ts`

- [ ] **Step 1: Write failing catalog tests**

Create `tests/workflow-catalog.test.ts` with assertions that the catalog contains exactly the 12 first-version workflow ids, each id is unique, every workflow has permissions, phases, and valid trigger hints, and custom workflow authoring is not represented.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test -- tests/workflow-catalog.test.ts`
Expected: FAIL because `src/workflows/catalog.ts` does not exist.

- [ ] **Step 3: Add workflow types and catalog**

Create `src/workflows/types.ts` with `WorkflowTemplate`, `WorkflowPermissions`, `WorkflowPhaseTemplate`, `WorkflowTriggerHint`, `WorkflowRun`, `WorkflowAgentRun`, `WorkflowTokenUsage`, and `WorkflowSource`.

Create `src/workflows/catalog.ts` exporting the 12 templates from the design spec.

Create `src/workflows/index.ts` as the public barrel.

- [ ] **Step 4: Run test to verify GREEN**

Run: `npm test -- tests/workflow-catalog.test.ts`
Expected: PASS.

### Task 2: Local Workflow Store

**Files:**
- Create: `src/workflows/store.ts`
- Test: `tests/workflow-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Create tests for creating a run, updating it, listing recent runs, preserving partial failed runs, and reading a missing run as `null`.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test -- tests/workflow-store.test.ts`
Expected: FAIL because `createWorkflowStore` does not exist.

- [ ] **Step 3: Add JSON-file workflow store**

Implement a per-root file store under `.jupiter/workflows/runs.json`. The store should expose `createRun`, `updateRun`, `getRun`, and `listRuns`.

- [ ] **Step 4: Run test to verify GREEN**

Run: `npm test -- tests/workflow-store.test.ts`
Expected: PASS.

### Task 3: Runner And Event Stream

**Files:**
- Create: `src/workflows/runner.ts`
- Test: `tests/workflow-runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Create tests proving that a mock workflow emits `workflow_started`, `workflow_phase_changed`, `workflow_agent_started`, `workflow_agent_completed`, `workflow_token_usage`, and `workflow_completed`, and that cancellation persists a canceled run.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test -- tests/workflow-runner.test.ts`
Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement deterministic runner**

Implement `runWorkflow` with mockable `executeAgent` injection. The runner should persist state through the store and aggregate token usage from agent results.

- [ ] **Step 4: Run test to verify GREEN**

Run: `npm test -- tests/workflow-runner.test.ts`
Expected: PASS.

### Task 4: CLI Slash Commands And Card

**Files:**
- Modify: `src/cli/ui/slash/commands.ts`
- Modify: `src/cli/ui/slash/dispatch.ts`
- Modify: `src/cli/ui/slash/types.ts`
- Create: `src/cli/ui/slash/handlers/workflows.ts`
- Modify: `src/cli/ui/state/cards.ts`
- Modify: `src/cli/ui/cards/CardRenderer.tsx`
- Create: `src/cli/ui/cards/WorkflowCard.tsx`
- Test: `tests/workflow-slash.test.ts`

- [ ] **Step 1: Write failing slash tests**

Test `/workflows`, `/workflow status`, `/workflow open <id>`, and `/workflow cancel <id>` with a temp workflow store.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test -- tests/workflow-slash.test.ts`
Expected: FAIL because workflow slash handlers are not registered.

- [ ] **Step 3: Implement CLI commands**

Add command specs and handlers. The first version lists templates and stored runs; actual start can be a deterministic local mock run for one template until real agent execution is added.

- [ ] **Step 4: Add CLI workflow card**

Add `WorkflowCard` and the `workflow` card kind so CLI can render run status, phase, token usage, subagent counts, and recent log.

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/workflow-slash.test.ts`
Expected: PASS.

### Task 5: Desktop Workflow Run Card Component

**Files:**
- Modify: `desktop/src/ui/cards.tsx`
- Modify: `desktop/src/i18n/en.ts`
- Modify: `desktop/src/i18n/zh-CN.ts`
- Modify: `desktop/src/i18n/ja.ts`
- Modify: `desktop/src/i18n/de.ts`
- Modify: `desktop/src/styles.css`
- Test: `desktop/src/ui/workflow-card.test.tsx`

- [ ] **Step 1: Write failing desktop card tests**

Test collapsed rendering, expanded rendering, running state, token usage, subagent counts, source counts, and cancel callback.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm --prefix desktop exec vitest run src/ui/workflow-card.test.tsx`
Expected: FAIL because `WorkflowRunCard` does not exist.

- [ ] **Step 3: Implement reusable desktop card**

Add `WorkflowRunCard` to `desktop/src/ui/cards.tsx` using the existing `Card` shell and styling tokens.

- [ ] **Step 4: Run test to verify GREEN**

Run: `npm --prefix desktop exec vitest run src/ui/workflow-card.test.tsx`
Expected: PASS.

### Task 6: Verification

**Files:**
- All files from Tasks 1-5.

- [ ] **Step 1: Run focused tests**

Run: `npm test -- tests/workflow-catalog.test.ts tests/workflow-store.test.ts tests/workflow-runner.test.ts tests/workflow-slash.test.ts`
Expected: PASS.

- [ ] **Step 2: Run desktop focused test**

Run: `npm --prefix desktop exec vitest run src/ui/workflow-card.test.tsx`
Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run diff check**

Run: `git diff --check`
Expected: PASS.

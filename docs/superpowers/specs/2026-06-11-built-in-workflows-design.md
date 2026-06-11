# Built-in Workflows Design

## Summary

Jupiter should add a built-in workflow system for longer research, review, and engineering tasks that benefit from multiple focused agents, structured outputs, and background execution. The first version only ships official templates maintained by Jupiter. It does not expose custom JavaScript, custom DSLs, or user-authored workflow definitions.

The system should make workflows visible as first-class runs: when a workflow is active, the chat shows a live Workflow Run Card with the workflow name, phase, token usage, active subagent count, recent logs, and actions such as cancel, expand, save, or insert result.

## Goals

- Provide reusable multi-agent workflows for high-value tasks where normal chat is too unstructured.
- Keep the first version predictable, testable, and safe by shipping only built-in templates.
- Share the workflow catalog and runner behavior between desktop and CLI.
- Show live progress, token usage, and subagent status while workflows run.
- Save workflow runs and results so users can inspect them later.
- Allow workflow results to be inserted into the current conversation or saved into the workspace library.
- Suggest workflows for likely tasks without automatically starting expensive background work by default.

## Non-Goals

- No custom user-authored workflow JavaScript.
- No custom workflow DSL in the first version.
- No marketplace or remote workflow registry.
- No automatic write operations unless a built-in workflow explicitly asks for confirmation.
- No full replacement for normal chat, slash commands, plan mode, or existing tools.
- No first-version implementation of every brainstormed workflow idea.

## First-Version Workflow Catalog

The first version should include 12 workflows. These were selected because they have clear inputs, predictable outputs, and useful results without requiring extensive manual UI testing.

### Research And Decision Workflows

1. **Deep Fact Check**
   - Purpose: Verify facts across web pages, official docs, papers, and repositories.
   - Output: Conclusion, key facts, sources, caveats, confidence, and open questions.

2. **Paper Direction Validation**
   - Purpose: Validate data availability, baselines, novelty gaps, evaluation protocols, and publication risk for a research direction.
   - Output: Direction verdict, dataset table, baseline table, literature gap analysis, evaluation requirements, and risks.

3. **Open Source Project Selection**
   - Purpose: Compare candidate repositories or libraries before integration.
   - Output: License, maintenance, ecosystem, API stability, integration cost, alternatives, and recommendation.

4. **Technical Route Feasibility Review**
   - Purpose: Evaluate a technical route such as adding Chromium, choosing an SDK, or changing a build target.
   - Output: Cost, compatibility, dependency risk, implementation path, rollback plan, and recommendation.

### Engineering Workflows

5. **Code Change Plan Review**
   - Purpose: Review a proposed code change before implementation.
   - Output: Architecture impact, touched modules, test strategy, risk list, and implementation plan outline.

6. **PR Or Working Tree Review**
   - Purpose: Review staged, unstaged, or PR changes.
   - Output: Findings ordered by severity, file references, missing tests, regression risks, and summary.

7. **Dependency And License Audit**
   - Purpose: Audit dependencies for license compatibility, package size, maintenance, security, and supply-chain risk.
   - Output: Dependency table, license findings, risk ranking, and allowed/blocked recommendation.

8. **Release Readiness Check**
   - Purpose: Check versioning, changelog, release workflow, artifacts, packaging, and blockers before release.
   - Output: Release checklist, failed checks, warnings, and required fixes.

9. **Cross-Platform Compatibility Review**
   - Purpose: Check macOS, Windows, Linux, ARM, glibc, Tauri, WebKitGTK, and permission compatibility.
   - Output: Platform matrix, known gaps, required build changes, and compatibility target.

10. **Bug Reproduction Workflow**
    - Purpose: Turn a bug report into a reproducible diagnosis plan.
    - Output: Suspected area, reproduction steps, relevant files, likely causes, suggested tests, and next fix.

11. **Workspace Health Check**
    - Purpose: Inspect the current workspace for project hygiene.
    - Output: README, scripts, tests, CI, license, release, dependency, and documentation checklist.

12. **Decision Record Generator**
    - Purpose: Generate an ADR from a conversation, diff, or implementation decision.
    - Output: Context, decision, alternatives, consequences, risks, and follow-ups.

## Deferred Workflow Ideas

The following ideas should not enter the first-version catalog because their value depends on later library, memory, UI, or document-generation maturity:

- Library auto-organization
- Long-form paper or article writing assistant
- PPT pre-generation research
- Competitor analysis
- UI walkthrough
- Workspace memory organization
- Session continuation summary
- External conversation import cleanup
- Library ingestion recommendation
- Automatic knowledge cards

These can be revisited after the built-in workflow runner, run storage, and Workflow Run Card are stable.

## Workflow Template Model

Each built-in workflow should be defined as a typed template:

```ts
type WorkflowTemplate = {
  id: string;
  title: string;
  description: string;
  category: "research" | "engineering" | "workspace";
  version: number;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permissions: WorkflowPermissions;
  phases: WorkflowPhaseTemplate[];
  suggestedTriggers: WorkflowTriggerHint[];
};

type WorkflowPermissions = {
  allowNetwork: boolean;
  allowWorkspaceRead: boolean;
  allowLibraryRead: boolean;
  allowLibraryWrite: boolean;
  allowFileWrite: boolean;
  requiresApprovalBeforeWrite: boolean;
};
```

Templates should live in shared source so both desktop and CLI can list and start the same workflows. Templates are code, not user-editable data.

## Workflow Runner

The runner should execute a workflow as a persistent run with structured events. A run can contain sequential phases and parallel subagent groups.

The runner is responsible for:

- Creating a run record.
- Emitting lifecycle events.
- Starting subagents.
- Tracking token usage per run and per subagent.
- Validating structured outputs against schemas.
- Retrying schema or transient failures within a small bounded limit.
- Supporting cancellation.
- Producing a final synthesized report.
- Persisting partial results when a run fails or is canceled.

## Workflow Run Data Model

```ts
type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  title: string;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "canceled";
  phase: string | null;
  input: unknown;
  startedAt: string;
  completedAt?: string;
  tokenUsage: WorkflowTokenUsage;
  agents: WorkflowAgentRun[];
  logs: WorkflowLogEntry[];
  sources: WorkflowSource[];
  result?: unknown;
  error?: string;
};

type WorkflowAgentRun = {
  id: string;
  label: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  phase: string;
  summary?: string;
  tokenUsage: WorkflowTokenUsage;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

type WorkflowTokenUsage = {
  prompt: number;
  completion: number;
  total: number;
};
```

If a model provider only reports total usage, Jupiter should show total and leave prompt/completion unknown internally until better data is available.

## Workflow Events

Desktop should update the run card from events instead of waiting for the final result.

Required events:

- `workflow_started`
- `workflow_phase_changed`
- `workflow_log`
- `workflow_agent_started`
- `workflow_agent_updated`
- `workflow_agent_completed`
- `workflow_token_usage`
- `workflow_waiting_approval`
- `workflow_completed`
- `workflow_failed`
- `workflow_canceled`

The CLI can render the same event stream as status rows and summaries.

## Workflow Run Card

When a workflow is running, the current conversation should show a live card. This card is the primary workflow UI, not decorative status chrome.

Collapsed state should show:

- Workflow title.
- Current phase.
- Status.
- Running, completed, and failed subagent counts.
- Total token usage.
- Elapsed time.
- Most recent log line.
- Source count if available.
- Cancel button.
- Expand button.

Expanded state should show:

- Phase timeline.
- Subagent status list.
- Token usage per subagent.
- Recent logs.
- Source list.
- Retry or schema validation warnings.
- Final result when available.
- Actions: save to library, insert into conversation, export Markdown, copy result.

The right context panel can later add a Workflows module listing all runs in the current workspace. The first version only needs the chat card plus a minimal history view if the store requires inspection.

## Trigger Behavior

Workflow triggering should be conservative.

Default setting:

- `suggest`: Jupiter suggests a workflow when a task appears to match, but does not start it automatically.

Settings:

- `off`: never suggest or auto-start.
- `suggest`: suggest matching workflows. This is the default.
- `explicit`: start only when the user explicitly asks for a workflow.

The first version should not include fully automatic expensive workflow startup. Explicit user phrases such as "run a release check workflow", "use workflow to research this", or "start dependency audit" may start directly.

Intent detection should be model-based rather than keyword-only. The classifier should return:

```ts
type WorkflowIntent = {
  shouldSuggest: boolean;
  shouldStart: boolean;
  workflowId?: string;
  confidence: number;
  reason: string;
  estimatedCost: "low" | "medium" | "high";
};
```

If estimated cost is medium or high, the user should see the workflow suggestion before the run starts unless the user explicitly requested it.

## Desktop UX

Entry points:

- Command palette: search and start workflows.
- Composer suggestion: show a lightweight suggestion when intent detection matches.
- Contextual panels: review and release workflows can appear near Git/review surfaces later.

Run display:

- The workflow card appears in the current conversation.
- Running cards update live.
- Completed cards remain inspectable.
- Failed cards preserve partial outputs and errors.

Actions:

- Cancel running workflow.
- Save final report to library.
- Insert final report into the current conversation.
- Copy or export final report as Markdown.

## CLI UX

The CLI should expose the same catalog and runner:

- `/workflows` lists built-in workflows.
- `/workflow <id>` starts a workflow.
- `/workflow status` lists recent and running runs.
- `/workflow open <run-id>` shows a stored run.
- `/workflow cancel <run-id>` cancels a running workflow.

CLI rendering should show phase, subagent counts, elapsed time, token usage, and the final report.

## Storage

Workflow runs should be stored per workspace. The store should support:

- Running run snapshots.
- Completed run history.
- Failed and canceled partial results.
- Result lookup by run id.
- Later cleanup by storage-management tools.

The storage format should be append-friendly so live events can update the UI without rewriting large files.

## Permissions And Safety

Every workflow template must declare permissions. The runner must enforce them.

- Network access is allowed only for templates that declare it.
- Workspace reads are allowed only for templates that declare them.
- File writes require explicit approval unless the template is a safe built-in export path.
- Library writes should be explicit user actions from the result card.
- No user-authored workflow code is executed.
- No workflow should silently modify source files.

## Error Handling

The runner should support:

- Partial completion when one subagent fails.
- Bounded retry for transient failures or schema mismatch.
- Clear failed-state card with error detail.
- Cancellation that stops new subagents and requests active subagents to stop.
- Final synthesis that includes caveats when some checks failed.

## Testing Strategy

Unit tests:

- Catalog contains only approved built-in workflows.
- Each workflow has valid ids, schemas, permissions, and phases.
- Intent classifier routing respects settings.
- Runner emits ordered lifecycle events.
- Token usage aggregates from subagents into the parent run.
- Canceled and failed runs persist partial state.

Desktop tests:

- Workflow Run Card renders collapsed and expanded states.
- Live events update phase, token usage, and subagent counts.
- Cancel action calls the workflow cancel handler.
- Completed result actions are visible.

CLI tests:

- `/workflows` lists catalog entries.
- `/workflow status` renders running and completed runs.
- `/workflow cancel` invokes cancellation.

Integration tests:

- One small built-in workflow runs end-to-end with mocked agents.
- One parallel workflow aggregates multiple subagent outputs and produces synthesis.

## Implementation Batches

### Batch 0: Foundation

- Shared workflow catalog types.
- Shared run and event types.
- Local workflow store.
- Runner with mocked agent execution for tests.
- Workflow Run Card.
- CLI list/status/open/cancel command skeleton.
- One minimal workflow template for end-to-end validation.

### Batch 1: Research Workflows

- Deep Fact Check.
- Open Source Project Selection.
- Technical Route Feasibility Review.
- Live source and caveat display.

### Batch 2: Engineering Review Workflows

- Code Change Plan Review.
- PR Or Working Tree Review.
- Bug Reproduction Workflow.

### Batch 3: Release And Compatibility Workflows

- Dependency And License Audit.
- Release Readiness Check.
- Cross-Platform Compatibility Review.
- Workspace Health Check.

### Batch 4: Specialized Outputs

- Paper Direction Validation.
- Decision Record Generator.
- Markdown export and library save polish.

## Acceptance Criteria

- Jupiter ships a built-in workflow catalog with 12 enabled templates.
- No custom workflow authoring is exposed.
- Starting a workflow creates a persisted run.
- Running workflows show a live Workflow Run Card in the chat.
- The card updates phase, token usage, subagent counts, logs, and final result.
- Users can cancel running workflows.
- Completed workflow results can be inserted into the conversation or saved to the library.
- CLI and desktop share the same workflow catalog.
- Default behavior suggests workflows but does not auto-start expensive runs.
- Tests cover catalog validation, event updates, run persistence, desktop card rendering, and CLI commands.

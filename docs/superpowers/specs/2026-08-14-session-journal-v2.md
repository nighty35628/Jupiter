# Session Persistence V2: Tool Execution Journal

Status: implemented MVP, broader transaction work remains proposed.

## Problem

The chat transcript records assistant tool calls and their eventual tool messages, but it cannot
distinguish these crash windows:

1. Jupiter accepted a tool call but never entered the tool implementation.
2. The tool implementation started and Jupiter crashed before recording a result.
3. The tool returned, but the transcript result was not committed before restart.

Treating all three cases as retryable can repeat side effects. Treating all three as completed can
hide work that never ran.

## MVP Contract

Each persisted session has a sibling `.tool-executions.v2.journal` file. Records are JSON lines with
these common fields:

- `version`: literal `2`
- `sessionId`: stable identity from session metadata, preserved across title renames
- `seq`: monotonically increasing journal order
- `runId`: process/runtime instance that wrote the record
- `executionId`: unique invocation identity
- `turn`, `callId`, `toolName`

Arguments and results are represented only by SHA-256 digests. The journal does not retain raw
tool payloads or credentials.

Every invocation follows one of these state paths:

```text
intent -> result(blocked/rejected/interrupted)
intent -> execution_started -> result(returned)
intent -> execution_started -> result(unknown_after_restart)
```

`execution_started` is durably flushed immediately before control enters the tool implementation.
If that flush fails, the implementation is not called. A result record is flushed immediately after
dispatch returns and before post-tool hooks run.

## Restart Rules

On session load:

- `intent` without a result becomes `interrupted_before_execution`.
- `execution_started` without a result becomes `unknown_after_restart`.
- Recovery writes a terminal result once, so repeated restarts are idempotent.
- A dangling transcript tool call is completed with a synthetic tool result derived from the
  journal. Unknown or already-returned side effects explicitly say not to retry automatically.
- Corrupt JSON lines and a partial final line are ignored. The partial tail is truncated before the
  next append so sequence progression remains valid.

The journal is renamed, archived, and deleted with the transcript sidecars. Automatic title changes
retain the same session identity. A genuinely new session receives a new identity.

## Failure Policy

- If the intent cannot be persisted, the tool is not run.
- If the execution-start record cannot be persisted, the tool is not run.
- If the result cannot be persisted after execution began, the model receives an explicit
  `outcome: unknown` result and is told not to retry automatically.
- Ephemeral loops without a session remain outside this persistence contract.

## Deferred Work

This MVP does not turn the existing chat JSONL, typed event log, metadata, compaction rewrite, and
subagent logs into one transaction system. A later phase should add:

1. A single per-session writer that serializes transcript, event, metadata, and journal commits.
2. Transaction IDs for compaction (`prepare`, replacement snapshot, atomic swap, `commit`) with
   deterministic rollback after interruption.
3. Parent/child lineage and terminal state records for subagents.
4. Journal compaction or checkpoint records for very long sessions.
5. Process-level crash and kill tests on macOS, Windows, and Linux filesystems.
6. OS sandbox enforcement as a separate security project. The journal records outcomes; it is not
   a sandbox.

These items should not be implemented by extending the legacy `.events.jsonl` diagnostic stream in
place. They require an explicit versioned migration and compatibility plan.

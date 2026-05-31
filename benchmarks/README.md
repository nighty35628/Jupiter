# Benchmarks

This is where validation lives. The v0.1 milestone gates on a reproducible
tool-use eval that compares, on the same tasks:

1. **Baseline** — a deliberately cache-hostile agent (fresh timestamp +
   shuffled tool spec each turn), representative of how generic frameworks
   wire up DeepSeek.
2. **Jupiter** — the same tools and system prompt, driven through
   `CacheFirstLoop` so the byte prefix stays stable turn-over-turn.

Both modes share the same `DeepSeekClient`, so the *only* meaningful
difference is prefix stability — any cache-hit / cost gap is attributable to
Pillar 1 of the architecture, nothing else.

## Scope — this is τ-bench-*lite*

We don't ship a full port of [Sierra's τ-bench](https://github.com/sierra-research/tau-bench)
(airline + retail, Python). Instead:

- `tau-bench/tasks.ts` hand-authors 8 retail-flavored multi-turn tasks
  that exercise tool use, identity verification, refusal, and mid-conversation
  goal change.
- The task schema (`tau-bench/types.ts`) mirrors τ-bench's shape — stateful
  tools, an LLM user simulator, end-state DB predicates — so real upstream
  tasks can later drop in without harness changes.
- All success predicates are **deterministic DB checks**, not LLM judges.
  Refusal tasks pass iff the DB is unchanged.

## Files

```
tau-bench/
├── types.ts       — TaskDefinition / RunResult / BenchReport shapes
├── db.ts          — tiny in-memory WorldState + cloneDb
├── tasks.ts       — the 8 seed tasks + shared tool factories
├── user-sim.ts    — LLM user simulator (V3, T=0.1)
├── baseline.ts    — naive cache-hostile agent runner
├── runner.ts      — orchestrates user-sim × agent × task × mode
└── report.ts      — turns a results-*.json into a report.md
```

## Quickstart

```bash
# dry-run: no API calls, just validate the harness is wired up
npx tsx benchmarks/tau-bench/runner.ts --dry

# full run: both modes, all tasks, 1 repeat
export DEEPSEEK_API_KEY=sk-...
npx tsx benchmarks/tau-bench/runner.ts

# tighten variance: 3 repeats per task
npx tsx benchmarks/tau-bench/runner.ts --repeats 3

# narrow to one task while iterating
npx tsx benchmarks/tau-bench/runner.ts --task t01_address_happy --verbose

# render the report
npx tsx benchmarks/tau-bench/report.ts benchmarks/tau-bench/results-<date>.json

# emit per-run transcripts so you can jupiter replay / diff them
npx tsx benchmarks/tau-bench/runner.ts --transcripts-dir ./transcripts
npx jupiter diff \
  ./transcripts/t01_address_happy.baseline.r1.jsonl \
  ./transcripts/t01_address_happy.jupiter.r1.jsonl \
  --md diff.md
```

The runner writes `benchmarks/tau-bench/results-<iso-timestamp>.json`. Point
`report.ts` at it (or pass `--out report.md` to override the output path).

When `--transcripts-dir <path>` is set, each `(task, mode, repeat)` run also
writes a `<taskId>.<mode>.r<n>.jsonl` transcript into that directory —
these carry per-turn `usage`, `cost`, and (for Jupiter) the
`prefixHash`, so `jupiter replay` and `jupiter diff` can rebuild the
economics offline.

## CLI flags

| flag | default | meaning |
|---|---|---|
| `--task <id>` | all | run only one task by id |
| `--mode baseline` \| `jupiter` | both | restrict to one mode |
| `--repeats <N>` | 1 | repeat each (task, mode) pair N times |
| `--model <id>` | deepseek-chat | agent model |
| `--user-model <id>` | deepseek-chat | user-simulator model |
| `--out <path>` | `results-<ts>.json` | results file path |
| `--transcripts-dir <path>` | off | write one transcript per run for replay/diff |
| `--dry` | off | skip the LLM; only wire-check |
| `--verbose` \| `-v` | off | print every user / agent / tool line |

## What a run costs

A full run (8 tasks × 2 modes × 1 repeat) does on the order of 30–60
DeepSeek V3 calls — well under $0.05 at current pricing. `--repeats 3`
triples that.

## Adding tasks

1. Add a `TaskDefinition` to `tau-bench/tasks.ts`. Reuse the tool factories
   defined at the top of that file, or add new ones (remember: factories so
   tools close over the *per-run* db snapshot).
2. Make the `check` predicate check the end-state DB, not the agent's text —
   agents phrase things differently on every run.
3. Run `--task <your_id> --verbose` to eyeball the transcript.

Non-goals (for this harness):

- LLM-as-judge — brittle and expensive, DB predicates are enough.
- Streaming comparison — the harness uses `stream: false` in Jupiter mode
  so both runners make the exact same request shape.
- Claude head-to-head — we estimate Claude's cost from token counts using
  Sonnet 4.6 pricing (see `src/telemetry.ts`); running Claude for real is
  out of scope.

/**
 * Library example: programmatic replay + diff.
 *
 * This example runs with no API key and no DeepSeek calls — it reads the
 * reference transcripts committed at benchmarks/tau-bench/transcripts/ and
 * reconstructs the v0.1 cache-hit / cost numbers offline.
 *
 * Run from the repo root:
 *   npx tsx examples/replay-and-diff.ts
 *
 * Anything you can do with `jupiter replay` / `jupiter diff` is available
 * here as a function you can drive from your own scripts (CI gates, eval
 * dashboards, blog post generation, etc.).
 */

import {
  computeReplayStats,
  diffTranscripts,
  readTranscript,
  renderDiffSummary,
} from "../src/index.js";

const BASELINE = "benchmarks/tau-bench/transcripts/t01_address_happy.baseline.r1.jsonl";
const JUPITER = "benchmarks/tau-bench/transcripts/t01_address_happy.jupiter.r1.jsonl";

// ---------- 1. Replay a single transcript as pure data ----------

const parsed = readTranscript(JUPITER);
const stats = computeReplayStats(parsed.records);

console.log("=== Jupiter side, computed from transcript alone ===");
console.log(`  model calls:        ${stats.turns}`);
console.log(`  cache hit:          ${(stats.cacheHitRatio * 100).toFixed(1)}%`);
console.log(`  total cost:         $${stats.totalCostUsd.toFixed(6)}`);
console.log(`  vs claude estimate: $${stats.claudeEquivalentUsd.toFixed(6)}`);
console.log(`  savings:            ${stats.savingsVsClaudePct.toFixed(1)}%`);
console.log(`  prefix hashes:      ${stats.prefixHashes.length} distinct`);
if (stats.prefixHashes.length === 1) {
  console.log(`    → byte-stable: ${stats.prefixHashes[0]?.slice(0, 16)}…`);
}
console.log();

// ---------- 2. Diff two transcripts ----------

const aParsed = readTranscript(BASELINE);
const bParsed = readTranscript(JUPITER);

const report = diffTranscripts(
  { label: "baseline", parsed: aParsed },
  { label: "jupiter", parsed: bParsed },
);

// renderDiffSummary returns a monochrome stdout-ready string. Equivalent to
// what `jupiter diff --print` outputs.
console.log(renderDiffSummary(report));

// ---------- 3. Direct programmatic access to pairs ----------
//
// You can also inspect report.pairs directly — useful for writing custom
// filters like "show me only the turns where tool calls differed".

console.log("\n=== Turns where A and B took different paths ===");
const divergent = report.pairs.filter((p) => p.kind !== "match");
if (divergent.length === 0) {
  console.log("  (none — both agents followed the same path on every turn)");
} else {
  for (const p of divergent) {
    console.log(`  turn ${p.turn}: ${p.kind}${p.divergenceNote ? ` — ${p.divergenceNote}` : ""}`);
  }
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const home = await mkdtemp(join(tmpdir(), "jupiter-history-benchmark-"));
process.env.HOME = home;
const { readSessionHistoryPage } = await import("../src/memory/session-history.js");
const { loadSessionMessages } = await import("../src/memory/session.js");
const directory = join(home, ".jupiter", "sessions");
await mkdir(directory, { recursive: true });
const results = [];
for (const turns of [100, 1000, 5000]) {
  const name = `benchmark-${turns}`;
  const records = Array.from({ length: turns }, (_, index) => [
    { role: "user", content: `Question ${index + 1}: preserve all original records.` },
    { role: "assistant", content: `Answer ${index + 1}. ${"bounded history evidence ".repeat(80)}` },
  ]).flat();
  const source = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const path = join(directory, `${name}.jsonl`);
  await writeFile(path, source);
  let started = performance.now();
  const full = loadSessionMessages(name);
  const fullReadMs = performance.now() - started;
  assert.equal(full.length, records.length);
  started = performance.now();
  const latest = await readSessionHistoryPage(name);
  const coldPageMs = performance.now() - started;
  started = performance.now();
  const earlier = await readSessionHistoryPage(name, { cursor: latest.beforeCursor });
  const warmPageMs = performance.now() - started;
  assert.equal(latest.totalTurns, turns);
  assert.equal(latest.startTurn, turns - 20);
  assert.equal(earlier.startTurn, turns - 40);
  assert.equal(latest.generation, earlier.generation);
  assert(earlier.readBytes < Buffer.byteLength(source) / 2, "warm pages must not reread the entire source");
  assert.equal(await readFile(path, "utf8"), source);
  results.push({ turns, sourceBytes: Buffer.byteLength(source), fullReadMs, coldPageMs, warmPageMs,
    coldReadBytes: latest.readBytes, warmReadBytes: earlier.readBytes,
    pageRecords: earlier.records.length, processMemory: process.memoryUsage() });
}
const report = { fixtureHome: home, results,
  boundary: "Cold indexing may scan once; warm reads are bounded. Timings and process memory are observations, not cross-platform guarantees." };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

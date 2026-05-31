# Reference transcripts

These are the raw `.jsonl` transcripts from running task `t01_address_happy`
under both baseline and Jupiter modes. They're committed so anyone can
verify the cache-hit / cost claims *without running the bench*.

## Files

| file | what it is |
|---|---|
| `t01_address_happy.baseline.r1.jsonl` | Naive cache-hostile agent's record of the run |
| `t01_address_happy.jupiter.r1.jsonl` | Jupiter's record of the same task |
| `t01_address_happy.diff.md` | Output of `jupiter diff` on the two above |
| `mcp-demo.add.jsonl` | End-to-end run through the bundled demo MCP server. DeepSeek called the `add` tool; the second turn hit 96.6% cache, 94% cheaper than Claude at same token counts |
| `mcp-filesystem.jsonl` | End-to-end run through the **official external** `@modelcontextprotocol/server-filesystem`. 5 turns, 4 tool calls including a permission-denied recovery. Overall cache 96.7%, 97% cheaper than Claude. Proof that Cache-First generalizes to third-party MCP servers without any code change on our side |
| `mcp-multi-server.jsonl` | End-to-end run with **two MCP servers concurrently** — bundled demo (`demo_add`) + official `@modelcontextprotocol/server-filesystem` (`fs_write_file`). Model computed 17+25 on one server, wrote the result to a real file via the other. 5 turns, 4 tool calls across two subprocesses. **1 distinct prefix hash** held across all turns — Cache-First byte-stability survives running two MCP servers at once. Cache 81.1%, cost $0.00185, 95.9% cheaper than Claude |

## Verify for yourself

```bash
# Install and build (or run from source via tsx)
npm install

# Rebuild the summary — this does NOT call the API; it reads the JSONL.
npx jupiter replay benchmarks/tau-bench/transcripts/t01_address_happy.jupiter.r1.jsonl

# Reproduce the diff:
npx jupiter diff \
  benchmarks/tau-bench/transcripts/t01_address_happy.baseline.r1.jsonl \
  benchmarks/tau-bench/transcripts/t01_address_happy.jupiter.r1.jsonl \
  --label-a baseline --label-b jupiter
```

Headline numbers from the committed run:

- cache hit: **45.9% → 93.9% (+48.0pp)**
- cost: **$0.001192 → $0.000953 (−20.1%)**
- Jupiter's prefix stayed byte-stable (1 distinct prefix hash) across all
  model calls; baseline's churned every call (untracked, by design).

## Regenerate

```bash
export DEEPSEEK_API_KEY=sk-...
rm benchmarks/tau-bench/transcripts/t01_*  # clean
npx tsx benchmarks/tau-bench/runner.ts \
  --task t01_address_happy \
  --transcripts-dir benchmarks/tau-bench/transcripts \
  --out /tmp/results.json
npx jupiter diff \
  benchmarks/tau-bench/transcripts/t01_address_happy.baseline.r1.jsonl \
  benchmarks/tau-bench/transcripts/t01_address_happy.jupiter.r1.jsonl \
  --label-a baseline --label-b jupiter \
  --md benchmarks/tau-bench/transcripts/t01_address_happy.diff.md
```

Cost: ~$0.003 per full regeneration.

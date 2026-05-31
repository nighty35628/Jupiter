/**
 * End-to-end smoke test for the memory layer. Runs against a temp
 * homeDir so the developer's real ~/.jupiter/memory/ is never touched.
 * Exercises: write → index regeneration → prefix assembly →
 * recall → delete → JUPITER_MEMORY=off short-circuit.
 *
 * Run: npx tsx scripts/smoke-memory.mts
 * Exit code 0 on success, 1 on any assertion failure.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../src/tools.js";
import { registerMemoryTools } from "../src/tools/memory.js";
import {
  MemoryStore,
  applyMemoryStack,
  applyUserMemory,
  projectHash,
} from "../src/user-memory.js";

let failures = 0;
function check(label: string, cond: unknown, detail?: string) {
  if (cond) {
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  ✗ ${label}${detail ? `  — ${detail}` : ""}\n`);
  }
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "jupiter-smoke-home-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "jupiter-smoke-proj-"));
  process.stdout.write(`home:    ${home}\nproject: ${projectRoot}\n\n`);

  try {
    // ── 1. MemoryStore write + index regeneration ────────────────────
    process.stdout.write("1. MemoryStore write → index regen\n");
    const store = new MemoryStore({ homeDir: home, projectRoot });
    store.write({
      name: "bun_build",
      type: "project",
      scope: "project",
      description: "Build command on this machine is `bun run build`",
      body: "On this machine, no npm — always `bun run build` / `bun run test`.",
    });
    store.write({
      name: "tabs_not_spaces",
      type: "user",
      scope: "global",
      description: "Use tabs for indentation across all projects",
      body: "Rule.\n\n**Why:** muscle memory, editor config across machines.\n\n**How to apply:** always tabs.",
    });

    const hash = projectHash(projectRoot);
    const projectFile = join(home, "memory", hash, "bun_build.md");
    const globalFile = join(home, "memory", "global", "tabs_not_spaces.md");
    check("project-scoped file landed in <hash>/ dir", existsSync(projectFile));
    check("global-scoped file landed in global/ dir", existsSync(globalFile));
    check("no cross-contamination project ⇒ global", !existsSync(join(home, "memory", "global", "bun_build.md")));

    const projectIndex = readFileSync(join(home, "memory", hash, "MEMORY.md"), "utf8");
    check("project MEMORY.md points at bun_build.md", projectIndex.includes("[bun_build](bun_build.md)"));
    const globalIndex = readFileSync(join(home, "memory", "global", "MEMORY.md"), "utf8");
    check("global MEMORY.md points at tabs_not_spaces.md", globalIndex.includes("[tabs_not_spaces](tabs_not_spaces.md)"));

    const raw = readFileSync(projectFile, "utf8");
    check("frontmatter has name/type/scope/created", /^---\nname: bun_build\n/.test(raw) && /type: project/.test(raw) && /scope: project/.test(raw) && /created: \d{4}-\d{2}-\d{2}/.test(raw));

    // ── 2. Prefix assembly via applyMemoryStack (+ JUPITER.md) ────────
    process.stdout.write("\n2. Prefix assembly (JUPITER.md + user memory)\n");
    writeFileSync(join(projectRoot, "JUPITER.md"), "# Project notes\nPrefer explicit types over inference.\n", "utf8");
    const BASE = "You are a test assistant.";
    const withProjOnly = applyUserMemory(BASE, { homeDir: home, projectRoot });
    check("applyUserMemory contains global block", withProjOnly.includes("# User memory — global"));
    check("applyUserMemory contains project block", withProjOnly.includes("# User memory — this project"));
    check("bun_build description present in prefix", withProjOnly.includes("bun run build"));
    check("tabs_not_spaces description present in prefix", withProjOnly.includes("Use tabs for indentation"));

    // Order: base → (JUPITER.md would go first via applyMemoryStack) → global → project
    const ordered = applyUserMemory(BASE, { homeDir: home, projectRoot });
    const iGlobalBlock = ordered.indexOf("# User memory — global");
    const iProjBlock = ordered.indexOf("# User memory — this project");
    check("global block precedes project block (stable for cache)", iGlobalBlock > 0 && iGlobalBlock < iProjBlock);

    // Determinism — two calls with same state produce byte-identical prompts.
    const a = applyUserMemory(BASE, { homeDir: home, projectRoot });
    const b = applyUserMemory(BASE, { homeDir: home, projectRoot });
    check("applyUserMemory is deterministic (byte-stable)", a === b);

    // ── 3. The `remember` / `recall_memory` / `forget` tools ───────────
    process.stdout.write("\n3. Tool dispatch (remember / recall / forget)\n");
    const reg = new ToolRegistry();
    registerMemoryTools(reg, { homeDir: home, projectRoot });
    check("remember tool registered", reg.has("remember"));
    check("forget tool registered", reg.has("forget"));
    check("recall_memory tool registered", reg.has("recall_memory"));
    check("recall_memory is readOnly (plan-mode safe)", reg.get("recall_memory")?.readOnly === true);
    check("remember is NOT readOnly (plan-mode blocked)", reg.get("remember")?.readOnly !== true);

    const remOut = await reg.dispatch("remember", {
      type: "feedback",
      scope: "global",
      name: "prefers_short_replies",
      description: "User wants terse answers, no trailing summaries",
      content: "Default to terse. If the user wants detail they'll ask.",
    });
    check("remember returns a confirmation (not an error)", remOut.includes("REMEMBERED (global/prefers_short_replies)"), remOut);

    const recallOut = await reg.dispatch("recall_memory", {
      scope: "global",
      name: "prefers_short_replies",
    });
    check("recall_memory returns the body", recallOut.includes("Default to terse"));

    const forgetOut = await reg.dispatch("forget", {
      scope: "global",
      name: "prefers_short_replies",
    });
    check("forget returns a confirmation", forgetOut.includes("forgot (global/prefers_short_replies)"));
    check("recall_memory after forget returns an error", (await reg.dispatch("recall_memory", { scope: "global", name: "prefers_short_replies" })).includes("error"));

    // ── 4. Project scope refused when projectRoot is absent ────────────
    process.stdout.write("\n4. Chat-mode (no projectRoot) refuses project scope\n");
    const chatReg = new ToolRegistry();
    registerMemoryTools(chatReg, { homeDir: home });
    const projInChat = await chatReg.dispatch("remember", {
      type: "project",
      scope: "project",
      name: "should_fail",
      description: "d",
      content: "c",
    });
    check("scope='project' in chat mode → error payload", projInChat.includes("error") && projInChat.includes("project"));
    const globalInChat = await chatReg.dispatch("remember", {
      type: "user",
      scope: "global",
      name: "global_from_chat",
      description: "works across projects",
      content: "body",
    });
    check("scope='global' in chat mode → writes successfully", globalInChat.includes("REMEMBERED (global/"));

    // ── 5. JUPITER_MEMORY=off short-circuit ───────────────────────────
    process.stdout.write("\n5. JUPITER_MEMORY=off opt-out\n");
    process.env.JUPITER_MEMORY = "off";
    try {
      const silenced = applyUserMemory(BASE, { homeDir: home, projectRoot });
      check("applyUserMemory returns BASE unchanged when off", silenced === BASE);
      const fullStack = applyMemoryStack(BASE, projectRoot);
      check("applyMemoryStack returns BASE unchanged when off (JUPITER.md also skipped)", fullStack === BASE);
    } finally {
      delete process.env.JUPITER_MEMORY;
    }

    // ── 6. Delete regeneration: MEMORY.md matches current file set ─────
    process.stdout.write("\n6. Delete + index regeneration\n");
    store.delete("global", "tabs_not_spaces");
    store.delete("global", "global_from_chat");
    const globalIdxAfter = join(home, "memory", "global", "MEMORY.md");
    check("global MEMORY.md removed when last file deleted", !existsSync(globalIdxAfter));
    const projectIdxStill = readFileSync(join(home, "memory", hash, "MEMORY.md"), "utf8");
    check("project MEMORY.md untouched (different scope)", projectIdxStill.includes("bun_build"));

    // ── 7. Name-sanitization boundary ──────────────────────────────────
    process.stdout.write("\n7. Name sanitization (path-traversal refused)\n");
    const badOut = await reg.dispatch("remember", {
      type: "user",
      scope: "global",
      name: "../../etc/passwd",
      description: "d",
      content: "c",
    });
    check("remember refuses path-traversal name", badOut.includes("invalid memory name"));
    const outsideFile = join(home, "etc", "passwd.md");
    check("no file written outside the memory dir", !existsSync(outsideFile));

    process.stdout.write(`\n${failures === 0 ? "✅ all smoke checks passed" : `❌ ${failures} failure(s)`}\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const run = resolve(process.argv[2] ?? "");
assert(run.startsWith("/tmp/jupiter-update-20261008/run-"), "Use an owned synthetic-service run");
const state = JSON.parse(await readFile(join(run, "state.json"), "utf8"));
assert.equal(state.mode, "web");
const totalTurns = Number(process.argv[3] ?? 85);
assert(Number.isSafeInteger(totalTurns) && totalTurns >= 85 && totalTurns <= 10_000);
const firstTurn = totalTurns - 19;
const name = `history-acceptance-${randomUUID().slice(0, 8)}`;
const records = Array.from({ length: totalTurns }, (_, index) => [
  { role: "user", content: `History question ${index + 1}: preserve the original target.` },
  { role: "assistant", content: `History answer ${index + 1}. ${"Bounded transcript evidence. ".repeat(12)}` },
]).flat();
await mkdir(join(state.home, ".jupiter", "sessions"), { recursive: true });
await writeFile(join(state.home, ".jupiter", "sessions", `${name}.jsonl`), records.map(JSON.stringify).join("\n") + "\n");
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const storage = join(run, "upstream-browser-state.json");
const context = await browser.newContext({ viewport: { width: 1360, height: 900 },
  ...(existsSync(storage) ? { storageState: storage } : {}),
});
const page = await context.newPage();
const checks = [];
const errors = [];
let connectionId;
let anchorBefore;
let anchorAfter;
await page.route("**/api/rpc", async (route) => {
  const payload = route.request().postDataJSON()?.payload;
  if (payload?.cmd === "session_history_page" && !anchorBefore) {
    anchorBefore = await page.locator(`.thread-inner[data-turn="${firstTurn}"]`).first().boundingBox();
  }
  await route.continue();
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/events") connectionId = url.searchParams.get("connectionId");
});
await page.addInitScript(() => {
  window.__historyEvidence = [];
  const Original = window.EventSource;
  window.EventSource = class extends Original {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (message) => {
        try {
          const packet = JSON.parse(message.data);
          if (packet.channel === "rpc:event") window.__historyEvidence.push(JSON.parse(packet.payload.data));
        } catch { /* application reports malformed frames */ }
      });
    }
  };
});
const check = (label, value) => { assert(value, label); checks.push(label); };
const events = () => page.evaluate(() => window.__historyEvidence);
const rpc = async (payload) => page.evaluate(async ({ payload, connectionId }) => {
  const session = await (await fetch("/api/session")).json();
  if (payload.cmd === "session_load" || payload.cmd === "new_chat") payload.workspaceId = session.workspaces[0].id;
  const headers = { "content-type": "application/json", "x-jupiter-csrf": session.csrfToken,
    "x-jupiter-connection": connectionId, ...(session.lease ? {
      "x-jupiter-lease": session.lease.id, "x-jupiter-fence": String(session.lease.fence),
    } : {}) };
  const response = await fetch("/api/rpc", { method: "POST", headers,
    body: JSON.stringify({ commandId: crypto.randomUUID(), payload }) });
  if (!response.ok) throw new Error(await response.text());
}, { payload, connectionId });
try {
  await page.goto(existsSync(storage) ? state.webOrigin : state.browserUrl);
  await page.locator("textarea").first().waitFor();
  await page.evaluate(async (id) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/lease/acquire", { method: "POST",
      headers: { "content-type": "application/json", "x-jupiter-csrf": session.csrfToken, "x-jupiter-connection": id },
      body: JSON.stringify({ force: true, confirm: "take-control" }) });
    if (!response.ok) throw new Error("Could not take control of the synthetic fixture");
  }, connectionId);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.webWriter === "true");
  await page.waitForFunction(() => window.__historyEvidence.some((event) => event.type === "$ready"));
  const tabId = (await events()).findLast((event) => event.type === "$tab_opened").tabId;
  const emptyName = `${name}-empty`;
  await writeFile(join(state.home, ".jupiter", "sessions", `${emptyName}.jsonl`), "");
  const emptyRequest = randomUUID();
  await rpc({ cmd: "session_load", tabId, name: emptyName, historyPaging: true, requestId: emptyRequest });
  await page.waitForFunction((id) => window.__historyEvidence.some((event) => event.type === "$session_loaded" && event.snapshot?.requestId === id), emptyRequest);
  await page.waitForFunction(() => document.querySelector("textarea") && !document.querySelector("textarea").disabled);
  await rpc({ cmd: "ask_light", tabId, text: "SMOKE:empty-history-first-message", clientId: randomUUID() });
  await page.getByText("LOCAL_OK SMOKE:empty-history-first-message", { exact: true }).waitFor();
  check("first-response-in-an-empty-paged-session-is-visible", true);
  const requestId = randomUUID();
  const started = Date.now();
  await rpc({ cmd: "session_load", tabId, name, historyPaging: true, requestId });
  await page.waitForFunction((id) => window.__historyEvidence.some((event) =>
    event.type === "$session_loaded" && event.snapshot?.requestId === id), requestId);
  const first = (await events()).find((event) => event.type === "$session_loaded" && event.snapshot?.requestId === requestId);
  check("first-page-is-bounded", first.messages.length <= 40 && first.history?.totalTurns === totalTurns && first.history.hasMore);
  check("absolute-turn-and-rollback-identity", first.messages[0].turn === firstTurn && first.messages[0].rollbackRef.turn === firstTurn);
  check("first-page-before-runtime-ready", first.runtimeReady === false);
  const firstPageMs = Date.now() - started;
  await page.waitForFunction(({ target, id }) => {
    const start = window.__historyEvidence.findIndex((event) => event.type === "$session_loaded" && event.snapshot?.requestId === id);
    return window.__historyEvidence.slice(start + 1).some((event) => event.type === "$ready" && event.tabId === target);
  }, { target: tabId, id: requestId });
  const scroll = page.locator('[data-virtuoso-scroller="true"]').first();
  await scroll.waitFor();
  await page.waitForTimeout(300);
  const titleBefore = await page.locator(".main-head h1 .editable").textContent();
  const before = await scroll.evaluate((element) => element.scrollHeight);
  await scroll.hover();
  await page.mouse.wheel(0, -100_000);
  await page.waitForFunction(() => window.__historyEvidence.some((event) => event.type === "$session_history_page" && event.messages?.length));
  check("scroll-loads-an-older-page", (await events()).some((event) => event.type === "$session_history_page" && event.messages.some((row) => row.turn < firstTurn)));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const metrics = await scroll.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight }));
  check("prepend-keeps-a-reading-anchor", metrics.height > before && metrics.top > 0);
  anchorAfter = await page.locator(`.thread-inner[data-turn="${firstTurn}"]`).first().boundingBox();
  check("prepend-keeps-original-turn-position", anchorBefore && anchorAfter && Math.abs(anchorBefore.y - anchorAfter.y) < 24);
  check("prepend-keeps-session-title", await page.locator(".main-head h1 .editable").textContent() === titleBefore);
  check("transcript-stays-nonblank", await page.locator(".thread-inner").count() > 0);
  await page.screenshot({ path: join(run, "upstream-history-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  check("mobile-has-no-document-overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check("mobile-transcript-stays-nonblank", await page.locator(".thread-inner").count() > 0);
  await page.screenshot({ path: join(run, "upstream-history-mobile.png") });
  await rpc({ cmd: "rollback_to_turn", tabId, turn: firstTurn, role: "assistant", historyGeneration: first.history.generation });
  await page.waitForFunction(({ name, turns }) => window.__historyEvidence.some((event) => event.type === "$session_loaded" && event.name === name && event.snapshot?.reason === "rollback" && event.history?.totalTurns === turns), { name, turns: firstTurn });
  const sourceAfterRollback = await readFile(join(state.home, ".jupiter", "sessions", `${name}.jsonl`), "utf8");
  check("rollback-keeps-the-absolute-source-turn", sourceAfterRollback.trim().split("\n").map(JSON.parse).filter((row) => row.role === "user").length === firstTurn);
  const previousCount = (await events()).length;
  await rpc({ cmd: "rollback_to_turn", tabId, turn: 1, role: "user", historyGeneration: first.history.generation });
  await page.waitForFunction((count) => window.__historyEvidence.slice(count).some((event) => event.type === "$error" && event.message?.includes("History changed")), previousCount);
  check("stale-generation-cannot-mutate-history", await readFile(join(state.home, ".jupiter", "sessions", `${name}.jsonl`), "utf8") === sourceAfterRollback);
  const beforeNewChat = (await events()).length;
  await rpc({ cmd: "new_chat", tabId });
  await page.waitForFunction((count) => window.__historyEvidence.slice(count).some((event) => event.type === "$session_loaded" && event.snapshot?.reason === "new"), beforeNewChat);
  await rpc({ cmd: "ask_light", tabId, text: "SMOKE:new-chat-after-history", clientId: randomUUID() });
  await page.getByText("LOCAL_OK SMOKE:new-chat-after-history", { exact: true }).waitFor({ timeout: 5_000 });
  check("new-chat-after-paging-renders-first-response", true);
  check("no-browser-errors", errors.length === 0);
  await writeFile(join(run, "upstream-history-web-results.json"), JSON.stringify({ passed: true, checks, errors, firstPageMs, totalTurns,
    firstPageBytes: Buffer.byteLength(JSON.stringify(first)), fullSourceBytes: Buffer.byteLength(records.map(JSON.stringify).join("\n")), metrics, anchorBefore, anchorAfter }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, firstPageMs, evidence: join(run, "upstream-history-web-results.json") }));
} catch (error) {
  await page.screenshot({ path: join(run, "upstream-history-failure.png") }).catch(() => {});
  await writeFile(join(run, "upstream-history-web-results.json"), JSON.stringify({ passed: false, checks, errors, error: String(error), anchorBefore, anchorAfter, events: await events() }, null, 2));
  throw error;
} finally {
  await context.storageState({ path: storage });
  await browser.close();
}

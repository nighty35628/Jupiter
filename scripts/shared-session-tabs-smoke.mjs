#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const run = resolve(process.argv[2] ?? "");
assert(run.startsWith("/tmp/jupiter-update-20261008/run-"));
const state = JSON.parse(await readFile(join(run, "state.json"), "utf8"));
assert.equal(state.mode, "web");
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const storagePath = join(run, "shared-browser-state.json");
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...(existsSync(storagePath) ? { storageState: storagePath } : {}) });
const page = await context.newPage();
page.setDefaultTimeout(10000);
let connectionId;
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/events") connectionId = url.searchParams.get("connectionId");
});
await page.addInitScript(() => {
  window.__sharedEvents = [];
  const Original = window.EventSource;
  window.EventSource = class extends Original {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (message) => {
        const packet = JSON.parse(message.data);
        if (packet.channel === "rpc:event") window.__sharedEvents.push(JSON.parse(packet.payload.data));
      });
    }
  };
});
const checks = [];
const check = (name, condition) => { assert(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const events = () => page.evaluate(() => window.__sharedEvents);
const rpc = (payload) => page.evaluate(async ({ payload, connectionId }) => {
  const session = await (await fetch("/api/session")).json();
  if (payload.cmd === "new_chat" || payload.cmd === "tab_open") payload.workspaceId = session.workspaces[0].id;
  const commandId = crypto.randomUUID();
  const response = await fetch("/api/rpc", { method: "POST", headers: {
    "content-type": "application/json", "x-jupiter-csrf": session.csrfToken, "x-jupiter-connection": connectionId,
    "x-jupiter-lease": session.lease.id, "x-jupiter-fence": String(session.lease.fence),
  }, body: JSON.stringify({ commandId, payload }) });
  if (!response.ok) throw new Error(await response.text());
  return commandId;
}, { payload, connectionId });
const waitEvent = async (type, tabId, marker) => page.waitForFunction(({ type, tabId, marker }) =>
  window.__sharedEvents.some((event) => event.type === type && (!tabId || event.tabId === tabId) &&
    (!marker || JSON.stringify(event).includes(marker))), { type, tabId, marker }, { timeout: 30000 });
const activeInput = () => page.locator('.main:visible textarea').first();
try {
  await page.goto(existsSync(storagePath) ? state.webOrigin : state.browserUrl);
  await page.waitForFunction(() => window.__sharedEvents.some((event) => event.type === "$ready"));
  await context.storageState({ path: storagePath });
  await page.evaluate(async (connectionId) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/lease/acquire", { method: "POST", headers: {
      "content-type": "application/json", "x-jupiter-csrf": session.csrfToken, "x-jupiter-connection": connectionId,
    }, body: JSON.stringify({ force: true, confirm: "take-control" }) });
    if (!response.ok) throw new Error(await response.text());
  }, connectionId);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.webWriter === "true");
  await waitEvent("$ready");
  const openCommand = await rpc({ cmd: "tab_open" });
  await page.waitForFunction((id) => window.__sharedEvents.some((event) => event.type === "$command_ack" && event.commandId === id && event.phase === "completed"), openCommand);
  const openingEvents = await events();
  const acceptedAt = openingEvents.findIndex((event) => event.type === "$command_ack" && event.commandId === openCommand && event.phase === "accepted");
  const completedAt = openingEvents.findIndex((event) => event.type === "$command_ack" && event.commandId === openCommand && event.phase === "completed");
  const a = openingEvents.slice(acceptedAt + 1, completedAt).find((event) => event.type === "$tab_opened" && event.active);
  assert(a, "The acknowledged new-tab command must open a new active tab");
  await waitEvent("$ready", a.tabId);
  await page.locator(`.tabbar:visible [role="tab"][data-conversation-view-id="${a.conversationViewId}"]`).click();
  await rpc({ cmd: "ask_light", tabId: a.tabId, text: "SMOKE:parallel-cancel-a hold this turn", clientId: crypto.randomUUID() });
  console.log("Started A");
  await waitEvent("user.message", a.tabId, "parallel-cancel-a");
  const aTab = page.locator(`.tabbar:visible [role="tab"][data-conversation-view-id="${a.conversationViewId}"]`);
  await aTab.click({ button: "right" });
  await page.getByRole("menuitem", { name: /parallel|并行/i }).click();
  await page.waitForFunction((id) => window.__sharedEvents.some((event) => event.type === "$tab_opened" && event.sessionId === id && event.active && event.conversationViewId && event.conversationViewId !== window.__sharedEvents.find((event) => event.type === "$tab_opened" && event.sessionId === id).conversationViewId), a.sessionId);
  const b = (await events()).findLast((event) => event.type === "$tab_opened" && event.sessionId === a.sessionId && event.tabId !== a.tabId);
  check("parallel-tab-shares-session-not-view", b && b.conversationViewId !== a.conversationViewId);
  await waitEvent("$ready", b.tabId);
  console.log("B ready");
  await rpc({ cmd: "ask_light", tabId: b.tabId, text: "SMOKE:parallel-fast-b answer now", clientId: crypto.randomUUID() });
  await waitEvent("model.final", b.tabId, "parallel-fast-b");
  console.log("B final");
  await waitEvent("$shared_session_updated", b.tabId);
  const all = await events();
  check("b-finishes-while-a-still-running", !all.some((event) => event.type === "model.final" && event.tabId === a.tabId && event.content?.includes("parallel-cancel-a")));
  await waitEvent("$session_loaded", b.tabId, "parallel-fast-b");
  const loadedB = (await events()).findLast((event) => event.type === "$session_loaded" && event.tabId === b.tabId);
  const path = join(state.home, ".jupiter", "sessions", `${loadedB.name}.jsonl`);
  const interim = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  check("in-progress-a-is-not-in-shared-history", interim.some((row) => row.content?.includes("parallel-fast-b")) && !interim.some((row) => row.content?.includes("parallel-cancel-a")));
  await activeInput().fill("private draft B");
  await aTab.click();
  await activeInput().fill("private draft A");
  await page.locator(`.tabbar:visible [role="tab"][data-conversation-view-id="${b.conversationViewId}"]`).click();
  check("draft-b-is-independent", await activeInput().inputValue() === "private draft B");
  await waitEvent("model.final", a.tabId, "parallel-cancel-a");
  await page.waitForFunction((id) => window.__sharedEvents.filter((event) => event.type === "$shared_session_updated" && event.tabId === id).length >= 2, b.tabId);
  check("foreign-completion-preserves-draft", await activeInput().inputValue() === "private draft B");
  const rows = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  check("whole-turns-commit-in-completion-order", rows.filter((row) => row.role === "user").map((row) => row.content.match(/SMOKE:[a-z0-9-]+/)[0]).join(",") === "SMOKE:parallel-fast-b,SMOKE:parallel-cancel-a");
  await rpc({ cmd: "ask_light", tabId: b.tabId, text: "SMOKE:parallel-next Which is better?", clientId: crypto.randomUUID() });
  await waitEvent("model.final", b.tabId, "parallel-next");
  const receipts = (await readFile(join(run, "provider.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const next = receipts.findLast((receipt) => receipt.kind === "request" && receipt.marker === "SMOKE:parallel-next");
  const markers = next.historyMarkers.flatMap((row) => row.markers);
  check("actual-next-request-sees-both-completed-turns", markers.includes("SMOKE:parallel-fast-b") && markers.includes("SMOKE:parallel-cancel-a"));
  check("provider-does-not-receive-local-identities", receipts.filter((receipt) => receipt.kind === "request").every((receipt) => !receipt.localMetadataLeak));
  const cancelCursor = (await events()).length;
  await rpc({ cmd: "ask_light", tabId: a.tabId, text: "SMOKE:cancel cancel only this view", clientId: crypto.randomUUID() });
  await page.waitForFunction(({ cursor, id }) => window.__sharedEvents.slice(cursor).some((event) => event.type === "user.message" && event.tabId === id), { cursor: cancelCursor, id: a.tabId });
  await rpc({ cmd: "ask_light", tabId: b.tabId, text: "SMOKE:parallel-survivor finish in the other view", clientId: crypto.randomUUID() });
  await rpc({ cmd: "abort", tabId: a.tabId });
  await page.waitForFunction(({ cursor, id }) => window.__sharedEvents.slice(cursor).some((event) => event.type === "$turn_complete" && event.tabId === id), { cursor: cancelCursor, id: a.tabId });
  await waitEvent("model.final", b.tabId, "parallel-survivor");
  const cancelEvents = (await events()).slice(cancelCursor);
  check("cancelling-one-view-does-not-cancel-sibling", !cancelEvents.some((event) => event.type === "model.final" && event.tabId === a.tabId) && cancelEvents.some((event) => event.type === "model.final" && event.tabId === b.tabId));
  await page.waitForFunction(({ cursor, id }) => window.__sharedEvents.slice(cursor).some((event) => event.type === "$shared_session_updated" && event.tabId === id && event.sourceViewId), { cursor: cancelCursor, id: b.tabId });
  const cancelledRows = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  check("cancelled-turn-is-explicitly-interrupted", cancelledRows.some((row) => row.role === "assistant" && row.content?.includes("[Interrupted:")));
  await page.reload();
  await waitEvent("$ready", b.tabId);
  const restored = (await events()).filter((event) => event.type === "$tab_opened" && event.sessionId === a.sessionId);
  check("restored-view-identities-match", [a, b].every((view) => restored.some((event) => event.conversationViewId === view.conversationViewId && event.tabId === view.tabId)));
  check("parallel-view-numbers-remain-visible", await page.evaluate((views) => views.every((view) => {
    const tab = document.querySelector(`.tabbar [data-conversation-view-id="${view.conversationViewId}"]`);
    const badge = tab?.querySelector(".tab-view-number");
    if (!badge || getComputedStyle(badge).flexShrink !== "0") return false;
    const outer = tab.getBoundingClientRect(); const inner = badge.getBoundingClientRect();
    return inner.width > 0 && inner.left >= outer.left && inner.right <= outer.right;
  }), [a, b]));
  await page.getByText("LOCAL_OK SMOKE:parallel-survivor", { exact: true }).waitFor({ state: "visible" });
  check("reconnected-transcript-renders-visible-reply", await page.getByText("LOCAL_OK SMOKE:parallel-survivor", { exact: true }).isVisible());
  await page.screenshot({ path: join(run, "shared-tabs-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const input = [...document.querySelectorAll('.main textarea')].find((node) => node.getBoundingClientRect().width > 0);
    return input && input.getBoundingClientRect().width >= 250;
  });
  check("mobile-composer-remains-usable", true);
  check("mobile-does-not-overflow-document", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(run, "shared-tabs-mobile.png"), animations: "disabled" });
  check("no-browser-runtime-errors", errors.length === 0);
  await writeFile(join(run, "shared-tabs-browser-results.json"), JSON.stringify({ checks, errors, a, b, path }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, run, checks }, null, 2));
} finally {
  await writeFile(join(run, "shared-tabs-browser-events.json"), JSON.stringify(await events()));
  await context.storageState({ path: storagePath }); await browser.close();
}

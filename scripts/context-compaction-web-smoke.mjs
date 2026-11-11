#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const run = resolve(process.argv[2] ?? "");
assert(run.startsWith("/tmp/jupiter-update-20261008/run-"));
const state = JSON.parse(await readFile(join(run, "state.json"), "utf8"));
assert.equal(state.mode, "web");
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const storage = join(run, "context-browser-state.json");
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...(existsSync(storage) ? { storageState: storage } : {}) });
const page = await context.newPage();
const checks = [];
const errors = [];
let connectionId;
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/events") connectionId = url.searchParams.get("connectionId");
});
await page.addInitScript(() => {
  window.__contextEvents = [];
  const Original = window.EventSource;
  window.EventSource = class extends Original {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (message) => {
        const packet = JSON.parse(message.data);
        if (packet.channel === "rpc:event") window.__contextEvents.push(JSON.parse(packet.payload.data));
      });
    }
  };
});
const events = () => page.evaluate(() => window.__contextEvents);
const check = (name, condition) => { assert(condition, name); checks.push(name); };
const rpc = (payload) => page.evaluate(async ({ payload, connectionId }) => {
  const session = await (await fetch("/api/session")).json();
  if (["session_load", "new_chat", "tab_open"].includes(payload.cmd)) payload.workspaceId = session.workspaces[0].id;
  const response = await fetch("/api/rpc", { method: "POST", headers: {
    "content-type": "application/json", "x-jupiter-csrf": session.csrfToken,
    "x-jupiter-connection": connectionId, "x-jupiter-lease": session.lease.id,
    "x-jupiter-fence": String(session.lease.fence),
  }, body: JSON.stringify({ commandId: crypto.randomUUID(), payload }) });
  if (!response.ok) throw new Error(await response.text());
}, { payload, connectionId });
try {
  await page.goto(existsSync(storage) ? state.webOrigin : state.browserUrl);
  await page.locator("textarea").first().waitFor();
  await context.storageState({ path: storage });
  await page.evaluate(async (id) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/lease/acquire", { method: "POST", headers: {
      "content-type": "application/json", "x-jupiter-csrf": session.csrfToken, "x-jupiter-connection": id,
    }, body: JSON.stringify({ force: true, confirm: "take-control" }) });
    if (!response.ok) throw new Error("Synthetic writer acquisition failed");
  }, connectionId);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.webWriter === "true");
  await page.waitForFunction(() => window.__contextEvents.some((event) => event.type === "$ready"));
  let tabId = (await events()).findLast((event) => event.type === "$tab_opened").tabId;
  for (const mode of ["agent", "ask"]) {
    const name = `context-${mode}-${randomUUID().slice(0, 8)}`;
    const records = Array.from({ length: 14 }, (_, index) => [
      { role: "user", content: `Original objective ${index}: do not publish.` },
      { role: "assistant", content: `Evidence ${index}. ${"Useful old historical evidence. ".repeat(300)}` },
    ]).flat();
    const path = join(state.home, ".jupiter/sessions", `${name}.jsonl`);
    const original = `${records.map(JSON.stringify).join("\n")}\n`;
    await writeFile(path, original, { flag: "wx", mode: 0o600 });
    const requestId = randomUUID();
    await rpc({ cmd: "session_load", tabId, name, historyPaging: true, requestId });
    await page.waitForFunction((id) => {
      const rows = window.__contextEvents;
      const loaded = rows.findIndex((event) => event.type === "$session_loaded" && event.snapshot?.requestId === id);
      return loaded >= 0 && rows.slice(loaded).some((event) => event.type === "$ready");
    }, requestId);
    const clientId = randomUUID();
    const marker = `SMOKE:context-overflow-${mode}-${randomUUID().slice(0, 8)}`;
    await rpc({ cmd: mode === "agent" ? "user_input" : "ask_light", tabId, clientId, text: `${marker} Continue the original task.` });
    await page.waitForFunction((marker) => window.__contextEvents.some((event) => event.type === "model.final" && event.content?.includes(`LOCAL_OK ${marker}`)), marker, { timeout: 30000 });
    await page.getByText(`LOCAL_OK ${marker}`, { exact: true }).waitFor();
    await page.waitForFunction((clientId) => {
      const rows = window.__contextEvents;
      const accepted = rows.findIndex((event) => event.type === "user.message" && event.clientId === clientId);
      return accepted >= 0 && rows.slice(accepted).some((event) => event.type === "$shared_session_updated");
    }, clientId);
    await page.waitForFunction(() => document.querySelector("textarea") && !document.querySelector("textarea").disabled);
    const raw = await readFile(path, "utf8");
    check(`${mode}-raw-retained`, raw.startsWith(original));
    check(`${mode}-user-once`, raw.trim().split("\n").map(JSON.parse).filter((row) => row.clientId === clientId).length === 1);
    const cp = JSON.parse(await readFile(path.replace(/\.jsonl$/, ".compaction.json"), "utf8"));
    check(`${mode}-published-checkpoint`, cp.coveredRecords === records.length && cp.summary.content.includes("Durable synthetic facts"));
    const before = (await readFile(join(run, "provider.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.kind === "request" && row.compaction).length;
    const nextClientId = randomUUID();
    await rpc({ cmd: "ask_light", tabId, text: `SMOKE:context-next-${mode} Continue.`, clientId: nextClientId });
    await page.waitForFunction((mode) => window.__contextEvents.some((event) => event.type === "model.final" && event.content?.includes(`LOCAL_OK SMOKE:context-next-${mode}`)), mode);
    await page.waitForFunction((id) => {
      const rows = window.__contextEvents;
      const accepted = rows.findIndex((event) => event.type === "user.message" && event.clientId === id);
      return accepted >= 0 && rows.slice(accepted).some((event) => event.type === "$turn_complete");
    }, nextClientId);
    const after = (await readFile(join(run, "provider.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.kind === "request" && row.compaction).length;
    check(`${mode}-next-runtime-reuses-recap`, before === after);
    await page.reload();
    await page.waitForFunction(() => window.__contextEvents.some((event) => event.type === "$ready"));
    tabId = (await events()).findLast((event) => event.type === "$tab_opened").tabId;
    const resumedId = randomUUID();
    const resumedMarker = `SMOKE:context-refreshed-${mode}-${randomUUID().slice(0, 8)}`;
    await rpc({ cmd: "ask_light", tabId, text: `${resumedMarker} Keep the same objective.`, clientId: resumedId });
    await page.getByText(`LOCAL_OK ${resumedMarker}`, { exact: true }).waitFor();
    await page.waitForFunction((id) => {
      const rows = window.__contextEvents;
      const accepted = rows.findIndex((event) => event.type === "user.message" && event.clientId === id);
      return accepted >= 0 && rows.slice(accepted).some((event) => event.type === "$turn_complete");
    }, resumedId);
    const resumedRaw = await readFile(path, "utf8");
    check(`${mode}-refresh-keeps-raw-and-third-turn`, resumedRaw.startsWith(original) && resumedRaw.trim().split("\n").map(JSON.parse).filter((row) => row.clientId === resumedId).length === 1);
    const resumedCount = (await readFile(join(run, "provider.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.kind === "request" && row.compaction).length;
    check(`${mode}-refresh-reuses-checkpoint`, resumedCount === after);
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(run, "context-compaction-web.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  check("mobile-no-horizontal-overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(run, "context-compaction-mobile.png") });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const threshold = page.getByRole("spinbutton", { name: "Early threshold (tokens)" });
  await threshold.fill("32000");
  await threshold.blur();
  await page.waitForFunction(() => window.__contextEvents.some((event) => event.type === "$settings" && event.earlyCompactionTokens === 32000));
  await page.waitForFunction(() => document.querySelector('#early-compaction-tokens')?.value === '32000');
  check("web-settings-persists-early-threshold", JSON.parse(await readFile(join(state.home, ".jupiter/config.json"), "utf8")).earlyCompactionTokens === 32000);
  await page.getByRole("switch", { name: "Early compaction", exact: true }).click();
  await page.waitForFunction(() => window.__contextEvents.some((event) => event.type === "$settings" && event.earlyCompactionTokens === null));
  await page.getByRole("switch", { name: "Early compaction", exact: true, checked: false }).waitFor();
  check("web-settings-renders-disabled-threshold", await threshold.isDisabled());
  check("web-settings-persists-capacity-only-policy", JSON.parse(await readFile(join(state.home, ".jupiter/config.json"), "utf8")).earlyCompactionTokens === null);
  await page.screenshot({ path: join(run, "context-compaction-settings.png") });
  check("no-browser-errors", errors.length === 0);
  check("no-obsolete-history-errors", !(await events()).some((event) => event.type === "$error" && /changed during history read/.test(event.message ?? "")));
  await writeFile(join(run, "context-compaction-web-results.json"), JSON.stringify({ passed: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, run }));
} catch (error) {
  await page.screenshot({ path: join(run, "context-compaction-failure.png") }).catch(() => {});
  await writeFile(join(run, "context-compaction-web-results.json"), JSON.stringify({ passed: false, checks, errors, error: String(error), events: await events() }, null, 2));
  throw error;
} finally { await browser.close(); }

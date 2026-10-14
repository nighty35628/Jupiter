#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const run = resolve(process.argv[2] ?? "");
assert(run.startsWith("/tmp/jupiter-update-20261008/run-"), "Use an owned local synthetic-provider run");
const url = (await readFile(join(run, "browser-url.txt"), "utf8")).trim();
const origin = new URL(url).origin;
assert(new URL(origin).hostname === "127.0.0.1");
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
const checks = [];
let connectionId;
page.on("request", (request) => {
  const requestUrl = new URL(request.url());
  if (requestUrl.pathname === "/api/events") connectionId = requestUrl.searchParams.get("connectionId");
});
const check = (name, ok) => { checks.push({ name, ok: !!ok }); assert(ok, name); };
page.on("pageerror", (error) => errors.push(error.message));
const predictionCount = async () => (await readFile(join(run, "provider.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter((entry) => entry.kind === "prediction").length;
const typeAndSend = async (text) => {
  const input = page.locator("textarea").first();
  await input.fill(text);
  await input.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".composer textarea")?.disabled);
};
try {
  await page.goto(url);
  await page.locator("textarea").first().waitFor({ state: "visible" });
  // Pairing uses only this fixture's generated cookie and synthetic key; no user config.
  await page.evaluate(async (connectionId) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/lease/acquire", { method: "POST", headers: { "content-type": "application/json", "x-jupiter-csrf": session.csrfToken, "x-jupiter-connection": connectionId }, body: JSON.stringify({ force: true, confirm: "take-control" }) });
    if (!response.ok) throw new Error(`Could not take fixture control: ${response.status}`);
  }, connectionId);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.webWriter === "true");
  await page.locator("textarea").first().waitFor({ state: "visible" });
  await typeAndSend("SMOKE:prediction-one explain the result");
  const ghost = page.locator(".composer-prediction");
  await ghost.waitFor({ state: "visible", timeout: 20000 });
  check("first-cost-disclosure-remains-visible", await page.locator(".composer-prediction-notice").count() > 0);
  check("suggestion-not-draft", await page.locator("textarea").first().inputValue() === "");
  await page.screenshot({ path: join(run, "prediction-desktop-light.png"), fullPage: false });
  const beforeAccept = await predictionCount();
  await page.locator("textarea").first().press("Tab");
  check("tab-fills-draft", await page.locator("textarea").first().inputValue() === "Review the result and run the relevant tests.");
  await page.waitForTimeout(150);
  check("tab-does-not-send-or-predict-again", await predictionCount() === beforeAccept);
  await page.locator("textarea").first().fill("");
  check("accepted-suggestion-does-not-revive", await ghost.count() === 0);

  await typeAndSend("SMOKE:prediction-two explain the result");
  await ghost.waitFor({ state: "visible", timeout: 20000 });
  await page.locator("textarea").first().press("Escape");
  await page.reload();
  await page.locator("textarea").first().waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  check("dismissed-suggestion-does-not-revive-on-refresh", await ghost.count() === 0);
  check("refresh-does-not-bill-again", await predictionCount() === beforeAccept + 1);

  await typeAndSend("SMOKE:prediction-late explain the result");
  await page.waitForTimeout(400);
  await page.locator("textarea").first().fill("My own draft");
  await page.waitForTimeout(3000);
  check("late-result-does-not-overwrite-draft", await page.locator("textarea").first().inputValue() === "My own draft");
  check("late-result-is-hidden", await ghost.count() === 0);
  await page.locator("textarea").first().fill("");
  check("clearing-does-not-revive-late-result", await ghost.count() === 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await typeAndSend("SMOKE:prediction-mobile explain the result");
  await ghost.waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: join(run, "prediction-mobile.png"), fullPage: false });
  await page.locator(".composer-prediction-accept").click();
  check("mobile-accept-fills-draft", await page.locator("textarea").first().inputValue() === "Review the result and run the relevant tests.");
  check("mobile-accept-restores-focus", await page.locator("textarea").first().evaluate((element) => element === document.activeElement));
  check("no-page-errors", errors.length === 0);
  await writeFile(join(run, "prediction-web-results.json"), JSON.stringify({ checks, errors, browser: "Chrome production Web, local fake Provider", passed: true }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, evidence: join(run, "prediction-web-results.json") }));
} catch (error) {
  await page.screenshot({ path: join(run, "prediction-failure.png") }).catch(() => {});
  await writeFile(join(run, "prediction-web-results.json"), JSON.stringify({ checks, errors, passed: false, error: error.message }, null, 2));
  throw error;
} finally {
  await browser.close();
}

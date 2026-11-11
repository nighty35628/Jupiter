#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const run = resolve(process.argv[2] ?? "");
assert(run.startsWith("/tmp/jupiter-update-20261008/run-"), "Use an owned synthetic-service run");
const state = JSON.parse(await readFile(join(run, "state.json"), "utf8"));
assert.equal(state.mode, "web");
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(30000);
const errors = [];
const checks = [];
let connectionId;
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/events") connectionId = url.searchParams.get("connectionId");
});
await page.addInitScript(() => localStorage.setItem("jupiter.lang", "en"));

async function assertBottom(mode) {
  await page.waitForFunction(
    (expected) => {
      const app = document.querySelector(".app");
      const ctx = document.querySelector(".ctx");
      return (
        app?.dataset.bottomCollapsed === "false" &&
        app.dataset.ctxCollapsed === "true" &&
        app.dataset.webDrawerOpen === "false" &&
        ctx?.dataset.placement === "bottom" &&
        (!expected || ctx.dataset.mode === expected)
      );
    },
    mode,
    { timeout: 5000 },
  );
  assert(await page.locator(".ctx").isVisible());
  assert(await page.locator(".main textarea").first().isVisible());
  const frame = await page.evaluate(() => ({
    scrollX,
    left: document.querySelector(".app").getBoundingClientRect().left,
    right: document.querySelector(".app").getBoundingClientRect().right,
    width: innerWidth,
    rootScrollLeft: document.getElementById("root").scrollLeft,
    bodyScrollLeft: document.body.scrollLeft,
  }));
  assert(
    Math.abs(frame.left) <= 1 && frame.right <= frame.width + 1,
    `Workbench frame shifted: ${JSON.stringify(frame)}`,
  );
}

try {
  await page.goto(state.browserUrl);
  await page.locator("textarea").first().waitFor();
  await page.evaluate(async (id) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/lease/acquire", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jupiter-csrf": session.csrfToken,
        "x-jupiter-connection": id,
      },
      body: JSON.stringify({ force: true, confirm: "take-control" }),
    });
    if (!response.ok) throw new Error("Synthetic fixture lease failed");
  }, connectionId);
  await page.reload();
  await context.storageState({ path: join(run, "bottom-panel-browser-state.json") });
  await page.waitForFunction(() => document.documentElement.dataset.webWriter === "true");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("textarea")].some((input) => !input.disabled),
  );
  for (const width of [375, 727, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if ((await page.locator(".app").getAttribute("data-bottom-collapsed")) === "true")
      await page.getByRole("button", { name: "Toggle bottom bar", exact: true }).click();
    await assertBottom();
    for (const [label, mode] of [
      ["Files", "files"],
      ["Library", "library"],
      ["Side Chat", "sidechat"],
      ["Review", "review"],
      ["Terminal", "terminal"],
    ]) {
      const home = page
        .locator(".ctx-home-card")
        .filter({ has: page.getByText(label, { exact: true }) });
      if (await home.count()) await home.click();
      else {
        await page.getByRole("button", { name: "Add panel", exact: true }).click();
        await page.getByRole("menuitem", { name: label, exact: true }).click();
      }
      await assertBottom(mode);
      checks.push(`${width}:${mode}:stays-bottom`);
    }
    await page
      .locator(".ctx-tab")
      .filter({ has: page.locator(".ctx-tab-title", { hasText: /^Files$/ }) })
      .click();
    await assertBottom("files");
    await page.screenshot({ path: join(run, `bottom-panel-${width}.png`) });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      "Document overflow",
    );
    await page.getByRole("button", { name: "Toggle bottom bar", exact: true }).click();
    await page.getByRole("button", { name: "Toggle right sidebar", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ctx")?.dataset.placement === "side");
    assert(await page.locator(".ctx").isVisible());
    await page.getByRole("button", { name: "Toggle right sidebar", exact: true }).click();
    checks.push(`${width}:explicit-sidebar-toggle-still-works`);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(run, "bottom-panel-results.json"),
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks: checks.length, run }));
} catch (error) {
  await page.screenshot({ path: join(run, "bottom-panel-failure.png") }).catch(() => {});
  await writeFile(
    join(run, "bottom-panel-results.json"),
    JSON.stringify({ passed: false, checks, errors, failure: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}

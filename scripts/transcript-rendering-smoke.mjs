import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
const require = createRequire(new URL("../desktop/package.json", import.meta.url));
const { createServer } = await import(
  new URL("./dist/node/index.js", `file://${require.resolve("vite")}`).href
);
const server = await createServer({
  configFile: "desktop/vite.config.ts",
  root: "desktop",
  server: { port: 0, strictPort: false },
});
await server.listen();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  await mkdir("output/transcript-qa", { recursive: true });
  for (const viewport of [
    { width: 1360, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}qa/transcript.html`);
    const scroller = page.locator('[data-virtuoso-scroller="true"]');
    await scroller.waitFor();
    await page.waitForTimeout(1500);
    const toggle = page.locator(".plan-progress-toggle");
    await toggle.click();
    await page.screenshot({ path: `output/transcript-qa/${viewport.width}-expanded.png` });
    await page.getByRole("button", { name: "Advance plan" }).click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.match(await toggle.innerText(), /1\/2/);
    await toggle.click();
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    const beforeHeight = await scroller.evaluate((el) => el.scrollHeight);
    await page.getByRole("button", { name: "Finish stream" }).click();
    await page.waitForTimeout(500);
    const afterHeight = await scroller.evaluate((el) => el.scrollHeight);
    console.log({ width: viewport.width, beforeHeight, afterHeight });
    assert(Math.abs(afterHeight - beforeHeight) < 100, "Stream completion collapsed the transcript");
    for (const position of [1, 0.99, 0.98, 0.7, 0.3, 0]) {
      await scroller.evaluate((el, fraction) => {
        el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
      }, position);
      await page.waitForTimeout(500);
      const visible = await scroller.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        return [...el.querySelectorAll(".thread-inner")].some((item) => {
          const rect = item.getBoundingClientRect();
          return (
            rect.bottom > bounds.top &&
            rect.top < bounds.bottom &&
            item.textContent.trim().length > 0
          );
        });
      });
      assert(visible, `Blank transcript at ${position} (${viewport.width})`);
    }
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    assert.equal(
      await page.locator("[data-compaction-state]").evaluateAll((items) =>
        items.some((item) => {
          const r = item.getBoundingClientRect();
          return r.top >= 0 && r.bottom < innerHeight;
        }),
      ),
      false,
      "Compaction should scroll out of view",
    );
    assert.equal(await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `output/transcript-qa/${viewport.width}.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "PASS: real Chromium transcript scrolling, inline compaction, plan disclosure, desktop and mobile widths",
  );
} finally {
  await browser.close();
  await server.close();
}

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  await mkdir("../.probe-snapshots", { recursive: true });
  for (const width of [1280, 520]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(`${server.resolvedUrls.local[0]}qa/automations.html`);
    await page.getByRole("status").waitFor();
    await page.getByRole("button", { name: "暂停: 每日工作晨报", exact: true }).click();
    await page.getByRole("button", { name: "恢复: 每日工作晨报", exact: true }).click();
    await page.getByRole("status").waitFor();
    await page.screenshot({ path: `../.probe-snapshots/automations-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill("资料整理");
    await page.getByLabel("任务提示词", { exact: true }).fill("整理资料并生成报告");
    await page.getByLabel("模式", { exact: true }).selectOption("agent");
    await page.getByLabel("目标任务：验证完成后停止", { exact: true }).check();
    await page.getByLabel("任务目标", { exact: true }).fill("输出可验证的报告");
    await page.getByLabel("完成条件（每行一条）", { exact: true }).fill("报告存在\n来源可追溯");
    await page.getByLabel("允许操作范围", { exact: true }).fill("工作目录");
    assert.ok(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "No horizontal overflow");
    await page.screenshot({ path: `../.probe-snapshots/automations-editor-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("heading", { name: "资料整理", exact: true }).waitFor();
    console.log(`PASS automation controls and goal editor at ${width}px`);
    await page.close();
  }
} finally { await browser?.close(); await server.close(); }

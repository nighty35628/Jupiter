import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

// Exercise real layout/ResizeObserver behavior; jsdom cannot reproduce CSS zoom.
const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  for (const fontScale of ["small", "medium", "large"]) {
    for (const longTail of [false, true]) {
      await checkTranscript(fontScale, longTail);
    }
  }
} finally {
  await browser?.close();
  await server.close();
}

async function checkTranscript(fontScale, longTail) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.addInitScript((scale) => {
      sessionStorage.setItem("jupiter.splash.shown", "1");
      localStorage.setItem("jupiter.fontScale", scale);
      const callbacks = new Map();
      const listeners = new Map();
      let id = 0;
      window.isTauri = true;
      window.qaCommands = [];
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback(fn) { callbacks.set(++id, fn); return id; },
        unregisterCallback(key) { callbacks.delete(key); },
        convertFileSrc(path) { return path; },
        async invoke(cmd, args) {
          if (cmd === "plugin:event|listen") {
            const bucket = listeners.get(args.event) ?? [];
            bucket.push(args.handler);
            listeners.set(args.event, bucket);
            return args.handler;
          }
          if (cmd === "rpc_send") window.qaCommands.push(JSON.parse(args.line));
          if (cmd === "plugin:window|is_focused") return true;
          return null;
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.qaEmit = (event) => {
        for (const key of listeners.get("rpc:event") ?? []) {
          callbacks.get(key)?.({ payload: { data: JSON.stringify(event) } });
        }
      };
      window.qaReady = () => listeners.has("rpc:event");
    }, fontScale);
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => window.qaReady());
    await page.evaluate(() => window.qaEmit({
      type: "$tab_opened", tabId: "qa", workspaceDir: "scroll-fixture", active: true,
    }));
    await page.waitForFunction(() => window.qaCommands.some((cmd) => cmd.cmd === "tab_activate"));
    await page.evaluate((lastIsLong) => {
      window.qaEmit({
        type: "$settings", tabId: "qa", reasoningEffort: "high", editMode: "review",
        budgetUsd: null, workspaceDir: "scroll-fixture", recentWorkspaces: [],
        model: "deepseek-v4-flash", subagentModels: {}, contextTokens: {},
        showSystemEvents: true, processCardsDefaultOpen: false, promptHistory: [], version: "test",
      });
      window.qaEmit({ type: "$ready", tabId: "qa" });
      const messages = Array.from({ length: 60 }, (_, i) => [
        { kind: "user", text: `Question ${i + 1}`, messageId: `u${i}`, turn: i + 1 },
        {
          kind: "assistant", messageId: `a${i}`, turn: i + 1, pending: false,
          segments: [{
            kind: "text",
            text: `## Answer ${i + 1}\n\n` + "A long readable answer with multiple paragraphs.\n\n"
              .repeat((i === 59) === lastIsLong ? 150 : 8) + `END-ANSWER-${i + 1}`,
          }],
        },
      ]).flat();
      window.qaEmit({
        type: "$session_loaded", tabId: "qa", name: "scroll-regression",
        history: { generation: "g1", hasMore: true, beforeCursor: "older", totalTurns: 100, sourceSize: 100000 },
        snapshot: { sessionId: "sid", bindingId: 2, reason: "load", payloadBytes: 0, truncated: false },
        messages, sessionFiles: [],
        carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 },
      });
    }, longTail);
    const scroller = page.locator('[data-virtuoso-scroller="true"]');
    await scroller.waitFor();
    await page.waitForTimeout(1500);
    await scroller.hover();
    await page.mouse.wheel(0, -15000);
    await page.waitForTimeout(300);
    const away = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    assert.ok(away > 100, "Wheel-up must allow reading earlier messages");
    const historicalAnswers = await scroller.evaluate((el) =>
      [...el.querySelectorAll(".msg.assistant")].map((answer) => ({
        complete: answer.textContent.includes("END-ANSWER-"),
        folded: !!answer.querySelector(".transcript-elision-notice"),
      })),
    );
    assert.ok(historicalAnswers.length > 0 && historicalAnswers.every((answer) => answer.complete && !answer.folded),
      `${fontScale}: scrolling must not replace loaded historical answers with previews`);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 10000);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(500);
    const readMetrics = () => scroller.evaluate((el) => {
      const end = [...el.querySelectorAll("p")].find((p) => p.textContent === "END-ANSWER-60");
      const viewport = el.getBoundingClientRect();
      const endRect = end?.getBoundingClientRect();
      const row = end?.closest("[data-item-index]");
      return {
        gap: el.scrollHeight - el.clientHeight - el.scrollTop,
        endVisible: !!endRect && endRect.top >= viewport.top && endRect.bottom <= viewport.bottom,
        viewportMismatch: Math.abs(viewport.height - el.clientHeight),
        rowMismatch: row ? Math.abs(row.getBoundingClientRect().height - row.offsetHeight) : Infinity,
      };
    });
    const label = `${fontScale}, ${longTail ? "long" : "short"} final answer`;
    const atBottom = await readMetrics();
    assert.ok(Math.abs(atBottom.gap) <= 2, `${label}: bounced ${atBottom.gap}px away from bottom`);
    assert.ok(atBottom.endVisible, `${label}: last paragraph must be readable`);
    assert.ok(atBottom.viewportMismatch <= 1 && atBottom.rowMismatch <= 1,
      `${label}: measurement and scrolling must use the same coordinate space`);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(150);
      const settled = await readMetrics();
      assert.ok(Math.abs(settled.gap) <= 2 && settled.endVisible, `${label}: wheel at bottom must not bounce`);
    }
    assert.deepEqual(errors, [], `${label}: browser errors`);
    console.log(`PASS ${label}: bottom stable; final paragraph visible`);
  } finally {
    await page.close();
  }
}

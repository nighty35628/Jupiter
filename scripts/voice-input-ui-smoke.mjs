import { createServer } from "node:http";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

// Production Web UI + synthetic Android port. No phone, microphone or model API.
const out = resolve("output/voice-input-20261106");
await mkdir(out, { recursive: true });
let unexpectedRequests = 0;
const providerRequests = [];
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  providerRequests.push(req.url);
  if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "voice-qa" }] }));
  else if (req.url === "/v1/user/balance") res.end(JSON.stringify({
    is_available: true, balance_infos: [{ currency: "USD", total_balance: "10.00", granted_balance: "0.00", topped_up_balance: "10.00" }],
  }));
  else { unexpectedRequests++; res.writeHead(503).end(JSON.stringify({ error: { message: "No model calls in voice UI acceptance" } })); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const home = await mkdtemp(join(tmpdir(), "jupiter-voice-ui-"));
const workspace = join(home, "project");
await mkdir(join(home, ".jupiter")); await mkdir(workspace);
await writeFile(join(home, ".jupiter/config.json"), JSON.stringify({
  apiKey: "sk-jupiter-synthetic-voice-qa", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  model: "voice-qa", providerDialect: "openai-compatible", setupCompleted: true,
  promptPredictionsEnabled: false, workspaceDir: workspace, mcp: [], mcpServers: {},
  memory: { globalEnabled: false }, desktopUpdate: { disabled: true },
}), { mode: 0o600 });
const host = spawn(process.execPath, [resolve("dist/cli/index.js"), "web", workspace, "--no-open"], {
  cwd: workspace, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: "en_US.UTF-8", JUPITER_HOME: join(home, ".jupiter") },
  stdio: ["ignore", "pipe", "pipe"],
});
const bootstrap = await new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error("Web QA startup timed out")), 30000);
  createInterface({ input: host.stdout }).on("line", line => {
    const url = line.match(/http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[a-z0-9]+/i)?.[0];
    if (url) { clearTimeout(timer); done(url); }
  });
  host.on("exit", code => { clearTimeout(timer); fail(new Error("Web QA exited: " + code)); });
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext();
const checks = [];
try {
  for (const width of [390, 1280]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/", async route => {
      const response = await route.fetch();
      const html = (await response.text())
        .replace(/(name="jupiter-platform" content=")[^"]*/, "$1android")
        .replace(/(name="jupiter-run" content=")[^"]*/, "$1voice-qa");
      await route.fulfill({ response, body: html });
    });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("jupiter.lang", "en");
      localStorage.setItem("jupiter.speech.language", "en");
      window.voiceQaCommands = [];
      window.JupiterAndroid = {
        postMessage(raw) {
          const request = JSON.parse(raw);
          window.voiceQaCommands.push(request.command);
          const respond = result => queueMicrotask(() => window.JupiterAndroid.onmessage?.({
            data: JSON.stringify({ runId: "voice-qa", requestId: request.requestId, ok: true, result }),
          }));
          const event = (state, text) => queueMicrotask(() => window.JupiterAndroid.onmessage?.({
            data: JSON.stringify({ type: "speech", runId: "voice-qa",
              event: { sessionId: request.args.sessionId, state, text } }),
          }));
          if (request.command === "speechCapabilities") return respond({
            available: true, backend: "android", localAvailable: true, networkAvailable: true,
            autoLanguage: false, modelReady: true, modelBytes: 0,
          });
          if (request.command === "speechStart") { respond(null); event("recording"); return; }
          if (request.command === "speechFinish") {
            respond(null); event("transcribing"); event("result", "Multilingual voice test"); return;
          }
          if (request.command === "speechCancel") { respond(null); event("cancelled"); return; }
          respond(request.command === "consumeShare" ? null : false);
        },
      };
    });
    const url = new URL(bootstrap).origin;
    await page.goto(width === 390 ? bootstrap : url);
    const mic = page.getByRole("button", { name: "Start dictation", exact: true });
    await mic.waitFor();
    await page.locator(".splash").waitFor({ state: "hidden" });
    const textarea = page.locator(".main:visible .composer textarea").first();
    await textarea.fill("Existing draft ");
    await textarea.evaluate(e => e.setSelectionRange(e.value.length, e.value.length));
    await mic.click();
    await page.getByRole("button", { name: "Finish dictation", exact: true }).click();
    await assert.doesNotReject(async () => {
      await page.waitForFunction(() => [...document.querySelectorAll(".composer textarea")]
        .some(e => e.value === "Existing draft Multilingual voice test"));
    });
    assert.equal(await page.locator(".main:visible .msg.user").count(), 0, "Dictation auto-sent a message");
    await mic.click();
    await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();
    await mic.waitFor();
    const box = await textarea.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1, "Composer overflow");
    await page.screenshot({ path: join(out, `voice-ui-${width}.png`) });
    checks.push({ width, result: "pass", errors, syntheticNative: true });
    assert.deepEqual(errors, []);
    await page.unroute("**/");
    await page.goto(url);
    await page.locator(".composer textarea").first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Start dictation", exact: true }).count(), 0,
      "Ordinary browser advertises native dictation");
    await page.close();
  }
  await writeFile(join(out, "provider-request-paths.json"), JSON.stringify(providerRequests, null, 2));
  assert.equal(unexpectedRequests, 0, "Unexpected model request: " + providerRequests.join(", "));
  await writeFile(join(out, "ui-smoke.json"), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks));
} finally {
  await browser.close();
  host.kill("SIGTERM");
  await new Promise(done => host.exitCode !== null ? done() : host.once("exit", done));
  await new Promise(done => server.close(done));
}

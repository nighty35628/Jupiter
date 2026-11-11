const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { createServer } = require("node:http");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
const { Worker } = require("node:worker_threads");
const https = require("node:https");
const dns = require("node:dns/promises");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 30000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= end) throw new Error("Probe condition timed out"); await sleep(25); }
}
async function main() {
  const directory = fs.mkdtempSync("/tmp/jupiter-engine-");
  const home = `${directory}/home`, workspace = `${directory}/workspace`;
  fs.mkdirSync(`${home}/.jupiter`, { recursive: true }); fs.mkdirSync(workspace);
  const key = "synthetic-android-probe-" + randomUUID();
  const receipts = [], events = [], toolResponses = [];
  let child, terminal, webChild;
  const server = createServer((req, res) => { void (async () => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (req.url.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "android-local-synthetic", object: "model" }] })); return;
    }
    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Synthetic provider has no account endpoint" } })); return;
    }
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; assert(length < 1024 * 1024); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.messages?.[0]?.content?.startsWith("Predict one short next message")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ suggestion: null }) }, finish_reason: "stop" }] })); return;
    }
    const user = body.messages.findLast(m => m.role === "user");
    const text = String(user?.content ?? "");
    const receipt = { stream: body.stream === true, text, closed: false };
    receipts.push(receipt); res.on("close", () => { receipt.closed = true; receipt.completed = res.writableEnded; });
    if (text.includes("cancel")) { await sleep(15000); if (res.destroyed) return; }
    const afterUser = body.messages.slice(body.messages.lastIndexOf(user) + 1);
    toolResponses.push(...afterUser.filter(m => m.role === "tool").map(m => String(m.content)));
    const toolsDone = afterUser.some(m => m.role === "tool");
    const tool = text.includes("tools") && !toolsDone && body.tools?.some(t => t.function.name === "write_file");
    const content = `ANDROID_LOCAL_OK ${toolsDone ? "TOOLS_VERIFIED" : "CHAT_VERIFIED"}`;
    const call = { id: "android-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "verified.txt", content: "android real tool output\n" }) } };
    const calls = [call,
      { id: "android-python", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: 'python3 -c "assert sum([1, 2]) == 3; print(\'ANDROID_PY_OK\')"' }) } },
      { id: "android-node", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: 'node -e "require(\'node:assert/strict\').equal(2+2,4); console.log(\'ANDROID_NODE_OK\')"' }) } },
    ];
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); return;
    }
    res.setHeader("content-type", "text/event-stream");
    const delta = (value, reason = null) => res.write(`data: ${JSON.stringify({ id: "android-local", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`);
    delta({ role: "assistant" });
    if (tool) { for (const [index, value] of calls.entries()) delta({ tool_calls: [{ index, ...value }] }); delta({}, "tool_calls"); }
    else { delta({ content: content.slice(0, 8) }); await sleep(20); delta({ content: content.slice(8) }); delta({}, "stop"); }
    res.end("data: [DONE]\n\n");
  })().catch(error => { console.error("SYNTHETIC_PROVIDER_ERROR", error.message.replaceAll(key, "[redacted]")); if (!res.headersSent) res.writeHead(500); res.end(); }); });
  try {
    const address = await Promise.race([dns.lookup("example.com"), sleep(10000).then(() => { throw new Error("Android DNS timed out"); })]);
    assert(address.address);
    const cert = fs.readFileSync("/opt/jupiter/probe-cert.pem");
    const tls = https.createServer({ key: fs.readFileSync("/opt/jupiter/probe-key.pem"), cert }, (_req, res) => res.end("ANDROID_TLS_OK"));
    await new Promise((resolve, reject) => { tls.once("error", reject); tls.listen(0, "127.0.0.1", resolve); });
    const tlsRequest = ca => new Promise((resolve, reject) => {
      const request = https.get({ host: "127.0.0.1", port: tls.address().port, ca, rejectUnauthorized: true, timeout: 3000 }, response => {
        let text = ""; response.on("data", value => { text += value; }); response.once("end", () => resolve(text)); response.once("error", reject);
      }); request.once("error", reject); request.once("timeout", () => request.destroy(new Error("TLS probe timed out")));
    });
    try {
      assert.equal(await tlsRequest(cert), "ANDROID_TLS_OK");
      await assert.rejects(tlsRequest(undefined), /self.signed|certificate/i);
    } finally { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); }
    console.log("JUPITER_ENGINE_STEP dns-tls");
    const run = (program, args) => {
      const result = spawnSync(program, args, { cwd: workspace, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr); return result.stdout;
    };
    run("git", ["init", "--initial-branch=main"]);
    fs.writeFileSync(`${workspace}/seed.txt`, "original\n");
    run("git", ["add", "seed.txt"]);
    run("git", ["-c", "user.name=Android QA", "-c", "user.email=qa@example.invalid", "commit", "-m", "synthetic baseline"]);
    fs.writeFileSync(`${workspace}/seed.txt`, "modified\n");
    assert.match(run("git", ["diff", "--", "seed.txt"]), /\+modified/);
    assert.match(run("rg", ["modified", "seed.txt"]), /modified/);
    console.log("JUPITER_ENGINE_STEP git-ripgrep");
    const pty = require("./node_modules/node-pty");
    terminal = pty.spawn("/bin/sh", [], { name: "xterm-256color", cols: 80, rows: 24, cwd: workspace, env: { PATH: process.env.PATH, HOME: home } });
    let terminalOutput = "", terminalExit;
    terminal.onData(data => { terminalOutput += data; }); terminal.onExit(value => { terminalExit = value; });
    terminal.resize(90, 30); terminal.write("stty size\n");
    await until(() => /30\s+90/.test(terminalOutput));
    terminal.write("node -e \"process.stdout.write('ANDROID_PTY_'+'CHILD_RUNNING\\n'); setInterval(()=>{},1000)\"\n");
    await until(() => terminalOutput.includes("ANDROID_PTY_CHILD_RUNNING"));
    terminal.write("\x03");
    terminal.write("printf 'ANDROID_PTY_%s\\n' OK; exit $?\n");
    await until(() => terminalExit); assert.equal(terminalExit.exitCode, 0); assert.match(terminalOutput, /(?:^|\r?\n)ANDROID_PTY_OK\r?\n/);
    console.log("JUPITER_ENGINE_STEP pty");
    const image = fs.readFileSync("/opt/jupiter/probe.png");
    const worker = new Worker("/opt/jupiter/dist/cli/image-worker.cjs", { workerData: { bytes: image, mode: "request" } });
    const result = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    await worker.terminate(); assert.equal(result.ok, true, JSON.stringify(result)); assert(result.value.image.data.length);
    assert.equal(result.value.image.width, 12); assert.equal(result.value.image.height, 8);
    console.log("JUPITER_ENGINE_STEP image-worker");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    fs.writeFileSync(`${home}/.jupiter/config.json`, JSON.stringify({ apiKey: key, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      providerDialect: "openai-compatible", model: "android-local-synthetic", workspaceDir: workspace, editMode: "yolo", thinkingEnabled: false,
      setupCompleted: true, search: false, computerUse: { enabled: false }, mcp: [], mcpServers: {}, dashboard: { enabled: false },
      desktopUpdate: { disabled: true }, memory: { globalEnabled: false, confirmWrites: true }, lang: "en" }), { mode: 0o600 });
    const launch = () => {
      child = spawn(process.execPath, ["--max-old-space-size=768", "/opt/jupiter/dist/cli/index.js", "desktop", "--dir", workspace], {
        cwd: workspace, env: { PATH: process.env.PATH, HOME: home, TMPDIR: "/tmp", JUPITER_RUNTIME_SURFACE: "web-beta", JUPITER_WEB_ACCESS_MODE: "local", NO_COLOR: "1", CI: "1" }, stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", error => console.error("ENGINE_CHILD_ERROR", error.message));
      child.stderr.on("data", data => console.error("ENGINE_STDERR", String(data).replaceAll(key, "[redacted]").slice(0, 2000)));
      createInterface({ input: child.stdout }).on("line", line => { try { const event = JSON.parse(line); events.push(event); if (["$error", "error"].includes(event.type)) console.error("ENGINE_EVENT_ERROR", JSON.stringify(event).replaceAll(key, "[redacted]")); } catch { console.error("ENGINE_INVALID_LINE", line.slice(0, 200)); } });
    };
    const send = value => child.stdin.write(JSON.stringify(value) + "\n");
    launch(); await until(() => events.some(e => e.type === "$ready"), 60000);
    let tabId = events.findLast(e => e.type === "$ready").tabId;
    const input = async (cmd, text) => {
      const cursor = events.length; send({ cmd, text, tabId, clientId: randomUUID() });
      await until(() => events.slice(cursor).some(e => e.type === "$turn_complete"), 60000);
      assert(events.slice(cursor).some(e => e.type === "model.final" && e.content?.includes("ANDROID_LOCAL_OK")), JSON.stringify(events.slice(cursor).map(e => e.type)));
    };
    await input("ask_light", "android normal chat"); console.log("JUPITER_ENGINE_STEP chat");
    await input("user_input", "android tools write verified.txt with no plan");
    assert.equal(fs.readFileSync(`${workspace}/verified.txt`, "utf8"), "android real tool output\n");
    assert(events.some(e => e.type === "tool.result" && e.ok)); console.log("JUPITER_ENGINE_STEP real-tool");
    assert(toolResponses.some(text => text.includes("ANDROID_PY_OK")), "Python tool result missing");
    assert(toolResponses.some(text => text.includes("ANDROID_NODE_OK")), "Node tool result missing");
    const cursor = events.length;
    send({ cmd: "ask_light", text: "android cancel", tabId, clientId: randomUUID() });
    await until(() => receipts.some(r => r.text.includes("cancel"))); send({ cmd: "abort", tabId });
    await until(() => events.slice(cursor).some(e => e.type === "$turn_complete"), 10000);
    await until(() => receipts.some(r => r.text.includes("cancel") && r.closed && !r.completed), 10000);
    console.log("JUPITER_ENGINE_STEP cancel");
    await input("ask_light", "android after abort");
    child.kill("SIGTERM"); await until(() => child.exitCode !== null || child.signalCode !== null, 5000);
    let webUrl;
    webChild = spawn(process.execPath, ["--max-old-space-size=768", "/opt/jupiter/dist/cli/index.js", "web", workspace, "--no-open"], {
      cwd: workspace, env: { PATH: process.env.PATH, HOME: home, TMPDIR: "/tmp", NO_COLOR: "1", CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    webChild.on("error", error => console.error("WEB_CHILD_ERROR", error.message));
    createInterface({ input: webChild.stdout }).on("line", line => {
      const match = line.match(/http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[a-zA-Z0-9_-]+/);
      if (match) webUrl = match[0];
    });
    webChild.stderr.on("data", data => console.error("WEB_STDERR", String(data).replaceAll(key, "[redacted]").slice(0, 1000)));
    await until(() => webUrl, 60000);
    const response = await fetch(new URL(webUrl).origin, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); assert.match(await response.text(), /app\.js/);
    console.log("JUPITER_WEB_READY " + JSON.stringify({ runId: process.argv[2], url: webUrl }));
    await sleep(90000);
    console.log("JUPITER_ENGINE_RESULT " + JSON.stringify({ schemaVersion: 1, probeKind: "jupiter-engine", runId: process.argv[2], pty: true, imageWorker: true, chat: true, tools: true, git: true, ripgrep: true, dns: true, tls: true, pythonCommand: true, nodeCommand: true, cancel: true, recovery: true, requests: receipts.length }));
  } finally {
    terminal?.kill();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM"); await until(() => child.exitCode !== null || child.signalCode !== null, 5000).catch(() => child.kill("SIGKILL"));
    }
    if (webChild && webChild.exitCode === null) {
      webChild.kill("SIGTERM"); await until(() => webChild.exitCode !== null || webChild.signalCode !== null, 5000).catch(() => webChild.kill("SIGKILL"));
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

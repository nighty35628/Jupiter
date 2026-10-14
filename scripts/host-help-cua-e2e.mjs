import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

assert(process.argv.includes("--auto"), "Pass --auto to permit opening and inspecting System Settings with real desktop input.");
assert.equal(process.platform, "darwin", "This acceptance scenario is macOS-only.");
const cliIndex = process.argv.indexOf("--cli");
const cli = resolve(cliIndex >= 0 ? process.argv[cliIndex + 1] : "dist/cli/index.js");
const home = homedir();
const original = JSON.parse(await readFile(join(home, ".jupiter/config.json"), "utf8"));
assert(original.apiKey || process.env.DEEPSEEK_API_KEY, "A configured API key is required; it will not be printed.");
const isolated = await mkdtemp(join(tmpdir(), "jupiter-host-help-e2e-"));
const workspace = join(isolated, "workspace");
await mkdir(workspace);
await mkdir(join(isolated, ".jupiter"));
// Share only the desktop lease and driver's existing authorization, never user sessions.
await mkdir(join(home, ".jupiter/computer-use"), { recursive: true });
await symlink(join(home, ".jupiter/computer-use"), join(isolated, ".jupiter/computer-use"));
if (existsSync(join(home, ".cua-driver"))) await symlink(join(home, ".cua-driver"), join(isolated, ".cua-driver"));
await mkdir(join(isolated, "Library/Caches"), { recursive: true });
if (existsSync(join(home, "Library/Caches/cua-driver"))) await symlink(join(home, "Library/Caches/cua-driver"), join(isolated, "Library/Caches/cua-driver"));
await writeFile(join(isolated, ".jupiter/config.json"), JSON.stringify({
  apiKey: original.apiKey, baseUrl: original.baseUrl, providerDialect: original.providerDialect,
  model: original.model, visionModels: original.visionModels, imageTransport: original.imageTransport,
  proxy: original.proxy, computerUse: { enabled: true, permissionMode: "standard" },
  editMode: "yolo", thinkingEnabled: false, reasoningEffort: "medium", lang: "zh-CN",
}), { mode: 0o600 });

// Record the final HTTP body shape without credentials, user text, or image bytes.
const capture = `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const spawn=cp.spawn;cp.spawn=(command,args,opts)=>spawn(command,args,typeof command==='string'&&command.endsWith('/cua-driver')?{...opts,env:{...opts?.env,HOME:${JSON.stringify(home)}}}:opts);syncBuiltinESMExports();const real=globalThis.fetch.bind(globalThis);globalThis.fetch=async(input,init)=>{if(init?.body){try{const b=JSON.parse(String(init.body));if(Array.isArray(b.messages)){const row={model:b.model,tools:(b.tools??[]).map(t=>t.function?.name),images:b.messages.reduce((n,m)=>n+(Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url'||p.type==='file').length:0),0),help:b.messages.filter(m=>typeof m.content==='string'&&m.content.includes('# Jupiter Host Help ')).length};process.stderr.write('[http-contract]'+JSON.stringify(row)+String.fromCharCode(10));}}catch{}}return real(input,init)};`;
const node = process.argv.includes("--installed-node") ? join(dirname(cli), "../../node") : process.execPath;
const child = spawn(node, ["--import", `data:text/javascript,${encodeURIComponent(capture)}`, cli, "desktop", "--dir", workspace], {
  env: { ...process.env, HOME: isolated, PATH: `${home}/.local/bin:${process.env.PATH}`, JUPITER_RUNTIME_SURFACE: "desktop", JUPITER_DEBUG_MCP: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
const events = [];
const http = [];
let stage = "startup";
let tabId;
let stderr = "";
const send = (msg) => child.stdin.write(`${JSON.stringify({ ...msg, ...(tabId ? { tabId } : {}) })}\n`);
createInterface({ input: child.stdout }).on("line", (line) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  events.push({ ...event, stage });
  if (event.type === "$ready") tabId = event.tabId;
  if (event.type === "tool.intent") console.log(`${stage}: ${event.name}`);
  if (event.type === "model.final") console.log(`${stage}: ${event.content}`);
  if (event.type === "$error") console.log(`${stage}: error ${event.message}`);
});
createInterface({ input: child.stderr }).on("line", (line) => {
  if (line.startsWith("[http-contract]")) http.push({ ...JSON.parse(line.slice(15)), stage });
  else stderr = `${stderr}\n${line}`.slice(-5000);
});
async function until(predicate, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert(child.exitCode === null && child.signalCode === null, `Jupiter exited: ${stderr}`);
    assert(Date.now() < deadline, `Timed out during ${stage}: ${stderr}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}
let report;
try {
  await until(() => events.some((e) => e.type === "$ready"), 45000);
  send({ cmd: "settings_get" });
  await until(() => events.some((e) => e.type === "$settings" && e.computerUseStatus), 5000);
  const settings = events.findLast((e) => e.type === "$settings");
  assert.equal(settings?.computerUseStatus?.state, "idle", "Startup must not acquire desktop control.");
  stage = "ask";
  send({ cmd: "ask_light", text: "Jupiter 支持 computer use 吗？我现在能使用吗？" });
  await until(() => events.some((e) => e.stage === stage && e.type === "$turn_complete"));
  const ask = events.findLast((e) => e.stage === "ask" && e.type === "model.final")?.content;
  assert(ask, "Ask must answer.");
  assert(http.filter((r) => r.stage === "ask").every((r) => r.tools.length === 0), "Ask must not advertise tools.");
  assert(http.some((r) => r.stage === "ask" && r.help === 1), "Ask must receive the official manual exactly once.");
  stage = "agent";
  send({ cmd: "user_input", text: "现在能 computer use 了吗？打开 macOS 系统设置给我看看。优先用当前截图和鼠标点击 Apple 菜单及系统设置；若无法确认菜单点击结果，可以用正常命令启动系统设置再截图确认。不修改任何系统选项。" });
  await until(() => events.some((e) => e.stage === stage && e.type === "$turn_complete"));
  const intents = events.filter((e) => e.stage === "agent" && e.type === "tool.intent").map((e) => e.name);
  const screenshots = events.filter((e) => e.stage === "agent" && e.type === "tool.result" && e.attachments?.length);
  const final = events.findLast((e) => e.stage === "agent" && e.type === "model.final")?.content;
  assert(intents.includes("computer_use_get_desktop_state"), "The actual Jupiter model must request a screenshot.");
  assert(screenshots.length >= 2, "Opening Settings requires a before/after screenshot.");
  assert(http.some((r) => r.stage === "agent" && r.images > 0), "Screenshots must reach the model's real HTTP body.");
  assert(final, "Agent must finish with an answer.");
  assert(/(?:已|成功|打开了|opened|open now|now open|已经).*(?:系统设置|System Settings)|(?:系统设置|System Settings).*(?:打开|opened|open|前台|front)/i.test(final) && !/(?:没有|未|没能|无法|cannot|couldn.t).{0,20}(?:打开|open)/i.test(final), "A tool-chain pass is not a Settings-navigation pass.");
  const settled = events.findLast((e) => e.type === "$settings")?.computerUseStatus;
  assert.equal(settled?.state, "idle", "The completed turn must release desktop ownership.");
  assert(!existsSync(join(home, ".jupiter/computer-use/desktop.lock")), "No desktop lease may be leaked.");
  report = { passed: true, cli, ask, final, tools: intents, screenshots: screenshots.length, http, settled };
  console.log(JSON.stringify({ passed: true, cli, tools: intents, screenshots: screenshots.length, imageRequests: http.filter((r) => r.images > 0).length, settled }, null, 2));
} catch (error) {
  report = {
    passed: false, error: String(error), stderr, http,
    results: events.filter((e) => ["model.final", "tool.intent", "$error", "$settings", "tool.result"].includes(e.type)).map((e) => ({
      type: e.type, stage: e.stage, name: e.name, content: e.type === "model.final" ? e.content : undefined,
      output: e.type === "tool.result" ? e.output : undefined, status: e.computerUseStatus,
    })),
  };
  throw error;
} finally {
  child.kill("SIGTERM");
  const exited = await Promise.race([once(child, "exit").then(() => true), new Promise((done) => setTimeout(() => done(false), 10000))]);
  if (!exited) { child.kill("SIGKILL"); await once(child, "exit"); }
  await mkdir("tmp/cua", { recursive: true });
  let screenshotIndex = 0;
  for (const event of events.filter((e) => e.type === "tool.result" && e.attachments?.length)) {
    for (const image of event.attachments) await copyFile(join(isolated, ".jupiter/attachments/v1/objects", image.id, "image"), `tmp/cua/host-help-${++screenshotIndex}.webp`);
  }
  await rm(isolated, { recursive: true, force: true });
  if (report) {
    await mkdir("tmp/cua", { recursive: true });
    await writeFile("tmp/cua/host-help-e2e.json", JSON.stringify(report, null, 2));
  }
}

#!/usr/bin/env node
// Real-process acceptance, not unit tests. Never imports application source into this runner.
// node scripts/update-reliability-smoke.mjs --help
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = "/tmp/jupiter-update-20261008";
const argv = process.argv.slice(2);
const mode = argv[0] ?? "web";
const value = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  assert(argv[i + 1] && !argv[i + 1].startsWith("--"), `${flag} requires a value`);
  return argv[i + 1];
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const syntheticKey = "sk-jupiter-isolated-synthetic-20261008-never-real";
const contentA = "JUPITER-SYNTHETIC-A\n" + "a0123456789\\\"\n".repeat(4096);
const contentB = "JUPITER-SYNTHETIC-B\n" + "b9876543210\\\"\n".repeat(4096);
const models = ["smoke-model", "smoke-empty-models", "smoke-fault-models"];
const help = `Local-only production acceptance. Node >=22; no install/build/API payment.
  node scripts/update-reliability-smoke.mjs self-check
  node scripts/update-reliability-smoke.mjs web [--cli dist/cli/index.js] [--no-keep]
  node scripts/update-reliability-smoke.mjs prepare-native
  node scripts/update-reliability-smoke.mjs native --driver /tmp/.../target/debug/jupiter-smoke-native [--cli dist/cli/index.js]
  node scripts/update-reliability-smoke.mjs native-ui --app '/tmp/.../Jupiter Reliability QA.app' [--cli /absolute/new/dist/cli/index.js] [--node /absolute/node]
  node scripts/update-reliability-smoke.mjs stop --run /tmp/jupiter-update-20261008/run-...
Web stays alive by default, including on assertion failure, until SIGINT/SIGTERM or stop.
Browser URL is minted after probes; state.json and browser-url.txt are local-only artifacts.
Optional --expected-cli-sha256 HASH binds acceptance to the parent's completed build.
Native driver is an independent hidden Tauri host using a byte-identical rpc.rs snapshot.
It is supplemental RPC evidence only, never Desktop acceptance.
native-ui execs the real QA executable through sandbox-exec. --launch-services registers
the temporary bundle using a generated wrapper with the same isolated environment/sandbox.
Its default CLI is the QA bundle's Contents/Resources/dist/cli/index.js, not the repo's old dist.
It keeps the QA process/provider for parent CUA; it sends no UI or RPC inputs itself.
native-ui requires the unique QA bundle ID/product name; optional --expected-app-sha256 HASH.
Its macOS sandbox denies IP egress except the owned provider, and Node has an additional guard.
state.json, launch-env.json, native-commands.jsonl, native-sidecar-events.jsonl, provider.jsonl
and native-evidence.json are evidence, NOT an automatic Desktop pass. Use the authenticated
control /evidence endpoint (state.json has port/token) to refresh evidence after parent CUA.
prepare-native emits offline build instructions; missing cached crates must NOT be downloaded.
Stages: 0 isolation/artifact identity; 1 host/Node/provider; 2 long tools/identity;
3 delay/cancel/auth failure/truncated stream/recovery. Not a claim to cover every update requirement.
All output is under ${base}; never reads user config, .env, Keychain, or installed Jupiter.
Only synthetic inputs are logged. Child env is rebuilt, not inherited; Node TCP egress is
restricted to this run's provider port (other loopback services are refused too).
`;
if (mode === "--help" || argv.includes("--help")) {
  console.log(help);
  process.exit(0);
}
assert(["self-check", "web", "prepare-native", "native", "native-ui", "stop"].includes(mode), help);
assert(Number(process.versions.node.split(".")[0]) >= 22, "Node 22+ required");

async function contained(path) {
  const actualBase = await realpath(base);
  const actual = await realpath(path);
  assert(actual.startsWith(actualBase + "/"), "Artifact must be inside the owned /tmp directory");
  return actual;
}
if (mode === "stop") {
  const run = await contained(resolve(value("--run", "")));
  const state = JSON.parse(await readFile(join(run, "state.json"), "utf8"));
  assert(Number.isSafeInteger(state.controlPort) && state.controlToken, "Missing control endpoint");
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/stop`, {
    method: "POST", headers: { authorization: `Bearer ${state.controlToken}` },
    signal: AbortSignal.timeout(3000), redirect: "error",
  });
  assert.equal(response.status, 200);
  console.log(`Stop requested for ${run}; inspect state.json for stopped status.`);
  process.exit(0);
}

await mkdir(base, { recursive: true, mode: 0o700 });
const run = await mkdtemp(join(base, mode === "prepare-native" ? "native-" : "run-"));
const home = join(run, "home");
const workspace = join(run, "workspace");
const temp = join(run, "tmp");
for (const path of [join(home, ".jupiter"), workspace, temp]) await mkdir(path, { recursive: true });
const journal = (name, record) => appendFileSync(join(run, name), JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", { mode: 0o600 });
const save = (name, object) => writeFile(join(run, name), JSON.stringify(object, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replaceAll(syntheticKey, "[synthetic-key-redacted]");
const report = { mode, run, startedAt: new Date().toISOString(), status: "preparing", assertions: [],
  nativeScope: mode === "native-ui" ? "real newly built QA Desktop.app; acceptance pending parent CUA" : "supplemental independent RPC driver; not Desktop acceptance",
  browserStatus: "not_checked_by_this_script", stages: {}, artifacts: [] };
function check(name, condition, details = {}) {
  const result = { name, ok: Boolean(condition), ...details };
  report.assertions.push(result);
  journal("assertions.jsonl", result);
  assert(condition, name);
}
async function fingerprint(path) {
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: hash(bytes), mtime: (await stat(path)).mtime.toISOString() };
}
async function inventory(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected symlink in production artifact tree: ${path}`);
    if (entry.isDirectory()) files.push(...await inventory(path));
    else if (entry.isFile()) files.push(await fingerprint(path));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// A child preload covers undici/http/https TCP connections, including background update checks.
// It does not patch the provider protocol or business code. Refuse unknown socket signatures.
const guard = join(run, "loopback-only.mjs");
await writeFile(guard, `import net from 'node:net';
import fs, { appendFileSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
const file=${JSON.stringify(join(run, "network.jsonl"))};
const emit=r=>appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),pid:process.pid,ppid:process.ppid,...r})+'\\n',{mode:0o600});
emit({kind:'process',entry:process.argv[1],argv:process.argv.slice(2),home:process.env.HOME,cwd:process.cwd()});
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 let a=args; if(Array.isArray(a[0])) a=a[0];
 let o=a[0]; if(typeof o!=='object'||o===null) o=typeof o==='number'||/^\\d+$/.test(String(o))?{port:o,host:typeof a[1]==='string'?a[1]:'127.0.0.1'}:{path:o};
 const host=o.host??'127.0.0.1';
 const ports=JSON.parse(readFileSync(${JSON.stringify(join(run, "allowed-ports.json"))},'utf8'));
 const allowed=!o.path&&['127.0.0.1','::1'].includes(host)&&ports.includes(Number(o.port));
 emit({kind:'connect',host,port:o.port,allowed});
 if(!allowed) throw new Error('SMOKE_EGRESS_DENIED');
 this.once('connect',()=>emit({kind:'connected',host,port:o.port,localPort:this.localPort,remotePort:this.remotePort}));
 return original.apply(this,args);
};
// Observational tees only: preserve writes, byte counts, stdin flow and the actual Rust pipes.
if(${JSON.stringify(mode === "native-ui")}||process.env.JUPITER_SMOKE_CAPTURE_RPC==='1'){
 const buffers={stdin:'',stdout:''};
 const decoders={stdin:new StringDecoder('utf8'),stdout:new StringDecoder('utf8')};
 const clean=s=>String(s).replaceAll(${JSON.stringify(syntheticKey)},'[synthetic-key-redacted]');
 const observe=(channel,chunk)=>{
  buffers[channel]+=Buffer.isBuffer(chunk)?decoders[channel].write(chunk):String(chunk);
  let end;
  while((end=buffers[channel].indexOf('\\n'))>=0){
   const line=buffers[channel].slice(0,end);buffers[channel]=buffers[channel].slice(end+1);
   try{
    const parsed=JSON.parse(line);
    const safe=JSON.parse(JSON.stringify(parsed,(k,v)=>typeof v==='string'&&/apiKey|password|secret|token|authorization|^key$/i.test(k)?'[redacted]':typeof v==='string'?clean(v):v));
    const name=channel==='stdin'?'native-commands.jsonl':'native-sidecar-events.jsonl';
    appendFileSync(${JSON.stringify(run)}+'/'+name,JSON.stringify({ts:new Date().toISOString(),pid:process.pid,ppid:process.ppid,channel,bytes:Buffer.byteLength(line),[channel==='stdin'?'command':'event']:safe})+'\\n',{mode:0o600});
   }catch{}
  }
  if(buffers[channel].length>8*1024*1024)throw new Error('SMOKE_RPC_CAPTURE_LIMIT');
 };
 const write=fs.writeSync;
 fs.writeSync=function(fd,data,...args){
  const written=write.call(this,fd,data,...args);
  if(fd===1){
   const bytes=typeof data==='string'?Buffer.from(data,typeof args[1]==='string'?args[1]:'utf8'):data;
   observe('stdout',bytes.subarray(typeof data==='string'?0:(args[0]??0),(typeof data==='string'?0:(args[0]??0))+written));
  }
  return written;
 };
 const stdinEmit=process.stdin.emit;
 process.stdin.emit=function(event,...args){if(event==='data')observe('stdin',args[0]);return stdinEmit.call(this,event,...args);};
}
syncBuiltinESMExports();
`, { mode: 0o600 });
function isolatedEnv() {
  return {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
    TMPDIR: temp, TMP: temp, TEMP: temp, SHELL: "/bin/sh", ZDOTDIR: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "en_US.UTF-8",
    CI: "1", NO_COLOR: "1", JUPITER_NO_OPEN: "1", NODE_OPTIONS: `--import=${guard}`,
    JUPITER_SMOKE_CAPTURE_RPC: mode === "web" ? "1" : "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  };
}

async function prepareNative() {
  const original = join(repo, "desktop/src-tauri/src/rpc.rs");
  const source = await readFile(original);
  const dir = join(run, "driver");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/rpc.rs"), source);
  await writeFile(join(dir, "Cargo.toml"), `[package]
name = "jupiter-smoke-native"
version = "0.0.0"
edition = "2021"
[build-dependencies]
tauri-build = { version = "2", features = [] }
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
parking_lot = "0.12"
anyhow = "1"
which = "7"
`);
  await writeFile(join(dir, "build.rs"), 'fn main() { tauri_build::build() }\n');
  await writeFile(join(dir, "tauri.conf.json"), JSON.stringify({ productName: "JupiterIsolatedSmoke",
    version: "0.0.0", identifier: "local.jupiter.isolated.smoke", build: { frontendDist: "ui" },
    app: { windows: [], security: { csp: null } }, bundle: { active: false, icon: ["icon.png"] } }, null, 2));
  // Tauri's generate_context requires an RGBA PNG even for a windowless host.
  await writeFile(join(dir, "icon.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQ2Rn1HwAEUwIvpKF2aQAAAABJRU5ErkJggg==", "base64"));
  await mkdir(join(dir, "ui"));
  await writeFile(join(dir, "ui/index.html"), "<!doctype html><title>Isolated RPC acceptance host</title>\n");
  await writeFile(join(dir, "src/main.rs"), `mod rpc;
use std::io::{BufRead, Write};
use tauri::{Listener, Manager};
fn output(value: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", value);
    let _ = out.flush();
}
fn main() {
    tauri::Builder::default().manage(rpc::RpcState::default()).setup(|app| {
        #[cfg(target_os = "macos")]
        app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
        for channel in ["rpc:event", "rpc:stderr", "rpc:exit"] {
            app.listen(channel, move |event| {
                let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap_or_default();
                output(serde_json::json!({"channel": channel, "payload": payload}));
            });
        }
        rpc::rpc_spawn(app.handle().clone(), app.state()).map_err(std::io::Error::other)?;
        // Exercise the real idempotent-spawn branch without a second Node daemon.
        rpc::rpc_spawn(app.handle().clone(), app.state()).map_err(std::io::Error::other)?;
        output(serde_json::json!({"channel":"harness:ready", "payload":{"pid":std::process::id(), "rpcSourceSha256":${JSON.stringify(hash(source))}}}));
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let result = rpc::rpc_send(handle.state(), line);
                if let Err(error) = result {
                    output(serde_json::json!({"channel":"harness:error", "payload":error}));
                }
            }
            let _ = rpc::rpc_kill(handle.state());
            output(serde_json::json!({"channel":"harness:stopped", "payload":{}}));
            handle.exit(0);
        });
        Ok(())
    }).run(tauri::generate_context!()).expect("isolated Tauri host failed");
}
`);
  // Copy only dependency caches; Cargo must not write through a symlink into the user's cache.
  const instructions = `# Native Production RPC Driver

Original rpc.rs copied byte-for-byte (SHA-256 ${hash(source)}).
This is a fresh independent real Tauri/Wry host, no mock runtime, no app plugins,
no window, no single-instance reuse, no installed Jupiter. It calls the actual
rpc_spawn/rpc_send/rpc_kill functions and emits their real rpc:* events to stdout.
It does not prove packaged resource resolution, desktop React UI or OS permissions.
JUPITER_CLI pins an absolute newly built Node CLI and temporary workspace.

Build only after the parent's concurrent Cargo work finishes. This command does
not use or modify the repository target directory.
Build using already installed toolchain binaries and cached crates ONLY. Replace
the paths below with absolute installed toolchain paths (not rustup shims), and a
registry cache directory. Do not copy .cargo/config or credentials, symlink a
real CARGO_HOME/registry, or run online Cargo. Use a local APFS clone below (macOS);
on other filesystems replace cp -cR with cp -R, allowing for cache disk usage.
Use no spaces in toolchain/artifact paths (rpc.rs splits JUPITER_CLI on whitespace).

\`\`\`sh
mkdir -p '${run}/cargo-home'
cp -cR /ABSOLUTE/EXISTING/CARGO/registry '${run}/cargo-home/registry'
env -i HOME='${home}' TMPDIR='${temp}' PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
  CARGO_HOME='${run}/cargo-home' CARGO_TARGET_DIR='${run}/native-target' \\
  RUSTC=/ABSOLUTE/TOOLCHAIN/bin/rustc RUSTDOC=/ABSOLUTE/TOOLCHAIN/bin/rustdoc \\
  /ABSOLUTE/TOOLCHAIN/bin/cargo build --offline --manifest-path '${dir}/Cargo.toml'
node '${join(repo, "scripts/update-reliability-smoke.mjs")}' native \\
  --driver '${run}/native-target/debug/jupiter-smoke-native' --cli '${join(repo, "dist/cli/index.js")}'
\`\`\`

If offline resolution fails, report Native blocked. Do not download/install.
Use a debug driver: release resolve_cli adds resource-path lookup requiring extra Tauri config.
Copying current source is not proof of runtime execution. Only native report.json
status=supplemental_rpc_passed_not_desktop_acceptance, source identity,
executable hash, rpc:* events, provider receipts,
and network.jsonl child PID/PPID together constitute Native RPC chain evidence.
`;
  await writeFile(join(run, "NATIVE.md"), instructions);
  report.rpcSource = await fingerprint(original);
  report.driverSource = await fingerprint(join(dir, "src/rpc.rs"));
  check("native_rpc_source_byte_identical", report.rpcSource.sha256 === report.driverSource.sha256);
  report.status = "prepared_not_executed";
  await save("report.json", report);
  console.log(`Native driver prepared, not built or executed: ${join(run, "NATIVE.md")}`);
}
if (mode === "prepare-native") {
  await prepareNative();
  process.exit(0);
}

const receipts = [];
const tries = new Map();
let providerPort;
const providerPid = process.pid;
const provider = createServer((req, res) => { void serveProvider(req, res).catch((error) => {
  journal("provider-errors.jsonl", { message: redact(error.message) });
  if (!res.headersSent) res.writeHead(500);
  res.end();
}); });
async function serveProvider(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") { res.end("local synthetic provider"); return; }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    assert(bytes <= 8 * 1024 * 1024, "provider request too large");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const users = (body.messages ?? []).filter((m) => m.role === "user");
  const last = users.at(-1)?.content;
  const text = typeof last === "string" ? last : JSON.stringify(last ?? "");
  const marker = text.match(/SMOKE:[a-z0-9-]+/)?.[0] ?? "SMOKE:probe";
  const toolArgumentChunkDelayMs = marker.includes("ui-tools") ? 30 : 5;
  const previous = tries.get(marker) ?? 0;
  tries.set(marker, previous + 1);
  const receipt = { id: randomUUID(), marker, route: url.pathname, method: req.method, model: body.model,
    remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort,
    stream: body.stream === true, authenticatedSynthetic: req.headers.authorization === `Bearer ${syntheticKey}`,
    bytes, tools: (body.tools ?? []).map((t) => t.function?.name),
    historyMarkers: (body.messages ?? []).map((message) => ({ role: message.role,
      markers: String(typeof message.content === "string" ? message.content : "").match(/SMOKE:[a-z0-9-]+/g) ?? [] })),
    localMetadataLeak: (body.messages ?? []).some((message) => "turnId" in message || "conversationViewId" in message || "clientId" in message),
    toolResults: (body.messages ?? []).filter((m) => m.role === "tool").map((m) => ({ id: m.tool_call_id, contentHash: hash(JSON.stringify(m.content)) })),
    attempt: previous + 1, start: Date.now(), toolArgumentChunkDelayMs };
  receipts.push(receipt);
  journal("provider.jsonl", { kind: "request", ...receipt });
  res.on("close", () => {
    receipt.closed = Date.now(); receipt.completed = res.writableEnded;
    journal("provider.jsonl", { kind: "close", id: receipt.id, marker, completed: receipt.completed, elapsedMs: receipt.closed - receipt.start });
  });
  const json = (code, payload) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
  if (!receipt.authenticatedSynthetic) { json(401, { error: { message: "synthetic authorization required" } }); return; }
  if (url.pathname.startsWith("/deny/")) { json(401, { error: { message: "synthetic provider denied" } }); return; }
  if (url.pathname.endsWith("/models")) {
    if (url.pathname.startsWith("/fault/")) json(401, { error: { message: "synthetic models denied" } });
    else json(200, { object: "list", data: url.pathname.startsWith("/empty/") ? [] : models.map((id) => ({ id, object: "model", owned_by: "local-smoke" })) });
    return;
  }
  if (!url.pathname.endsWith("/chat/completions")) { json(404, { error: { message: "unsupported synthetic route" } }); return; }
  if (body.messages?.[0]?.content?.startsWith("Predict one short next message")) {
    receipt.prediction = true;
    journal("provider.jsonl", { kind: "prediction", id: receipt.id, marker, tools: receipt.tools });
    if (marker.includes("prediction-late")) await sleep(2500);
    const content = marker.includes("prediction-invalid") ? "not valid JSON" : JSON.stringify({ suggestion: marker.includes("prediction-null") ? null : "Review the result and run the relevant tests." });
    json(200, { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } });
    return;
  }
  if (marker.includes("auth-fault")) { json(401, { error: { message: `synthetic auth denial ${syntheticKey}`, code: "invalid_api_key" } }); return; }
  if (marker.includes("retry") && previous === 0) { res.setHeader("retry-after", "0"); json(429, { error: { message: "synthetic retryable fault" } }); return; }
  if (marker.includes("delay")) await sleep(900);
  if (marker.includes("cancel")) await sleep(12000);
  if (res.destroyed) return;
  const isTools = marker.includes("tools");
  const toolIds = ["smoke-provider-a", "smoke-provider-b", "smoke-provider-read"];
  const lastUserIndex = (body.messages ?? []).findLastIndex((m) => m.role === "user");
  const currentToolResults = (body.messages ?? []).slice(lastUserIndex + 1).filter((m) => m.role === "tool");
  const hasResults = toolIds.every((id) => currentToolResults.some((t) => t.tool_call_id === id));
  // User text also appears in no-tool routing/classification calls. Those must remain valid chat.
  const toolCalls = isTools && !hasResults && receipt.tools.includes("write_file") && receipt.tools.includes("read_file") ? [
    { id: toolIds[0], type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "long-a.txt", content: contentA }) } },
    { id: toolIds[1], type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "long-b.txt", content: contentB }) } },
    { id: toolIds[2], type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "seed.txt" }) } },
  ] : [];
  const usage = { prompt_tokens: 100, completion_tokens: toolCalls.length ? 40000 : 16, total_tokens: toolCalls.length ? 40100 : 116, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
  const content = marker.includes("long-transcript")
    ? `LOCAL_OK ${marker}\n\n` + Array.from({ length: 240 }, (_, index) =>
      `LOCAL_LINE_${String(index + 1).padStart(3, "0")} Synthetic transcript paragraph for real scroll and rendering checks.`,
    ).join("\n\n")
    : `LOCAL_OK ${marker} ${hasResults ? "TOOLS_VERIFIED" : ""}`.trim();
  if (!body.stream) {
    json(200, { id: receipt.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }], usage });
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const delta = (data, finish = null) => res.write(`data: ${JSON.stringify({ id: receipt.id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: data, finish_reason: finish }] })}\n\n`);
  delta({ role: "assistant" });
  if (marker.includes("truncated")) {
    delta({ tool_calls: [{ index: 0, id: "smoke-truncated", type: "function", function: { name: "write_file", arguments: '{"path":"must-not-exist.txt","content":"partial' } }] });
    await sleep(200);
    res.end(); // Deliberately no terminal reason / [DONE], no executable arguments.
    return;
  }
  if (toolCalls.length) {
    // Interleave long arguments across indices. Provider IDs arrive at the very end.
    for (let i = 0; i < toolCalls.length; i++) delta({ tool_calls: [{ index: i, type: "function", function: { name: toolCalls[i].function.name, arguments: "" } }] });
    const length = Math.max(...toolCalls.map((t) => t.function.arguments.length));
    for (let offset = 0; offset < length; offset += 1024) {
      if (res.destroyed) return;
      for (let i = 0; i < toolCalls.length; i++) {
        const part = toolCalls[i].function.arguments.slice(offset, offset + 1024);
        if (part) {
          delta({ tool_calls: [{ index: i, function: { arguments: part } }] });
          await sleep(toolArgumentChunkDelayMs);
        }
      }
    }
    for (let i = 0; i < toolCalls.length; i++) delta({ tool_calls: [{ index: i, id: toolCalls[i].id, function: { arguments: "" } }] });
    delta({}, "tool_calls");
  } else {
    delta({ content: content.slice(0, 8) }); await sleep(30); delta({ content: content.slice(8) }); delta({}, "stop");
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}
async function listen(server) {
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  return server.address().port;
}
providerPort = await listen(provider);
await save("allowed-ports.json", [providerPort]);
const providerUrl = `http://127.0.0.1:${providerPort}/v1`;
await writeFile(join(workspace, "seed.txt"), "isolated real tool read\n");
const isolationWitness = { name: `isolation-${randomUUID()}.txt`, content: `owned-workspace-${randomUUID()}\n` };
await writeFile(join(workspace, isolationWitness.name), isolationWitness.content);
await writeFile(join(home, isolationWitness.name), `OUTSIDE-WORKSPACE-${randomUUID()}\n`);
await writeFile(join(home, ".jupiter/config.json"), JSON.stringify({ apiKey: syntheticKey, baseUrl: providerUrl,
  providerDialect: "openai-compatible", model: models[0], workspaceDir: workspace,
  editMode: "yolo", thinkingEnabled: false, setupCompleted: true, search: false,
  computerUse: { enabled: false }, mcp: [], mcpServers: {}, dashboard: { enabled: false },
  desktopUpdate: { disabled: true }, memory: { globalEnabled: false, confirmWrites: true }, lang: "en" }), { mode: 0o600 });

const events = [];
let phase = "startup";
let child;
let state;
let control;
let closing;
let readerAbort;
let readerTask;
let renewTimer;
let send;
let mintBrowser;
let tabId;
let harnessStopped = false;
let nativeMonitor;
let nativeRefresh = Promise.resolve();
let nativeSandbox;
let processGroupOwned = false;

async function captureProgram(program, args, options = {}) {
  return new Promise((done, fail) => {
    const proc = spawn(program, args, { cwd: workspace, env: isolatedEnv(), stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => proc.kill("SIGKILL"), 10000);
    proc.once("error", (error) => { clearTimeout(timeout); fail(error); });
    proc.once("exit", (code, signal) => { clearTimeout(timeout); done({ code, signal, stdout, stderr: redact(stderr) }); });
  });
}
async function rows(name) {
  try { return (await readFile(join(run, name), "utf8")).split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function ownedWorkspaceScript(command, { cwd, logFile, cwdWitness } = {}) {
  assert(cwd && command.length, "Owned workspace and command required");
  const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
  return "#!/bin/sh\ncd " + quote(cwd) + " || exit 1\n" +
    (cwdWitness ? "pwd -P >" + quote(cwdWitness) + " || exit 1\n" : "") +
    "exec " + command.map(quote).join(" ") + (logFile ? " >>" + quote(logFile) + " 2>&1" : "") + "\n";
}

async function stopOwnedHost(host, {
  groupOwned = false, native = false, kill = (pid, signal) => process.kill(pid, signal), wait = sleep,
} = {}) {
  const live = () => host?.pid && host.exitCode === null && host.signalCode === null && !host.ownershipLost;
  const verify = async () => {
    if (!live()) return false;
    try {
      if (host.verifyOwned && !(await host.verifyOwned())) {
        host.ownershipLost = true;
        return false;
      }
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      host.ownershipLost = true;
      return false;
    }
    return Boolean(live());
  };
  const signal = async (name) => {
    if (!(await verify())) return;
    try {
      if (groupOwned) kill(-host.pid, name);
      else host.kill(name);
      host.lastSignal = name;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      host.ownershipLost = true;
    }
  };
  if (!(await verify())) return;
  if (native) host.stdin.end();
  else await signal("SIGTERM");
  for (let i = 0; i < 100 && await verify(); i++) await wait(50);
  // Revalidate immediately before escalation; an old PID/PGID is not proof of ownership.
  await signal("SIGKILL");
  await wait(100);
  if (await verify()) throw new Error("Owned host still running after SIGKILL");
}

async function refreshNativeEvidence() {
  if (child.verifyOwned && !(await child.verifyOwned())) child.ownershipLost = true;
  const network = await rows("network.jsonl");
  const nodes = network.filter((r) => r.kind === "process" && r.ppid === child.pid && r.entry === report.cli.path && r.home === home && r.argv.includes("desktop"));
  const commands = (await rows("native-commands.jsonl")).filter((r) => nodes.some((n) => n.pid === r.pid));
  const output = (await rows("native-sidecar-events.jsonl")).filter((r) => nodes.some((n) => n.pid === r.pid));
  const correlated = receipts.map((r) => ({ ...r, nodePids: [...new Set(network.filter((n) => n.kind === "connected" && n.localPort === r.remotePort && Number(n.remotePort) === providerPort && nodes.some((node) => node.pid === n.pid)).map((n) => n.pid))] }));
  const inputMarkers = commands.filter((r) => ["user_input", "ask_light", "btw"].includes(r.command.cmd)).map((r) => ({ ts: r.ts, cmd: r.command.cmd,
    marker: r.command.text?.match(/SMOKE:[a-z0-9-]+/)?.[0], pid: r.pid }));
  const matched = inputMarkers.filter((input) => input.marker && correlated.some((r) => r.marker === input.marker && r.nodePids.includes(input.pid) && r.authenticatedSynthetic));
  const artifacts = [];
  for (const file of ["long-a.txt", "long-b.txt", "must-not-exist.txt"]) {
    if (existsSync(join(workspace, file))) artifacts.push(await fingerprint(join(workspace, file)));
  }
  const evidence = { scope: "real QA Desktop.app, not the independent driver", acceptance: "pending_parent_cua_not_automatic_pass",
    app: report.app, appExecutable: report.appExecutable, cli: report.cli, node: report.node,
    refreshedAt: new Date().toISOString(), appPid: child.pid, appExitCode: child.exitCode, appSignal: child.signalCode,
    appOwnershipLost: Boolean(child.ownershipLost), appCwd: report.host.cwd,
    nodes, readyObservedAtNodeStdout: output.some((r) => r.event.type === "$ready"),
    rustToNodeCommands: commands.length, inputMarkers, matchedInputMarkers: matched,
    providerReceipts: correlated, nodeEventCounts: Object.fromEntries([...new Set(output.map((r) => r.event.type))].map((type) => [type, output.filter((r) => r.event.type === type).length])),
    nodeFinals: output.filter((r) => r.event.type === "model.final").map((r) => ({ pid: r.pid, ts: r.ts, content: r.event.content })),
    deniedNodeConnections: network.filter((r) => r.kind === "connect" && !r.allowed).length, workspaceArtifacts: artifacts,
    observationBoundary: "stdin tee observes actual Rust pipe bytes and stdout tee observes bytes written to Rust; parent CUA must confirm rendering and UI behavior",
  };
  await save("native-evidence.json", evidence);
  report.nativeUiEvidence = { refreshedAt: evidence.refreshedAt, nodePids: nodes.map((n) => n.pid), readyObserved: evidence.readyObservedAtNodeStdout,
    rustToNodeCommands: commands.length, matchedInputMarkers: matched.length, providerRequests: receipts.length, acceptance: evidence.acceptance };
  await save("report.json", report);
  if (state) {
    state = { ...state, status: !child.ownershipLost && child.exitCode === null && child.signalCode === null ? "running_for_parent_cua" : "qa_app_not_owned_provider_kept", evidence: report.nativeUiEvidence };
    await save("state.json", state);
  }
  return evidence;
}
function queueNativeRefresh() {
  if (closing) return nativeRefresh;
  nativeRefresh = nativeRefresh.catch(() => {}).then(refreshNativeEvidence);
  return nativeRefresh;
}
async function createNativeSandbox(bundleId = report.app?.bundleId) {
  nativeSandbox = join(run, "qa-native.sb");
  const realHome = await realpath(homedir());
  const protectedPaths = [".jupiter", ".ssh", ".aws", ".gnupg", ".config", "Library/Keychains"].map((path) => join(realHome, path));
  assert(typeof bundleId === "string" && bundleId !== "dev.jupiter.desktop" && /^dev\.jupiter\.desktop\.[a-z0-9.-]+qa[a-z0-9.-]*$/.test(bundleId));
  // Cocoa resolves these through the real account home, not the isolated HOME.
  // Permit only this explicitly named QA artifact's cache directories, never Jupiter's data.
  const qaCaches = ["Library/WebKit", "Library/Caches", "Library/HTTPStorages", "Library/Saved Application State"].map((path) =>
    join(realHome, path, bundleId + (path.endsWith("State") ? ".savedState" : "")));
  report.qaCachePaths = qaCaches;
  const profile = `(version 1)\n(allow default)\n(deny network-outbound (remote ip))\n(allow network-outbound (remote ip "localhost:${providerPort}"))\n` +
    `(deny file-write* (require-all (subpath ${JSON.stringify(realHome)}) ${qaCaches.map((path) => `(require-not (subpath ${JSON.stringify(path)}))`).join(" ")}))\n` + protectedPaths.map((path) => `(deny file-read* (subpath ${JSON.stringify(path)}))\n`).join("");
  await writeFile(nativeSandbox, profile, { mode: 0o600 });
}
async function probeNativeSandbox(node, env) {
  // No Node preload: test the OS policy, not merely the JavaScript TCP guard.
  const probeEnv = { ...env }; delete probeEnv.NODE_OPTIONS;
  const allowed = await captureProgram("/usr/bin/sandbox-exec", ["-f", nativeSandbox, node, "--input-type=module", "-e", `const r=await fetch('http://127.0.0.1:${providerPort}/health');if(!(await r.text()).includes('synthetic'))process.exitCode=1;`], { env: probeEnv });
  check("native_os_sandbox_owned_provider_reachable", allowed.code === 0, { stderr: allowed.stderr });
  const canary = createServer((req, res) => { res.end("unowned canary"); });
  const canaryPort = await listen(canary);
  try {
    const blocked = await captureProgram("/usr/bin/sandbox-exec", ["-f", nativeSandbox, node, "--input-type=module", "-e", `import net from 'node:net';const s=net.connect(${canaryPort},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exitCode=1;});s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))process.exitCode=2;});`], { env: probeEnv });
    check("native_os_sandbox_denies_unowned_ip_egress", blocked.code === 0, { stderr: blocked.stderr });
  } finally { canary.closeAllConnections(); await new Promise((done) => canary.close(done)); }
  const noWrites = await captureProgram("/usr/bin/sandbox-exec", ["-f", nativeSandbox, node, "--input-type=module", "-e", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(join(run, "sandbox-owned-write.txt"))},'owned');`], { env: probeEnv });
  check("native_os_sandbox_owned_output_writable", noWrites.code === 0, { stderr: noWrites.stderr });
}

async function startNativeUi() {
  phase = "native-ui-parent-cua";
  check("native_ui_macos_only", process.platform === "darwin");
  const app = await realpath(resolve(value("--app", "")));
  check("qa_app_is_temporary_not_installed", app.endsWith(".app") && app.startsWith((await realpath("/tmp")) + "/"));
  const plist = join(app, "Contents/Info.plist");
  const decoded = await captureProgram("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
  check("qa_plist_readable", decoded.code === 0);
  const metadata = JSON.parse(decoded.stdout);
  const expectedId = value("--expected-bundle-id", "dev.jupiter.desktop.reliability-qa");
  check("qa_unique_bundle_identity", metadata.CFBundleIdentifier === expectedId && expectedId !== "dev.jupiter.desktop");
  const expectedProductName = value("--expected-product-name", "Jupiter Reliability QA");
  check("qa_unique_product_name", /^Jupiter .+ QA$/.test(expectedProductName) && (metadata.CFBundleDisplayName ?? metadata.CFBundleName) === expectedProductName);
  check("qa_executable_basename_safe", typeof metadata.CFBundleExecutable === "string" && !/[\/\\]/.test(metadata.CFBundleExecutable) && metadata.CFBundleExecutable !== "..");
  const executable = await realpath(join(app, "Contents/MacOS", metadata.CFBundleExecutable));
  check("qa_executable_inside_bundle", executable.startsWith(app + "/Contents/MacOS/"));
  const bundledCli = join(app, "Contents/Resources/dist/cli/index.js");
  const cli = await realpath(resolve(value("--cli", bundledCli)));
  check("native_ui_uses_built_js_not_source", cli.endsWith(".js") && !cli.includes("/src/") && (cli.startsWith(app + "/Contents/Resources/") || cli.startsWith(repo + "/dist/") || cli.startsWith((await realpath(base)) + "/")));
  const bundledNode = join(app, "Contents/Resources/node");
  const node = await realpath(resolve(value("--node", existsSync(bundledNode) ? bundledNode : process.execPath)));
  report.app = { path: app, bundleId: metadata.CFBundleIdentifier, productName: metadata.CFBundleDisplayName ?? metadata.CFBundleName,
    plist: await fingerprint(plist), identityBoundary: "bundle metadata verified; parent owns the fresh QA build provenance" };
  report.appExecutable = await fingerprint(executable);
  report.cli = await fingerprint(cli);
  report.node = { ...await fingerprint(node), origin: node.startsWith(app + "/") ? "QA bundle runtime" : "explicit/system Node runtime; JS sidecar is the separately hashed production artifact" };
  report.artifacts.push(report.appExecutable, report.cli, report.node, await fingerprint(fileURLToPath(import.meta.url)));
  for (const [flag, artifact] of [["--expected-cli-sha256", report.cli], ["--expected-app-sha256", report.appExecutable]]) {
    const expected = value(flag, null);
    if (expected) check(flag.slice(2) + "_matches", artifact.sha256 === expected);
  }
  await save("qa-app-metadata.json", metadata);
  await save("production-artifacts.json", await inventory(cli.startsWith(app + "/") ? join(app, "Contents/Resources/dist") : dirname(cli)));
  const ownedCwd = await realpath(workspace);
  const launcher = join(run, "qa-sidecar-launch");
  const sidecarArgs = [cli, "desktop", "--dir", workspace, "--model", models[0]];
  // rpc.rs splits JUPITER_CLI on whitespace; the absolute shim preserves .app paths with spaces.
  await writeFile(launcher, ownedWorkspaceScript([node, ...sidecarArgs], { cwd: ownedCwd }), { mode: 0o700 });
  const env = { ...isolatedEnv(), __CFBundleIdentifier: expectedId, JUPITER_CLI: launcher, JUPITER_RUNTIME_SURFACE: "desktop", JUPITER_SMOKE_CAPTURE_RPC: "1" };
  await save("launch-env.json", env);
  await createNativeSandbox();
  await probeNativeSandbox(node, env);
  const args = ["-f", nativeSandbox, executable];
  if (argv.includes("--launch-services")) {
    // Register the temporary bundle with macOS while retaining the exact same isolation.
    const realExecutable = executable + ".qa-native";
    check("qa_launch_wrapper_does_not_replace_existing_file", !existsSync(realExecutable));
    await rename(executable, realExecutable);
    report.appExecutable = await fingerprint(realExecutable);
    const invocation = ["/usr/bin/env", "-i", ...Object.entries(env).map(([key, val]) => `${key}=${val}`), "/usr/bin/sandbox-exec", "-f", nativeSandbox, realExecutable];
    const cwdWitness = join(run, "native-launch-cwd.txt");
    await writeFile(executable, ownedWorkspaceScript(invocation, { cwd: ownedCwd, cwdWitness, logFile: join(run, "native-host.log") }), { mode: 0o700 });
    const opened = await captureProgram("/usr/bin/open", ["-n", app]);
    check("qa_launch_services_registered", opened.code === 0, { stderr: opened.stderr });
    await until(async () => (await rows("network.jsonl")).some((r) => r.kind === "process" && r.home === home && r.entry === cli));
    const ownedNode = (await rows("network.jsonl")).find((r) => r.kind === "process" && r.home === home && r.entry === cli);
    const pid = ownedNode.ppid;
    const identity = await captureProgram("/bin/ps", ["-p", String(pid), "-o", "command="]);
    check("qa_launch_services_pid_is_exact_owned_binary", identity.stdout.trim() === realExecutable);
    const group = await captureProgram("/bin/ps", ["-p", String(pid), "-o", "pgid="]);
    const started = await captureProgram("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
    check("qa_launch_services_process_start_identity", started.code === 0 && Boolean(started.stdout.trim()));
    processGroupOwned = Number(group.stdout.trim()) === pid;
    child = { pid, exitCode: null, signalCode: null,
      async verifyOwned() {
        const identity = await captureProgram("/bin/ps", ["-p", String(pid), "-o", "command="]);
        if (identity.code !== 0 || identity.stdout.trim() !== realExecutable) return false;
        const currentStart = await captureProgram("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
        const currentGroup = await captureProgram("/bin/ps", ["-p", String(pid), "-o", "pgid="]);
        return currentStart.code === 0 && currentStart.stdout.trim() === started.stdout.trim() &&
          currentGroup.code === 0 && currentGroup.stdout.trim() === group.stdout.trim();
      },
      kill(signal) { return process.kill(pid, signal); } };
    const actualCwd = (await readFile(cwdWitness, "utf8")).trim();
    check("qa_launch_services_actual_cwd_is_owned_workspace", actualCwd === ownedCwd);
    report.host = { pid, program: realExecutable, wrapper: executable, cwd: actualCwd, cwdWitness,
      processStartedAt: started.stdout.trim(), processGroup: processGroupOwned ? pid : null,
      launch: "LaunchServices temporary bundle; wrapper execs unchanged Rust binary with isolated env and OS+Node network guards", sidecarLaunch: { command: launcher, node, args: sidecarArgs, cwd: ownedCwd } };
  } else {
    child = spawn("/usr/bin/sandbox-exec", args, { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    processGroupOwned = Number.isSafeInteger(child.pid);
    child.once("error", (error) => { report.transportError = redact(error.message); });
    report.host = { pid: child.pid, program: executable, wrapper: "/usr/bin/sandbox-exec", args, cwd: ownedCwd,
      processGroup: child.pid, launch: "exec actual QA binary; no open/LaunchServices", sidecarLaunch: { command: launcher, node, args: sidecarArgs, cwd: ownedCwd } };
    for (const [channel, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
      createInterface({ input: stream }).on("line", (line) => journal("host.jsonl", { phase, channel, data: redact(line) }));
    }
  }
  await until(() => existsSync(join(run, "network.jsonl")));
  await until(() => existsSync(join(run, "native-sidecar-events.jsonl")));
  await queueNativeRefresh();
  check("qa_rust_spawned_expected_node_with_isolated_home", report.nativeUiEvidence.nodePids.length > 0);
  const ownedNodes = (await rows("network.jsonl")).filter((row) => report.nativeUiEvidence.nodePids.includes(row.pid) && row.kind === "process");
  report.host.sidecarLaunch.actualCwds = [...new Set(ownedNodes.map((row) => row.cwd))];
  check("qa_sidecar_actual_cwd_is_owned_workspace", ownedNodes.every((row) => row.cwd === ownedCwd));
  report.status = "running_awaiting_parent_cua_not_desktop_pass";
  report.stages[0] = "QA bundle identity, binary/CLI/runtime hashes, independent HOME, tested OS+Node egress restrictions";
  report.stages[1] = "QA app launched; all UI sends and final acceptance belong to parent CUA";
}
function accept(packet) {
  journal("transport.jsonl", { phase, packet: JSON.parse(redact(JSON.stringify(packet))) });
  if (packet.channel === "rpc:event") {
    const event = JSON.parse(packet.payload.data);
    events.push({ ...event, phase, receivedAt: Date.now() });
    journal("events.jsonl", { phase, event: JSON.parse(redact(JSON.stringify(event))) });
    if (event.type === "$ready") tabId = event.tabId;
    checkNoKey(event);
  } else if (packet.channel === "harness:ready") {
    report.harness = packet.payload;
  } else if (packet.channel === "harness:stopped") {
    harnessStopped = true;
  } else if (packet.channel === "harness:error") {
    report.transportError = "Native rpc_send failed: " + JSON.stringify(packet.payload);
  }
}
function checkNoKey(event) {
  assert(!JSON.stringify(event).includes(syntheticKey), "Application event leaked synthetic credential");
}
async function until(predicate, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    assert(!report.transportError, report.transportError);
    if (child) assert(child.exitCode === null && child.signalCode === null, "Host exited before probe completed");
    assert(Date.now() < deadline, `Timed out in ${phase}; inspect events/transport/provider logs`);
    await sleep(30);
  }
}
async function shutdown() {
  if (closing) return closing;
  closing = (async () => {
    const errors = [];
    const attempt = async (stage, action) => {
      try { await action(); }
      catch (error) { errors.push({ stage, message: redact(error.message ?? error) }); }
    };
    const recordErrors = () => {
      if (!errors.length) return;
      report.cleanupErrors = errors;
      report.status = "failed";
      report.error = "Harness cleanup failed; inspect cleanupErrors";
      process.exitCode = 1;
    };
    try {
      clearInterval(renewTimer);
      clearInterval(nativeMonitor);
      await nativeRefresh.catch(() => {});
      readerAbort?.abort();
      await stopOwnedHost(child, { groupOwned: processGroupOwned, native: mode === "native" });
      if (child) {
        report.shutdown = { hostPid: child.pid, exitCode: child.exitCode, signal: child.signalCode,
          lastSignal: child.lastSignal, ownershipLost: Boolean(child.ownershipLost), harnessStopped };
        if (mode === "native" && report.egress) {
          report.shutdown.nodeProcesses = report.egress.nodeProcesses.filter((node) => node.ppid === child.pid).map((node) => {
            let alive = false;
            try { process.kill(node.pid, 0); alive = true; } catch (error) { alive = error.code !== "ESRCH"; }
            return { pid: node.pid, alive };
          });
        }
        journal("lifecycle.jsonl", report.shutdown);
        if (mode === "native" && report.status === "supplemental_rpc_passed_not_desktop_acceptance" &&
            (!harnessStopped || child.exitCode !== 0 || child.signalCode !== null || report.shutdown.nodeProcesses?.some((node) => node.alive))) {
          report.status = "failed";
          report.error = "Native rpc_kill/EOF shutdown did not finish cleanly";
          process.exitCode = 1;
        }
      }
    } catch (error) {
      errors.push({ stage: "host", message: redact(error.message ?? error) });
    } finally {
      // Each resource gets its own attempt, even when signalling or another close fails.
      await attempt("provider-connections", () => provider.closeAllConnections());
      await attempt("provider-close", () => new Promise((done, fail) => provider.close((error) => error ? fail(error) : done())));
      if (control) {
        await attempt("control-connections", () => control.closeAllConnections());
        await attempt("control-close", () => new Promise((done, fail) => control.close((error) => error ? fail(error) : done())));
      }
      recordErrors();
      if (state) {
        state = { ...state, status: errors.length ? "stopped_with_errors" : "stopped", stoppedAt: new Date().toISOString() };
        await attempt("state-save", () => save("state.json", state));
      }
      recordErrors();
      await attempt("report-save", () => save("report.json", report));
      recordErrors();
    }
  })();
  return closing;
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });

async function startHost() {
  const cli = await realpath(resolve(value("--cli", join(repo, "dist/cli/index.js"))));
  check("production_js_entry_not_source", cli.endsWith(".js") && !cli.includes("/src/"));
  check("no_installed_cli", cli.startsWith(repo + "/dist/") || cli.startsWith((await realpath(base)) + "/"));
  report.cli = await fingerprint(cli);
  report.artifacts.push(report.cli, await fingerprint(fileURLToPath(import.meta.url)));
  const distRoot = cli.startsWith(repo + "/dist/") ? join(repo, "dist") : dirname(cli);
  await save("production-artifacts.json", await inventory(distRoot));
  await save("protocol-sources.json", await Promise.all([
    "src/web/server.ts", "src/web/sidecar.ts", "src/web/workspaces.ts", "src/web/host.ts", "src/cli/commands/web.ts",
    "src/cli/commands/desktop.ts", "desktop/src-tauri/src/rpc.rs", "desktop/src/protocol.ts",
  ].map((file) => fingerprint(join(repo, file)))));
  const expected = value("--expected-cli-sha256", null);
  if (expected) check("parent_build_hash_matches", report.cli.sha256 === expected);
  report.buildFreshness = expected ? "parent hash matched" : "hash recorded; runner does not assert build freshness";
  const env = isolatedEnv();
  let program = process.execPath;
  let args = [cli, "web", workspace, "--model", models[0], "--host", "127.0.0.1", "--no-open"];
  if (mode === "native") {
    program = await contained(resolve(value("--driver", "")));
    check("driver_is_new_independent_artifact", program.endsWith("/jupiter-smoke-native"));
    check("rpc_override_has_no_whitespace", !/\s/.test(process.execPath + cli + workspace));
    env.JUPITER_CLI = `${process.execPath} ${cli} desktop --dir ${workspace} --model ${models[0]}`;
    report.driver = await fingerprint(program);
    report.artifacts.push(report.driver);
    args = [];
  }
  child = spawn(program, args, { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (error) => { journal("host.jsonl", { error: redact(error.message) }); });
  report.host = { pid: child.pid, program, args, envNames: Object.keys(env), cwd: workspace, runnerPid: process.pid };
  let printedUrl;
  let announcedWorkspace;
  createInterface({ input: child.stdout }).on("line", (line) => {
    journal("host.jsonl", { channel: "stdout", data: redact(line) });
    if (mode === "native") {
      try { accept(JSON.parse(line)); } catch (error) { report.transportError = redact(error.message); }
    } else {
      const match = line.match(/http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[a-z0-9]+/i);
      if (match) printedUrl = match[0];
      const root = line.match(/^\s+workspace:\s+(.+)$/);
      if (root) announcedWorkspace = root[1];
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => journal("host.jsonl", { channel: "stderr", data: redact(line) }));
  if (mode === "native") {
    await until(() => report.harness && events.some((e) => e.type === "$ready"));
    report.rpcSource = await fingerprint(join(repo, "desktop/src-tauri/src/rpc.rs"));
    check("executed_native_rpc_source_matches_current_source", report.harness.rpcSourceSha256 === report.rpcSource.sha256);
    send = async (payload) => new Promise((done, fail) => child.stdin.write(JSON.stringify(payload) + "\n", (error) => error ? fail(error) : done()));
    return;
  }
  await until(() => printedUrl && announcedWorkspace);
  const url = new URL(printedUrl);
  const origin = url.origin;
  report.webOrigin = origin;
  const html = await fetch(origin, { redirect: "error", signal: AbortSignal.timeout(5000) });
  const htmlText = await html.text();
  check("production_html_served", html.status === 200 && htmlText.includes("app.js"));
  const response = await fetch(origin + "/api/bootstrap", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token: url.hash.slice("#bootstrap=".length), deviceName: "isolated-smoke-runner" }), redirect: "error" });
  check("real_bootstrap_accepted", response.status === 200);
  const session = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  await save("bootstrap-workspaces.json", { runtimeEpoch: session.runtimeEpoch, workspaces: session.workspaces });
  const canonicalWorkspace = await realpath(workspace);
  check("server_announced_only_requested_root", announcedWorkspace === workspace && await realpath(announcedWorkspace) === canonicalWorkspace &&
    report.host.args[1] === "web" && report.host.args[2] === workspace && !report.host.args.includes("--approved-root"), { announcedWorkspace, canonicalWorkspace });
  check("one_public_workspace_id_name", Array.isArray(session.workspaces) && session.workspaces.length === 1 &&
    /^[0-9a-f-]{36}$/i.test(session.workspaces[0].id) && session.workspaces[0].name === basename(canonicalWorkspace) && session.workspaces[0].writable === true,
    { workspaces: session.workspaces });
  const publicWorkspace = session.workspaces[0];
  if (Object.hasOwn(publicWorkspace, "root")) check("published_root_matches_canonical_owned_root", publicWorkspace.root === canonicalWorkspace,
    { publishedRoot: publicWorkspace.root, canonicalWorkspace });
  for (const asset of ["app.js", "app.css"]) {
    const result = await fetch(origin + "/assets/" + asset, { headers: { cookie }, signal: AbortSignal.timeout(5000), redirect: "error" });
    const bytes = Buffer.from(await result.arrayBuffer());
    check(`production_asset_${asset}`, result.status === 200 && bytes.length > 100, { bytes: bytes.length, sha256: hash(bytes) });
  }
  const connectionId = randomUUID();
  readerAbort = new AbortController();
  const stream = await fetch(`${origin}/api/events?connectionId=${connectionId}`, { headers: { cookie, origin }, signal: readerAbort.signal, redirect: "error" });
  check("real_sse_connected", stream.status === 200);
  readerTask = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const bytes of stream.body) {
      pending += decoder.decode(bytes, { stream: true }).replaceAll("\r\n", "\n");
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const block = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) accept(JSON.parse(data));
      }
    }
  })().catch((error) => { if (!readerAbort.signal.aborted) report.transportError = redact(error.message); });
  const headers = { cookie, origin, "content-type": "application/json", "x-jupiter-csrf": session.csrfToken, "x-jupiter-connection": connectionId };
  async function post(path, body, overrides = {}) {
    const response = await fetch(origin + path, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: "error" });
    const payload = await response.json();
    journal("web-http.jsonl", { phase, path, status: response.status, response: payload });
    return { status: response.status, payload };
  }
  const leaseResult = await post("/api/lease/acquire", { force: false });
  check("real_writer_lease_acquired", leaseResult.status === 200);
  const lease = leaseResult.payload.lease;
  Object.assign(headers, { "x-jupiter-lease": lease.id, "x-jupiter-fence": String(lease.fence) });
  renewTimer = setInterval(() => { void post("/api/lease/renew", {}).then((r) => { if (r.status !== 200) report.leaseError = r.status; }).catch(() => {}); }, 10000);
  // Bind the public ID to a fresh unpredictable local witness through real host authority.
  const resolved = await post("/api/files/resolve", { workspaceId: publicWorkspace.id, path: isolationWitness.name });
  const ref = resolved.payload.file;
  check("workspace_id_resolves_owned_canary", resolved.status === 200 && ref?.workspaceId === publicWorkspace.id && ref?.source === "workspace" &&
    ref?.name === isolationWitness.name && ref?.relativePath === isolationWitness.name && ref?.size === Buffer.byteLength(isolationWitness.content));
  const preview = await post("/api/host-invoke", { operationId: randomUUID(), command: "read_file_preview", args: { fileId: ref.id } });
  check("workspace_id_bound_to_exact_owned_root", preview.status === 200 && preview.payload.result?.text === isolationWitness.content &&
    preview.payload.result?.absPath === `jupiter-file:${ref.id}` && preview.payload.result?.truncated === false);
  const escaped = await post("/api/files/resolve", { workspaceId: publicWorkspace.id, path: `../home/${isolationWitness.name}` });
  check("workspace_id_cannot_read_isolated_home_outside_root", escaped.status === 400 && !escaped.payload.file);
  const unknown = await post("/api/files/resolve", { workspaceId: randomUUID(), path: isolationWitness.name });
  check("unknown_workspace_id_rejected", unknown.status === 400 && !unknown.payload.file);
  report.workspaceBinding = { publicWorkspace, announcedWorkspace, canonicalWorkspace, launchArgs: report.host.args,
    witness: { name: isolationWitness.name, sha256: hash(isolationWitness.content), fileRef: ref }, previewSha256: hash(preview.payload.result.text),
    outsideRootStatus: escaped.status, unknownIdStatus: unknown.status };
  await save("workspace-binding.json", report.workspaceBinding);
  check("only_isolated_workspace_exposed", session.workspaces.length === 1 && hash(preview.payload.result.text) === hash(isolationWitness.content) && escaped.status === 400 && unknown.status === 400);
  const denied = await post("/api/rpc", { commandId: randomUUID(), payload: { cmd: "settings_get" } }, { "x-jupiter-csrf": "deliberately-wrong" });
  check("csrf_rejects_mutation", denied.status === 403);
  // Mint only after probes, so the five-minute pairing TTL starts when the parent can inspect.
  mintBrowser = async () => {
    const pairing = await post("/api/pairing", {});
    check("fresh_browser_pairing_created", pairing.status === 201 && typeof pairing.payload.url === "string");
    report.browserUrl = pairing.payload.url;
  };
  await until(() => events.some((e) => e.type === "$ready"));
  send = async (payload) => {
    const id = randomUUID();
    const result = await post("/api/rpc", { commandId: id, payload });
    check(`rpc_accepted_${payload.cmd}`, result.status === 202, { commandId: id });
  };
}

async function inputProbe(name, cmd, predicate, timeout = 45000) {
  phase = name;
  const cursor = events.length;
  const started = Date.now();
  await send({ ...cmd, tabId, ...(cmd.text ? { clientId: randomUUID() } : {}) });
  await until(() => predicate(events.slice(cursor)), timeout);
  return { events: events.slice(cursor), elapsedMs: Date.now() - started };
}
const complete = (list) => list.some((e) => e.type === "$turn_complete");
const successful = (list, marker) => complete(list) && list.some((e) => e.type === "model.final" && e.content?.includes(`LOCAL_OK SMOKE:${marker}`));

async function suite() {
  report.stages[0] = "isolated HOME/env/workspace, synthetic credential, production artifact identity";
  await startHost();
  check("no_transport_parse_error", !report.transportError);
  const normal = await inputProbe("nonstream", { cmd: "ask_light", text: "SMOKE:nonstream Reply OK" }, (list) => successful(list, "nonstream"));
  check("production_nonstream_provider_chain", receipts.some((r) => r.marker === "SMOKE:nonstream" && !r.stream && r.authenticatedSynthetic));
  report.stages[1] = { chain: mode === "web" ? "production CLI Web server -> production Node desktop sidecar -> HTTP provider" : "real Tauri rpc_spawn -> production Node desktop -> HTTP provider", elapsedMs: normal.elapsedMs };
  if (mode === "native") {
    for (const [prefix, model, ok, validation] of [["", models[0], true, "models"], ["/empty", models[1], true, "chat"], ["/fault", models[2], true, "chat"], ["/deny", models[2], false, "chat"]]) {
      const requestId = randomUUID();
      const result = await inputProbe(`native-provider${prefix}`, { cmd: "provider_test", requestId,
        baseUrl: `http://127.0.0.1:${providerPort}${prefix}/v1`, model, providerDialect: "openai-compatible", apiKey: syntheticKey },
      (list) => list.some((e) => e.type === "$provider_test_result" && e.requestId === requestId && e.status !== "pending"));
      const event = result.events.findLast((e) => e.type === "$provider_test_result" && e.requestId === requestId);
      check(`native_models_chat_probe${prefix}`, event.ok === ok && event.validation === validation);
    }
  }
  const tools = await inputProbe("long-tools", { cmd: "user_input", text: "SMOKE:tools Write the two synthetic files and read seed.txt. No plan or shell needed." }, (list) => successful(list, "tools"));
  for (const [file, expected] of [["long-a.txt", contentA], ["long-b.txt", contentB]]) {
    const artifact = await fingerprint(join(workspace, file));
    report.artifacts.push(artifact);
    check(`real_tool_file_hash_${file}`, artifact.sha256 === hash(expected));
  }
  const intents = tools.events.filter((e) => e.type === "tool.intent");
  const results = tools.events.filter((e) => e.type === "tool.result");
  check("three_tools_executed_once", intents.length === 3 && results.length === 3 && results.every((e) => e.ok));
  check("stable_unique_local_tool_identity", new Set(intents.map((e) => e.callId)).size === 3 && intents.every((e) => results.some((r) => r.callId === e.callId)));
  check("long_argument_progress_observed", tools.events.some((e) => e.type === "tool.progress" && e.toolCallArgsChars > 32768));
  check("provider_late_ids_preserved_in_followup", receipts.some((r) => r.marker === "SMOKE:tools" && ["smoke-provider-a", "smoke-provider-b", "smoke-provider-read"].every((id) => r.toolResults.some((t) => t.id === id))));
  report.stages[2] = { elapsedMs: tools.elapsedMs, argumentChars: intents.map((e) => e.args.length) };
  const delayed = await inputProbe("delay", { cmd: "ask_light", text: "SMOKE:delay Reply OK" }, (list) => successful(list, "delay"));
  check("real_delayed_response", delayed.elapsedMs >= 850);
  const broken = await inputProbe("truncated", { cmd: "user_input", text: "SMOKE:truncated Exercise stream failure" }, complete);
  check("truncated_fault_reached_real_stream", receipts.some((r) => r.marker === "SMOKE:truncated" && r.stream && r.authenticatedSynthetic));
  check("partial_tool_never_writes_file", !existsSync(join(workspace, "must-not-exist.txt")) && !broken.events.some((e) => e.type === "tool.result" && e.ok));
  check("truncated_stream_failure_visible", broken.events.some((e) => ["error", "$error"].includes(e.type)));
  await inputProbe("stream-fault-recovery", { cmd: "ask_light", text: "SMOKE:stream-fault-recovery Reply OK" }, (list) => successful(list, "stream-fault-recovery"));
  phase = "cancel";
  const cursor = events.length;
  await send({ cmd: "ask_light", tabId, clientId: randomUUID(), text: "SMOKE:cancel Reply slowly" });
  await until(() => receipts.some((r) => r.marker === "SMOKE:cancel"));
  const abortedAt = Date.now();
  await send({ cmd: "abort", tabId });
  await until(() => complete(events.slice(cursor)), 10000);
  await until(() => receipts.some((r) => r.marker === "SMOKE:cancel" && r.closed && !r.completed), 10000);
  check("cancel_closes_provider_before_delayed_response", Date.now() - abortedAt < 10000 && !events.slice(cursor).some((e) => e.type === "model.final" && e.content?.includes("LOCAL_OK SMOKE:cancel")));
  const fault = await inputProbe("auth-fault", { cmd: "ask_light", text: "SMOKE:auth-fault Reply OK" }, complete);
  check("auth_fault_visible_and_not_success", fault.events.some((e) => ["error", "$error"].includes(e.type)) && !fault.events.some((e) => e.type === "model.final" && e.content?.includes("LOCAL_OK")));
  const retry = await inputProbe("retry", { cmd: "ask_light", text: "SMOKE:retry Reply OK" }, (list) => successful(list, "retry"));
  check("real_http_retry_then_success", receipts.filter((r) => r.marker === "SMOKE:retry").length === 2, { elapsedMs: retry.elapsedMs });
  const agentRecovery = await inputProbe("agent-after-cancel", { cmd: "user_input", text: "SMOKE:agent-recovery Reply OK using Agent mode. No tool is needed." }, complete);
  check("agent_recovers_after_ask_cancel", receipts.some((r) => r.marker === "SMOKE:agent-recovery" && r.stream && r.authenticatedSynthetic) &&
    successful(agentRecovery.events, "agent-recovery"), { finals: agentRecovery.events.filter((e) => e.type === "model.final").map((e) => ({ content: e.content, forcedSummary: e.forcedSummary })) });
  await inputProbe("recovery", { cmd: "ask_light", text: "SMOKE:recovery Reply OK" }, (list) => successful(list, "recovery"));
  if (argv.includes("--shared-tabs")) {
    phase = "shared-session-parallel";
    const cursor = events.length;
    const sourceTab = tabId;
    const slowId = randomUUID();
    await send({ cmd: "ask_light", tabId: sourceTab, clientId: slowId, text: "SMOKE:parallel-cancel-a hold this turn" });
    await until(() => events.slice(cursor).some((event) => event.type === "user.message" && event.tabId === sourceTab));
    await send({ cmd: "tab_parallel", tabId: sourceTab });
    await until(() => events.slice(cursor).some((event) => event.type === "$tab_opened" && event.tabId !== sourceTab));
    const peer = events.slice(cursor).find((event) => event.type === "$tab_opened" && event.tabId !== sourceTab);
    await until(() => events.slice(cursor).some((event) => event.type === "$ready" && event.tabId === peer.tabId));
    await send({ cmd: "ask_light", tabId: peer.tabId, clientId: randomUUID(), text: "SMOKE:parallel-fast-b reply now" });
    await until(() => events.slice(cursor).some((event) => event.type === "model.final" && event.tabId === peer.tabId));
    check("native_parallel_peer_completes_while_source_runs", !events.slice(cursor).some((event) => event.type === "model.final" && event.tabId === sourceTab));
    await until(() => events.slice(cursor).filter((event) => event.type === "$shared_session_updated" && event.tabId === peer.tabId).length >= 2);
    const commits = events.slice(cursor).filter((event) => event.type === "$shared_session_updated" && event.tabId === peer.tabId);
    check("native_parallel_commits_follow_completion_order", commits[0].sourceTurnId !== slowId && commits[1].sourceTurnId === slowId);
    await send({ cmd: "ask_light", tabId: peer.tabId, clientId: randomUUID(), text: "SMOKE:parallel-next see both replies" });
    await until(() => events.slice(cursor).some((event) => event.type === "model.final" && event.content?.includes("SMOKE:parallel-next")));
    const next = receipts.findLast((receipt) => receipt.marker === "SMOKE:parallel-next");
    const markers = next.historyMarkers.flatMap((row) => row.markers);
    check("native_next_request_sees_both_committed_turns", markers.includes("SMOKE:parallel-cancel-a") && markers.includes("SMOKE:parallel-fast-b"));
    check("native_provider_does_not_receive_local_identity", receipts.every((receipt) => !receipt.localMetadataLeak));
  }
  check("no_transport_error_after_faults", !report.transportError && !report.leaseError);
  const network = (await readFile(join(run, "network.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const nodeProcesses = network.filter((r) => r.kind === "process");
  check("production_node_process_observed", nodeProcesses.some((r) => r.entry === report.cli.path && r.argv.includes("desktop") && r.home === home));
  check("host_parent_to_node_child_observed", nodeProcesses.some((r) => r.argv.includes("desktop") && r.ppid === child.pid));
  if (mode === "native") check("native_idempotent_spawn_one_node", nodeProcesses.filter((r) => r.argv.includes("desktop") && r.ppid === child.pid).length === 1);
  check("all_provider_requests_synthetic_auth", receipts.every((r) => r.authenticatedSynthetic));
  report.egress = { denied: network.filter((r) => r.kind === "connect" && !r.allowed).length,
    allowed: network.filter((r) => r.kind === "connect" && r.allowed).length, nodeProcesses };
  report.stages[3] = "delay, cancellation with provider socket closure, 401 redaction, 429 retry, truncated tools, subsequent recovery";
  report.status = mode === "native" ? "supplemental_rpc_passed_not_desktop_acceptance" : "passed";
}

async function memorySafetyCheck() {
  // Execute this runner's actual shutdown with fake hosts, servers and signals only.
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function shutdown() {"), source.indexOf('process.once("SIGTERM"'));
  assert(body.includes("finally"), "Shutdown cleanup must have a finally boundary");
  const invoke = new Function("child", "stopOwnedHost", "process", "provider", "control", "save", "report", "redact", "groupOwned", "testMode", `
    let closing, renewTimer, nativeMonitor, readerAbort;
    let state = { status: 'running_for_parent_cua' };
    const nativeRefresh = Promise.resolve();
    const processGroupOwned = groupOwned;
    const mode = testMode;
    const harnessStopped = true;
    const journal = () => {};
    ${body}
    return shutdown();
  `);
  const cases = [
    { name: "ownership_lost_before_term", initiallyOwned: false, noSignals: true },
    { name: "ownership_lost_after_term", loseAfterWait: 1, termOnly: true },
    { name: "ownership_lost_before_kill", loseAfterWait: 100, termOnly: true },
    { name: "term_esrch_still_cleans", termError: "ESRCH", termOnly: true },
    { name: "kill_esrch_still_cleans", killError: "ESRCH" },
    { name: "direct_pid_esrch_still_cleans", groupOwned: false, termError: "ESRCH", termOnly: true },
    { name: "host_eperm_still_cleans", termError: "EPERM", failureStage: "host", termOnly: true },
    { name: "verify_eperm_still_cleans", verifyError: "EPERM", failureStage: "host", noSignals: true },
    { name: "verify_esrch_still_cleans", verifyError: "ESRCH", noSignals: true },
    { name: "provider_failure_still_closes_control_and_saves", providerError: true, failureStage: "provider-connections" },
    { name: "owned_group_escalation", escalation: true },
    { name: "owned_direct_escalation", groupOwned: false, escalation: true },
    { name: "native_eof_without_signal", testMode: "native", noSignals: true },
  ];
  const results = [];
  for (const fixture of cases) {
    let owned = fixture.initiallyOwned !== false, checks = 0, waits = 0;
    const signals = [], closes = [], saved = [];
    const signal = (target, name) => {
      signals.push({ target, signal: name, owned });
      const code = name === "SIGTERM" ? fixture.termError : fixture.killError;
      if (code) throw Object.assign(new Error(`mock ${code}`), { code });
      if (name === "SIGKILL") owned = false;
    };
    const host = { pid: 777777, exitCode: null, signalCode: null,
      async verifyOwned() {
        checks++;
        if (fixture.verifyError) throw Object.assign(new Error(`mock ${fixture.verifyError}`), { code: fixture.verifyError });
        return owned;
      },
      kill: (name) => signal(777777, name),
      stdin: { end() { owned = false; } },
    };
    const server = (name) => ({
      closeAllConnections() {
        closes.push(`${name}-connections`);
        if (name === "provider" && fixture.providerError) throw new Error("mock provider close failure");
      },
      close(done) { closes.push(`${name}-close`); done(); },
    });
    const mockReport = { status: "memory-test" };
    await invoke(host, (target, options) => stopOwnedHost(target, { ...options, kill: signal,
      wait: async () => { if (++waits === fixture.loseAfterWait) owned = false; } }),
      { kill: signal, exitCode: 0 }, server("provider"), server("control"),
      async (name, data) => saved.push({ name, data: JSON.parse(JSON.stringify(data)) }), mockReport, (text) => text,
      fixture.groupOwned !== false, fixture.testMode ?? "native-ui");
    const cleanupCompleted = ["provider-connections", "provider-close", "control-connections", "control-close"].every((name) => closes.includes(name)) &&
      ["state.json", "report.json"].every((name) => saved.some((entry) => entry.name === name));
    const expectedSignals = fixture.noSignals ? signals.length === 0 : fixture.termOnly ?
      signals.length === 1 && signals[0].signal === "SIGTERM" :
      signals.length === 2 && signals[0].signal === "SIGTERM" && signals[1].signal === "SIGKILL";
    const expectedFailure = fixture.failureStage ? mockReport.status === "failed" &&
      mockReport.cleanupErrors?.some((error) => error.stage === fixture.failureStage) : !mockReport.cleanupErrors;
    const stateStatus = saved.find((entry) => entry.name === "state.json")?.data.status;
    const result = { name: fixture.name, ownershipChecks: checks, signals, closes, stateStatus,
      ok: cleanupCompleted && expectedSignals && expectedFailure && signals.every((entry) => entry.owned) &&
        stateStatus === (fixture.failureStage ? "stopped_with_errors" : "stopped") &&
        (!fixture.escalation || signals.at(-1)?.target === (fixture.groupOwned === false ? 777777 : -777777)),
    };
    results.push(result);
    const { name, ...details } = result;
    check(`memory_${name}`, result.ok, details);
  }
  const cwd = "/owned/work space's", witness = "/owned/cwd.txt", logFile = "/owned/log.txt";
  const script = ownedWorkspaceScript(["/owned/binary", "argument's value"], { cwd, cwdWitness: witness, logFile });
  const cwdOk = script.includes("cd '/owned/work space'\\''s' || exit 1\n") &&
    script.includes("pwd -P >'/owned/cwd.txt' || exit 1\n") && script.indexOf("cd ") < script.indexOf("exec ") &&
    script.includes("'argument'\\''s value'") && script.endsWith(" >>'/owned/log.txt' 2>&1\n");
  check("memory_launch_wrapper_enters_owned_cwd_and_records_witness", cwdOk);
  results.push({ name: "launch_wrapper_cwd", ok: cwdOk });
  await save("harness-safety-memory.json", { scope: "pure memory mocks; no real process signals or app launch",
    runnerSha256: hash(source), results, passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length });
}

async function selfCheck() {
  phase = "provider-self-check";
  await memorySafetyCheck();
  const cwdProbe = join(workspace, "cwd probe's");
  await mkdir(cwdProbe);
  const canonicalProbe = await realpath(cwdProbe);
  const cwdWitness = join(run, "self-check-cwd.txt");
  const cwdResult = await captureProgram("/bin/sh", ["-c", ownedWorkspaceScript([
    process.execPath, "--input-type=module", "-e", "process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME}))",
  ], { cwd: canonicalProbe, cwdWitness })], { cwd: "/" });
  check("launch_wrapper_actual_cwd_is_owned_from_unowned_parent", cwdResult.code === 0 &&
    JSON.parse(cwdResult.stdout).cwd === canonicalProbe && JSON.parse(cwdResult.stdout).home === home &&
    (await readFile(cwdWitness, "utf8")).trim() === canonicalProbe);
  const refused = await captureProgram("/bin/sh", ["-c", ownedWorkspaceScript([
    process.execPath, "-e", "process.stdout.write('UNEXPECTED_EXEC')",
  ], { cwd: join(run, "missing-owned-cwd") })], { cwd: "/" });
  check("launch_wrapper_missing_owned_cwd_fails_before_exec", refused.code === 1 && refused.stdout === "");
  const headers = { authorization: `Bearer ${syntheticKey}`, "content-type": "application/json" };
  const modelResult = await fetch(providerUrl + "/models", { headers });
  check("fake_models_protocol", (await modelResult.json()).data[0].id === models[0]);
  for (const stream of [false, true]) {
    const response = await fetch(providerUrl + "/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model: models[0], stream, messages: [{ role: "user", content: `SMOKE:self-${stream}` }] }) });
    const text = await response.text();
    check(`fake_chat_${stream ? "stream" : "nonstream"}`, response.status === 200 && text.includes("LOCAL_OK") && (!stream || text.includes("[DONE]")));
  }
  const toolResponse = await fetch(providerUrl + "/chat/completions", { method: "POST", headers,
    body: JSON.stringify({ model: models[0], stream: true, messages: [{ role: "user", content: "SMOKE:self-tools" }],
      tools: ["write_file", "read_file"].map((name) => ({ type: "function", function: { name } })) }) });
  const chunks = (await toolResponse.text()).split("\n\n").filter((block) => block.startsWith("data: {")).map((block) => JSON.parse(block.slice(6)));
  const calls = new Map();
  for (const chunk of chunks) for (const delta of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
    const call = calls.get(delta.index) ?? { args: "", name: "", id: "" };
    call.args += delta.function?.arguments ?? "";
    call.name += delta.function?.name ?? "";
    call.id += delta.id ?? "";
    calls.set(delta.index, call);
  }
  check("fake_long_interleaved_arguments_reassemble", calls.size === 3 && JSON.parse(calls.get(0).args).content === contentA && JSON.parse(calls.get(1).args).content === contentB && calls.get(2).id === "smoke-provider-read");
  const child = spawn(process.execPath, ["--import", guard, "--input-type=module", "-e", "import net from 'node:net'; try { net.connect(443,'example.com');process.exitCode=1; } catch(e) { if(e.message!=='SMOKE_EGRESS_DENIED') process.exitCode=2; }"], { env: isolatedEnv(), cwd: workspace, stdio: "ignore" });
  const exit = await new Promise((done, fail) => { child.on("error", fail); child.on("exit", done); });
  check("network_guard_denies_external_tcp_before_connect", exit === 0);
  const probe = spawn(process.execPath, ["--input-type=module", "-e", `import net from 'node:net';try{net.connect(${providerPort === 11434 ? 11435 : 11434},'127.0.0.1');process.exitCode=1;}catch(e){if(e.message!=='SMOKE_EGRESS_DENIED')process.exitCode=2;}`], { env: isolatedEnv(), cwd: workspace, stdio: "ignore" });
  const denied = await new Promise((done, fail) => { probe.on("error", fail); probe.on("exit", done); });
  check("network_guard_denies_unowned_loopback_service", denied === 0);
  const local = spawn(process.execPath, ["--input-type=module", "-e", `const r=await fetch('http://127.0.0.1:${providerPort}/health');if(!(await r.text()).includes('synthetic'))process.exitCode=1;`], { env: isolatedEnv(), cwd: workspace, stdio: "ignore" });
  const allowed = await new Promise((done, fail) => { local.on("error", fail); local.on("exit", done); });
  check("guarded_node_can_reach_owned_provider", allowed === 0);
  const tee = spawn(process.execPath, ["--input-type=module", "-e", `import fs from 'node:fs';process.stdin.emit('data',Buffer.from(JSON.stringify({cmd:'ask_light',text:'SMOKE:tee-check',apiKey:'synthetic-must-be-redacted'})+'\\n'));fs.writeSync(1,Buffer.from(JSON.stringify({type:'$ready',tabId:'self-check-only'})+'\\n'));`], {
    env: { ...isolatedEnv(), JUPITER_SMOKE_CAPTURE_RPC: "1" }, cwd: workspace, stdio: "ignore",
  });
  const teeExit = await new Promise((done, fail) => { tee.on("error", fail); tee.on("exit", done); });
  check("observational_stdio_tee_and_key_redaction", teeExit === 0 && (await rows("native-commands.jsonl")).some((r) => r.command.text === "SMOKE:tee-check" && r.command.apiKey === "[redacted]") && (await rows("native-sidecar-events.jsonl")).some((r) => r.event.type === "$ready"));
  if (process.platform === "darwin") {
    await createNativeSandbox("dev.jupiter.desktop.shared-qa-self-check");
    await probeNativeSandbox(process.execPath, isolatedEnv());
  }
  report.status = "self_check_passed_not_production_acceptance";
}

try {
  if (mode === "self-check") await selfCheck();
  else if (mode === "native-ui") await startNativeUi();
  else await suite();
} catch (error) {
  report.status = "failed";
  report.error = redact(error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  if (mintBrowser && !closing) {
    try { await mintBrowser(); } catch (error) {
      report.browserError = redact(error.message);
      if (report.status === "passed") { report.status = "failed"; process.exitCode = 1; }
    }
  }
  clearInterval(renewTimer);
  readerAbort?.abort();
  if (readerTask) await readerTask;
  report.finishedAt = new Date().toISOString();
  await save("report.json", report);
}
function printResult() {
  console.log(`RESULT ${report.status}\nREPORT ${join(run, "report.json")}`);
  if (report.error) console.error(redact(report.error.split("\n")[0]));
}
const keep = ["web", "native-ui"].includes(mode) && child?.pid && !child.ownershipLost && child.exitCode === null && child.signalCode === null && !argv.includes("--no-keep") && !closing;
if (mode === "web" && argv.includes("--yield-control")) clearInterval(renewTimer);
if (keep) {
  const controlToken = randomUUID();
  control = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${controlToken}`) { res.writeHead(403); res.end(); return; }
    if (req.method === "POST" && req.url === "/stop") {
      res.end("stopping"); setTimeout(() => { void shutdown(); }, 50); return;
    }
    if (req.method === "GET" && req.url === "/state") {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(state)); return;
    }
    if (mode === "native-ui" && req.method === "GET" && req.url === "/evidence") {
      void queueNativeRefresh().then((evidence) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(evidence)); }).catch((error) => { res.writeHead(500); res.end(redact(error.message)); });
      return;
    }
    res.writeHead(404); res.end();
  });
  const controlPort = await listen(control);
  state = { status: mode === "native-ui" ? "running_for_parent_cua" : "running_for_browser", mode, run, runnerPid: process.pid, hostPid: child.pid, providerPid,
    providerUrl, webOrigin: report.webOrigin, browserUrl: report.browserUrl, workspace, home, controlPort, controlToken,
    ...(mode === "native-ui" ? { app: report.app, appExecutable: report.appExecutable, node: report.node, cli: report.cli,
      launchEnvFile: join(run, "launch-env.json"), launch: report.host, sandboxProfile: nativeSandbox,
      evidenceFile: join(run, "native-evidence.json"), nativeDiagnosticPath: join(home, ".jupiter/desktop-diagnostics.jsonl"),
      acceptance: "pending_parent_cua_not_automatic_pass" } : {}) };
  await save("state.json", state);
  if (mode === "native-ui") {
    await queueNativeRefresh();
    nativeMonitor = setInterval(() => { void queueNativeRefresh().catch((error) => journal("monitor-errors.jsonl", { message: redact(error.message) })); }, 1500);
  }
  printResult();
  if (report.browserUrl) {
    await writeFile(join(run, "browser-url.txt"), report.browserUrl + "\n", { mode: 0o600 });
    console.log(`BROWSER ${report.browserUrl}`);
  }
  console.log(`KEPT ${run}\nSTOP node ${fileURLToPath(import.meta.url)} stop --run ${run}`);
  if (mode === "native-ui") {
    console.log(`QA_APP ${report.app.path}\nQA_PID ${child.pid}\nHOME ${home}\nWORKSPACE ${workspace}\nENV ${join(run, "launch-env.json")}\nSTATE ${join(run, "state.json")}\nPROVIDER ${providerUrl}\nEVIDENCE ${join(run, "native-evidence.json")}`);
    console.log("Parent CUA only: Ask SMOKE:nativeui-nonstream; Agent SMOKE:nativeui-tools; delay/cancel/auth-fault/retry/truncated markers are available. No Desktop pass is claimed by this runner.");
  } else {
    // Releasing the probe SSE and lease renewal allows browser takeover after its short lease TTL.
    console.log("Browser: pair with the URL above; take control explicitly if the probe lease is still active.\nSynthetic prompts: SMOKE:nonstream / SMOKE:tools / SMOKE:delay / SMOKE:cancel / SMOKE:auth-fault.\nBrowser/UI checks remain the parent's responsibility, not a claimed script pass.");
  }
} else {
  await shutdown();
  printResult();
}

const assert = require("node:assert/strict");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { Worker } = require("node:worker_threads");

async function main() {
  const dir = fs.mkdtempSync("/tmp/jupiter-probe-");
  let result;
  try {
    if (process.argv[3] === "timeout") {
      const descendant = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      console.log("JUPITER_TIMEOUT_DESCENDANT_PID " + descendant.pid);
      await new Promise(() => {});
    }
    fs.writeFileSync(`${dir}/source`, "synthetic-data");
    fs.renameSync(`${dir}/source`, `${dir}/renamed`);
    assert.equal(fs.readFileSync(`${dir}/renamed`, "utf8"), "synthetic-data");
    fs.symlinkSync(`${dir}/renamed`, `${dir}/link`);
    assert.equal(fs.readFileSync(`${dir}/link`, "utf8"), "synthetic-data");
    const shell = childProcess.spawnSync("/bin/sh", ["-c", "printf CHILD_OK"], { encoding: "utf8" });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(shell.stdout, "CHILD_OK");
    const worker = new Worker("const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]);const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes));require('node:worker_threads').parentPort.postMessage(instance.exports.answer())", { eval: true });
    const wasm = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    await worker.terminate();
    assert.equal(wasm, 42);
    result = { schemaVersion: 1, probeKind: "runtime", runId: process.argv[2], node: process.version, platform: process.platform, arch: process.arch, kernel: require("node:os").release(), workerWasm: wasm === 42, atomicRename: true, symlink: true, childExec: true };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log("JUPITER_GUEST_RESULT " + JSON.stringify({ ...result, cleanup: true }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

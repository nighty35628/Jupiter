import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = ts.createSourceFile(
  "server.ts",
  readFileSync("src/web/server.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let dispatch = "";
function visit(node: ts.Node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "dispatch")
    dispatch = node.getText(source);
  else ts.forEachChild(node, visit);
}
visit(source);

function delayedDispatch() {
  expect(dispatch).not.toBe("");
  let finish!: () => void;
  const dispatchAccepted = vi.fn(
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  const code = ts.transpileModule(
    `return { accepting: true, pendingRequests: 0,
    expectedOrigin: "http://127.0.0.1:1234", dispatchAccepted, ${dispatch} };`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const runtime = new Function("dispatchAccepted", code)(dispatchAccepted);
  return { runtime, dispatchAccepted, finish: () => finish() };
}

describe("idle-neutral HTTP accounting", { retry: 0 }, () => {
  it.each([
    ["POST", "/api/lease/renew"],
    ["GET", "/api/session"],
    ["GET", "/api/events?connectionId=heartbeat"],
  ])("does not count a delayed %s %s, but still dispatches it normally", async (method, url) => {
    const f = delayedDispatch();
    const request = { method, url };
    const response = {};
    const pending = f.runtime.dispatch(request, response);
    expect(f.dispatchAccepted).toHaveBeenCalledWith(request, response);
    expect(f.runtime.pendingRequests).toBe(0);
    f.finish();
    await pending;
    expect(f.runtime.pendingRequests).toBe(0);
  });

  it.each([
    ["POST", "/api/rpc"],
    ["POST", "/api/files/upload"],
    ["GET", "/api/files/download-id"],
    ["POST", "/api/lease/acquire"],
    ["POST", "/api/session"],
    ["POST", "/api/events"],
    ["GET", "/api/lease/renew"],
    ["HEAD", "/api/session"],
    ["GET", "/api/session/"],
  ])("continues to protect delayed %s %s", async (method, url) => {
    const f = delayedDispatch();
    const pending = f.runtime.dispatch({ method, url }, {});
    expect(f.runtime.pendingRequests).toBe(1);
    f.finish();
    await pending;
    expect(f.runtime.pendingRequests).toBe(0);
  });
});

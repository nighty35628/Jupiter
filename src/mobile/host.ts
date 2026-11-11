import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadWorkspaceDir, readConfig, saveDashboardPort } from "../config.js";
import { installProxyIfConfigured } from "../net/proxy.js";
import { startWebServer } from "../web/server.js";
import { DesktopSidecar, SupervisedSidecar, type WebSidecar } from "../web/sidecar.js";
import { WorkspaceRegistry } from "../web/workspaces.js";
import { getAndroidRuntimeContext } from "./runtime-context.js";

const DIRECTORY = /^(?:default|[0-9a-f-]{36})$/;
const UUID = /^[0-9a-f-]{36}$/;

/** Optional display-only metadata; malformed/missing files leave the directory-name fallback. */
export async function readAndroidWorkspaceName(
  workspacesRoot: string,
  directory: string,
): Promise<string | undefined> {
  if (!UUID.test(directory)) return undefined;
  let handle: FileHandle | undefined;
  try {
    const names = join(workspacesRoot, ".names");
    if (!(await lstat(names)).isDirectory()) return undefined;
    handle = await open(
      join(names, `${directory}.txt`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 400) return undefined;
    // Read one extra byte so growth after fstat cannot bypass the limit.
    const buffer = Buffer.alloc(401);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > 400) return undefined;
    const label = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)).trim();
    if (
      !label ||
      Array.from(label).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      })
    )
      return undefined;
    return label;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface AndroidActivity {
  active: number;
  idleReady: boolean;
  stopped?: boolean;
}

/** Private owner-state query, never an inference from renderer/model events. */
export function requestAndroidActivity(
  sidecar: WebSidecar,
  command: "android_activity" | "android_guarded_idle_stop",
  timeoutMs = 3000,
): Promise<AndroidActivity> {
  const runtimeEpoch = sidecar.runtimeEpoch;
  const requestId = randomUUID();
  return new Promise((resolveReply, rejectReply) => {
    const finish = (error?: Error, activity?: AndroidActivity) => {
      clearTimeout(timer);
      unsubscribe();
      if (error) rejectReply(error);
      else resolveReply(activity!);
    };
    const unsubscribe = sidecar.subscribe(({ packet }) => {
      if (packet.channel === "rpc:exit") {
        finish(new Error("Android runtime exited"));
        return;
      }
      if (packet.channel !== "rpc:event") return;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(packet.payload.data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        event = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "$runtime_restarted") {
        finish(new Error("Android runtime changed"));
        return;
      }
      if (event.type !== "$android_activity" || event.requestId !== requestId) return;
      if (
        sidecar.runtimeEpoch !== runtimeEpoch ||
        event.runtimeEpoch !== runtimeEpoch ||
        !Number.isSafeInteger(event.active) ||
        (event.active as number) < 0 ||
        typeof event.idleReady !== "boolean"
      ) {
        finish(new Error("Invalid Android activity response"));
        return;
      }
      finish(undefined, {
        active: event.active as number,
        idleReady: event.idleReady,
        stopped: event.stopped === true,
      });
    });
    const timer = setTimeout(
      () => finish(new Error("Android activity query timed out")),
      timeoutMs,
    );
    void sidecar.send({ cmd: command, requestId, runtimeEpoch }).catch((error) => finish(error));
  });
}

export async function guardedAndroidIdleStop(
  handle: Pick<Awaited<ReturnType<typeof startWebServer>>, "guardedClose">,
  sidecar: WebSidecar,
): Promise<boolean> {
  return handle.guardedClose(async () => {
    const reply = await requestAndroidActivity(sidecar, "android_guarded_idle_stop");
    return reply.stopped === true && reply.idleReady && reply.active === 0;
  });
}

/** One local host; the existing supervisor continues to own its Agent child. */
export async function startAndroidHost(): Promise<void> {
  const context = getAndroidRuntimeContext();
  if (context?.role !== "host") throw new Error("Android host requires a private bootstrap");
  const workspacesRoot = "/workspaces";
  await mkdir(join(workspacesRoot, "default"), { recursive: true });
  const registry = new WorkspaceRegistry();
  const register = async (directory: string, name?: string) => {
    if (!DIRECTORY.test(directory)) throw new Error("Invalid private project directory");
    const path = join(workspacesRoot, directory);
    if (!(await lstat(path)).isDirectory()) throw new Error("Project is not a private directory");
    const canonical = await realpath(path);
    const rel = relative(await realpath(workspacesRoot), canonical);
    if (rel !== directory) throw new Error("Project path is outside the private project root");
    const displayName = name ?? (await readAndroidWorkspaceName(workspacesRoot, directory));
    return registry.register(canonical, { name: displayName?.slice(0, 100) });
  };
  for (const entry of await readdir(workspacesRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && DIRECTORY.test(entry.name)) await register(entry.name);
  }
  const configured = loadWorkspaceDir();
  const initial =
    configured && (await registry.idForExactRoot(configured))
      ? resolve(configured)
      : join(workspacesRoot, "default");
  const config = readConfig();
  const proxy = config.proxy;
  installProxyIfConfigured(process.env, {
    disabled: proxy?.disabled === true,
    url: proxy?.url,
    extraNoProxy: proxy?.noProxy,
    bypassDeepSeekDirect: proxy?.bypassDeepSeekDirect,
  });
  let idleStopInProgress = false;
  const sidecar = new SupervisedSidecar({
    create: () => {
      // Do not replace an idle-committed child between its acknowledgement and host close.
      if (idleStopInProgress) throw new Error("Android idle shutdown is in progress");
      return new DesktopSidecar({
        dir: initial,
        cliEntry: process.argv[1],
        inheritEnvironment: false,
        accessMode: "local",
      });
    },
  });
  let handle: Awaited<ReturnType<typeof startWebServer>>;
  const requestedPort = config.dashboard?.port;
  const port =
    typeof requestedPort === "number" &&
    Number.isInteger(requestedPort) &&
    requestedPort > 0 &&
    requestedPort <= 65535
      ? requestedPort
      : 0;
  try {
    handle = await startWebServer({
      sidecar,
      mode: "local",
      host: "127.0.0.1",
      port,
      workspaces: registry,
    });
  } catch (error) {
    await sidecar.close();
    throw error;
  }
  // Keep the WebView origin stable so existing draft/theme storage survives restarts.
  // A busy saved port is an explicit failure, never an unrelated server's readiness.
  try {
    saveDashboardPort(handle.port);
  } catch (error) {
    await handle.close();
    throw error;
  }
  const publish = (value: object) =>
    process.stdout.write(`${JSON.stringify({ ...value, runId: context.runId, version: 1 })}\n`);
  publish({ type: "android-ready", url: handle.url });
  await new Promise<void>((resolveDone, rejectDone) => {
    const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    let closed = false;
    let sampling = false;
    let pendingControls = 0;
    const sample = async () => {
      if (closed || sampling || idleStopInProgress) return;
      sampling = true;
      let activity: AndroidActivity = { active: 1, idleReady: false };
      try {
        activity = await requestAndroidActivity(sidecar, "android_activity");
      } catch {
        /* A missing or restarting owner is not known-idle. */
      } finally {
        sampling = false;
      }
      if (!closed && !idleStopInProgress) {
        const active = activity.active + handle.activityCount() + pendingControls;
        publish({
          type: "android-activity",
          active,
          idleReady: activity.idleReady && active === 0,
        });
      }
    };
    const sampleTimer = setInterval(() => void sample(), 5000);
    sampleTimer.unref();
    publish({ type: "android-activity", active: 1, idleReady: false });
    void sample();
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(sampleTimer);
      input.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void handle.close().then(resolveDone, rejectDone);
    };
    let queue = Promise.resolve();
    input.on("line", (line) => {
      pendingControls++;
      queue = queue
        .then(async () => {
          if (closed) return;
          let value: Record<string, unknown>;
          try {
            if (Buffer.byteLength(line) > 8192) throw new Error();
            value = JSON.parse(line);
            if (
              value.type !== "android-control" ||
              value.version !== 1 ||
              value.runId !== context.runId
            )
              throw new Error();
          } catch {
            stop();
            return;
          }
          if (value.command === "stop") {
            stop();
            return;
          }
          const requestId = value.requestId;
          if (typeof requestId !== "string" || !UUID.test(requestId)) {
            stop();
            return;
          }
          try {
            let result: unknown;
            if (value.command === "register_workspace" && typeof value.directory === "string") {
              result = await register(
                value.directory,
                typeof value.name === "string" ? value.name : undefined,
              );
            } else if (value.command === "list_workspaces") {
              result = registry
                .list()
                .map((item) => ({ ...item, directory: basename(registry.rootFor(item.id)) }));
            } else if (value.command === "guarded_idle_stop") {
              let stopped = false;
              idleStopInProgress = true;
              try {
                if (pendingControls === 1) stopped = await guardedAndroidIdleStop(handle, sidecar);
              } finally {
                if (!stopped) idleStopInProgress = false;
              }
              publish({ type: "android-result", requestId, ok: true, result: { stopped } });
              if (stopped) stop();
              return;
            } else throw new Error("Unsupported Android host operation");
            publish({ type: "android-result", requestId, ok: true, result });
          } catch {
            publish({
              type: "android-result",
              requestId,
              ok: false,
              error: "The Android host operation could not be completed",
            });
          }
        })
        .catch(() => stop())
        .finally(() => {
          pendingControls--;
        });
    });
    input.once("close", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

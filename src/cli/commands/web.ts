import { existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import type { WebAccessMode } from "../../web/policy.js";
import { startWebServer } from "../../web/server.js";
import { DesktopSidecar, SupervisedSidecar } from "../../web/sidecar.js";
import { openUrl } from "../ui/open-url.js";

export interface WebCommandOptions {
  dir?: string;
  port?: number;
  open?: boolean;
  model?: string;
  budgetUsd?: number;
  access?: WebAccessMode;
  host?: string;
  origin?: string;
  proxySecretFile?: string;
  approvedRoots?: string[];
  highRiskEnabled?: boolean;
}

export async function webCommand(opts: WebCommandOptions): Promise<void> {
  const rootDir = resolve(opts.dir ?? process.cwd());
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    throw new Error(`web workspace is not a directory: ${rootDir}`);
  }
  const access = parseWebAccessMode(opts.access);
  const port = access === "local" ? opts.port : (opts.port ?? 1420);
  const origin = resolveWebOrigin(access, port, opts.origin);
  const proxySecret = access === "public" ? loadProxySecret(opts.proxySecretFile) : undefined;
  if (access === "public" && opts.highRiskEnabled) {
    throw new Error(
      "public Web Beta does not enable terminal, MCP, Git writes, or full-control mode",
    );
  }
  const workspaceRoots = [rootDir, ...(opts.approvedRoots ?? []).map((path) => resolve(path))];

  const createSidecar = () =>
    new DesktopSidecar({
      dir: rootDir,
      model: opts.model,
      budgetUsd: opts.budgetUsd,
      inheritEnvironment: access === "local",
      accessMode: access,
      highRiskEnabled: access === "lan" && opts.highRiskEnabled === true,
    });
  const sidecar = new SupervisedSidecar({ create: createSidecar });
  let handle: Awaited<ReturnType<typeof startWebServer>>;
  try {
    handle = await startWebServer({
      sidecar,
      port,
      mode: access,
      host: opts.host,
      origin,
      proxySecret,
      workspaceRoots,
      highRiskEnabled: access === "lan" && opts.highRiskEnabled === true,
    });
  } catch (err) {
    await sidecar.close().catch(() => undefined);
    throw err;
  }

  process.stdout.write(
    [
      `Jupiter Web Beta is running (${access}).`,
      `  ${handle.url}`,
      `  workspace: ${rootDir}`,
      access === "local"
        ? "  local browser only; press Ctrl+C to stop"
        : access === "lan"
          ? "  paired private-network devices only; press Ctrl+C to stop"
          : "  HTTPS identity proxy required; direct access is rejected",
      "",
    ].join("\n"),
  );
  if (opts.open !== false) {
    const opened = openUrl(handle.url);
    if (!opened.opened && opened.reason !== "ci" && opened.reason !== "disabled") {
      process.stderr.write(`Could not open the browser automatically (${opened.reason}).\n`);
    }
  }

  await new Promise<void>((resolveDone) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void handle.close().finally(resolveDone);
    };
    const unsubscribe = sidecar.subscribe((item) => {
      if (item.packet.channel === "rpc:stderr") {
        process.stderr.write(`${item.packet.payload.data}\n`);
        return;
      }
      if (item.packet.channel !== "rpc:exit" || stopping) return;
      const code = item.packet.payload.code;
      if (code !== null && code !== 0) process.exitCode = code;
      stop();
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const finish = () => {
      unsubscribe();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    handle.close = onceAfter(handle.close, finish);
  });
}

function parseWebAccessMode(value: unknown): WebAccessMode {
  if (value === undefined) return "local";
  if (value === "local" || value === "lan" || value === "public") return value;
  throw new Error(`invalid Web access mode: ${String(value)} (expected local, lan, or public)`);
}

function resolveWebOrigin(
  access: WebAccessMode,
  port: number | undefined,
  requested: string | undefined,
): string | undefined {
  if (access === "local") return requested;
  if (!port) throw new Error(`${access} Web mode requires an explicit --port`);
  if (requested) return new URL(requested).origin;
  if (access === "public") throw new Error("public Web mode requires --origin https://...");
  const address = firstPrivateIpv4();
  if (!address)
    throw new Error("could not determine a private LAN address; pass --origin explicitly");
  return `http://${address}:${port}`;
}

function loadProxySecret(path: string | undefined): string {
  const fromEnvironment = process.env.JUPITER_WEB_PROXY_SECRET?.trim();
  const value = path ? readFileSync(resolve(path), "utf8").trim() : fromEnvironment;
  if (!value || value.length < 32) {
    throw new Error(
      "public Web mode requires --proxy-secret-file or JUPITER_WEB_PROXY_SECRET (32+ characters)",
    );
  }
  return value;
}

function firstPrivateIpv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (
        entry.address.startsWith("10.") ||
        entry.address.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)
      ) {
        return entry.address;
      }
    }
  }
  return null;
}

function onceAfter(fn: () => Promise<void>, after: () => void): () => Promise<void> {
  let promise: Promise<void> | null = null;
  return () => {
    if (!promise) promise = fn().finally(after);
    return promise;
  };
}

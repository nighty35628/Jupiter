import { isAbsolute, resolve } from "node:path";

export type AndroidRuntimeRole = "host" | "interactive" | "scheduled";

/** Safe to inspect: the DEK is never a property of this object. */
export interface AndroidRuntimeContext {
  readonly role: AndroidRuntimeRole;
  readonly runId: string;
  readonly configPath: string;
}

export interface AndroidRuntimeBootstrap extends AndroidRuntimeContext {
  readonly dek: Uint8Array;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let context: AndroidRuntimeContext | undefined;
let configKey: Uint8Array | undefined;

function validateIdentity(role: unknown, runId: unknown): void {
  if (role !== "host" && role !== "interactive" && role !== "scheduled") {
    throw new Error("Invalid Android runtime role");
  }
  if (typeof runId !== "string" || !UUID.test(runId)) {
    throw new Error("Android runtime runId must be a UUID");
  }
}

/** Private stdin bootstrap only; caller erases its input DEK after this copies it. */
export function initializeAndroidRuntimeContext(
  input: AndroidRuntimeBootstrap,
): AndroidRuntimeContext {
  if (context) throw new Error("Android runtime context is already initialized");
  if (!input || typeof input !== "object") throw new Error("Invalid Android runtime bootstrap");
  validateIdentity(input.role, input.runId);
  if (
    typeof input.configPath !== "string" ||
    !isAbsolute(input.configPath) ||
    input.configPath.includes("\0")
  ) {
    throw new Error("Android runtime configPath must be an absolute path");
  }
  if (!(input.dek instanceof Uint8Array) || input.dek.byteLength !== 32) {
    throw new Error("Android runtime requires a 32-byte DEK");
  }
  const metadata = Object.freeze({
    role: input.role,
    runId: input.runId,
    configPath: resolve(input.configPath),
  });
  configKey = new Uint8Array(input.dek);
  context = metadata;
  return metadata;
}

export function getAndroidRuntimeContext(): AndroidRuntimeContext | undefined {
  return context;
}

/** Lexical path identity only; this API does not authorize alternate config files. */
export function isAndroidManagedConfigPath(path: string): boolean {
  return context !== undefined && resolve(path) === context.configPath;
}

/** Trusted synchronous use only. The temporary copy is zeroed even if use throws. */
export function withAndroidConfigKey<T>(path: string, use: (dek: Uint8Array) => T): T {
  if (!isAndroidManagedConfigPath(path) || !configKey) {
    throw new Error("Android config key is unavailable for this path");
  }
  const copy = new Uint8Array(configKey);
  try {
    return use(copy);
  } finally {
    copy.fill(0);
  }
}

/** Delivers a transient DEK synchronously to a trusted child, never through env or argv. */
export function withAndroidChildBootstrap(
  role: Exclude<AndroidRuntimeRole, "host">,
  runId: string,
  deliver: (metadata: AndroidRuntimeContext, dek: Uint8Array) => void,
): void {
  if (!context) throw new Error("Android child bootstrap requires an initialized runtime");
  validateIdentity(role, runId);
  if (role !== "interactive" && role !== "scheduled") {
    throw new Error("Invalid Android child runtime role");
  }
  if (context.role === "scheduled" || (context.role === "interactive" && role !== "scheduled")) {
    throw new Error("Android runtime role cannot bootstrap this child");
  }
  const metadata = Object.freeze({ role, runId, configPath: context.configPath });
  withAndroidConfigKey(context.configPath, (dek) => deliver(metadata, dek));
}

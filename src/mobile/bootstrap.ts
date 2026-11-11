import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  type AndroidRuntimeBootstrap,
  type AndroidRuntimeRole,
  getAndroidRuntimeContext,
  initializeAndroidRuntimeContext,
  withAndroidChildBootstrap,
} from "./runtime-context.js";

const MAX_FRAME_BYTES = 8192;

export function parseAndroidBootstrap(text: string): AndroidRuntimeBootstrap {
  try {
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error();
    const value = JSON.parse(text);
    const fields = ["type", "version", "role", "runId", "configPath", "dek"];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== fields.length ||
      !fields.every((key) => Object.hasOwn(value, key)) ||
      value.type !== "android-bootstrap" ||
      value.version !== 1 ||
      typeof value.dek !== "string"
    )
      throw new Error();
    const dek = Buffer.from(value.dek, "base64");
    if (dek.length !== 32 || dek.toString("base64") !== value.dek) {
      dek.fill(0);
      throw new Error();
    }
    return { role: value.role, runId: value.runId, configPath: value.configPath, dek };
  } catch {
    throw new Error("Invalid Android bootstrap frame");
  }
}

/** Consume only the private first frame; preserve any queued RPC bytes. */
export function readAndroidBootstrap(input: Readable, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      input.pause();
      input.off("data", data);
      input.off("end", end);
      input.off("error", failed);
    };
    const failed = () => {
      cleanup();
      pending.fill(0);
      reject(new Error("Android bootstrap channel failed"));
    };
    const end = () => {
      cleanup();
      pending.fill(0);
      reject(new Error("Android bootstrap ended before initialization"));
    };
    const timer = setTimeout(() => {
      cleanup();
      pending.fill(0);
      reject(new Error("Android bootstrap timed out"));
    }, timeoutMs);
    const data = (chunk: Buffer | string) => {
      const next = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      pending.fill(0);
      pending = next;
      const newline = pending.indexOf(10);
      if (newline < 0 && pending.length <= MAX_FRAME_BYTES) return;
      cleanup();
      let bootstrap: AndroidRuntimeBootstrap | undefined;
      try {
        if (newline < 0 || newline > MAX_FRAME_BYTES)
          throw new Error("Invalid Android bootstrap frame");
        bootstrap = parseAndroidBootstrap(pending.subarray(0, newline).toString("utf8"));
        initializeAndroidRuntimeContext(bootstrap);
        const rest = Buffer.from(pending.subarray(newline + 1));
        if (rest.length) input.unshift(rest);
        resolve();
      } catch {
        reject(new Error("Android bootstrap initialization failed"));
      } finally {
        bootstrap?.dek.fill(0);
        pending.fill(0);
      }
    };
    input.on("data", data);
    input.once("end", end);
    input.once("error", failed);
    input.resume();
  });
}

/** The managed child receives its DEK before any RPC command, never in its env. */
export function writeAndroidChildBootstrap(
  output: Writable,
  role: Exclude<AndroidRuntimeRole, "host">,
): Promise<void> {
  if (!getAndroidRuntimeContext()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    withAndroidChildBootstrap(role, randomUUID(), (metadata, dek) => {
      const frame = Buffer.from(
        `${JSON.stringify({
          type: "android-bootstrap",
          version: 1,
          ...metadata,
          dek: Buffer.from(dek).toString("base64"),
        })}\n`,
      );
      output.write(frame, (error) => {
        frame.fill(0);
        if (error) reject(new Error("Android child initialization channel failed"));
        else resolve();
      });
    });
  });
}

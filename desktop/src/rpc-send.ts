export type RpcSendFailureStage =
  | "not_spawned"
  | "write_failed"
  | "flush_failed"
  | "blocked"
  | "unknown";

export class RpcSendFailure extends Error {
  readonly stage: RpcSendFailureStage;
  readonly causeValue: unknown;

  constructor(stage: RpcSendFailureStage, message: string, causeValue?: unknown) {
    super(message);
    this.name = "RpcSendFailure";
    this.stage = stage;
    this.causeValue = causeValue;
  }
}

function messageFromUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isStage(value: unknown): value is Exclude<RpcSendFailureStage, "unknown"> {
  return (
    value === "not_spawned" ||
    value === "write_failed" ||
    value === "flush_failed" ||
    value === "blocked"
  );
}

export function coerceRpcSendFailure(value: unknown): RpcSendFailure {
  if (value instanceof RpcSendFailure) return value;
  if (value && typeof value === "object") {
    const candidate = value as { stage?: unknown; message?: unknown };
    if (isStage(candidate.stage)) {
      return new RpcSendFailure(candidate.stage, messageFromUnknown(value), value);
    }
  }

  const message = messageFromUnknown(value);
  if (/rpc not spawned/i.test(message)) {
    return new RpcSendFailure("not_spawned", message, value);
  }
  if (/^(?:write|rpc write failed):/i.test(message)) {
    return new RpcSendFailure("write_failed", message, value);
  }
  if (/^(?:flush|rpc flush failed):/i.test(message)) {
    return new RpcSendFailure("flush_failed", message, value);
  }
  return new RpcSendFailure("unknown", message || "RPC send failed", value);
}

export function isDefinitelyUnsent(value: unknown): boolean {
  const stage = coerceRpcSendFailure(value).stage;
  return stage === "not_spawned" || stage === "blocked";
}

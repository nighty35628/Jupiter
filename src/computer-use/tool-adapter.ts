import { attachments } from "../attachments/store.js";
import { MAX_IMAGE_INPUT_BYTES } from "../attachments/types.js";
import type { McpClient } from "../mcp/client.js";
import type { CallToolResult } from "../mcp/types.js";
import type { ToolCallContext, ToolRegistry } from "../tools.js";
import type { JSONSchema } from "../types.js";
import type { ComputerUseController } from "./controller.js";
import { ComputerUseStaleActionError } from "./controller.js";
import type {
  ComputerUseClick,
  ComputerUseFence,
  ComputerUseMove,
  ComputerUsePermissionMode,
  ComputerUseScroll,
  ComputerUseType,
} from "./types.js";

const desktopTarget = { kind: "desktop", display_id: "primary" } as const;

export const COMPUTER_USE_TOOL_NAMES = [
  "computer_use_get_desktop_state",
  "computer_use_get_screen_size",
  "computer_use_get_cursor_position",
  "computer_use_click",
  "computer_use_move",
  "computer_use_scroll",
  "computer_use_type",
] as const;

const observationSchema: JSONSchema = { type: "object", properties: {} };

function structured(result: CallToolResult): Record<string, unknown> | undefined {
  return result.structuredContent && typeof result.structuredContent === "object"
    ? (result.structuredContent as Record<string, unknown>)
    : undefined;
}

function output(result: CallToolResult): string {
  return JSON.stringify({
    ...(structured(result) ?? {}),
    content: result.content.filter((block) => block.type === "text"),
    ...(result.isError ? { isError: true } : {}),
  });
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Computer Use driver returned an invalid ${name}`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function actionSchema(properties: Record<string, JSONSchema>, required: string[]): JSONSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export class ComputerUseToolAdapter {
  constructor(
    private readonly client: McpClient,
    private readonly controller: ComputerUseController,
    private readonly permissionMode:
      | ComputerUsePermissionMode
      | (() => ComputerUsePermissionMode) = "standard",
    private readonly policy?: () => void,
  ) {}

  private guard(fence: ComputerUseFence, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    this.policy?.();
    signal?.throwIfAborted();
    this.controller.assertFence(fence);
  }

  async getDesktopState(
    signal?: AbortSignal,
    reportImage?: ToolCallContext["reportImage"],
  ): Promise<string> {
    this.controller.invalidateObservation();
    if (!reportImage)
      throw new Error("Computer Use requires an image-capable model. Select a vision model first.");
    const fence = this.controller.fence();
    signal?.throwIfAborted();
    await this.controller.renew();
    this.guard(fence, signal);
    const result = await this.client.callTool("get_desktop_state", {}, { signal });
    signal?.throwIfAborted();
    this.controller.assertFence(fence);
    if (!result.isError) {
      const data = structured(result);
      if (!data) throw new Error("Computer Use driver returned no screenshot metadata");
      {
        const screenshotWidth = numberField(data.screenshot_width, "screenshot width");
        const screenshotHeight = numberField(data.screenshot_height, "screenshot height");
        const screenWidth = numberField(data.screen_width, "screen width");
        const screenHeight = numberField(data.screen_height, "screen height");
        const blocks = result.content.filter((block) => block.type === "image");
        if (blocks.length !== 1)
          throw new Error("Computer Use driver did not return one screenshot");
        const block = blocks[0]!;
        if (
          block.data.length > Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4 ||
          block.mimeType !== "image/png"
        ) {
          throw new Error("Computer Use screenshot format/size is not supported");
        }
        const image = await attachments.importBytes(
          Buffer.from(block.data, "base64"),
          "desktop-screenshot.png",
          signal,
        );
        const variant = await attachments.requestImage(image.id, signal);
        this.guard(fence, signal);
        reportImage(image);
        const observation = this.controller.recordObservation({
          capturedAt: Date.now(),
          imageWidth: variant.width,
          imageHeight: variant.height,
          // Cua Driver desktop actions use native screenshot pixels. Keep the
          // fence in that coordinate space instead of silently mixing Retina points.
          screen: {
            left: 0,
            top: 0,
            width: screenshotWidth,
            height: screenshotHeight,
            scaleFactor: data.scale_factor as number | undefined,
          },
        });
        return JSON.stringify({
          ...data,
          observationId: observation.id,
          coordinateSpace:
            "Use x/y in the attached image dimensions, not native screen pixels or points.",
          screenWidth,
          screenHeight,
          observation: {
            id: observation.id,
            epoch: observation.epoch,
            imageWidth: observation.imageWidth,
            imageHeight: observation.imageHeight,
          },
        });
      }
    }
    return output(result);
  }

  async getScreenSize(signal?: AbortSignal): Promise<string> {
    return this.readMetadata("get_screen_size", signal);
  }

  async getCursorPosition(signal?: AbortSignal): Promise<string> {
    return this.readMetadata("get_cursor_position", signal);
  }

  private async readMetadata(name: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const fence = this.controller.fence();
    await this.controller.renew();
    this.guard(fence, signal);
    const result = await this.client.callTool(name, {}, { signal });
    signal?.throwIfAborted();
    this.controller.assertFence(fence);
    return output(result);
  }

  private async sendAction(
    name: string,
    args: Record<string, unknown>,
    fence: ComputerUseFence,
    signal?: AbortSignal,
  ): Promise<string> {
    this.guard(fence, signal);
    const mode =
      typeof this.permissionMode === "function" ? this.permissionMode() : this.permissionMode;
    if (name === "type_text" && mode !== "unrestricted" && (args.text as string).length > 2000) {
      throw new Error("Computer Use type_text is limited to 2000 characters in guarded modes");
    }
    signal?.throwIfAborted();
    this.controller.assertFence(fence);
    if (this.client.connected === false)
      throw new Error("Cua Driver disconnected before input dispatch");
    let remoteInput: ReturnType<ComputerUseController["beginRemoteInput"]> | undefined;
    let acknowledged = false;
    let responseReturned = false;
    const acknowledge = () => {
      acknowledged = true;
      remoteInput?.acknowledge();
    };
    try {
      const result = await this.client.callTool(name, args, {
        signal,
        onSending: () => {
          remoteInput = this.controller.beginRemoteInput(fence);
        },
        onResponse: acknowledge,
      });
      responseReturned = true;
      // An ACK settles daemon work even if the UI effect or local fence is uncertain.
      acknowledge();
      signal?.throwIfAborted();
      this.controller.assertFence(fence);
      return output(result);
    } catch (error) {
      // A local rejection before send, or a confirmed RPC error, is not lost input.
      if (!responseReturned && (!remoteInput || acknowledged)) throw error;
      remoteInput?.markUnknown();
      const remoteFault = this.controller.remoteInputFault;
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: remoteFault ? `${message}. ${remoteFault.message}` : message,
        executionOutcome:
          signal?.aborted || error instanceof ComputerUseStaleActionError
            ? "unknown_after_cancel"
            : "unknown_after_transport",
        recovery: "unknown",
        retry: remoteFault
          ? "manual_recovery_required_before_repeating"
          : "inspect_current_state_before_repeating",
        ...(remoteFault ? { manualRecoveryRequired: true, leaseRetained: true } : {}),
      });
    }
  }

  async click(
    args: { observationId: string; x: number; y: number; button?: "left" | "middle" | "right" },
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const fence = this.controller.fence();
    await this.controller.renew();
    signal?.throwIfAborted();
    const prepared = this.controller.prepareAction(
      { type: "click", ...args },
      fence,
    ) as ComputerUseClick;
    return this.sendAction(
      "click",
      {
        x: prepared.x,
        y: prepared.y,
        button: prepared.button ?? "left",
        target: desktopTarget,
      },
      fence,
      signal,
    );
  }

  async move(
    args: { observationId: string; x: number; y: number },
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const fence = this.controller.fence();
    await this.controller.renew();
    signal?.throwIfAborted();
    const prepared = this.controller.prepareAction(
      { type: "move", ...args },
      fence,
    ) as ComputerUseMove;
    return this.sendAction(
      "move_cursor",
      {
        x: prepared.x,
        y: prepared.y,
        target: desktopTarget,
      },
      fence,
      signal,
    );
  }

  async scroll(
    args: {
      observationId: string;
      x: number;
      y: number;
      direction: "up" | "down" | "left" | "right";
      amount?: number;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const amount = args.amount ?? 3;
    if (
      !["up", "down", "left", "right"].includes(args.direction) ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > 50
    ) {
      throw new Error("Computer Use scroll requires a direction and 1-50 wheel notches");
    }
    signal?.throwIfAborted();
    const fence = this.controller.fence();
    await this.controller.renew();
    signal?.throwIfAborted();
    const prepared = this.controller.prepareAction(
      { type: "scroll", ...args },
      fence,
    ) as ComputerUseScroll;
    return this.sendAction(
      "scroll",
      {
        x: prepared.x,
        y: prepared.y,
        direction: prepared.direction,
        amount,
        target: desktopTarget,
      },
      fence,
      signal,
    );
  }

  async type(args: { observationId: string; text: string }, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const fence = this.controller.fence();
    await this.controller.renew();
    signal?.throwIfAborted();
    const observationId = requiredString(args.observationId, "observationId");
    const text = requiredString(args.text, "text");
    this.controller.prepareAction({ type: "type", observationId, text }, fence) as ComputerUseType;
    return this.sendAction("type_text", { text, target: desktopTarget }, fence, signal);
  }
}

export type ComputerUseToolSurface = Pick<
  ComputerUseToolAdapter,
  "getDesktopState" | "getScreenSize" | "getCursorPosition" | "click" | "move" | "scroll" | "type"
>;

export function registerComputerUseTools(
  registry: ToolRegistry,
  adapter: ComputerUseToolSurface,
): void {
  registry.register({
    name: "computer_use_get_desktop_state",
    description:
      "Capture the primary desktop and create a short-lived observation fence. Call before every computer action.",
    parameters: observationSchema,
    readOnly: true,
    stormExempt: true,
    fn: (_args, ctx) => adapter.getDesktopState(ctx?.signal, ctx?.reportImage),
  });
  registry.register({
    name: "computer_use_get_screen_size",
    description: "Read the primary display size without changing input state.",
    parameters: { type: "object", properties: {} },
    readOnly: true,
    stormExempt: true,
    fn: (_args, ctx) => adapter.getScreenSize(ctx?.signal),
  });
  registry.register({
    name: "computer_use_get_cursor_position",
    description: "Read the current cursor position without moving it.",
    parameters: { type: "object", properties: {} },
    readOnly: true,
    stormExempt: true,
    fn: (_args, ctx) => adapter.getCursorPosition(ctx?.signal),
  });
  registry.register({
    name: "computer_use_click",
    description:
      "Click a point from the latest computer_use_get_desktop_state observation. Stale observations are rejected.",
    parameters: actionSchema(
      {
        observationId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"] },
      },
      ["observationId", "x", "y"],
    ),
    fn: (args, ctx) =>
      adapter.click(args as Parameters<ComputerUseToolAdapter["click"]>[0], ctx?.signal),
  });
  registry.register({
    name: "computer_use_move",
    description:
      "Move the pointer using the attached desktop observation coordinates. Movement may not trigger application hover events; inspect a fresh screenshot to verify effects.",
    parameters: actionSchema(
      { observationId: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
      ["observationId", "x", "y"],
    ),
    fn: (args, ctx) =>
      adapter.move(args as Parameters<ComputerUseToolAdapter["move"]>[0], ctx?.signal),
  });
  registry.register({
    name: "computer_use_scroll",
    description:
      "Scroll from a point in the attached observation image. Amount is 1-50 wheel notches (default 3), not pixels.",
    parameters: actionSchema(
      {
        observationId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 50 },
      },
      ["observationId", "x", "y", "direction"],
    ),
    fn: (args, ctx) =>
      adapter.scroll(args as Parameters<ComputerUseToolAdapter["scroll"]>[0], ctx?.signal),
  });
  registry.register({
    name: "computer_use_type",
    description:
      "Type into the current target after a fresh desktop observation. Guarded modes limit the text length.",
    parameters: actionSchema({ observationId: { type: "string" }, text: { type: "string" } }, [
      "observationId",
      "text",
    ]),
    fn: (args, ctx) =>
      adapter.type(args as Parameters<ComputerUseToolAdapter["type"]>[0], ctx?.signal),
  });
}

export function unregisterComputerUseTools(registry: ToolRegistry): void {
  for (const name of COMPUTER_USE_TOOL_NAMES) registry.unregister(name);
}

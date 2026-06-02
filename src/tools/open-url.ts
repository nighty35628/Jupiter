import { spawn } from "node:child_process";
import type { ToolRegistry } from "../tools.js";

export type BrowserTarget = "default" | "chrome";

export interface OpenUrlCommand {
  command: string;
  args: string[];
}

export interface OpenUrlToolOptions {
  open?: (url: string, browser: BrowserTarget) => void | Promise<void>;
}

function normalizeBrowser(value: unknown): BrowserTarget {
  if (value === undefined || value === null || value === "") return "default";
  if (value === "default" || value === "chrome") return value;
  throw new Error("open_url: browser must be 'default' or 'chrome'");
}

function normalizeWebUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("open_url: url must be a string");
  const raw = value.trim();
  if (!raw) throw new Error("open_url: url is required");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("open_url: url must be an absolute http:// or https:// URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("open_url: only supports http:// or https:// URLs");
  }
  return raw;
}

export function buildOpenUrlCommand(
  url: string,
  browser: BrowserTarget = "default",
  platform: NodeJS.Platform = process.platform,
): OpenUrlCommand {
  const normalizedUrl = normalizeWebUrl(url);
  if (platform === "darwin") {
    if (browser === "chrome") {
      return { command: "open", args: ["-a", "Google Chrome", normalizedUrl] };
    }
    return { command: "open", args: [normalizedUrl] };
  }
  if (platform === "win32") {
    if (browser === "chrome") {
      return { command: "cmd", args: ["/c", "start", "", "chrome", normalizedUrl] };
    }
    return { command: "cmd", args: ["/c", "start", "", normalizedUrl] };
  }
  if (browser === "chrome") {
    return { command: "google-chrome", args: [normalizedUrl] };
  }
  return { command: "xdg-open", args: [normalizedUrl] };
}

export function openUrl(url: string, browser: BrowserTarget = "default"): void {
  const command = buildOpenUrlCommand(url, browser);
  const child = spawn(command.command, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function registerOpenUrlTool(
  registry: ToolRegistry,
  opts: OpenUrlToolOptions = {},
): ToolRegistry {
  const opener = opts.open ?? openUrl;
  registry.register({
    name: "open_url",
    description:
      "Open an absolute http:// or https:// URL in the user's browser. Use this for natural-language requests to open Chrome, the default browser, localhost URLs, docs, previews, or websites. Do not use run_command/open/xdg-open for browser launching.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http:// or https:// URL to open.",
        },
        browser: {
          type: "string",
          enum: ["default", "chrome"],
          description:
            "Browser target. Defaults to default; use chrome when the user asks for Chrome.",
        },
      },
      required: ["url"],
    },
    fn: async (args: { url?: unknown; browser?: unknown }) => {
      const url = normalizeWebUrl(args.url);
      const browser = normalizeBrowser(args.browser);
      await opener(url, browser);
      const label = browser === "chrome" ? "Google Chrome" : "the default browser";
      return `opened ${url} in ${label}`;
    },
  });
  return registry;
}

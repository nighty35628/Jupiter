/**
 * Bundled demo MCP server.
 *
 * A minimal stdio MCP server that exposes three tools: echo, add, get_time.
 * Useful for:
 *   - running the MCP integration end-to-end without installing
 *     an external server
 *   - giving the integration tests a real subprocess to spawn
 *   - showing the minimal shape of a server for folks writing their own
 *
 * Usage:
 *   npx tsx examples/mcp-server-demo.ts          # speaks MCP on stdin/stdout
 *   jupiter chat --mcp "npx tsx examples/mcp-server-demo.ts"
 *
 * Spec reference: https://spec.modelcontextprotocol.io/ (2024-11-05)
 * Only the subset this demo needs is implemented — initialize, tools/list,
 * tools/call, notifications/initialized (no-op).
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "echo",
    description: "Echoes the provided message back.",
    inputSchema: {
      type: "object",
      properties: { msg: { type: "string", description: "What to echo" } },
      required: ["msg"],
    },
  },
  {
    name: "add",
    description: "Adds two integers and returns the sum.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "integer" },
        b: { type: "integer" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "get_time",
    description: "Returns the server's current ISO-8601 timestamp.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slow_count",
    description:
      "Counts from 1 to n with a ~300 ms pause between steps, emitting notifications/progress frames along the way. Useful for demonstrating Jupiter's progress-bar UI.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "integer", description: "Final number to count to (default 5, max 20)" },
      },
    },
  },
];

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

function send(msg: JsonRpcSuccess | JsonRpcError | JsonRpcNotification): void {
  // Stdio MCP framing: one JSON per line.
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleRequest(
  req: JsonRpcRequest,
): Promise<JsonRpcSuccess | JsonRpcError | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id: id ?? 0,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "jupiter-demo-mcp", version: "0.0.1" },
          capabilities: { tools: { listChanged: false } },
        },
      };
    }

    case "notifications/initialized":
      // No response for notifications.
      return null;

    case "tools/list": {
      return { jsonrpc: "2.0", id: id ?? 0, result: { tools: TOOLS } };
    }

    case "tools/call": {
      const params = (req.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
        _meta?: { progressToken?: string | number };
      };
      const name = params.name ?? "";
      const args = params.arguments ?? {};
      const progressToken = params._meta?.progressToken;
      const out = await callTool(name, args, progressToken);
      if (out.error) {
        return {
          jsonrpc: "2.0",
          id: id ?? 0,
          result: {
            content: [{ type: "text", text: out.error }],
            isError: true,
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id: id ?? 0,
        result: { content: [{ type: "text", text: out.text }] },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  progressToken: string | number | undefined,
): Promise<{ text: string; error?: string }> {
  if (name === "echo") {
    const msg = typeof args.msg === "string" ? args.msg : "";
    return { text: `echo: ${msg}` };
  }
  if (name === "add") {
    const a = typeof args.a === "number" ? args.a : Number(args.a);
    const b = typeof args.b === "number" ? args.b : Number(args.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { text: "", error: "add: both a and b must be numbers" };
    }
    return { text: String(a + b) };
  }
  if (name === "get_time") {
    return { text: new Date().toISOString() };
  }
  if (name === "slow_count") {
    // Cap at 20 so an over-eager model can't make the demo run for
    // minutes. Default 5 gives ~1.5s which is plenty to see the bar.
    const raw = typeof args.n === "number" ? args.n : Number(args.n);
    const n = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 20) : 5;
    for (let i = 1; i <= n; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (progressToken !== undefined) {
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken,
            progress: i,
            total: n,
            message: `counting ${i} of ${n}`,
          },
        });
      }
    }
    return { text: `counted to ${n}` };
  }
  return { text: "", error: `unknown tool: ${name}` };
}

function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // malformed input — respond with parse error
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      return;
    }
    // Fire-and-forget: handleRequest is async so slow tools (slow_count
    // and any future streamed-progress tools) can emit notifications
    // between in-flight requests without blocking the reader loop. Any
    // unexpected throw lands as an internal-error response so malformed
    // tool logic doesn't silently hang the client.
    handleRequest(req)
      .then((resp) => {
        if (resp) send(resp);
      })
      .catch((err) => {
        send({
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: { code: -32603, message: `internal: ${(err as Error).message}` },
        });
      });
  });
  rl.on("close", () => process.exit(0));
}

main();

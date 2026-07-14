import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { reconnectMcpServer } from "../src/mcp/reconnect.js";
import type { McpClientHost } from "../src/mcp/registry.js";
import { StdioTransport } from "../src/mcp/stdio.js";

/** A throwaway client we can hand to the host without bothering to initialize — reconnect won't touch it on the parse-failure path. */
function dummyHost(): McpClientHost {
  const transport = new StdioTransport({ command: "true", args: [], shell: false });
  return { client: new McpClient({ transport, requestTimeoutMs: 1_000 }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconnectMcpServer — early-return paths", () => {
  it("returns spec_parse when the spec string is empty", async () => {
    const host = dummyHost();
    const r = await reconnectMcpServer({ host, spec: "", beforeTools: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("spec_parse");
    expect(r.message).toMatch(/empty MCP spec/);
    await host.client.close();
  });

  it("returns spec_parse when the spec has a name but no command", async () => {
    const host = dummyHost();
    const r = await reconnectMcpServer({ host, spec: "fs=", beforeTools: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("spec_parse");
    expect(r.message).toMatch(/has name but no command/);
    await host.client.close();
  });

  // Handshake-failure path is platform-sensitive (Windows shell:true doesn't
  // surface ENOENT synchronously). Exercised in mcp-integration.test.ts via
  // the live demo server instead.
});

describe("reconnectMcpServer — complete tool catalog", () => {
  const tools = [
    { name: "first", inputSchema: { type: "object" } },
    { name: "second", inputSchema: { type: "object" } },
  ];

  it("uses listAllTools as the drift catalog and swaps only after it succeeds", async () => {
    const host = dummyHost();
    const old = host.client;
    vi.spyOn(McpClient.prototype, "initialize").mockResolvedValue({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "fake", version: "1" },
      capabilities: { tools: {} },
    });
    const listAll = vi.spyOn(McpClient.prototype, "listAllTools").mockResolvedValue(tools);
    const listPage = vi
      .spyOn(McpClient.prototype, "listTools")
      .mockRejectedValue(new Error("single-page listing must not be used"));
    vi.spyOn(McpClient.prototype, "close").mockResolvedValue();

    const result = await reconnectMcpServer({ host, spec: "fs=cmd", beforeTools: tools });

    expect(result).toMatchObject({ ok: true, kind: "identity", afterTools: tools });
    expect(host.client).not.toBe(old);
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(listPage).not.toHaveBeenCalled();
    await host.client.close();
  });

  it("keeps the old host when a later catalog page fails", async () => {
    const host = dummyHost();
    const old = host.client;
    vi.spyOn(McpClient.prototype, "initialize").mockResolvedValue({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "fake", version: "1" },
      capabilities: { tools: {} },
    });
    vi.spyOn(McpClient.prototype, "listAllTools").mockRejectedValue(
      new Error("tools/list page 2 failed"),
    );
    vi.spyOn(McpClient.prototype, "close").mockResolvedValue();

    const result = await reconnectMcpServer({ host, spec: "fs=cmd", beforeTools: tools });

    expect(result).toMatchObject({
      ok: false,
      reason: "handshake",
      message: "tools/list page 2 failed",
    });
    expect(host.client).toBe(old);
    await host.client.close();
  });
});

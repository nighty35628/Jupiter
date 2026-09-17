import { afterEach, describe, expect, it, vi } from "vitest";

type EventSourceInstance = {
  url: string;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

async function loadWebBridge(hash = "#bootstrap=fragment-secret", rpcStatus = 202) {
  vi.resetModules();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { hash, pathname: "/", search: "", origin: "http://127.0.0.1:1420" },
    history: { replaceState },
    open: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: { dataset: {} },
    querySelector: (selector: string) => {
      if (selector === 'meta[name="jupiter-mode"]') return { getAttribute: () => "web" };
      if (selector === 'meta[name="jupiter-token"]') return { getAttribute: () => "" };
      return null;
    },
  });

  const eventSources: EventSourceInstance[] = [];
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      eventSources.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    close() {}
  }
  vi.stubGlobal("EventSource", FakeEventSource);

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const session = {
      workspaces: [{ id: "workspace-1", name: "workspace", root: "/workspace", writable: true }],
      capabilities: { mode: "local", writerLease: true },
    };
    if (url === "/api/bootstrap") {
      return jsonResponse({ ...session, csrfToken: "csrf-from-bootstrap" });
    }
    if (url === "/api/session") return jsonResponse({ ...session, csrfToken: "csrf-from-session" });
    if (url === "/api/lease/acquire" || url === "/api/lease/renew") {
      return jsonResponse({
        lease: { id: "lease-browser-123", fence: 7, expiresAt: Date.now() + 30_000 },
      });
    }
    if (url === "/api/rpc") {
      return rpcStatus === 202
        ? jsonResponse({ accepted: true }, 202)
        : jsonResponse({ error: "this page is not the active Web controller" }, rpcStatus);
    }
    if (url === "/api/host-invoke") {
      return jsonResponse({ result: { isRepo: true, branch: "main" } });
    }
    return jsonResponse({ error: `unexpected ${url} ${init?.method ?? "GET"}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  const bridge = await import("../dashboard/src/lib/tauri-bridge");
  return { bridge, eventSources, fetchMock, replaceState };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard Web Beta bridge", () => {
  it("keeps the Web host command surface explicit", async () => {
    const { WEB_HOST_COMMANDS } = await import("../dashboard/src/lib/host-services");
    expect(WEB_HOST_COMMANDS).toEqual([
      "git_info",
      "git_status",
      "git_diff",
      "git_checkout_branch",
      "git_commit_all",
      "git_push",
      "git_create_pull_request",
      "read_file_preview",
      "read_file_bytes",
      "desktop_diagnostic_event",
    ]);
  });

  it("exchanges the fragment token for a cookie session before opening the event stream", async () => {
    const { bridge, eventSources, fetchMock, replaceState } = await loadWebBridge();
    await bridge.invoke("rpc_spawn");

    const bootstrap = fetchMock.mock.calls[0];
    expect(bootstrap?.[0]).toBe("/api/bootstrap");
    expect(JSON.parse(String(bootstrap?.[1]?.body))).toEqual({ token: "fragment-secret" });
    expect(String(bootstrap?.[0])).not.toContain("fragment-secret");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(eventSources).toHaveLength(1);
    expect(eventSources[0]?.url).toMatch(/^\/api\/events\?connectionId=[a-zA-Z0-9_-]+$/);
  });

  it("forwards native sidecar packets without inventing a tab or turn", async () => {
    const { bridge, eventSources } = await loadWebBridge();
    const received: Record<string, any>[] = [];
    await bridge.listen<{ data: string }>("rpc:event", (event) => {
      received.push(JSON.parse(event.payload.data));
    });
    await bridge.invoke("rpc_spawn");

    const nativeEvent = {
      type: "model.final",
      tabId: "tab-native",
      turn: 47,
      content: "authoritative answer",
    };
    eventSources[0]?.onmessage?.({
      data: JSON.stringify({
        channel: "rpc:event",
        payload: { data: JSON.stringify(nativeEvent) },
      }),
    } as MessageEvent);

    expect(received).toEqual([nativeEvent]);
  });

  it("posts the original Desktop RPC payload with connection, CSRF and command identity", async () => {
    const { bridge, fetchMock } = await loadWebBridge();
    await bridge.invoke("rpc_spawn");
    await bridge.invoke("rpc_send", {
      line: JSON.stringify({ cmd: "tab_activate", tabId: "tab-native" }),
    });

    const rpcCall = fetchMock.mock.calls.find((call) => call[0] === "/api/rpc");
    expect(rpcCall).toBeTruthy();
    const init = rpcCall?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.commandId).toMatch(/^[a-zA-Z0-9_-]{8,128}$/);
    expect(body.payload).toEqual({ cmd: "tab_activate", tabId: "tab-native" });
    expect((init.headers as Record<string, string>)["x-jupiter-csrf"]).toBe("csrf-from-bootstrap");
    expect((init.headers as Record<string, string>)["x-jupiter-connection"]).toMatch(
      /^[a-zA-Z0-9_-]{8,128}$/,
    );
    expect((init.headers as Record<string, string>)["x-jupiter-lease"]).toBe("lease-browser-123");
    expect((init.headers as Record<string, string>)["x-jupiter-fence"]).toBe("7");
  });

  it("restores an existing cookie session on refresh when the fragment is gone", async () => {
    const { bridge, fetchMock } = await loadWebBridge("");
    await bridge.invoke("rpc_spawn");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/session");
  });

  it("does not start RPC or acquire control in an unpaired browser", async () => {
    const { bridge, fetchMock, eventSources } = await loadWebBridge("");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "missing session" }, 401));
    await expect(bridge.invoke("rpc_spawn")).rejects.toMatchObject({ code: "required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(eventSources).toHaveLength(0);
  });

  it("can reopen a consumed link when the browser already has a valid cookie", async () => {
    const { bridge, fetchMock, replaceState, eventSources } = await loadWebBridge();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "used link" }, 401));
    await bridge.invoke("rpc_spawn");
    expect(fetchMock.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
      "/api/bootstrap",
      "/api/session",
    ]);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(eventSources).toHaveLength(1);
  });

  it("distinguishes an expired link from a missing cookie without bypassing pairing", async () => {
    const { bridge, fetchMock, eventSources } = await loadWebBridge();
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    await expect(bridge.invoke("rpc_spawn")).rejects.toMatchObject({ code: "expired" });
    expect(eventSources).toHaveLength(0);
  });

  it("coalesces simultaneous authentication attempts and allows retry after failure", async () => {
    const { fetchMock } = await loadWebBridge("");
    const { authenticateWebSession } = await import("../dashboard/src/lib/runtime-transport");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const first = authenticateWebSession();
    const second = authenticateWebSession();
    expect(first).toBe(second);
    await expect(first).rejects.toMatchObject({ code: "required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(authenticateWebSession()).resolves.toBeUndefined();
  });

  it("pairs a pasted same-origin link without putting the token in a request URL", async () => {
    const { fetchMock } = await loadWebBridge("");
    const { authenticateWebSession } = await import("../dashboard/src/lib/runtime-transport");
    await authenticateWebSession("http://127.0.0.1:1420/#bootstrap=fresh-pairing-token");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/bootstrap");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      token: "fresh-pairing-token",
    });
  });

  it("rejects malformed and cross-origin pairing links before sending any request", async () => {
    const { fetchMock } = await loadWebBridge("");
    const { authenticateWebSession } = await import("../dashboard/src/lib/runtime-transport");
    await expect(authenticateWebSession("not a link")).rejects.toMatchObject({
      code: "invalidLink",
    });
    await expect(authenticateWebSession("http://127.0.0.1:1420/")).rejects.toMatchObject({
      code: "invalidLink",
    });
    await expect(
      authenticateWebSession("https://other.example/#bootstrap=fresh-pairing-token"),
    ).rejects.toMatchObject({ code: "wrongServer" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes Desktop host reads through the authenticated Web whitelist", async () => {
    const { bridge, fetchMock } = await loadWebBridge();
    await bridge.invoke("rpc_spawn");
    await expect(bridge.invoke("git_info", { root: "/workspace" })).resolves.toMatchObject({
      isRepo: true,
      branch: "main",
    });

    const call = fetchMock.mock.calls.find((entry) => entry[0] === "/api/host-invoke");
    expect(call).toBeTruthy();
    const init = call?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      operationId: expect.stringMatching(/^[a-zA-Z0-9_-]{8,128}$/),
      command: "git_info",
      args: { workspaceId: "workspace-1" },
    });
    expect((init.headers as Record<string, string>)["x-jupiter-csrf"]).toBe("csrf-from-bootstrap");

    const fileId = "12345678-1234-4123-8123-123456789abc";
    await bridge.invoke("read_file_bytes", {
      path: `jupiter-file:${fileId}`,
      workspaceDir: null,
    });
    const fileCall = fetchMock.mock.calls.filter((entry) => entry[0] === "/api/host-invoke").at(-1);
    expect(JSON.parse(String(fileCall?.[1]?.body))).toEqual({
      operationId: expect.stringMatching(/^[a-zA-Z0-9_-]{8,128}$/),
      command: "read_file_bytes",
      args: { fileId },
    });
  });

  it("continues to reject commands outside the Web Beta capability surface", async () => {
    const { bridge } = await loadWebBridge();
    await bridge.invoke("rpc_spawn");
    await expect(bridge.invoke("write_text_file", { path: "/tmp/nope" })).rejects.toThrow(
      "write_text_file is not available in Jupiter Web Beta",
    );
  });

  it("surfaces a visible error when another page owns Web control", async () => {
    const { bridge, eventSources } = await loadWebBridge("#bootstrap=fragment-secret", 409);
    const received: Record<string, any>[] = [];
    await bridge.listen<{ data: string }>("rpc:event", (event) => {
      received.push(JSON.parse(event.payload.data));
    });
    await bridge.invoke("rpc_spawn");
    eventSources[0]?.onmessage?.({
      data: JSON.stringify({
        channel: "rpc:event",
        payload: {
          data: JSON.stringify({ type: "$tab_opened", tabId: "tab-native", active: true }),
        },
      }),
    } as MessageEvent);

    await expect(
      bridge.invoke("rpc_send", {
        line: JSON.stringify({ cmd: "tab_activate", tabId: "tab-native" }),
      }),
    ).rejects.toThrow("not the active Web controller");
    expect(received).toContainEqual(
      expect.objectContaining({
        type: "$error",
        tabId: "tab-native",
        message: expect.stringContaining("read-only"),
      }),
    );
  });
});

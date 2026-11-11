import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FILE_ID = "12345678-1234-4123-8123-123456789abc";
let platform: string;
let host: EventTarget & { open: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn>;
let nativeRequests: { command: string; args: Record<string, unknown> }[];
let resolvedFile: unknown;
let resolveStatus: number;
let nativeResult: unknown;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  platform = "android";
  nativeRequests = [];
  resolvedFile = { id: FILE_ID, name: "registered-report.pdf" };
  resolveStatus = 200;
  nativeResult = { saved: true };
  const port: {
    postMessage(message: string): void;
    onmessage?: (event: MessageEvent<string>) => void;
  } = {
    postMessage(message) {
      const request = JSON.parse(message);
      nativeRequests.push(request);
      queueMicrotask(() =>
        port.onmessage?.({
          data: JSON.stringify({ ...request, ok: true, result: nativeResult }),
        } as MessageEvent<string>),
      );
    },
  };
  host = Object.assign(new EventTarget(), {
    open: vi.fn(),
    JupiterAndroid: port,
    location: { hash: "", pathname: "/", search: "", origin: "http://127.0.0.1:1420" },
    history: { replaceState: vi.fn() },
  });
  vi.stubGlobal("window", host);
  vi.stubGlobal("document", {
    documentElement: { dataset: {} },
    querySelector: (selector: string) => {
      const content =
        selector === 'meta[name="jupiter-platform"]'
          ? platform
          : selector === 'meta[name="jupiter-mode"]'
            ? "web"
            : selector === 'meta[name="jupiter-run"]'
              ? "file-export-run"
              : "";
      return { getAttribute: () => content };
    },
  });
  class FakeEventSource {
    onopen?: () => void;
    close() {}
    constructor(_url: string) {
      queueMicrotask(() => this.onopen?.());
    }
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/session")
      return Response.json({
        csrfToken: "file-export-csrf",
        workspaces: [
          { id: "outer", name: "workspace", root: "/workspace", writable: true },
          { id: "nested", name: "nested", root: "/workspace/nested", writable: true },
        ],
      });
    if (url === "/api/lease/acquire")
      return Response.json({
        lease: { id: "file-export-lease", fence: 3, expiresAt: Date.now() + 30_000 },
      });
    if (url === "/api/files/resolve")
      return Response.json(
        resolveStatus === 200 ? { file: resolvedFile } : { error: "outside authorized workspace" },
        { status: resolveStatus },
      );
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  host.dispatchEvent(new Event("pagehide"));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Android project file export", { retry: 0 }, () => {
  it("resolves an absolute project file through the authenticated backend before invoking Native", async () => {
    const { openPath } = await import("../dashboard/src/lib/shell-services");
    await openPath("/workspace/docs/report.pdf");
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/files/resolve");
    expect(call).toBeTruthy();
    const init = call![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: "outer",
      path: "docs/report.pdf",
    });
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-jupiter-csrf": "file-export-csrf",
      "x-jupiter-lease": "file-export-lease",
      "x-jupiter-fence": "3",
      "x-jupiter-connection": expect.any(String),
    });
    expect(nativeRequests).toMatchObject([
      { command: "downloadFile", args: { fileId: FILE_ID, name: "registered-report.pdf" } },
    ]);
    expect(JSON.stringify(nativeRequests)).not.toContain("/workspace");
  });

  it("matches the longest authorized workspace root", async () => {
    const { openPath } = await import("../dashboard/src/lib/shell-services");
    await openPath("/workspace/nested/report.html");
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/files/resolve");
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1].body))).toEqual({
      workspaceId: "nested",
      path: "report.html",
    });
    expect(nativeRequests[0]!.command).toBe("downloadFile");
  });

  it.each(["/outside/report.pdf", "/workspace-other/report.pdf", "relative/report.pdf"])(
    "rejects paths outside the authorized roots (%s)",
    async (path) => {
      const { openPath } = await import("../dashboard/src/lib/shell-services");
      await expect(openPath(path)).rejects.toThrow();
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/files/resolve")).toHaveLength(0);
      expect(nativeRequests).toEqual([]);
    },
  );

  it.each([400, 403, 409])(
    "propagates backend refusal (%s) without calling Native or retrying",
    async (status) => {
      resolveStatus = status;
      const { openPath } = await import("../dashboard/src/lib/shell-services");
      await expect(openPath("/workspace/../private/report.pdf")).rejects.toThrow(
        "outside authorized workspace",
      );
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/files/resolve")).toHaveLength(1);
      expect(nativeRequests).toEqual([]);
    },
  );

  it.each([{ id: "/private/report.pdf", name: "report" }, { id: FILE_ID }, null])(
    "rejects invalid registered file metadata (%j)",
    async (file) => {
      resolvedFile = file;
      const { openPath } = await import("../dashboard/src/lib/shell-services");
      await expect(openPath("/workspace/report.pdf")).rejects.toThrow();
      expect(nativeRequests).toEqual([]);
    },
  );

  it("keeps existing file-token exports on the ID-only Native path", async () => {
    const { openPath } = await import("../dashboard/src/lib/shell-services");
    await openPath(`jupiter-file:${FILE_ID}`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nativeRequests[0]).toMatchObject({ command: "downloadFile", args: { fileId: FILE_ID } });
  });

  it("propagates Native cancellation after resolving a project path", async () => {
    nativeResult = { cancelled: true };
    const { openPath } = await import("../dashboard/src/lib/shell-services");
    await expect(openPath("/workspace/report.pdf")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not change ordinary Web openPath behavior", async () => {
    platform = "browser";
    const { openPath } = await import("../dashboard/src/lib/shell-services");
    await openPath("/workspace/report.pdf");
    expect(host.open).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await openPath(`jupiter-file:${FILE_ID}`);
    expect(host.open).toHaveBeenCalledWith(
      `/api/files/${FILE_ID}`,
      "_blank",
      "noopener,noreferrer",
    );
    expect(nativeRequests).toEqual([]);
  });
});

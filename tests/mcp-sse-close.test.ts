import { afterEach, describe, expect, it, vi } from "vitest";
import { SseTransport } from "../src/mcp/sse.js";

describe("SseTransport shutdown", () => {
  let transport: SseTransport | undefined;

  afterEach(async () => {
    await transport?.close();
    vi.unstubAllGlobals();
  });

  function openStream() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    transport = new SseTransport({ url: "http://localhost/sse" });
    return { controller, cancel, fetchMock, transport };
  }

  it.each(["EOF", "stream error"])(
    "rejects pending sends when %s arrives before the endpoint",
    async (ending) => {
      const { controller, transport, fetchMock } = openStream();
      const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
      const assertion = expect(pending).rejects.toThrow(/closed before endpoint/);
      if (ending === "EOF") controller.close();
      else controller.error(new Error("connection reset"));
      await assertion;
      await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow(
        /closed/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts the stream when the endpoint announcement is invalid", async () => {
    const { controller, transport, fetchMock, cancel } = openStream();
    const assertion = expect(
      transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ).rejects.toThrow(/bad URL/);
    controller.enqueue(
      new TextEncoder().encode(
        'event: endpoint\ndata: http://[invalid\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
      ),
    );
    await assertion;
    await transport.close();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    const messages = transport.messages();
    expect((await messages.next()).value).toMatchObject({ error: { code: -32000 } });
    await expect(messages.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("aborts an in-flight POST when the SSE stream ends", async () => {
    const { controller, transport, fetchMock } = openStream();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    const assertion = expect(
      transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ).rejects.toThrow(/abort/i);
    controller.enqueue(new TextEncoder().encode("event: endpoint\ndata: /messages\n\n"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.close();
    await assertion;
    expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    await expect(transport.messages().next()).resolves.toEqual({ done: true, value: undefined });
  });
});

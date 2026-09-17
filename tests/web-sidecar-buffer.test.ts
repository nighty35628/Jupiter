import { describe, expect, it, vi } from "vitest";
import {
  SequencedPacketBuffer,
  SupervisedSidecar,
  type WebDownlinkPacket,
  type WebSidecar,
  cliEntryForModulePath,
  currentCliEntry,
} from "../src/web/sidecar.js";

class FakeSidecar implements WebSidecar {
  readonly buffer = new SequencedPacketBuffer();
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  constructor(readonly runtimeEpoch: string) {}

  get latestSequence(): number {
    return this.buffer.latestSequence;
  }

  emit(packet: WebDownlinkPacket): void {
    this.buffer.append(packet);
  }

  send(command: Record<string, unknown>): Promise<void> {
    this.sent.push(command);
    return Promise.resolve();
  }

  subscribe(listener: Parameters<WebSidecar["subscribe"]>[0]): () => void {
    return this.buffer.subscribe(listener);
  }

  replayAfter(sequence: number, through?: number) {
    return this.buffer.replayAfter(sequence, through);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe("SequencedPacketBuffer", () => {
  it("resolves the source CLI entry used by the development sidecar", () => {
    expect(currentCliEntry()).toMatch(/[/\\]src[/\\]cli[/\\]index\.ts$/);
  });

  it("resolves the packaged CLI entry from a split Web chunk", () => {
    expect(cliEntryForModulePath("/opt/jupiter/dist/cli/web-ABC123.js")).toBe(
      "/opt/jupiter/dist/cli/index.js",
    );
    expect(cliEntryForModulePath("/opt/jupiter/dist/web/sidecar.js")).toBe(
      "/opt/jupiter/dist/cli/index.js",
    );
  });

  it("assigns a strict sequence and replays only unseen packets", () => {
    const buffer = new SequencedPacketBuffer();
    const seen: number[] = [];
    const unsubscribe = buffer.subscribe((item) => seen.push(item.sequence));

    buffer.append({ channel: "rpc:stderr", payload: { data: "one" } });
    buffer.append({ channel: "rpc:stderr", payload: { data: "two" } });
    unsubscribe();

    expect(seen).toEqual([1, 2]);
    expect(buffer.replayAfter(1)).toEqual({
      status: "ok",
      packets: [
        {
          sequence: 2,
          packet: { channel: "rpc:stderr", payload: { data: "two" } },
        },
      ],
    });
  });

  it("reports a gap once the requested cursor has fallen out of the bounded log", () => {
    const buffer = new SequencedPacketBuffer({ maxPackets: 2, maxBytes: 1024 });
    buffer.append({ channel: "rpc:stderr", payload: { data: "one" } });
    buffer.append({ channel: "rpc:stderr", payload: { data: "two" } });
    buffer.append({ channel: "rpc:stderr", payload: { data: "three" } });

    expect(buffer.replayAfter(0).status).toBe("gap");
    expect(buffer.replayAfter(1).status).toBe("ok");
  });

  it("adds the server watermark to a resync completion marker", () => {
    const buffer = new SequencedPacketBuffer();
    const item = buffer.append({
      channel: "rpc:event",
      payload: { data: JSON.stringify({ type: "$resync_complete", requestId: "sync-1" }) },
    });

    expect(
      JSON.parse(item.packet.channel === "rpc:event" ? item.packet.payload.data : "{}"),
    ).toEqual({
      type: "$resync_complete",
      requestId: "sync-1",
      watermark: 1,
    });
  });

  it("notifies subscribers synchronously in append order", () => {
    const buffer = new SequencedPacketBuffer();
    const listener = vi.fn();
    buffer.subscribe(listener);
    buffer.append({ channel: "rpc:exit", payload: { code: 0 } });
    expect(listener).toHaveBeenCalledWith({
      sequence: 1,
      packet: { channel: "rpc:exit", payload: { code: 0 } },
    });
  });

  it("restarts a failed runtime without forwarding a terminal exit", async () => {
    vi.useFakeTimers();
    try {
      const children = [new FakeSidecar("epoch-1"), new FakeSidecar("epoch-2")];
      const supervisor = new SupervisedSidecar({
        create: () => children.shift()!,
        restartBaseDelayMs: 10,
      });
      const packets: WebDownlinkPacket[] = [];
      supervisor.subscribe((item) => packets.push(item.packet));

      (supervisor as unknown as { child: FakeSidecar }).child.emit({
        channel: "rpc:exit",
        payload: { code: 1 },
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(supervisor.runtimeEpoch).toBe("epoch-2");
      expect(packets.some((packet) => packet.channel === "rpc:exit")).toBe(false);
      expect(
        packets.some(
          (packet) =>
            packet.channel === "rpc:event" &&
            JSON.parse(packet.payload.data).type === "$runtime_restarted",
        ),
      ).toBe(true);
      expect(
        (supervisor as unknown as { child: FakeSidecar }).child.sent.some(
          (command) => command.cmd === "desktop_resync",
        ),
      ).toBe(true);
      await supervisor.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

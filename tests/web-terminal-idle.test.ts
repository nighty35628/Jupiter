import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebTerminalManager } from "../src/web/terminal.js";

const pty = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => pty);

afterEach(() => vi.clearAllMocks());

function fixture(resolveWorkspace = async () => "/work") {
  const manager = new WebTerminalManager();
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  });
  const exits: Array<() => void> = [];
  pty.spawn.mockImplementation(() => ({
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: (callback: (value: { exitCode: number }) => void) =>
      exits.push(() => callback({ exitCode: 0 })),
  }));
  (manager as any).bind(socket, {
    deviceId: "device",
    validateLease: () => true,
    resolveWorkspace,
  });
  const send = (type: string) =>
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type, id: "one", workspaceId: "workspace", leaseId: "lease", fence: 1 }),
      ),
      false,
    );
  return { manager, socket, exits, send };
}

describe("PTY idle ownership", { retry: 0 }, () => {
  it("protects queued spawn and a silent PTY until its actual exit, including kill/replacement", async () => {
    const f = fixture();
    f.send("spawn");
    expect(f.manager.activityCount).toBe(1);
    await vi.waitFor(() => expect(f.exits).toHaveLength(1));
    expect(f.manager.activityCount).toBe(1);
    f.send("spawn");
    await vi.waitFor(() => expect(f.exits).toHaveLength(2));
    expect(f.manager.activityCount).toBe(2);
    f.exits[0]();
    expect(f.manager.activityCount).toBe(1);
    f.send("kill");
    await vi.waitFor(() => expect(f.manager.activityCount).toBe(1));
    f.exits[1]();
    expect(f.manager.activityCount).toBe(0);
    f.exits[1]();
    expect(f.manager.activityCount).toBe(0);
    f.manager.close();
  });

  it("does not spawn an orphan when the socket closes during workspace resolution", async () => {
    let resolve!: (root: string) => void;
    const f = fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.send("spawn");
    await vi.waitFor(() => expect(resolve).toBeDefined());
    f.socket.readyState = 3;
    f.socket.emit("close");
    resolve("/work");
    await vi.waitFor(() => expect(f.manager.activityCount).toBe(0));
    expect(pty.spawn).not.toHaveBeenCalled();
    f.manager.close();
  });

  it("fences messages on already connected sockets without treating an empty connection as work", async () => {
    const f = fixture();
    expect(f.manager.activityCount).toBe(0);
    f.manager.setAccepting(false);
    f.send("spawn");
    expect(f.manager.activityCount).toBe(0);
    expect(pty.spawn).not.toHaveBeenCalled();
    expect(f.socket.send).toHaveBeenCalledWith(expect.stringContaining("checking idle shutdown"));
    f.manager.setAccepting(true);
    f.send("spawn");
    await vi.waitFor(() => expect(f.exits).toHaveLength(1));
    f.socket.emit("close");
    expect(f.manager.activityCount).toBe(1);
    f.exits[0]();
    expect(f.manager.activityCount).toBe(0);
    f.manager.close();
  });
});

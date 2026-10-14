import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputerUseController,
  ComputerUseLease,
  ComputerUseLeaseBusyError,
  ComputerUseStaleActionError,
} from "../src/computer-use/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function leasePair() {
  const root = await mkdtemp(join(tmpdir(), "jupiter-computer-use-"));
  roots.push(root);
  return join(root, "desktop.lock");
}

describe("Computer Use lease", () => {
  it("serializes ownership across independent lease instances", async () => {
    const path = await leasePair();
    const first = new ComputerUseLease({ path });
    const second = new ComputerUseLease({ path });
    const handle = await first.acquire("session-a");
    await expect(second.acquire("session-b")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    await handle.release();
    const next = await second.acquire("session-b");
    await next.release();
  });

  it("refuses even a stale lease until its owner releases it", async () => {
    const path = await leasePair();
    let now = 1_000;
    const first = new ComputerUseLease({ path, staleAfterMs: 100, now: () => now });
    const second = new ComputerUseLease({ path, staleAfterMs: 100, now: () => now });
    const handle = await first.acquire("dead-session");
    await expect(second.acquire("live-session")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    now += 101;
    await expect(second.acquire("live-session")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    await handle.renew();
    await handle.release();
    const next = await second.acquire("live-session");
    await next.release();
  });
});

describe("Computer Use controller", () => {
  it("rejects expired observations and coordinates on the excluded image edge", async () => {
    const path = await leasePair();
    const controller = new ComputerUseController(new ComputerUseLease({ path }));
    await controller.start("test");
    try {
      const base = {
        imageWidth: 100,
        imageHeight: 100,
        screen: { left: 0, top: 0, width: 200, height: 200 },
      };
      const expired = controller.recordObservation({ ...base, capturedAt: Date.now() - 61_000 });
      expect(() =>
        controller.prepareAction(
          { type: "type", observationId: expired.id, text: "test" },
          controller.fence(),
        ),
      ).toThrow("expired");
      const fresh = controller.recordObservation({ ...base, capturedAt: Date.now() });
      expect(() =>
        controller.prepareAction(
          { type: "click", observationId: fresh.id, x: 100, y: 10 },
          controller.fence(),
        ),
      ).toThrow("outside");
    } finally {
      await controller.stop();
    }
  });
  it("maps image coordinates to screen coordinates", async () => {
    const path = await leasePair();
    const controller = new ComputerUseController(new ComputerUseLease({ path }));
    await controller.start("session-a");
    const observation = controller.recordObservation({
      capturedAt: Date.now(),
      imageWidth: 1000,
      imageHeight: 500,
      screen: { left: 100, top: 50, width: 2000, height: 1000, scaleFactor: 2 },
      windowId: "window-a",
    });
    const action = controller.prepareAction(
      { type: "click", observationId: observation.id, x: 250, y: 125 },
      controller.fence(),
    );
    expect(action).toMatchObject({ type: "click", x: 600, y: 300 });
    await controller.stop();
  });

  it("rejects old observations and invalidates in-flight fences on stop", async () => {
    const path = await leasePair();
    const controller = new ComputerUseController(new ComputerUseLease({ path }));
    await controller.start("session-a");
    const first = controller.recordObservation({
      capturedAt: 1,
      imageWidth: 100,
      imageHeight: 100,
      screen: { left: 0, top: 0, width: 100, height: 100 },
    });
    const fence = controller.fence();
    controller.recordObservation({
      capturedAt: 2,
      imageWidth: 100,
      imageHeight: 100,
      screen: { left: 0, top: 0, width: 100, height: 100 },
    });
    expect(() =>
      controller.prepareAction({ type: "click", observationId: first.id, x: 10, y: 10 }, fence),
    ).toThrow(ComputerUseStaleActionError);
    await controller.stop();
    expect(() => controller.assertFence(fence)).toThrow(ComputerUseStaleActionError);
  });
});

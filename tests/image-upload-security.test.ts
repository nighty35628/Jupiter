import { afterEach, describe, expect, it } from "vitest";
import { authorizeDesktopCommand } from "../src/web/policy.js";
import { UploadStore } from "../src/web/uploads.js";
import { WorkspaceRegistry } from "../src/web/workspaces.js";

const stores: UploadStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("image upload admission", () => {
  it("reserves quota before reading concurrent uploads and releases failed reservations", async () => {
    const registry = await WorkspaceRegistry.create([process.cwd()]);
    const store = await UploadStore.create(registry, { maxFileBytes: 10, maxTotalBytes: 10 });
    stores.push(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow() {
      await gate;
      yield Buffer.alloc(8);
    }
    const first = store.receive("a.png", "image/png", slow(), 8);
    await expect(store.receive("b.png", "image/png", slow(), 8)).rejects.toThrow(/quota/);
    release();
    const completed = await first;
    await store.remove(completed.file.id);
    async function* broken() {
      yield Buffer.alloc(4);
      throw new Error("disconnected");
    }
    await expect(store.receive("bad.png", "image/png", broken(), 8)).rejects.toThrow(
      /disconnected/,
    );
    async function* good() {
      yield Buffer.alloc(8);
    }
    expect((await store.receive("ok.png", "image/png", good(), 8)).file.size).toBe(8);
  });
  it("allows durable image tokens but not raw host paths in public mode", async () => {
    const workspaces = await WorkspaceRegistry.create([process.cwd()]);
    const options = { mode: "public" as const, workspaces };
    const token = `jupiter-image:${"a".repeat(64)}`;
    expect(
      (
        await authorizeDesktopCommand(
          { cmd: "attachment_import", path: token, requestId: "safe" },
          options,
        )
      ).command.path,
    ).toBe(token);
    await expect(
      authorizeDesktopCommand(
        { cmd: "attachment_import", path: "/etc/passwd", requestId: "bad" },
        options,
      ),
    ).rejects.toThrow();
    await expect(
      authorizeDesktopCommand(
        { cmd: "user_input", text: "", imagePaths: ["https://private-host/image.png"] },
        options,
      ),
    ).rejects.toThrow(/durable/);
    await expect(
      authorizeDesktopCommand(
        { cmd: "attachment_draft_refs", owner: "../../oops", revision: 1, ids: [] },
        options,
      ),
    ).rejects.toThrow();
  });
});

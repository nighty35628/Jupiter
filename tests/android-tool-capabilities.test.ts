import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodeToolset } from "../src/code/setup.js";

const android = vi.hoisted(() => ({ role: undefined as string | undefined }));
vi.mock("../src/mobile/runtime-context.js", async (original) => ({
  ...(await original<typeof import("../src/mobile/runtime-context.js")>()),
  getAndroidRuntimeContext: () => (android.role ? { role: android.role } : undefined),
}));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jupiter-android-tools-"));
  await writeFile(join(root, "config.json"), JSON.stringify({ editMode: "normal" }));
});
afterEach(async () => {
  android.role = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("Android tool capabilities", { retry: 0 }, () => {
  it.each(["interactive", "scheduled", "host"])(
    "does not advertise the unavailable guest OS browser launcher to %s",
    async (role) => {
      android.role = role;
      const toolset = await buildCodeToolset({
        rootDir: root,
        configPath: join(root, "config.json"),
      });
      try {
        expect(toolset.tools.has("open_url")).toBe(false);
        expect(toolset.tools.has("run_command")).toBe(true);
        expect(toolset.tools.has("read_file")).toBe(true);
        expect(toolset.tools.has("web_fetch")).toBe(true);
      } finally {
        await toolset.jobs.shutdown();
      }
    },
  );

  it("preserves the existing desktop/CLI launcher and ignores untrusted environment flags", async () => {
    vi.stubEnv("JUPITER_RUNTIME_SURFACE", "android");
    vi.stubEnv("JUPITER_ANDROID", "1");
    const toolset = await buildCodeToolset({
      rootDir: root,
      configPath: join(root, "config.json"),
    });
    try {
      expect(toolset.tools.has("open_url")).toBe(true);
    } finally {
      await toolset.jobs.shutdown();
    }
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeWebHost } from "../src/web/host.js";
import { WorkspaceRegistry } from "../src/web/workspaces.js";

describe("Web host command whitelist", () => {
  let workspace = "";
  let registry: WorkspaceRegistry;
  let workspaceId = "";

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "jupiter-web-host-"));
    execFileSync("git", ["init"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "jupiter@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Jupiter Test"], { cwd: workspace });
    writeFileSync(join(workspace, "note.txt"), "first\n", "utf8");
    execFileSync("git", ["add", "note.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "Initial"], { cwd: workspace });
    registry = await WorkspaceRegistry.create([workspace]);
    workspaceId = registry.list()[0]!.id;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns native-compatible Git information and changes", async () => {
    writeFileSync(join(workspace, "note.txt"), "first\nsecond\n", "utf8");
    const context = { workspaces: registry };
    const info = (await invokeWebHost("git_info", { workspaceId }, context)) as {
      isRepo: boolean;
      branches: string[];
    };
    const status = (await invokeWebHost("git_status", { workspaceId }, context)) as Array<{
      path: string;
      kind: string;
    }>;
    const diff = (await invokeWebHost("git_diff", { workspaceId }, context)) as string;

    expect(info.isRepo).toBe(true);
    expect(info.branches.length).toBeGreaterThan(0);
    expect(status).toContainEqual({ path: "note.txt", kind: "modified" });
    expect(diff).toContain("+second");
  });

  it("previews files only inside the active workspace", async () => {
    const preview = (await invokeWebHost(
      "read_file_preview",
      {
        path: "note.txt",
        workspaceId,
      },
      { workspaces: registry },
    )) as { absPath: string; kind: string; text: string; name: string };
    expect(preview).toMatchObject({ kind: "text", text: "first\n", name: "note.txt" });
    expect(preview.absPath).toMatch(/^jupiter-file:[0-9a-f-]{36}$/i);
    const fileId = preview.absPath.slice("jupiter-file:".length);
    await expect(
      invokeWebHost("read_file_bytes", { fileId }, { workspaces: registry }),
    ).resolves.toEqual(Array.from(Buffer.from("first\n")));

    await expect(
      invokeWebHost(
        "read_file_preview",
        {
          path: "../outside.txt",
          workspaceId,
        },
        { workspaces: registry },
      ),
    ).rejects.toThrow();

    await expect(
      invokeWebHost("git_info", { root: workspace }, { workspaces: registry }),
    ).rejects.toThrow("workspaceId");
  });

  it("rejects commands outside the explicit browser host whitelist", async () => {
    await expect(invokeWebHost("terminal_spawn", {}, { workspaces: registry })).rejects.toThrow(
      "not available in Jupiter Web Beta",
    );
  });
});

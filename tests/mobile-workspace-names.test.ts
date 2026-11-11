import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAndroidWorkspaceName } from "../src/mobile/host.js";
import { WorkspaceRegistry } from "../src/web/workspaces.js";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const source = ts.createSourceFile(
  "host.ts",
  readFileSync("src/mobile/host.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let registerSource = "";
let directorySource = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "register")
    registerSource = node.initializer!.getText(source);
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "DIRECTORY")
    directorySource = node.initializer!.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);

describe("Android private project display metadata", { retry: 0 }, () => {
  let root: string;
  let names: string;
  let metadata: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jupiter-project-names-"));
    names = join(root, ".names");
    metadata = join(names, `${ID}.txt`);
    await mkdir(names);
    await mkdir(join(root, ID));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function register(registry: WorkspaceRegistry, readName = readAndroidWorkspaceName) {
    expect(registerSource).not.toBe("");
    const code = ts.transpileModule(`return ${registerSource};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const bindings = {
      workspacesRoot: root,
      registry,
      lstat,
      realpath,
      relative,
      join,
      DIRECTORY: /^(?:default|[0-9a-f-]{36})$/,
      readAndroidWorkspaceName: readName,
    };
    return new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as (
      directory: string,
      name?: string,
    ) => Promise<{ name: string }>;
  }

  it("restores a persisted ZIP display name into a fresh existing registry", async () => {
    const first = new WorkspaceRegistry();
    const readName = vi.fn(readAndroidWorkspaceName);
    expect((await register(first, readName)(ID, "Synthetic imported project")).name).toBe(
      "Synthetic imported project",
    );
    expect(readName).not.toHaveBeenCalled();
    await writeFile(metadata, "Synthetic imported project");
    const restarted = new WorkspaceRegistry();
    expect((await register(restarted)(ID)).name).toBe("Synthetic imported project");
    expect(restarted.list()).toHaveLength(1);
    expect(readFileSync(metadata, "utf8")).toBe("Synthetic imported project");
  });

  it("keeps explicit names authoritative and missing metadata nonfatal", async () => {
    await writeFile(metadata, "Stored name");
    expect((await register(new WorkspaceRegistry())(ID, "Explicit name")).name).toBe(
      "Explicit name",
    );
    await rm(metadata);
    expect((await register(new WorkspaceRegistry())(ID)).name).toBe(ID);
    expect(await readAndroidWorkspaceName(root, "default")).toBeUndefined();
    expect(await readAndroidWorkspaceName(root, "../outside")).toBeUndefined();
  });

  it("excludes .names using the existing private-directory allowlist", () => {
    const allowed = new Function(`return ${directorySource};`)() as RegExp;
    expect(allowed.test(".names")).toBe(false);
    expect(allowed.test(ID)).toBe(true);
    expect(allowed.test("default")).toBe(true);
  });

  it("enforces a byte limit and strict UTF-8 without truncating oversized metadata", async () => {
    const boundary = "\u00e9".repeat(200);
    expect(Buffer.byteLength(boundary)).toBe(400);
    await writeFile(metadata, boundary);
    expect(await readAndroidWorkspaceName(root, ID)).toBe(boundary);
    await writeFile(metadata, `${boundary}x`);
    expect(await readAndroidWorkspaceName(root, ID)).toBeUndefined();
    await writeFile(metadata, Buffer.from([0xc3, 0x28]));
    expect(await readAndroidWorkspaceName(root, ID)).toBeUndefined();
    await writeFile(metadata, "bad\u0000name");
    expect(await readAndroidWorkspaceName(root, ID)).toBeUndefined();
    await writeFile(metadata, "   ");
    expect(await readAndroidWorkspaceName(root, ID)).toBeUndefined();
  });

  it("rejects symlink metadata, symlink parent directories, and nonregular files", async () => {
    const target = join(root, "outside.txt");
    await writeFile(target, "Not a project label");
    await symlink(target, metadata);
    expect(await readAndroidWorkspaceName(root, ID)).toBeUndefined();
    await rm(metadata);
    await mkdir(metadata);
    expect(await readAndroidWorkspaceName(root, ID)).toBeUndefined();
    await rm(names, { recursive: true });
    const other = join(root, "other");
    await mkdir(other);
    await writeFile(join(other, `${ID}.txt`), "Not a project label");
    await symlink(other, names);
    expect(await readAndroidWorkspaceName(root, ID)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "does not block opening a FIFO metadata entry",
    async () => {
      execFileSync("mkfifo", [metadata]);
      expect(await readAndroidWorkspaceName(root, ID)).toBeUndefined();
    },
  );
});

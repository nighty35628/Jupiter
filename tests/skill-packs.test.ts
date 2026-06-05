import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSlash } from "../src/cli/ui/slash/dispatch.js";
import {
  checkSkillPackUpdates,
  installSkillPackUpdates,
  managedSkillPackManifestPath,
  skillPackSkillRootsFromPackDirs,
} from "../src/skill-packs.js";
import { SkillStore } from "../src/skills.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function makeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = routes[url];
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

function writePackSkill(packDir: string, name: string, body = "body"): string {
  const dir = join(packDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\ndescription: ${name} skill\n---\n${body}\n`, "utf8");
  return path;
}

describe("built-in skill packs", () => {
  let home: string;
  let projectRoot: string;
  let packRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-skill-pack-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "jupiter-skill-pack-project-"));
    packRoot = mkdtempSync(join(tmpdir(), "jupiter-skill-pack-root-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(packRoot, { recursive: true, force: true });
  });

  it("loads skills from built-in pack skill roots as builtin scope", () => {
    writePackSkill(packRoot, "documents", "Create and verify DOCX files.");

    const store = new SkillStore({
      homeDir: home,
      projectRoot,
      builtinSkillPackRoots: [join(packRoot, "skills")],
    });

    const documents = store.read("documents");
    expect(documents?.scope).toBe("builtin");
    expect(documents?.path).toBe(join(packRoot, "skills", "documents", "SKILL.md"));
    expect(documents?.body).toContain("DOCX");
  });

  it("lets user-authored skills override built-in pack skills", () => {
    writePackSkill(packRoot, "documents", "bundled body");
    const globalSkill = join(home, ".jupiter", "skills", "documents");
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(
      join(globalSkill, "SKILL.md"),
      "---\ndescription: custom documents\n---\ncustom body\n",
      "utf8",
    );

    const store = new SkillStore({
      homeDir: home,
      projectRoot,
      builtinSkillPackRoots: [join(packRoot, "skills")],
    });

    const documents = store.read("documents");
    expect(documents?.scope).toBe("global");
    expect(documents?.body).toBe("custom body");
  });

  it("prefers the newest local pack version between managed and bundled roots", () => {
    const managed = join(home, ".jupiter", "skill-packs", "managed");
    const bundled = join(packRoot, "bundled");
    const managedPack = join(managed, "documents");
    const bundledPack = join(bundled, "documents");
    writePackSkill(managedPack, "documents", "old managed");
    writePackSkill(bundledPack, "documents", "new bundled");
    writeFileSync(
      join(managedPack, "pack.json"),
      JSON.stringify({ schema: 1, id: "documents", version: "1.0.0" }),
      "utf8",
    );
    writeFileSync(
      join(bundledPack, "pack.json"),
      JSON.stringify({ schema: 1, id: "documents", version: "2.0.0" }),
      "utf8",
    );

    expect(skillPackSkillRootsFromPackDirs(managed, bundled)).toEqual([
      join(bundledPack, "skills"),
    ]);
  });
});

describe("skill pack update channel", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-skill-update-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("checks manifest updates and installs a verified JSON bundle into managed skill packs", async () => {
    const bundle = {
      schema: 1,
      id: "documents",
      version: "1.1.0",
      files: [
        {
          path: "skills/documents/SKILL.md",
          content: "---\ndescription: Documents\n---\nCreate DOCX files.\n",
        },
      ],
    };
    const bundleText = JSON.stringify(bundle);
    const registryUrl = "https://updates.jupiter.test/skill-packs.json";
    const bundleUrl = "https://updates.jupiter.test/documents.bundle.json";
    const fetchImpl = makeFetch({
      [registryUrl]: {
        schema: 1,
        packs: [{ id: "documents", version: "1.1.0", url: bundleUrl, sha256: sha256(bundleText) }],
      },
      [bundleUrl]: bundle,
    });

    const status = await checkSkillPackUpdates({
      homeDir: home,
      registryUrl,
      fetchImpl,
      bundledPacks: [{ id: "documents", version: "1.0.0" }],
    });
    expect(status.ok).toBe(true);
    expect(status.packs).toEqual([
      expect.objectContaining({ id: "documents", currentVersion: "1.0.0", latestVersion: "1.1.0" }),
    ]);

    const installed = await installSkillPackUpdates({
      homeDir: home,
      registryUrl,
      fetchImpl,
      bundledPacks: [{ id: "documents", version: "1.0.0" }],
    });
    expect(installed.ok).toBe(true);
    expect(installed.installed).toEqual([{ id: "documents", version: "1.1.0" }]);

    const skillPath = join(
      home,
      ".jupiter",
      "skill-packs",
      "managed",
      "documents",
      "skills",
      "documents",
      "SKILL.md",
    );
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("Create DOCX files.");
    expect(existsSync(managedSkillPackManifestPath(home))).toBe(true);
  });

  it("rejects bundle files that escape the managed pack directory", async () => {
    const bundle = {
      schema: 1,
      id: "bad",
      version: "1.0.0",
      files: [{ path: "../bad.md", content: "nope" }],
    };
    const registryUrl = "https://updates.jupiter.test/skill-packs.json";
    const bundleUrl = "https://updates.jupiter.test/bad.bundle.json";
    const fetchImpl = makeFetch({
      [registryUrl]: {
        schema: 1,
        packs: [
          { id: "bad", version: "1.0.0", url: bundleUrl, sha256: sha256(JSON.stringify(bundle)) },
        ],
      },
      [bundleUrl]: bundle,
    });

    const installed = await installSkillPackUpdates({
      homeDir: home,
      registryUrl,
      fetchImpl,
      bundledPacks: [],
    });

    expect(installed.ok).toBe(false);
    expect(installed.error).toMatch(/unsafe/i);
    expect(existsSync(join(home, ".jupiter", "skill-packs", "managed", "bad.md"))).toBe(false);
  });

  it("installs only the requested pack id from the update channel", async () => {
    const registryUrl = "https://updates.jupiter.test/skill-packs.json";
    const docsUrl = "https://updates.jupiter.test/documents.bundle.json";
    const browserUrl = "https://updates.jupiter.test/browser.bundle.json";
    const fetchImpl = makeFetch({
      [registryUrl]: {
        schema: 1,
        packs: [
          { id: "documents", version: "1.0.0", url: docsUrl },
          { id: "browser", version: "1.0.0", url: browserUrl },
        ],
      },
      [docsUrl]: {
        schema: 1,
        id: "documents",
        version: "1.0.0",
        files: [
          {
            path: "skills/documents/SKILL.md",
            content: "---\ndescription: Documents\n---\nDocs body\n",
          },
        ],
      },
      [browserUrl]: {
        schema: 1,
        id: "browser",
        version: "1.0.0",
        files: [
          {
            path: "skills/browser/SKILL.md",
            content: "---\ndescription: Browser\n---\nBrowser body\n",
          },
        ],
      },
    });

    const installed = await installSkillPackUpdates({
      homeDir: home,
      registryUrl,
      fetchImpl,
      bundledPacks: [],
      packIds: ["browser"],
    });

    expect(installed.ok).toBe(true);
    expect(installed.installed).toEqual([{ id: "browser", version: "1.0.0" }]);
    expect(
      existsSync(join(home, ".jupiter", "skill-packs", "managed", "browser", "skills", "browser")),
    ).toBe(true);
    expect(
      existsSync(
        join(home, ".jupiter", "skill-packs", "managed", "documents", "skills", "documents"),
      ),
    ).toBe(false);
  });

  it("/skill update --check reports update status through postInfo", async () => {
    const registryUrl = "https://updates.jupiter.test/skill-packs.json";
    const oldUrl = process.env.JUPITER_SKILL_PACK_REGISTRY_URL;
    process.env.JUPITER_SKILL_PACK_REGISTRY_URL = registryUrl;
    vi.stubGlobal(
      "fetch",
      makeFetch({
        [registryUrl]: {
          schema: 1,
          packs: [
            {
              id: "documents",
              version: "99.99.99",
              url: "https://updates.jupiter.test/documents.json",
            },
          ],
        },
      }),
    );
    const posted: string[] = [];
    try {
      const result = handleSlash("skill", ["update", "--check"], {} as never, {
        homeDir: home,
        postInfo: (text) => posted.push(text),
      });

      expect(result.info).toContain(registryUrl);
      await vi.waitFor(() => expect(posted.join("\n")).toContain("documents"));
      expect(posted.join("\n")).toContain("99.99.99");
    } finally {
      if (oldUrl === undefined) {
        process.env.JUPITER_SKILL_PACK_REGISTRY_URL = undefined;
      } else {
        process.env.JUPITER_SKILL_PACK_REGISTRY_URL = oldUrl;
      }
      vi.unstubAllGlobals();
    }
  });
});

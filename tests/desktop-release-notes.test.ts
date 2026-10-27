import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MACOS_INSTALL_COMMAND,
  prepareDesktopReleaseNotes,
  withMacInstallInstructions,
} from "../scripts/prepare-desktop-release-notes.mjs";

const bilingual = "# Jupiter\n\n## 中文\n\n更新内容。\n\n## English\n\nChanges.\n";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop release notes", () => {
  it("adds bilingual macOS instructions when a future release omits them", () => {
    const prepared = withMacInstallInstructions(bilingual);
    expect(prepared).toContain(`\`\`\`sh\n${MACOS_INSTALL_COMMAND}\n\`\`\``);
    expect(prepared).toContain("将 Jupiter.app");
    expect(prepared).toContain("After moving Jupiter.app to Applications");
    expect(withMacInstallInstructions(prepared)).toBe(prepared);
  });

  it("keeps an author's existing command and surrounding instructions unchanged", () => {
    const notes = `${bilingual}\n\`\`\`sh\n${MACOS_INSTALL_COMMAND}\n\`\`\`\n`;
    expect(withMacInstallInstructions(notes)).toBe(notes);
  });

  it("rejects non-bilingual notes before publication", () => {
    expect(() => withMacInstallInstructions("## 中文\n更新")).toThrow("Chinese and English");
    expect(() => withMacInstallInstructions("## English\nChanges")).toThrow("Chinese and English");
  });

  it("prepares the selected release without changing its source and rejects invalid tags", () => {
    const root = mkdtempSync(join(tmpdir(), "jupiter-release-notes-"));
    roots.push(root);
    const notesDir = join(root, ".github", "release-notes");
    mkdirSync(notesDir, { recursive: true });
    const source = join(notesDir, "desktop-v1.0.11.md");
    const output = join(root, "prepared.md");
    writeFileSync(source, bilingual);
    prepareDesktopReleaseNotes("desktop-v1.0.11", output, root);
    expect(readFileSync(output, "utf8")).toBe(withMacInstallInstructions(bilingual));
    expect(readFileSync(source, "utf8")).toBe(bilingual);
    expect(() => prepareDesktopReleaseNotes("../README", output, root)).toThrow("release tag");
  });
});

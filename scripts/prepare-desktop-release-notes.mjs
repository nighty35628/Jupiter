import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MACOS_INSTALL_COMMAND =
  "sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app";

export function withMacInstallInstructions(notes) {
  if (!/^## 中文\s*$/m.test(notes) || !/^## English\s*$/m.test(notes)) {
    throw new Error("Desktop release notes must contain Chinese and English sections");
  }
  if (notes.includes(MACOS_INSTALL_COMMAND)) return notes;
  return `${notes.trimEnd()}

## macOS 安装 / macOS Installation

将 Jupiter.app 拖到“应用程序”后，如果未签名版本提示无法打开或文件已损坏，在终端运行以下命令，然后重新打开 Jupiter：

After moving Jupiter.app to Applications, if the unsigned build is blocked or reported as damaged, run this in Terminal, then reopen Jupiter:

\`\`\`sh
${MACOS_INSTALL_COMMAND}
\`\`\`
`;
}

export function prepareDesktopReleaseNotes(tag, outputPath, root = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  if (!/^desktop-v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(tag)) {
    throw new Error("Expected a desktop-v<semver> release tag");
  }
  const notes = readFileSync(join(root, ".github/release-notes", `${tag}.md`), "utf8");
  writeFileSync(outputPath, withMacInstallInstructions(notes));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tag, outputPath] = process.argv.slice(2);
  if (!tag || !outputPath) throw new Error("Usage: prepare-desktop-release-notes.mjs <tag> <output>");
  prepareDesktopReleaseNotes(tag, outputPath);
}

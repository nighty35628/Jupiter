# Desktop Release Notes

Each `desktop-v<version>.md` must contain `## 中文` and `## English` sections, the release changes, and macOS installation instructions including:

```sh
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
```

每个版本的双语发布说明都必须直接附上这条 macOS 指令，不能只链接到旧版本。发布流程在新建和更新 Release 时统一运行 `scripts/prepare-desktop-release-notes.mjs`，检查双语章节，并在遗漏时自动补全双语 macOS 安装说明。

The workflow uses `scripts/prepare-desktop-release-notes.mjs` both when creating and updating a release. It checks the bilingual sections and adds bilingual macOS installation instructions if the command is missing.

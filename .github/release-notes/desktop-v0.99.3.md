# Jupiter desktop-v0.99.3

## 中文

### 主要更新

- 文件系统工具现在会在沙盒判定前展开 `~/...` 和全角 `～/...`。
- 用户目录路径不会再被误当成工作区内的普通相对路径。
- `edit_file`、`write_file` 和 `multi_edit` 的路径审查同步支持用户目录展开，越界确认会指向真实目标文件。
- 桌面空状态的 hero 输入框、backdrop 和 placeholder 改为居中显示，初始工作台布局更稳定。
- 设置页归档列表新增一键清空入口，只清理已归档会话，不影响活动会话。
- 会话导入发现默认排除 Claude subagent 记录，并支持选择具体候选会话导入。
- 桌面端、根包、Tauri 配置和 Release notes 版本统一为 `0.99.3`。

### 安装提示

- Release 资产文件名会继续带平台名，方便区分 Windows x64、Windows ARM64、macOS Intel、macOS Apple Silicon、Linux x64 和 Linux ARM64。
- Windows 安装包仍为未签名版本，首次安装可能触发 SmartScreen 提示。
- macOS 如果提示无法打开或 App 已损坏，可在安装到 `/Applications` 后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

### Highlights

- Filesystem tools now expand `~/...` and full-width `～/...` before sandbox checks.
- Home-directory paths are no longer treated as normal workspace-relative paths by accident.
- `edit_file`, `write_file`, and `multi_edit` path review uses the same home-path expansion, so outside-workspace confirmations point at the real target file.
- The desktop empty-state hero composer, backdrop, and placeholder are centered for a steadier initial workbench layout.
- The settings archive list now includes a clear-archive action that only removes archived conversations.
- Session import discovery excludes Claude subagent records by default and supports importing selected candidate sessions.
- Desktop, root package, Tauri config, and release notes versions are aligned on `0.99.3`.

### Installer Notes

- Release asset names continue to include platform labels for Windows x64, Windows ARM64, macOS Intel, macOS Apple Silicon, Linux x64, and Linux ARM64.
- Windows installers are still unsigned, so SmartScreen may warn on first launch.
- If macOS reports that Jupiter cannot be opened or is damaged after installing, move it to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

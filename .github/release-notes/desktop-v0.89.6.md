# Jupiter desktop-v0.89.6

## 中文

### 主要更新

- 侧栏默认工具箱升级：文件、侧边聊天、浏览器、审查/Diff、终端五个入口统一管理。
- 信息面板改为与侧栏同宽的切换面板，会像侧栏一样推开主对话区。
- 新增底栏面板，使用与右侧栏一致的卡片和标签逻辑。
- URL 和 HTML 文件默认在内置浏览器打开，并保留浏览器侧栏状态。
- 队列模式改为纵向堆叠，加入“插队/引导”操作。
- 对话 hover 操作新增回滚按钮；`/undo` 和 `/rewind` 支持回退最新一轮对话。
- 工具卡展示 diff 统计，Diff 和终端面板体验更接近 Codex/Claude。
- 设置页补充过程细节默认展开/收起、全局记忆开关和保存模型记忆前询问选项。
- Desktop slash 命令补齐 CLI 行为，包括 `/init`、`/undo`、`/rewind`。
- 工具箱预设包新增 Documents 和 Superpowers，并支持内置 Skill 渠道。

### 安装包

- 新增 Linux ARM64 `.deb` 安装包。
- Release 资产文件名现在带平台名，方便区分 Windows、macOS Intel、macOS Apple Silicon、Linux x64 和 Linux ARM64。
- Windows 安装包仍为未签名版本，首次安装可能触发 SmartScreen 提示。
- macOS 如果提示无法打开或 App 已损坏，可在安装到 `/Applications` 后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

### Highlights

- Upgraded the sidebar default toolbox with Files, Side Chat, Browser, Review/Diff, and Terminal entries.
- Reworked the info panel into a sidebar-width switchable panel that pushes the main conversation area.
- Added a bottom panel with the same card and tab behavior as the right sidebar.
- URLs and HTML files now open in the in-app browser by default, while browser sidebar state is preserved.
- Queue mode now uses a vertical stacked layout with interrupt/guide actions.
- Message hover actions now include rollback; `/undo` and `/rewind` can roll back the latest conversation turn.
- Tool cards show diff totals, with diff and terminal panels closer to Codex/Claude workflows.
- Settings now include process-detail defaults, global memory, and ask-before-saving-model-memory controls.
- Desktop slash commands now mirror more CLI behavior, including `/init`, `/undo`, and `/rewind`.
- Bundled toolbox presets now include Documents and Superpowers, with built-in Skill channel support.

### Installers

- Added a Linux ARM64 `.deb` installer.
- Release asset names now include platform labels for Windows, macOS Intel, macOS Apple Silicon, Linux x64, and Linux ARM64.
- Windows installers are still unsigned, so SmartScreen may warn on first launch.
- If macOS reports that Jupiter cannot be opened or is damaged after installing, move it to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

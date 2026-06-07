# Jupiter desktop-v0.89.6

## 中文

### 主要更新

- 会话切换稳定性提升：运行中的对话在切换后可以恢复流式内容、思考过程和停止按钮状态。
- 侧栏会话状态后端化：置顶、归档、已读/未读和完成时间写入 session meta，跨窗口和重启后更一致。
- 侧栏对话右键菜单补齐置顶、重命名、归档、标记未读、复制会话信息等常用操作。
- 新增轻量资料库：网页搜索结果、本地文件和手动导入可以保存到工作区资料库。
- 资料库接入后端存储：资料源按工作区持久化到 `~/.jupiter/library/`，网页正文会抓取、提取并保存到本地。
- 资料库添加入口改为独立搜索浮窗，支持渐进式加载、内置浏览器打开网页结果、在文件夹中定位本地资料。
- 搜索入口复用设置中的搜索引擎配置，避免桌面端搜索和设置不一致。
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

- Improved session switching: running conversations can restore live content, reasoning, and stop-button state
  after switching away and back.
- Backend-backed sidebar session state: pinned, archived, read/unread, and completion timestamps now live in
  session metadata for better cross-window and restart behavior.
- Sidebar conversation context menus now include pin, rename, archive, mark unread, copy session info, and related
  operations.
- Added a lightweight workspace library for saving web search results, local files, and manual imports.
- Library sources are now persisted per workspace under `~/.jupiter/library/`; web pages are fetched, extracted,
  and saved locally.
- The library add flow now uses a dedicated search popover with progressive loading, in-app browser opening for
  web results, and folder/file actions for local sources.
- The search entry reuses the configured search engine so desktop search follows settings.
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

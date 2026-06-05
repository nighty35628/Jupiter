# Jupiter

[![Release](https://img.shields.io/github/v/release/nighty35628/Jupiter?display_name=tag&label=release)](https://github.com/nighty35628/Jupiter/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

Jupiter is a local-first AI coding workbench for personal development. It keeps the fast terminal loop,
desktop shell, MCP wiring, skills, memory, checkpoints, browser previews, diffs, and dashboard flows in one
repo.

Jupiter 是一个本地优先的 AI 编程工作台，面向个人开发场景。它把快速终端循环、桌面端外壳、MCP、
Skill、记忆、检查点、浏览器预览、Diff 和 Dashboard 流程放在同一个项目里。

## Download / 下载

Desktop installers are published on GitHub Releases:

桌面端安装包发布在 GitHub Releases：

- [Latest Release / 最新版本](https://github.com/nighty35628/Jupiter/releases/latest)
- [All Releases / 全部版本](https://github.com/nighty35628/Jupiter/releases)

Release asset names include the platform so you can pick the right installer:

Release 里的安装包文件名会带平台名，方便选择：

- Windows: `Jupiter_<version>_windows-x64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

Windows note: current Windows installers are unsigned. Microsoft Defender SmartScreen may show
an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you
downloaded Jupiter from the official GitHub Releases page above.

Windows 提示：当前 Windows 安装包未做代码签名。首次安装或启动时，Microsoft Defender
SmartScreen 可能提示“无法识别的应用”；如果你是从上面的官方 GitHub Releases 下载的，
可以点 **更多信息** -> **仍要运行** 继续安装。

macOS note: if the app cannot be opened after installing from the DMG, move `Jupiter.app` to
`/Applications`, then run:

macOS 提示：如果从 DMG 安装后提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进
`/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## Current Release / 当前版本

**Jupiter Desktop 0.89.6**

### 中文更新摘要

- 侧栏默认工具箱升级：文件、侧边聊天、浏览器、审查/Diff、终端五个入口统一管理。
- 信息面板改为与侧栏同宽的切换面板，会像侧栏一样推开主对话区。
- 新增底栏面板，使用与右侧栏一致的卡片和标签逻辑。
- URL 和 HTML 文件默认在内置浏览器打开，并保留浏览器侧栏状态。
- 队列模式改为纵向堆叠，加入“插队/引导”操作。
- 对话 hover 操作新增回滚按钮；`/undo` 和 `/rewind` 支持回退最新一轮对话。
- 工具卡展示 diff 统计，Diff 和终端面板体验更接近 Codex/Claude。
- 设置页补充过程细节默认展开/收起、全局记忆开关和保存模型记忆前询问选项。
- Desktop slash 命令补齐 CLI 行为，包括 `/init`、`/undo`、`/rewind`。

### English Highlights

- Upgraded the sidebar default toolbox with Files, Side Chat, Browser, Review/Diff, and Terminal entries.
- Reworked the info panel into a sidebar-width switchable panel that pushes the main conversation area.
- Added a bottom panel with the same card and tab behavior as the right sidebar.
- URLs and HTML files now open in the in-app browser by default, while browser sidebar state is preserved.
- Queue mode now uses a vertical stacked layout with interrupt/guide actions.
- Message hover actions now include rollback; `/undo` and `/rewind` can roll back the latest conversation turn.
- Tool cards show diff totals, with diff and terminal panels closer to Codex/Claude workflows.
- Settings now include process-detail defaults, global memory, and ask-before-saving-model-memory controls.
- Desktop slash commands now mirror more CLI behavior, including `/init`, `/undo`, and `/rewind`.

For the full bilingual changelog, see [CHANGELOG.md](./CHANGELOG.md).

完整双语更新记录见 [CHANGELOG.md](./CHANGELOG.md)。

## Focus / 方向

- Desktop-first workbench UI.
- Graphical MCP and skills configuration.
- DeepSeek-oriented coding sessions with long-running context.
- Local-first development and testing.

- 桌面端优先的工作台界面。
- 图形化 MCP 和 Skill 配置。
- 面向 DeepSeek 的长上下文编码会话。
- 本地优先的开发、测试和验证流程。

## Development / 开发

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm --prefix desktop run build
```

For desktop UI development:

桌面端 UI 开发：

```bash
npm --prefix desktop run dev -- --host 127.0.0.1
```

## Release Checklist / 发布检查

Before pushing a desktop release tag, add bilingual release notes at
`.github/release-notes/desktop-vX.Y.Z.md`. The desktop release workflow fails if
the notes file is missing, then publishes that file to the GitHub Release after
all platform bundles finish.

推送桌面端发布 tag 前，必须先新增双语发布说明：
`.github/release-notes/desktop-vX.Y.Z.md`。如果缺少该文件，桌面端发布工作流会失败；
所有平台安装包构建完成后，工作流会把这份说明写入 GitHub Release。

## License / 许可证

MIT. Required source-only notice is kept in `src/legal/upstream-notice.ts`.

MIT。必要的源码声明保留在 `src/legal/upstream-notice.ts`。

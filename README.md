# Jupiter

[中文](#中文) / [ENGLISH](#english)

[![Release](https://img.shields.io/github/v/release/nighty35628/Jupiter?display_name=tag&label=release)](https://github.com/nighty35628/Jupiter/releases/latest)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](#license--许可证)

## 中文

Jupiter 是一个本地优先的 AI 工作台，把长期项目里的对话、代码、资料、终端、浏览器、MCP 工具和远程消息通道放在同一个桌面环境里。
它既可以作为桌面端工作台使用，也保留 CLI/TUI 和浏览器仪表盘能力；核心组织方式是“工作区”，而不是一次性聊天窗口。

Jupiter 适合需要反复阅读文件、运行命令、验证页面、审查 diff、保存资料、切换会话并持续推进任务的开发和研究工作。
它的目标不是替代编辑器，而是把 AI 协作最常用的上下文集中到一个可恢复、可检查、可迁移的本地工作面板里。

### 0.99.0 重点

- 飞书通道进入完整工作流：桌面设置页、CLI/TUI `/feishu` 命令、自动启动、群聊 @ 策略和最终回复回传都已接入。
- 桌面端支持通过飞书进行轻量远程控制，包括查看状态、列出/切换会话、创建新会话、列出/切换工作区。
- QQ、飞书、Telegram 等消息通道可以把远程输入送入当前 Jupiter 会话，并把助手最终回复发送回来源通道。
- 版本元数据、CHANGELOG 和 GitHub Release notes 统一升级到 `0.99.0`，发布说明继续保持中英双语。

### 适合什么场景

- 长时间维护一个代码库，需要模型理解项目结构、会话历史和当前工作区状态。
- 边开发边验证前端界面、浏览器页面、文件变更、终端输出和测试结果。
- 做论文、PPT、报告、产品调研或资料整理，希望把网页、文件和摘录保存到同一个资料库。
- 使用 MCP、Skills、记忆、检查点、子任务和远程消息通道，把 AI 从问答助手扩展成完整工作环境。
- 希望项目上下文、资料库、配置、技能和记忆尽量保存在本地，而不是完全依赖远端服务。

### 核心能力

**桌面工作台**

桌面端提供对话区、侧栏、文件入口、终端、内置浏览器、审查/Diff 面板、底部工具区和设置页。
对话会和当前工作区、会话状态、工具调用、文件操作、浏览器验证和远程消息来源结合起来。

**长期会话**

Jupiter 支持长时间运行的会话、多对话切换和会话状态管理。会话元数据记录工作区、标题、归档、置顶、已读/未读和完成状态，
让 AI 对话可以像项目任务一样被恢复、整理和继续推进。

**资料库与浏览器**

每个工作区都可以拥有自己的资料库。你可以从网页搜索结果、本地文件或手动导入中添加资料源；网页内容会被抓取、
提取正文并保存到本地。内置浏览器可以打开网页和本地 HTML，用于预览、调研、验证页面和保存资料。

**文件、终端与 Diff**

你可以在同一个界面里查看工作区文件、运行命令、观察工具输出、审查变更并回看 diff。
工具卡会展示关键执行结果，桌面端也提供终端与编辑历史相关面板，方便把验证结果带回对话。

**MCP、Skills 与记忆**

Jupiter 支持 MCP 工具接入、Skills 工作流和本地记忆。Skills 可以把常用方法论、工具约束、项目习惯和领域流程变成模型可调用的能力。
内置 Superpowers skill pack 面向计划、调试、TDD、验证和分支收尾等工程流程。

**远程消息通道**

Jupiter 支持 QQ、飞书和 Telegram 通道。飞书通道可以通过桌面设置页配置，也可以在 CLI/TUI 中使用：

```bash
/feishu connect <appId> <appSecret> [mention|all]
/feishu status
/feishu disconnect
```

也可以通过环境变量提供飞书凭据：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_REQUIRE_MENTION_IN_GROUP=true
```

默认情况下，飞书私聊会直接进入 Jupiter；群聊需要 @ 机器人。把策略设为 `all` 后，群聊消息也可以全部进入当前通道。

**本地优先**

会话、资料库、配置、技能和记忆都以本地文件为核心组织。Jupiter 尽量让项目状态可检查、可备份、可迁移，
并减少对单一远端服务的依赖。

### 下载

桌面端安装包发布在 GitHub Releases：

- [最新版本](https://github.com/nighty35628/Jupiter/releases/latest)
- [全部版本](https://github.com/nighty35628/Jupiter/releases)

安装包文件名会标出平台：

- Windows: `Jupiter_<version>_windows-x64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

Windows 安装包目前未做代码签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；
如果你是从上面的官方 GitHub Releases 下载的，可以点 **More info** -> **Run anyway**。

macOS 如果从 DMG 安装后提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

### 开发

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm --prefix desktop run build
```

桌面端开发：

```bash
npm --prefix desktop run dev -- --host 127.0.0.1
```

### 发布说明

发布记录见 [CHANGELOG.md](./CHANGELOG.md)。GitHub Release 使用的双语说明保存在
[.github/release-notes](./.github/release-notes/)。旧 README 快照保存在 [history/readme](./history/readme/)。

## ENGLISH

Jupiter is a local-first AI workbench that brings conversations, code, research material, terminal output,
browser verification, MCP tools, and remote messaging channels into one desktop environment. It can be used as
a desktop workbench while still preserving CLI/TUI and browser-dashboard surfaces. Its main unit is the
workspace, not a one-off chat window.

Jupiter is built for development and research work that requires repeated file reading, command execution,
page verification, diff review, source collection, session switching, and task continuation. It is not meant
to replace your editor; it concentrates the context AI collaboration usually needs into a restorable local
surface.

### 0.99.0 Highlights

- Feishu Channel now has a complete workflow: desktop settings, CLI/TUI `/feishu` commands, auto-start,
  group @mention policy, and final assistant replies back to Feishu.
- Desktop can be lightly controlled from Feishu, including status, session list/switch/new, and workspace
  list/switch commands.
- QQ, Feishu, and Telegram channels can route remote messages into the active Jupiter session and send the
  assistant's final reply back to the source channel.
- Version metadata, CHANGELOG, and GitHub Release notes are aligned on `0.99.0`, with release notes kept
  bilingual.

### What Jupiter Is For

- Maintaining a codebase over long sessions while preserving project structure, chat history, and workspace state.
- Developing and verifying frontend screens, browser pages, file changes, terminal output, and test results.
- Writing papers, decks, reports, product research, or technical notes with saved web and file sources.
- Using MCP, Skills, memory, checkpoints, subtasks, and remote messaging channels to turn AI assistance into a
  fuller work surface.
- Keeping project context, library data, configuration, skills, and memory local where possible instead of
  depending entirely on remote services.

### Core Capabilities

**Desktop workbench**

The desktop app provides a conversation area, sidebars, files, terminal, in-app browser, review/Diff panels,
bottom tools, and settings. Conversations are connected to the current workspace, session state, tool calls,
file operations, browser verification, and remote message sources.

**Long-running sessions**

Jupiter supports long-running sessions, conversation switching, and session state management. Session metadata
tracks workspace, title, archive state, pin state, read/unread state, and completion state so conversations can
be restored, organized, and continued like project tasks.

**Workspace library and browser**

Each workspace can have its own library. You can add sources from web search results, local files, or manual
imports. Web pages can be fetched, extracted, and saved locally. The in-app browser opens web pages and local
HTML for previewing, researching, verifying, and saving sources.

**Files, terminal, and Diff**

You can inspect workspace files, run commands, read tool output, review changes, and compare diffs from the
same surface. Tool cards expose important execution results, and the desktop app includes terminal and edit
history panels so verification can feed back into the conversation.

**MCP, Skills, and memory**

Jupiter supports MCP tool integrations, Skills workflows, and local memory. Skills let local methods, tool
rules, project habits, and domain-specific processes become reusable model-facing capabilities. The bundled
Superpowers skill pack covers planning, debugging, TDD, verification, and development branch wrap-up workflows.

**Remote messaging channels**

Jupiter supports QQ, Feishu, and Telegram channels. Feishu can be configured in desktop settings or from the
CLI/TUI:

```bash
/feishu connect <appId> <appSecret> [mention|all]
/feishu status
/feishu disconnect
```

Feishu credentials can also come from environment variables:

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_REQUIRE_MENTION_IN_GROUP=true
```

By default, direct Feishu messages route into Jupiter, while group chats require an @mention. Set the policy to
`all` to route every group message into the active channel.

**Local-first**

Sessions, library data, configuration, skills, and memory are organized around local files. Jupiter aims to keep
project state inspectable, backup-friendly, and portable while reducing dependence on a single remote service.

### Download

Desktop installers are published on GitHub Releases:

- [Latest Release](https://github.com/nighty35628/Jupiter/releases/latest)
- [All Releases](https://github.com/nighty35628/Jupiter/releases)

Asset names include platform labels:

- Windows: `Jupiter_<version>_windows-x64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app"
warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from the official
GitHub Releases page above.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app`
to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

### Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm --prefix desktop run build
```

For desktop development:

```bash
npm --prefix desktop run dev -- --host 127.0.0.1
```

### Release Notes

See [CHANGELOG.md](./CHANGELOG.md) for release history. GitHub Release notes are kept under
[.github/release-notes](./.github/release-notes/). Older README snapshots are kept under
[history/readme](./history/readme/).

## License / 许可证

Jupiter is licensed under the GNU General Public License v3.0 or later
(`GPL-3.0-or-later`). Contributions are accepted under the project CLA in
[`CLA.md`](./CLA.md), which grants the project owner the right to maintain,
relicense, and offer separate commercial licensing where needed.

Required source-only upstream notice is kept in `src/legal/upstream-notice.ts`.

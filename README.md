# Jupiter

[中文](#中文) / [English](#english)

[![Release](https://img.shields.io/github/v/release/nighty35628/Jupiter?display_name=tag&label=release)](https://github.com/nighty35628/Jupiter/releases/latest)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](#license--许可证)

## 中文

Jupiter 是我自己长期用的 coding agent 工作台。最早只是想把 DeepSeek 的缓存吃满，把长上下文成本压下来；
后来慢慢把桌面多会话、本地资料库、MCP、Skills、远程消息通道和一些顺手的小工具都塞了进去。

它不是一个讲概念的壳子。日常我希望它能做三件事：

- 看得懂一个真实项目，能改代码、跑命令、看 diff、补测试。
- 长会话别太贵，资料和上下文尽量沉到本地，第二天还能接着干。
- 桌面端别像单个聊天窗口，多个任务、多个工作区要能同时挂着。

现在的状态可以理解为：一个偏工程师口味的本地优先 AI 工作台。界面和流程还在不断打磨，但我会优先保证能干活、
能验证、能发布。

### 0.99.9 重点

- 修复 macOS Finder 文件粘贴：支持从系统剪贴板读取 `public.file-url` 和 `.file/id=...` 这类真实文件引用。
- 粘贴图片、粘贴文件、点加号添加文件/图片，都统一成输入框上方的附件卡片，不再把路径硬塞进正文。
- 文件附件卡片做了收窄和压缩，侧边设置卡片、右侧 resize guide 也顺手调得更贴边。
- CLI 里粘贴工作区内文件路径时，会自动转成相对 `@mention`，终端里复制路径也能直接进上下文。
- 首轮会话标题改用低成本 flash 模型生成，桌面默认会话也能自动命名。
- Linux ARM64 release runner 从 Ubuntu 24.04 降到 Ubuntu 22.04，降低 glibc 基线，方便 Debian ARM 机器安装。
- 桌面端、根包、Tauri 配置、Cargo、CHANGELOG 和 Release notes 版本统一到 `0.99.9`。

### 我为什么做这个

很多 agent 工具都能写代码，但我遇到的痛点比较具体：

- 长项目反复喂上下文很贵，缓存命中率不稳定。
- 资料散在网页、文件、聊天记录里，过几天就找不到。
- 单聊天窗口切任务很痛苦，尤其是同时修 bug、查资料、跑验证的时候。
- 桌面端和 CLI/TUI 经常割裂，一个地方好用，另一个地方没有。

Jupiter 主要围着这些问题做。它不追求每个功能都最花哨，但尽量让工程工作流闭环。

### 能做什么

**代码和终端**

读仓库、回答代码问题、跨文件编辑、写测试、跑命令、看工具输出、审查 diff、辅助提交和发布。

**桌面多会话**

桌面端有顶部标签页、左侧会话、右侧上下文、内置浏览器、终端和设置页。不同工作区和任务可以并排挂着。

**本地资料库**

每个工作区可以保存网页、搜索结果、本地文件和摘录。资料落在本地，后续写文档、做研究、查历史都能复用。

**缓存优先**

运行循环围绕 DeepSeek prefix cache 设计，尽量保持长会话前缀稳定。目标不是炫技，是少花钱还能持续做事。

**MCP、Skills 和记忆**

支持 MCP 工具、Skills 工作流、本地记忆和检查点。内置 Superpowers skill pack，用来做计划、调试、TDD、验证和分支收尾。

**远程消息**

支持 QQ、飞书和 Telegram。比如飞书可以在桌面设置页配，也可以在 CLI/TUI 里连：

```bash
/feishu connect <appId> <appSecret> [mention|all]
/feishu status
/feishu disconnect
```

也可以用环境变量：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_REQUIRE_MENTION_IN_GROUP=true
```

### 当前取舍

- 桌面端还没有签名，Windows 和 macOS 首次启动会有系统提示。
- Linux 桌面包优先做 `.deb`，x64 和 ARM64 都有；更老的 glibc 发行版需要单独实验。
- 很多能力优先服务我自己的日常工程流，所以有些界面文案和交互还会继续改。
- 这是个人项目，不是商业 SaaS。配置、资料库、会话和记忆尽量放本地，可检查、可备份、可迁移。

### 下载

桌面安装包在 GitHub Releases：

- [最新版本](https://github.com/nighty35628/Jupiter/releases/latest)
- [全部版本](https://github.com/nighty35628/Jupiter/releases)

文件名里会带平台：

- Windows x64: `Jupiter_<version>_windows-x64.exe`
- Windows ARM64: `Jupiter_<version>_windows-arm64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；
如果你确认是从上面的 GitHub Releases 下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

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

### 发布资料

发布记录见 [CHANGELOG.md](./CHANGELOG.md)。GitHub Release 使用的双语说明在
[.github/release-notes](./.github/release-notes/)。旧 README 快照在 [history/readme](./history/readme/)。

## English

Jupiter is the coding-agent workbench I use for my own projects. It started as a way to make DeepSeek prefix
cache useful in long sessions, then grew into a desktop app with tabs, a local source library, MCP, Skills,
remote messaging, and a CLI/TUI path that still matters.

It is not trying to sound like a platform. The goals are plain:

- understand a real codebase, edit files, run commands, inspect diffs, and add tests;
- keep long sessions affordable, with sources and memory saved locally;
- make the desktop app feel like a workbench, not one locked chat window.

### 0.99.9 Highlights

- macOS Finder file paste now reads `public.file-url` and `.file/id=...` references from the system clipboard.
- Pasted images, pasted files, and plus-button file/image picks now share compact attachment cards above the composer.
- File cards are narrower, and a few desktop layout details were tightened around settings and the right resize guide.
- CLI pasted workspace file paths can become relative `@mentions`, so terminal path copies enter context directly.
- First-turn session titles use the low-cost flash title model, including desktop default sessions.
- Linux ARM64 release builds now use Ubuntu 22.04 instead of Ubuntu 24.04 to lower the glibc baseline for Debian ARM users.
- Desktop, root package, Tauri config, Cargo, CHANGELOG, and Release notes are aligned on `0.99.9`.

### Why It Exists

The problems I care about are practical:

- long project context gets expensive when cache behavior is not respected;
- web pages, files, and notes disappear into scattered chats;
- one chat window is awkward when several engineering tasks are alive at once;
- desktop and CLI workflows should share the same project state instead of drifting apart.

Jupiter is built around those constraints. It favors a local, inspectable engineering workflow over polished marketing.

### What It Does

**Code and terminal**

Read a repo, answer code questions, edit across files, write and run tests, execute shell commands, inspect output,
review diffs, and help with commit/release work.

**Tabbed desktop**

The desktop app has top tabs, session lists, context panels, an in-app browser, terminal surfaces, and settings.
Different workspaces and tasks can stay open at the same time.

**Local source library**

Each workspace can save web pages, search results, local files, and excerpts. Sources are stored locally so they can
be reused for docs, research, and long-running project work.

**Cache-first loop**

The runtime is shaped around DeepSeek prefix cache behavior. The point is simple: spend less on repeated context while
still keeping enough state to work continuously.

**MCP, Skills, and memory**

Jupiter supports MCP tools, Skills, local memory, and checkpoints. The bundled Superpowers skill pack covers planning,
debugging, TDD, verification, and branch wrap-up workflows.

**Remote messaging**

QQ, Feishu, and Telegram are supported. Feishu can be configured in desktop settings or from the CLI/TUI:

```bash
/feishu connect <appId> <appSecret> [mention|all]
/feishu status
/feishu disconnect
```

Credentials can also come from environment variables:

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_REQUIRE_MENTION_IN_GROUP=true
```

### Current Tradeoffs

- Desktop installers are unsigned for now, so Windows and macOS may show first-run warnings.
- Linux desktop releases are `.deb` packages for x64 and ARM64. Very old glibc targets need separate legacy experiments.
- Some UI details are still changing because this is a personal tool used in daily work.
- Sessions, library data, configuration, skills, and memory are local-first where possible.

### Download

Desktop installers are published on GitHub Releases:

- [Latest Release](https://github.com/nighty35628/Jupiter/releases/latest)
- [All Releases](https://github.com/nighty35628/Jupiter/releases)

Asset names include platform labels:

- Windows x64: `Jupiter_<version>_windows-x64.exe`
- Windows ARM64: `Jupiter_<version>_windows-arm64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning
on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from the official GitHub Releases
page above.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to
`/Applications` and run:

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

Jupiter is licensed under the GNU General Public License v3.0 or later (`GPL-3.0-or-later`). Contributions are
accepted under the project CLA in [`CLA.md`](./CLA.md), which grants the project owner the right to maintain,
relicense, and offer separate commercial licensing where needed.

Required source-only upstream notice is kept in `src/legal/upstream-notice.ts`.

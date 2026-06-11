# Jupiter

[中文](#中文) / [English](#english)

[![Release](https://img.shields.io/github/v/release/nighty35628/Jupiter?display_name=tag&label=release)](https://github.com/nighty35628/Jupiter/releases/latest)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](#license--许可证)

## 中文

Jupiter 1.0.0 正式发布。

Jupiter 是一款 DeepSeek 桌面 agent，也是日常开发、检索与发布的工作台。它围绕 DeepSeek prefix cache 设计，
把长上下文成本压下来，并把桌面多会话、本地资料库、MCP、Skills、远程消息通道和常用工程工具放进一个统一环境。

我希望把 Jupiter 做成最好用的 DeepSeek 桌面 agent。如果它对你有帮助，欢迎给项目点 Star，也欢迎分享给身边正在用
DeepSeek 做开发、研究或自动化工作的朋友。

### 适合谁

- 想用 DeepSeek 长时间处理真实项目，而不是每次都重新喂上下文的人。
- 同时维护多个任务、多个仓库、多个会话，需要桌面端持续挂着的人。
- 经常查网页、读本地资料、跑命令、看 diff、补测试，希望资料和过程能留在本地的人。
- 希望把 MCP、Skills、远程消息和 coding agent 工作流放在同一个工具里的人。

### 核心能力

**DeepSeek 优先**

Jupiter 默认面向 DeepSeek 模型和 prefix cache。运行循环尽量保持长会话前缀稳定，用更低成本支撑持续工作。

**桌面工作台**

桌面端提供多标签页、会话列表、上下文面板、内置浏览器、终端、设置页和资料库。不同工作区与任务可以并行保留，
适合把一个项目连续做几天、几周。

**代码与终端**

Jupiter 可以阅读仓库、回答代码问题、跨文件编辑、编写测试、执行命令、查看工具输出、审查 diff，并辅助提交与发布。

**本地资料库**

每个工作区可以保存网页、搜索结果、本地文件与摘录。资料留在本地，后续写文档、做研究、查历史时可以继续复用。

**MCP、Skills 与记忆**

Jupiter 支持 MCP 工具、Skills 工作流、本地记忆与检查点。内置 Superpowers skill pack，用于计划、调试、TDD、
验证与分支收尾。

**远程消息**

Jupiter 支持 QQ、飞书与钉钉通道。以飞书为例，可在桌面设置页配置，也可在 CLI/TUI 中连接：

```bash
/feishu connect <appId> <appSecret> [mention|all]
/feishu status
/feishu disconnect
```

也可使用环境变量：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_REQUIRE_MENTION_IN_GROUP=true
```

### 下载

桌面安装包发布在 GitHub Releases：

- [最新版本](https://github.com/nighty35628/Jupiter/releases/latest)
- [全部版本](https://github.com/nighty35628/Jupiter/releases)

文件名包含平台标识：

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

### CLI 使用

首次运行会进入配置向导，也可以直接设置环境变量：

```bash
export DEEPSEEK_API_KEY=sk-...
jupiter
```

常用命令：

```bash
jupiter              # 在当前目录启动 coding agent
jupiter chat         # 启动普通聊天/TUI
jupiter setup        # 重新配置 API key、语言、主题和 MCP
jupiter --help
```

### 开发

```bash
npm ci
npm --prefix dashboard ci
npm --prefix desktop ci
npm run lint
npm run typecheck
npm test
npm --prefix desktop run build
```

桌面端开发：

```bash
npm --prefix desktop run dev -- --host 127.0.0.1
```

### 项目状态

- Jupiter 是独立项目，配置、资料库、会话、Skills 与记忆尽量本地优先，可检查、可备份、可迁移。
- 桌面端暂未签名，Windows 与 macOS 首次启动会出现系统提示。
- Linux 桌面包优先提供 `.deb`，x64 与 ARM64 均覆盖；更早版本的 glibc 发行版需单独测试。
- 发布记录见 [CHANGELOG.md](./CHANGELOG.md)，GitHub Release 使用的双语说明在
  [.github/release-notes](./.github/release-notes/)，旧 README 快照在 [history/readme](./history/readme/)。

## English

Jupiter 1.0.0 is officially released.

Jupiter is a DeepSeek desktop agent and a workbench for daily development, research, and release work. It is designed
around DeepSeek prefix cache, keeps long-context cost under control, and brings tabbed desktop sessions, local sources,
MCP, Skills, remote messaging, and practical engineering tools into one environment.

I am building Jupiter to be the best DeepSeek desktop agent I can make. If it helps your work, please star the project
and share it with people who use DeepSeek for development, research, or automation.

### Who It Is For

- People who want to use DeepSeek on real projects for long sessions without rebuilding context every time.
- People who keep multiple tasks, repositories, and sessions open at the same time.
- People who research on the web, read local files, run commands, inspect diffs, and want the material to stay local.
- People who want MCP, Skills, remote messaging, and coding-agent workflows in one tool.

### Core Capabilities

**DeepSeek first**

Jupiter is built around DeepSeek models and prefix cache behavior. The runtime keeps long-session prefixes stable so
continuous work costs less.

**Desktop workbench**

The desktop app provides tabs, session lists, context panels, an in-app browser, terminal surfaces, settings, and a
local source library. Different workspaces and tasks can remain active in parallel.

**Code and terminal**

Jupiter can read repositories, answer code questions, edit across files, write tests, execute commands, inspect tool
output, review diffs, and assist with commit and release work.

**Local source library**

Each workspace can save web pages, search results, local files, and excerpts. Sources stay local and can be reused for
docs, research, and long-running project work.

**MCP, Skills, and memory**

Jupiter supports MCP tools, Skills workflows, local memory, and checkpoints. The bundled Superpowers skill pack covers
planning, debugging, TDD, verification, and branch wrap-up workflows.

**Remote messaging**

Jupiter supports QQ, Feishu, and DingTalk channels. Feishu can be configured in desktop settings or from the CLI/TUI:

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

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on
first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from the official GitHub Releases page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to
`/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

### CLI Usage

The first run opens the setup wizard. You can also set the environment variable directly:

```bash
export DEEPSEEK_API_KEY=sk-...
jupiter
```

Common commands:

```bash
jupiter              # start the coding agent in the current directory
jupiter chat         # start plain chat/TUI mode
jupiter setup        # reconfigure API key, language, theme, and MCP
jupiter --help
```

### Development

```bash
npm ci
npm --prefix dashboard ci
npm --prefix desktop ci
npm run lint
npm run typecheck
npm test
npm --prefix desktop run build
```

For desktop development:

```bash
npm --prefix desktop run dev -- --host 127.0.0.1
```

### Project Status

- Jupiter is an independent, local-first project. Sessions, library data, configuration, skills, and memory stay local
  where possible.
- Desktop installers are unsigned for now, so Windows and macOS may show first-run warnings.
- Linux desktop releases are `.deb` packages for x64 and ARM64. Very old glibc targets need separate legacy testing.
- See [CHANGELOG.md](./CHANGELOG.md) for release history. GitHub Release notes are kept under
  [.github/release-notes](./.github/release-notes/). Older README snapshots are kept under
  [history/readme](./history/readme/).

## License / 许可证

Jupiter is licensed under the GNU General Public License v3.0 or later (`GPL-3.0-or-later`). Contributions are accepted
under the project CLA in [`CLA.md`](./CLA.md), which grants the project owner the right to maintain, relicense, and
offer separate commercial licensing where needed.

Required source-only upstream notice is kept in `src/legal/upstream-notice.ts`.

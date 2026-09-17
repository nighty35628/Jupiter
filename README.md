# Jupiter

[中文](#中文) / [English](#english)

[![Release](https://img.shields.io/github/v/release/nighty35628/Jupiter?display_name=tag&label=release)](https://github.com/nighty35628/Jupiter/releases/latest)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](#license--许可证)

## 中文

Jupiter 是一款 DeepSeek 桌面 agent，也是日常开发、检索与发布的工作台。

目标很直接：做最好用的 DeepSeek desktop agent。Jupiter 围绕 DeepSeek prefix cache 设计，把长上下文成本压下来；
桌面端负责多会话、本地资料库、MCP、Skills、远程消息通道和常用工程工具，让一个项目可以连续做几天、几周，
中途不用反复重新整理上下文。

如果 Jupiter 对你有帮助，欢迎点 Star，也欢迎分享给身边正在用 DeepSeek 做开发、研究或自动化工作的朋友。

### 适合谁用

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

- 当前版本：`desktop-v1.0.9`，2026-09-18 发布
- [最新版本](https://github.com/nighty35628/Jupiter/releases/latest)
- [全部版本](https://github.com/nighty35628/Jupiter/releases)

文件名包含平台标识：

- Windows x64: `Jupiter_<version>_windows-x64.exe`
- Windows ARM64: `Jupiter_<version>_windows-arm64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Arch Linux x64: `Jupiter_<version>_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

Linux 目前发布原生 `.deb` 包，并为 Arch Linux x64 发布 pacman 包。Debian/Ubuntu 系可以直接安装 `.deb`；
Arch 系发行版可以用 `pacman -U` 安装 `.pkg.tar.zst`。项目也提供了一个安装脚本，会自动选择当前发行版最合适
的 release 产物；Arch 旧版本 release 没有 pacman 包时，会回退到解包 `.deb`。脚本会为 Arch 安装 WebKitGTK
与 AppIndicator 运行库；如果旧脚本曾解包 `.deb` 导致 `/usr/bin/Jupiter` 不归 pacman 管理，重新运行脚本会在
安装 pacman 包前迁移这些旧文件：

```bash
curl -fsSL https://raw.githubusercontent.com/nighty35628/Jupiter/main/install-linux.sh | bash
```

AUR 发布使用 `jupiter-bin` 包名；维护模板在 [packaging/arch/jupiter-bin](./packaging/arch/jupiter-bin/)。

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
jupiter web [目录]   # 启动 Web Beta（默认仅本机）
jupiter setup        # 重新配置 API key、语言、主题和 MCP
jupiter --help
```

第三方 DeepSeek 或 OpenAI 兼容 Chat Completions 服务可以在 Desktop 的 **设置 -> 模型** 中配置、测试并保存。
纯 CLI 环境可以使用：

```bash
jupiter setup \
  --provider-url https://example.com/v1 \
  --provider-protocol openai-compatible \
  --provider-model your-model-id \
  --provider-key sk-...
```

`--provider-protocol` 支持 `auto`、`deepseek` 和 `openai-compatible`。DeepSeek 协议会发送 `thinking`、
reasoning 和缓存统计等扩展字段；普通兼容端点不会收到这些字段。供应商修改只用于新对话，已有会话会绑定原端点，
防止历史上下文被静默发送给另一个服务。第三方价格未知时 Jupiter 不会套用官方 DeepSeek 价格。

Web Beta 默认只监听 `127.0.0.1`，复用当前 Desktop 界面、会话与 agent 运行时。浏览器文件通过授权工作区和上传/下载流转；多个已配对设备可以观察，但同一时刻只有一个设备持有写入租约。Desktop 与 Web 同时打开同一会话时也会启用跨进程单写保护。

局域网使用 `--access lan`；公网使用 `--access public`，并且必须放在带身份验证的 HTTPS 反向代理后，Jupiter 本身仍只绑定回环地址。公网模式固定关闭终端、MCP 写入、Git 写入和密钥写入。完整命令、能力差异与代理示例见 [Web Beta 访问指南](docs/web-beta.md)。

### 图片对话 Beta

在 Desktop 或 Web 选择 `deepseek-flash` 后，可以粘贴截图、拖入图片，或通过输入框的“添加文件”选择图片。
支持 PNG、JPEG、WebP、GIF；每条最多 12 张、单张原始文件不超过 20 MiB，动图只使用首帧。图片会先归一化、压缩并持久保存，
缩略图可打开大图；纯图片、询问模式、排队、编辑和失败恢复都会保留附件。

第三方接口需要在 **设置 -> 模型** 勾选“此模型支持图片输入”，并确认服务端支持 Chat Completions 的图片格式。
官方 Pro 不支持直接附图，也不会自动转发给其他模型。图片传输方式默认自动，第三方始终使用内联传输。
Markdown 导出包含附件说明，不包含图片本体。详细资源限制、清理策略和测试记录见 [多模态实现说明](docs/codebase/multimodal-implementation.md)。

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
- Linux 桌面包提供 `.deb`，x64 与 ARM64 均覆盖；Arch Linux x64 同步提供 `.pkg.tar.zst`，并准备了
  `jupiter-bin` AUR 模板。更早版本的 glibc 发行版需单独测试。
- 发布记录见 [CHANGELOG.md](./CHANGELOG.md)，GitHub Release 使用的双语说明在
  [.github/release-notes](./.github/release-notes/)，旧 README 快照在 [history/readme](./history/readme/)。

## English

Jupiter is a DeepSeek desktop agent and a workbench for daily development, research, and release work.

The goal is simple: build the best DeepSeek desktop agent. Jupiter is designed around DeepSeek prefix cache to keep
long-context cost down. The desktop app brings multi-session work, local sources, MCP, Skills, remote messaging, and
practical engineering tools into one place, so a real project can stay alive for days or weeks without rebuilding
context every time.

If Jupiter helps your work, please star the project and share it with people using DeepSeek for development, research,
or automation.

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

- Current version: `desktop-v1.0.9`, released on 2026-09-18
- [Latest Release](https://github.com/nighty35628/Jupiter/releases/latest)
- [All Releases](https://github.com/nighty35628/Jupiter/releases)

Asset names include platform labels:

- Windows x64: `Jupiter_<version>_windows-x64.exe`
- Windows ARM64: `Jupiter_<version>_windows-arm64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Arch Linux x64: `Jupiter_<version>_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

Linux currently ships native `.deb` packages and an Arch Linux x64 pacman package. Debian/Ubuntu-family systems can
install the `.deb` directly; Arch-family systems can install the `.pkg.tar.zst` with `pacman -U`. The installer script
automatically selects the best release asset for the current distribution, and falls back to `.deb` payload extraction
for older releases that do not have a pacman package. On Arch-family systems it installs the WebKitGTK and AppIndicator
runtime libraries; if an older script extracted the `.deb` and left `/usr/bin/Jupiter` outside pacman's ownership,
rerunning the script migrates those old files before installing the pacman package:

```bash
curl -fsSL https://raw.githubusercontent.com/nighty35628/Jupiter/main/install-linux.sh | bash
```

The AUR package name is `jupiter-bin`; its package template lives in
[packaging/arch/jupiter-bin](./packaging/arch/jupiter-bin/).

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
jupiter web [dir]    # start Web Beta (localhost by default)
jupiter setup        # reconfigure API key, language, theme, and MCP
jupiter --help
```

Third-party DeepSeek or OpenAI-compatible Chat Completions services can be configured and tested under
**Settings -> Models** in Desktop. In a CLI-only environment, use:

```bash
jupiter setup \
  --provider-url https://example.com/v1 \
  --provider-protocol openai-compatible \
  --provider-model your-model-id \
  --provider-key sk-...
```

`--provider-protocol` accepts `auto`, `deepseek`, or `openai-compatible`. The DeepSeek preset sends supported
thinking, reasoning, and cache extensions; the generic preset strips those fields. Provider changes apply only to new
conversations, while existing sessions remain bound to their original endpoint. Jupiter does not apply official
DeepSeek prices to third-party usage when pricing is unknown.

Web Beta listens on `127.0.0.1` by default and reuses the current Desktop UI, sessions, and agent runtime. Browser files flow through approved workspaces and upload/download APIs. Multiple paired devices may observe, while only one device holds the writer lease at a time. A cross-process single-writer lock also protects a session opened by Desktop and Web simultaneously.

Use `--access lan` on a private network. Public access uses `--access public` behind an authenticated HTTPS reverse proxy while Jupiter remains bound to loopback. Public mode always disables terminals, MCP writes, Git writes, and secret writes. See the [Web Beta access guide](docs/web-beta.md) for commands, capability differences, and proxy configuration.

### Image Conversations Beta

Select `deepseek-flash` in Desktop or Web, then paste, drop, or pick PNG, JPEG, WebP or GIF images.
A message accepts up to 12 images of at most 20 MiB each; animated formats use their first frame. Images are normalized,
compressed and saved before submission. Previews, image-only messages, Ask, queues, edits and recovery retain attachments.

For third-party endpoints, enable **Settings -> Models -> This model supports image input** only when the endpoint
supports Chat Completions image content. Official Pro does not accept images or silently route them to
another model. Third-party endpoints always use inline images; official transport defaults to automatic Files reuse.
Markdown exports describe attachments but do not embed their bytes. See [Multimodal implementation](docs/codebase/multimodal-implementation.md)
for limits, retention and verification details.

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
- Linux desktop releases include `.deb` packages for x64 and ARM64, plus an Arch Linux x64 `.pkg.tar.zst`. The
  `jupiter-bin` AUR template is included for AUR publication; very old glibc targets need separate legacy testing.
- See [CHANGELOG.md](./CHANGELOG.md) for release history. GitHub Release notes are kept under
  [.github/release-notes](./.github/release-notes/). Older README snapshots are kept under
  [history/readme](./history/readme/).

## License / 许可证

Jupiter is licensed under the GNU General Public License v3.0 or later (`GPL-3.0-or-later`). Contributions are accepted
under the project CLA in [`CLA.md`](./CLA.md), which grants the project owner the right to maintain, relicense, and
offer separate commercial licensing where needed.

Required upstream attribution is kept in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md), outside the runtime source tree.

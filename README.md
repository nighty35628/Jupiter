# Jupiter

[中文](#中文) / [ENGLISH](#english)

[![Release](https://img.shields.io/github/v/release/nighty35628/Jupiter?display_name=tag&label=release)](https://github.com/nighty35628/Jupiter/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license--许可证)

## 中文

Jupiter 是一个本地优先的 AI 工作台，用来把长期项目里的编码、资料、工具调用和上下文管理放在同一个桌面环境里。
它不是单纯的聊天窗口，也不是只跑命令的终端壳，而是一个围绕“工作区”组织的开发与研究界面：你可以在里面写代码、
阅读文件、运行终端、打开网页、管理资料库、调用 MCP 工具，并让模型持续理解当前项目的上下文。

Jupiter 的核心目标是让 AI 协作更接近真实工作流。一个项目通常不会只靠一次 prompt 完成：你需要反复查资料、切换文件、
跑测试、回看历史、比较 diff、打开浏览器验证页面，并在不同对话之间保留状态。Jupiter 把这些动作收进一个本地桌面应用，
尽量减少“模型在对话里、文件在编辑器里、资料在浏览器里、命令在终端里”造成的割裂。

### 适合什么场景

- 长时间维护一个代码库，需要模型理解项目结构、会话历史和当前工作区状态。
- 边开发边验证前端界面、浏览器页面、文件变更和终端输出。
- 做论文、PPT、报告、产品调研或资料整理，希望把网页、文件和摘录保存到同一个工作区资料库。
- 使用 MCP、Skills、记忆、检查点、子任务等能力，把 AI 从“问答助手”变成更完整的工作环境。
- 需要本地优先的项目上下文，而不是把所有资料都交给远端服务保存。

### 主要能力

**桌面工作台**

Jupiter 提供桌面端主界面，包含对话区、侧栏、文件入口、终端、浏览器、审查/Diff 面板和底部工具区。
对话不是孤立存在的，它会和当前工作区、会话状态、工具调用、文件操作和浏览器验证结合起来。

**长期会话**

Jupiter 支持长时间运行的会话和多对话切换。会话元数据会记录工作区、标题、归档、置顶、已读/未读和完成状态，
让你可以像管理项目任务一样管理 AI 对话。

**资料库**

每个工作区都可以拥有自己的资料库。你可以从网页搜索结果、本地文件或手动导入中添加资料源；网页内容会被抓取、
提取正文并保存到本地。资料库适合保存论文资料、产品文档、技术文章、竞品页面、灵感片段和项目背景材料。

**内置浏览器**

Jupiter 可以在应用内打开网页和本地 HTML，用于预览、调研、验证页面和保存资料。网页搜索和资料库入口会尽量复用同一套
搜索引擎设置，避免不同入口行为不一致。

**文件、终端与 Diff**

你可以在同一个界面里查看工作区文件、运行命令、观察工具输出、审查变更并回看 diff。Jupiter 的目标不是替代你的编辑器，
而是把 AI 协作时最常需要的上下文集中到一个可恢复的工作面板里。

**MCP 与 Skills**

Jupiter 支持 MCP 工具接入和 Skills 工作流。Skills 可以把常用方法论、工具约束、项目习惯和领域流程变成模型可调用的本地能力。
内置的 Superpowers skill pack 面向计划、调试、TDD、验证和分支收尾等工程流程。

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
如果你是从上面的官方 GitHub Releases 下载的，可以点 **更多信息** -> **仍要运行**。

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

发布记录见 [CHANGELOG.md](./CHANGELOG.md)。旧 README 快照保存在 [history/readme](./history/readme/)。

## ENGLISH

Jupiter is a local-first AI workbench for keeping coding, research material, tool calls, and project context in
one desktop environment. It is not just a chat window, and it is not only a terminal wrapper. It is organized
around a workspace: you can write code, inspect files, run commands, open web pages, save sources into a local
library, call MCP tools, and keep the model oriented around the project you are actually working on.

The goal is to make AI collaboration feel closer to real work. Most projects are not completed by one prompt:
you search, read, edit, test, inspect diffs, preview pages, switch conversations, and return to unfinished work.
Jupiter brings those motions into a recoverable local desktop app, reducing the split between chat, editor,
browser, terminal, and notes.

### What Jupiter Is For

- Maintaining a codebase over long sessions while preserving project structure, chat history, and workspace state.
- Developing and verifying frontend screens, browser pages, file changes, and terminal output in one loop.
- Writing papers, decks, reports, product research, or technical notes with saved web and file sources.
- Using MCP, Skills, memory, checkpoints, and subtask workflows to turn AI assistance into a fuller work surface.
- Keeping project context local and inspectable instead of relying on a single remote service to hold everything.

### Core Capabilities

**Desktop workbench**

Jupiter provides a desktop interface with a conversation area, sidebars, files, terminal, browser, review/Diff
panels, and bottom tools. Conversations are connected to the current workspace, session state, tool calls, file
operations, and browser verification.

**Long-running sessions**

Jupiter supports long-running sessions and switching between conversations. Session metadata tracks workspace,
title, archive state, pin state, read/unread state, and completion state so conversations can be managed more
like project tasks.

**Workspace library**

Each workspace can have its own library. You can add sources from web search results, local files, or manual
imports. Web pages can be fetched, extracted, and saved locally. The library is useful for papers, product docs,
technical articles, competitor pages, notes, and background material.

**In-app browser**

Jupiter can open web pages and local HTML inside the app for previewing, researching, verifying, and saving
sources. Search and library entry points share the configured search engine where possible, keeping behavior
consistent across the interface.

**Files, terminal, and Diff**

You can inspect workspace files, run commands, read tool output, review changes, and compare diffs from the same
surface. Jupiter is not meant to replace your editor; it concentrates the context AI collaboration usually needs
into a panel that can be restored and navigated.

**MCP and Skills**

Jupiter supports MCP tool integrations and Skills workflows. Skills let local methods, tool rules, project habits,
and domain-specific processes become reusable model-facing capabilities. The bundled Superpowers skill pack
covers planning, debugging, TDD, verification, and development branch wrap-up workflows.

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

Windows installers are currently unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning
on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from the official GitHub
Releases page above.

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

See [CHANGELOG.md](./CHANGELOG.md) for release history. Older README snapshots are kept under
[history/readme](./history/readme/).

## License / 许可证

MIT. Required source-only notice is kept in `src/legal/upstream-notice.ts`.

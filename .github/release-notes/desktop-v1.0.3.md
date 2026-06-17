# Jupiter desktop-v1.0.3

## 中文

Jupiter 1.0.3 继续围绕 DeepSeek desktop agent 的日常工程体验打磨：桌面端补上可选组件检测和更清晰的用量历史，轻量 Ask 更会判断什么时候该快答，工具侧也减少了多次搜索、多次读文件带来的上下文浪费。

### 主要更新

- 桌面设置新增可选组件页，可检测 Chrome、Edge、Chromium、LibreOffice、FFmpeg、Tesseract OCR 与 Pandoc。
- 浏览器自动化优先复用系统 Chrome/Edge/Chromium，并新增 `playwright-core` 依赖，为后续浏览器能力做准备。
- 桌面输入新增轻量 Ask 路由：短问答、寒暄和解释类问题走更轻的请求；涉及代码、文件、终端、测试、构建、提交、浏览器或工作区操作时保留完整 agent 流程。
- 新增 `read_files` 工具，一次读取多个已知文件，减少反复 `read_file` 带来的上下文开销。
- 新增 `web_research` 工具，把搜索、页面抓取、去重和摘录合并到一次研究调用里。
- 系统提示进一步压缩，保留关键约束，同时降低固定 prompt 成本。
- Skills 与 subagent wrapper 调用在桌面会话中以专门卡片展示，任务和结果更容易扫读。
- 设置页计费视图改为历史用量，支持按月、周、日查看 turns、tokens 与费用汇总。
- Markdown 渲染、工具卡片样式、文件/网页工具预算和速率限制细节继续修正。
- Arch 安装脚本会补齐 WebKitGTK、AppIndicator 等运行库，并迁移旧脚本遗留的非 pacman 管理安装文件。
- 桌面端、根包、Tauri、Cargo、CHANGELOG、README 和 release notes 版本统一为 `1.0.3`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.3_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.3_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.3_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.3_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.3_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.3_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.3_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.3 keeps tightening the everyday DeepSeek desktop agent workflow: desktop now detects optional local components, usage history is easier to inspect, lightweight Ask is better at choosing when to answer quickly, and tool calls waste less context on repeated file reads or web fetches.

### Highlights

- Desktop settings now include an optional components page for Chrome, Edge, Chromium, LibreOffice, FFmpeg, Tesseract OCR, and Pandoc.
- Browser automation prefers system Chrome/Edge/Chromium, with `playwright-core` added for upcoming browser capabilities.
- Desktop input now has lightweight Ask routing: short casual questions, greetings, and explanation prompts take a lighter request path, while code, file, terminal, test, build, commit, browser, and workspace tasks stay on the full agent path.
- Added `read_files` for reading several known files in one model-visible tool result.
- Added `web_research` for search, page fetch, dedupe, and excerpts in one research call.
- The coding system prompt was compressed while keeping the key constraints, reducing fixed prompt cost.
- Skills and subagent wrapper calls now render as dedicated desktop conversation cards.
- Billing settings now show usage history by month, week, and day, including turns, tokens, and cost totals.
- Markdown rendering, tool-card styling, file/web tool budgets, and rate-limit details received additional fixes.
- The Arch installer now ensures WebKitGTK, AppIndicator, and related runtime libraries are installed, and migrates old unmanaged files left by earlier `.deb` extraction installs.
- Desktop, root package, Tauri, Cargo, CHANGELOG, README, and release notes are aligned on `1.0.3`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.3_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.3_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.3_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.3_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.3_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.3_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.3_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

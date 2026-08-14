# Jupiter desktop-v1.0.8

## 中文

Jupiter 1.0.8 于 2026-08-14 发布，重点完善 DeepSeek V4 官方能力、可选的 Beta Prefix 自动续写、宠物右键菜单、工具执行恢复，以及会话和凭据安全性。

### 主要更新

- 仅在官方 `api.deepseek.com` 的 `deepseek-v4-flash` 和 `deepseek-v4-pro` 上启用 V4 专属能力。
- 按 DeepSeek 官方协议发送顶层 `thinking` 字段，Azure 与自定义兼容端点继续沿用原有请求协议。
- CLI、TUI、桌面 Composer 和 QQ/钉钉远程命令统一支持关闭推理，以及 medium、high、max 三档显示。
- 新增可选 DeepSeek Beta Prefix 自动续写；V4 回答因长度上限结束且没有工具调用时，可携带已有 answer/reasoning 发起一次受控续写。
- 自动续写会检查上下文余量、预算、会话绑定和中止状态，禁止自动重试，并合并两次请求的内容与 usage。
- 对继续截断、内容过滤、资源不足和未知 `finish_reason` 显示明确警告。
- Loop 新增统一的会话重绑定和逻辑会话 epoch，后台压缩提交前会检查会话切换与日志 revision。
- 异步会话标题生成会校验 tab、session 和 binding，避免旧任务覆盖新会话或复活旧会话文件。
- 桌面恢复事件只在历史消息确实载入后标记 restoring session。
- 新增宠物原生右键菜单，可打开当前任务、互动、重置位置、打开宠物设置或隐藏宠物。
- 原生菜单不可用时自动回退到支持鼠标和键盘导航的内置右键菜单。
- 宠物浮窗改为不可聚焦，避免浮窗显示时抢走当前应用的键盘焦点。
- 新增 durable tool execution journal，在 intent、execution started 和 result 阶段落盘；重启后会区分尚未执行与结果未知，避免自动重复有副作用的工具调用。
- 新增 `deepseek-native` 联网搜索引擎，解析 DeepSeek 原生 `web_search` 引用与结果，并把辅助调用的 token/成本计入会话。
- 官方 DeepSeek 主端点可复用主 API key；自定义端点需要独立 `DEEPSEEK_SEARCH_API_KEY`，桌面设置页显示凭据状态。
- shell、后台任务、Hook 和 MCP 子进程默认移除凭据类环境变量，诊断 JSONL 在持久化前脱敏结构化 secret。
- Provider 请求拒绝跨域重定向；官方 DeepSeek SSE 校验终止标记并保留同一 chunk 内的多个工具调用 delta。
- 设置保存新增 requestId/revision 保护，避免较旧的异步设置回包覆盖新状态。
- 用量统计区分完整/不完整 usage，并分别记录账单累计 token 与最后一次请求的上下文 token。
- 移除不再使用的第三方定时健康检查工作流。
- 桌面端、根包、Tauri、Cargo、CHANGELOG、README 和 release notes 版本统一为 `1.0.8`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.8_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.8_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.8_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.8_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.8_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.8_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.8_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

本次 GitHub Release 的 Apple 签名 Secret 尚未配置完整，因此 macOS 会回退为未签名 DMG。如果安装后提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.8 was released on 2026-08-14 with official DeepSeek V4 capability handling, optional Beta Prefix auto-continuation, a pet context menu, durable tool recovery, and stronger session and credential safety.

### Highlights

- Enables V4-specific behavior only for `deepseek-v4-flash` and `deepseek-v4-pro` on the official `api.deepseek.com` endpoint.
- Sends the documented top-level DeepSeek `thinking` field while preserving existing request behavior for Azure and custom compatible endpoints.
- Adds consistent reasoning off, medium, high, and max display choices across CLI, TUI, desktop Composer, and QQ/DingTalk remote commands.
- Adds optional DeepSeek Beta Prefix auto-continuation when a V4 response reaches its output limit without tool calls.
- Auto-continuation checks remaining context, budget, session binding, and abort state, disables automatic retries, and merges content and usage across both requests.
- Shows explicit warnings for continued truncation, content filtering, resource exhaustion, and unknown `finish_reason` values.
- Adds a unified loop session-rebinding path and logical-session epoch; background compaction checks session changes and log revision before committing.
- Guards asynchronous session-title generation with tab, session, and binding checks so stale work cannot overwrite or resurrect old sessions.
- Marks a desktop session as restoring only when its history was actually loaded.
- Adds a native pet context menu for opening the current task, interacting, resetting position, opening pet settings, or hiding the pet.
- Falls back to a mouse- and keyboard-navigable in-app context menu when the native menu is unavailable.
- Makes the pet overlay non-focusable so showing it does not steal keyboard focus from the current app.
- Adds a durable tool execution journal across intent, execution-started, and result stages; restart recovery distinguishes never-started from unknown outcomes to prevent automatic repetition of side effects.
- Adds a `deepseek-native` web-search engine that parses native `web_search` citations/results and accounts for auxiliary token usage and cost.
- Reuses the main key only for official DeepSeek endpoints; custom endpoints require `DEEPSEEK_SEARCH_API_KEY`, with credential state visible in desktop settings.
- Sanitizes credential-like environment variables for shell, background, hook, and MCP children, and redacts structured secrets before diagnostic JSONL persistence.
- Rejects provider redirects; validates official DeepSeek SSE termination and preserves multiple tool-call deltas from a single chunk.
- Adds settings requestId/revision guards so stale asynchronous settings responses cannot overwrite newer state.
- Tracks complete/incomplete usage and separates aggregate billable tokens from the final request's context tokens.
- Removes the unused third-party scheduled health-check workflow.
- Aligns desktop, root package, Tauri, Cargo, CHANGELOG, README, and release notes on `1.0.8`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.8_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.8_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.8_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.8_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.8_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.8_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.8_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

The Apple signing secrets for this GitHub Release are not yet complete, so macOS falls back to an unsigned DMG. If macOS reports that Jupiter cannot be opened or is damaged, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

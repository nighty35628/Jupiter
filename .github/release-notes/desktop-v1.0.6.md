# Jupiter desktop-v1.0.6

## 中文

Jupiter 1.0.6 于 2026-07-14 发布，重点提升桌面端 RPC 发送可靠性、回合并发控制、AI 可见上下文透明度，以及 MCP 工具列表和上游错误处理稳定性。

### 主要更新

- Tauri `rpc_send` 返回结构化失败阶段，区分核心未启动、写入失败和 flush 失败。
- 桌面端串行发送 RPC；核心不可用时会显示顶部告警并暂停继续发送。
- 只在确认命令未送达时回滚乐观用户消息；送达状态未知时保留忙碌状态，避免重复发送。
- 审批、路径授权、选择、计划、checkpoint 和 revision 响应在发送中会锁定，防止重复点击。
- 后端新增单标签回合 lease，避免普通回合、轻量 `/ask`、`/btw` 和远程通道回合在同一标签重叠运行。
- 切换会话、切换工作区或关闭标签时会失效旧回合，减少陈旧事件污染当前界面。
- 右侧上下文面板新增“AI 可见内容”摘要，展示对话、系统规则类别、工具、文件、记忆和工作区状态。
- 设置页新增“AI 可见内容”显示/隐藏开关；Ask 模式按钮、提示和可访问性文案同步优化。
- DeepSeek 和自定义上游 HTTP 错误会提取有限长度的安全详情，并脱敏 Authorization、API key、JWT、cookie、password 等敏感内容。
- 新增 403 和非 DeepSeek 上游 HTTP 错误提示，loop error detail 也会使用脱敏文本。
- MCP `tools/list` 支持 cursor 分页，并检查页数上限、工具数上限、重复工具名和重复 cursor。
- 工具 schema canonicalize 后再进入工具列表和不可变前缀，降低工具顺序变化导致的 prefix cache 抖动。
- MCP inspect、bridge 和 reconnect 均改用完整工具列表。
- 补充桌面流、RPC 发送、上下文面板、设置、MCP 分页、工具契约和 Provider 错误脱敏测试。
- 桌面端、根包、Tauri、Cargo、CHANGELOG、README 和 release notes 版本统一为 `1.0.6`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.6_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.6_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.6_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.6_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.6_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.6_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.6_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.6 was released on 2026-07-14 with a focus on desktop RPC send reliability, per-tab turn admission, AI-visible context transparency, MCP tool-list stability, and safer upstream error handling.

### Highlights

- Tauri `rpc_send` now returns structured failure stages for core-not-started, write-failed, and flush-failed cases.
- Desktop RPC writes are serialized; when the core is unavailable, the app shows a top banner and pauses further sends.
- Optimistic user messages roll back only when a command definitely was not sent; unknown-delivery failures keep the busy state to avoid duplicate sends.
- Confirmation, path access, choice, plan, checkpoint, and revision responses lock while being sent to prevent duplicate clicks.
- The backend now uses a per-tab turn lease so normal turns, lightweight `/ask`, `/btw`, and remote-channel turns cannot overlap in the same tab.
- Session switches, workspace switches, and tab closes invalidate old turns to reduce stale event leakage into the current UI.
- The right context panel now includes an "AI visible content" summary for conversation, system-rule category, tools, files, memory, and workspace state.
- Settings adds a show/hide toggle for "AI visible content"; Ask mode labels, status text, and accessibility copy were also improved.
- DeepSeek and custom-upstream HTTP errors now extract bounded safe details and redact Authorization headers, API keys, JWTs, cookies, passwords, and similar secrets.
- User-facing errors now cover 403 and non-DeepSeek upstream HTTP responses, and loop error details use sanitized text.
- MCP `tools/list` now supports cursor pagination with page-limit, tool-count, duplicate-name, and repeated-cursor guards.
- Tool schemas are canonicalized before entering the tool list and immutable prefix, reducing prefix-cache churn from tool ordering changes.
- MCP inspect, bridge, and reconnect now use the complete tool list.
- Added tests for desktop streaming, RPC sends, the context panel, settings, MCP pagination, tool-contract canonicalization, and provider-error redaction.
- Desktop, root package, Tauri, Cargo, CHANGELOG, README, and release notes are aligned on `1.0.6`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.6_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.6_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.6_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.6_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.6_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.6_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.6_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

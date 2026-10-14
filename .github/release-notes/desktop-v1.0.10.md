# Jupiter desktop-v1.0.10

## 中文

Jupiter 1.0.10 于 2026-10-14 发布，新增桌面 Computer Use、下一条消息预测与安装包内的官方帮助，并修复工具进度和会话可靠性问题。

### 更新内容

- Desktop Computer Use Beta 可通过 Cua Driver 观察桌面、点击、移动、滚动和输入。控制租约、观测校验、审批暂停与取消收尾保护并发操作；结果未知的输入不会自动重放。
- 对话结束后可预测下一条消息。Tab 或接受按钮填入草稿，Esc 忽略；接受不会自动发送。辅助请求独立记录用量，输入或切换会话使过期建议失效，只读 Web 客户端不发起预测。
- `jupiter_help` 读取随安装包附带的版本化官方手册，覆盖模式、会话、文件、资料库、浏览器、技能、MCP 和 Computer Use，并结合当前能力状态回答帮助问题。
- 工具调用使用稳定标识，显示参数生成进度和完成、失败、取消状态；修复中止后悬挂卡片、过期会话事件及重复结果，改善 MCP 断开与进程收尾。
- 改善上下文压缩、token 计数、取消响应与供应商设置异步状态；增强 API、代理和错误诊断脱敏。
- 文本模型可继续有历史图片的会话，明确省略旧图。连续桌面操作的请求只保留最近三张截图，持久历史仍保存附件。
- 桌宠透明区域支持鼠标穿透，拖动和右键按实际图像命中；点击宠物互动，状态气泡展开任务列表。

### 安装与限制

Windows x64/ARM64 提供 EXE，macOS Intel/Apple Silicon 提供 DMG，Linux x64/ARM64 提供 DEB，Arch Linux x64 提供 pacman 包。

Computer Use 为 Beta，默认关闭且仅限 Desktop Agent。需要图片模型、单独安装的 Cua Driver 及操作系统授权；驱动不会随安装包自动安装。`standard` 与 `bounded` 当前使用相同保护，不代表额外隔离。输入结果未知时需按诊断人工恢复。

消息预测默认开启，可在设置中关闭，会产生辅助 API 请求及相应费用。图片对话与 Web 继续为 Beta。macOS 仅在完整 Apple 签名和公证凭据可用时生成签名包。

## English

Jupiter 1.0.10 was released on 2026-10-14 with Desktop Computer Use, next-message prediction and packaged official help, plus tool-progress and session reliability fixes.

### Changes

- Desktop Computer Use Beta observes, clicks, moves, scrolls and types through Cua Driver. Control leases, observation checks, approval pauses and cancellation cleanup protect concurrent operations; uncertain input is not replayed automatically.
- Completed conversations can predict the next message. Tab or the accept button fills the draft; Esc dismisses it. Acceptance never sends automatically. Auxiliary usage is recorded separately, typing or switching sessions invalidates stale suggestions, and read-only Web clients cannot request predictions.
- `jupiter_help` reads the versioned official manual shipped with the app, covering modes, sessions, files, libraries, browser, skills, MCP and Computer Use with runtime capability facts.
- Stable tool identities support argument-generation progress and completed, failed and cancelled states. Fixes hanging cards after abort, stale-session events and duplicate results; improves MCP disconnection and process cleanup.
- Improves compaction, token counting, cancellation and asynchronous provider settings; strengthens credential redaction in API, proxy and error diagnostics.
- Text models can continue sessions containing historical images by explicitly omitting old pixels. Continuous desktop requests retain only the latest three screenshots; durable history keeps attachments.
- Transparent pet areas pass mouse input through, and dragging/context menus use image hit testing. Clicking the pet interacts with it; its status bubble opens the task list.

### Installation and Limits

EXE installers are available for Windows x64/ARM64, DMGs for Intel/Apple Silicon macOS, DEBs for Linux x64/ARM64, and a pacman package for Arch Linux x64.

Computer Use is Beta, disabled by default and limited to Desktop Agent. It requires an image-capable model, a separately installed Cua Driver and OS permissions; the installer does not install the driver automatically. `standard` and `bounded` currently use the same guards, not additional isolation. Uncertain input requires manual recovery following the diagnostic.

Message prediction is enabled by default, can be disabled in settings and makes auxiliary API requests with associated costs. Image conversations and Web remain Beta. macOS builds are signed and notarized only when all required Apple credentials are available.

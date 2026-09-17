# Jupiter desktop-v1.0.9

## 中文

Jupiter 1.0.9 于 2026-09-18 发布。本次新增图片对话 Beta、第三方 API 配置，以及复用 Desktop 界面的 Web Beta。

### 更新内容

- 图片对话支持粘贴、选择、拖放、缩略图与原图预览、纯图片提问、排队、编辑重发和失败恢复。默认官方视觉模型为 `deepseek-flash`；第三方模型需明确开启图片输入。
- 图片经过有界 WASM 解码、方向校正和压缩后持久保存。会话保存内容哈希引用，官方 Files 上传可复用，第三方使用内联图片；压缩上下文与存储清理保护原图、会话、归档、备份及草稿引用。
- 模型设置可配置、测试并保存供应商地址、API key、协议与模型 ID；CLI 提供 `jupiter setup --provider-*` 参数。通用 OpenAI 兼容端点不会收到 DeepSeek 专用扩展字段。
- 会话绑定供应商端点与协议，避免切换服务后静默转发历史。第三方未知价格不套用官方费率，可能已计费的失败请求不自动重放；远程 Web 不可读取或修改供应商凭据。
- `jupiter web [目录]` 复用 Desktop React 界面与 agent 运行时，支持工作区、文件上传下载与预览、终端、Git、通知、设备管理及移动端抽屉。
- Web 提供本机、局域网和公网访问模式，加入一次性配对、设备撤销、来源校验、事件重放、写入租约与跨进程会话锁。公网要求带身份验证的 HTTPS 反向代理，并限制终端、Git/MCP 写入、密钥写入及 full-control 模式。
- 改善输入框尺寸、计划进度、推理卡片安全性与长对话渲染；上游归属声明移至 `THIRD_PARTY_NOTICES.md`。
- 补齐 ARM 发布流程的共享桌面依赖，版本声明同步为 `1.0.9`。

### 安装包与限制

Windows x64/ARM64 提供 EXE；macOS Intel/Apple Silicon 提供 DMG；Linux x64/ARM64 提供 DEB，Arch Linux x64 提供 pacman 包。

图片对话与 Web 为 Beta。支持 PNG/JPEG/WebP/GIF，每条最多 12 张、单张原始文件最多 20 MiB，动图只使用首帧。官方 Pro 不支持直接附图，也不会自动转发到辅助模型。Markdown 导出不包含图片本体。桌宠、自动更新、全局快捷键和原生 WebView 仅限 Desktop。

macOS 只有在完整 Apple 签名与公证凭据可用时生成签名包；否则构建未签名 DMG。完整访问限制见 [Web Beta 指南](https://github.com/nighty35628/Jupiter/blob/desktop-v1.0.9/docs/web-beta.md)。

## English

Jupiter 1.0.9 was released on 2026-09-18 with Image Conversations Beta, third-party API configuration, and a Desktop-aligned Web Beta.

### Changes

- Image conversations support paste, picking, dropping, thumbnails, full previews, image-only questions, queues, editing and recovery. The default official visual model is `deepseek-flash`; third-party models require explicit image-input opt-in.
- Bounded WASM decoding normalizes and compresses images before durable storage. History retains content-addressed references; official Files uploads are reused, while third parties use inline images. Compaction and cleanup protect images referenced by sessions, archives, backups and drafts.
- Models settings can test and save provider URLs, API keys, protocols and model IDs; CLI provides `jupiter setup --provider-*` options. Generic OpenAI-compatible endpoints do not receive DeepSeek-only extensions.
- Sessions bind to their provider endpoint and protocol to prevent silent history forwarding. Unknown third-party prices do not inherit official rates, ambiguous billable failures are not replayed automatically, and remote Web cannot read or edit provider credentials.
- `jupiter web [dir]` reuses the Desktop React UI and agent runtime, with workspaces, file upload/download and previews, terminals, Git, notifications, device management and mobile drawers.
- Local, LAN and public access modes add one-time pairing, device revocation, origin validation, event replay, writer leases and cross-process session locks. Public mode requires an authenticated HTTPS reverse proxy and restricts terminals, Git/MCP writes, secret writes and full-control mode.
- Improves composer sizing, plan progress, reasoning-card security and long-transcript rendering. Upstream attribution moves to `THIRD_PARTY_NOTICES.md`.
- Installs shared Desktop dependencies in ARM release builds and aligns version declarations on `1.0.9`.

### Installers and Limits

EXE installers are available for Windows x64/ARM64; DMGs for Intel/Apple Silicon macOS; DEBs for Linux x64/ARM64; and a pacman package for Arch Linux x64.

Image conversations and Web remain Beta. Supported formats are PNG/JPEG/WebP/GIF, with up to 12 images per message and 20 MiB per input image; animations use the first frame. Official Pro does not accept images or silently route them to a helper model. Markdown exports do not embed image bytes. Pets, auto-update, global shortcuts and native WebViews remain Desktop-only.

macOS builds are signed and notarized only when all required Apple credentials are available; otherwise the workflow produces unsigned DMGs. See the [Web Beta guide](https://github.com/nighty35628/Jupiter/blob/desktop-v1.0.9/docs/web-beta.md) for access restrictions.

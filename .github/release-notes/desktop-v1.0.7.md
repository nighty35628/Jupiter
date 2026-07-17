# Jupiter desktop-v1.0.7

## 中文

Jupiter 1.0.7 于 2026-07-17 发布，重点新增桌面宠物系统、自定义宠物安全加载、大会话转录预算、会话复制/导出，以及桌面流式输出和原生诊断稳定性。

### 主要更新

- 新增桌面宠物浮窗、宠物设置页和对话状态联动动画。
- 内置 companion cube、Jupiter sprout、origami fox、cloudsmith、lantern jelly、copperwing 和 ink dragon 七个伙伴。
- 宠物支持 idle、waiting、running、review、failure 等状态，支持拖动、点击回到主窗口、减少动态效果和设置页刷新。
- 原生层新增 `~/.jupiter/pets` 目录准备与自定义 v2 宠物包扫描。
- 自定义宠物加载会限制包数量、manifest、spritesheet 和 thumbnail 大小，拒绝 symlink/junction，并校验 ID、WebP 尺寸、缩略图和 asset protocol 路径。
- 会话 snapshot 新增稳定 sessionId、bindingId、requestId 和 session files 信息。
- 大会话载入会对 renderer transcript payload 做预算控制，长 assistant 内容显示折叠占位和尾部预览，长用户消息显示截断状态。
- 完整会话记录仍保存在磁盘，可按回合加载完整内容，减少长历史导致的桌面卡顿。
- 新增会话复制和 Markdown 导出命令，支持跨平台剪贴板。
- Markdown 导出保留用户、assistant、reasoning、工具调用和工具结果结构，reasoning 使用可折叠详情块，工具内容使用 fenced code block。
- 桌面事件新增有序 delta batcher，只合并相邻兼容的 `model.delta`，并保留非 delta 事件作为 FIFO 屏障。
- 新增 turn committed 事件、最近客户端消息记录和轻量 Ask 去重路径，减少重连、切会话或本地恢复后的重复消息与乱序流式输出。
- 原生层新增自动轮转的 JSONL 诊断日志，覆盖 native lifecycle、pet overlay 和事件状态。
- CI 增加桌面依赖安装、桌面前端构建、Node sidecar 打包、宠物模块检查和 Tauri cargo tests。
- 桌面端、根包、Tauri、Cargo、CHANGELOG、README 和 release notes 版本统一为 `1.0.7`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.7_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.7_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.7_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.7_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.7_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.7_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.7_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.7 was released on 2026-07-17 with a focus on desktop pets, safer custom pet loading, large-session transcript budgets, session copy/export, streaming stability, and native desktop diagnostics.

### Highlights

- Added a desktop pet overlay, pet settings page, and chat-state-aware pet animations.
- Added seven built-in companions: companion cube, Jupiter sprout, origami fox, cloudsmith, lantern jelly, copperwing, and ink dragon.
- Pets support idle, waiting, running, review, failure, and related states, plus dragging, click-to-focus-main-window, reduced motion, and settings refresh.
- The native layer now prepares `~/.jupiter/pets` and scans custom v2 pet packages.
- Custom pet loading limits package count, manifest size, spritesheet size, and thumbnail size, rejects symlinks and junctions, and validates IDs, WebP dimensions, thumbnails, and asset-protocol paths.
- Session snapshots now include stable sessionId, bindingId, requestId, and session files.
- Large-session loading now bounds the renderer transcript payload: long assistant content appears as elision placeholders with tail previews, and long user messages are marked as truncated.
- Full session records still remain on disk and can be loaded per turn, reducing desktop stalls from very long histories.
- Added session copy and Markdown export commands with cross-platform clipboard support.
- Markdown export preserves user, assistant, reasoning, tool-call, and tool-result structure; reasoning uses collapsible detail blocks and tool content uses fenced code blocks.
- Desktop events now use an ordered delta batcher that only coalesces adjacent compatible `model.delta` events while preserving non-delta events as FIFO barriers.
- Added turn committed events, recent client-message tracking, and lightweight Ask de-duplication to reduce duplicate messages and out-of-order streams after reconnects, session switches, or local recovery.
- Native desktop now writes rotating JSONL diagnostics for lifecycle, pet overlay, and event state.
- CI now installs desktop dependencies, builds the desktop frontend, bundles the Node sidecar, checks the pet module, and runs Tauri cargo tests.
- Desktop, root package, Tauri, Cargo, CHANGELOG, README, and release notes are aligned on `1.0.7`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.7_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.7_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.7_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.7_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.7_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.7_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.7_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

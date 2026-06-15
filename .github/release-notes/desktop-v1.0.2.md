# Jupiter desktop-v1.0.2

## 中文

Jupiter 1.0.2 继续围绕 DeepSeek 桌面 agent 的日常使用做收敛：Linux 安装包补齐 Arch 产物，桌面端加入轻量 Ask，长会话上下文成本更透明，右侧上下文面板和文件预览也更顺手。

### 主要更新

- Release 工作流新增 Arch Linux x64 `.pkg.tar.zst`，下载列表同步覆盖 Windows、macOS、Debian/Ubuntu、Arch Linux 和 Linux ARM64。
- `install-linux.sh` 会为 Arch/Manjaro/EndeavourOS 优先安装原生 pacman 包；旧 release 没有 pacman 包时，回退到 `.deb` 解包安装。
- 新增 `jupiter-bin` AUR 模板，维护文件位于 `packaging/arch/jupiter-bin`。
- 桌面端新增 `/ask` 和输入框 Ask 模式，适合不需要工具调用的快速问题；问答会写回当前会话，并正常记录用量与自动命名。
- 上下文诊断增加系统、工具、日志、记忆、摘要、缓存命中和高成本工具结果统计，便于判断长会话成本来源。
- 长会话支持成本导向折叠，并在折叠摘要里保留关键原始用户回合，降低上下文费用的同时减少信息丢失。
- 文件预览增加图片、Markdown、PDF、DOCX 等更丰富渲染；右侧上下文标签打开时会自动处理底部栏与侧边栏可见性。
- 暂停确认卡在重连或切换标签后会重新出现；更新检查增加单源超时；原子写入和流式读取补了更稳的重试与空闲超时。
- 桌面端、根包、Tauri、Cargo、CHANGELOG、README 和 release notes 版本统一为 `1.0.2`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.2_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.2_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.2_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.2_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.2_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.2_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.2_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.2 continues tightening the DeepSeek desktop agent for everyday work: Arch Linux release assets are now covered, desktop gets lightweight Ask, long-session context cost is easier to inspect, and the context panel plus file preview flow are smoother.

### Highlights

- The release workflow now builds an Arch Linux x64 `.pkg.tar.zst`; the installer list covers Windows, macOS, Debian/Ubuntu, Arch Linux, and Linux ARM64.
- `install-linux.sh` prefers the native pacman package on Arch/Manjaro/EndeavourOS and falls back to `.deb` payload extraction for older releases without a pacman asset.
- Added the `jupiter-bin` AUR template under `packaging/arch/jupiter-bin`.
- Desktop now supports `/ask` and a composer Ask mode for quick questions that do not need tool calls; exchanges are written back to the active session with usage tracking and normal auto-title behavior.
- Context diagnostics now report system, tool, log, memory, summary, cache, and high-cost tool-result tokens so long-session cost sources are visible.
- Long sessions can use cost-aware folding earlier, while fold summaries preserve important original user turns.
- File preview adds richer image, Markdown, PDF, and DOCX rendering; opening context tabs now manages bottom/sidebar visibility automatically.
- Pending approval cards replay after reconnect or tab activation; update checks have per-source timeouts; atomic writes and streaming reads have stronger retry and idle-timeout handling.
- Desktop, root package, Tauri, Cargo, CHANGELOG, README, and release notes are aligned on `1.0.2`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.2_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.2_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.2_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.2_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.2_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.2_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.2_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

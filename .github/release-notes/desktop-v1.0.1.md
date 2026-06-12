# Jupiter desktop-v1.0.1

## 中文

Jupiter 1.0.1 是 1.0 正式版后的稳定性更新，主要修复桌面端在 Linux/ARM、子智能体展示、Git 提交、输入框和中断流程里的几个实际问题。

### 主要更新

- Linux 桌面端禁用 WebKit 加速合成，ARM64 设备默认使用 llvmpipe，降低 Debian/ARM 等设备因 Mesa zink、Vulkan 或 EGL 初始化失败导致窗口打不开的概率。
- 子智能体运行会直接显示在主对话流中，并可在右侧上下文面板打开详情标签页，查看任务、状态、模型、耗时、摘要、错误与成本信息。
- 从右侧上下文面板打开子智能体时，不再把主对话切换到子会话，当前工作流保持在原会话里。
- 桌面 Git 提交信息可留空，后端会根据变更文件自动生成提交信息。
- 输入框会清理从终端粘贴进来的方向键等控制序列。
- Esc 中断产生的强制摘要不再当作正常助手回复保存。
- 右侧上下文面板、Git 状态输出和子智能体详情修复宽内容横向溢出。
- README 改为长期项目说明；桌面端、根包、Tauri、Cargo、CHANGELOG 和 release notes 版本统一为 `1.0.1`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.1_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.1_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.1_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.1_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.1_linux-x64.deb`
- Linux ARM64: `Jupiter_desktop-v1.0.1_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.1 is a stability update after the 1.0 release. It focuses on real desktop fixes around Linux/ARM startup, subagent visibility, Git commits, composer input, and abort handling.

### Highlights

- Linux desktop builds now disable WebKit accelerated compositing, and ARM64 devices default to llvmpipe to reduce first-window failures caused by broken Mesa zink, Vulkan, or EGL setups.
- Subagent runs now appear directly in the main conversation and can be opened in a context-panel detail tab with task, status, model, elapsed time, summary, error, and cost information.
- Opening a subagent from the context panel no longer switches the main chat into the child session.
- Desktop Git commits can leave the message empty and let the backend generate one from changed files.
- Composer input now strips terminal arrow-key/control escape sequences pasted into the text box.
- Forced summaries produced by Esc aborts are no longer stored as normal assistant replies.
- The context panel, Git command output, and subagent detail views now avoid horizontal overflow on wide content.
- README is now a long-lived project overview; desktop, root package, Tauri, Cargo, CHANGELOG, and release notes are aligned on `1.0.1`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.1_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.1_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.1_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.1_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.1_linux-x64.deb`
- Linux ARM64: `Jupiter_desktop-v1.0.1_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

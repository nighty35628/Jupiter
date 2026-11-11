# Jupiter desktop-v1.0.12

## 中文

- **上下文与压缩恢复：** 统一模型窗口与请求预算，独立保存压缩检查点和原始历史，改善超限恢复、跨轮次状态、共享会话基线及取消保护。
- **定时任务：** 支持单次、间隔、每天及每周任务，独立结果会话、暂停、恢复、手动运行与取消。需要主机 Jupiter 保持运行；公网 Web 仅可查看，不自动批准需要确认的操作。
- **本地语音输入：** Desktop 加入多语言 Whisper 转写、模型下载与校验、麦克风权限处理和录音取消。模型需另行下载，识别效果取决于设备与音频条件。
- **Web 与移动端：** 改善持久化附件、文件选择和导出、空闲连接及会话快照；纳入 Android 本地运行、分享与语音桥接工程。Android 仍为 QA 构建，本次不提供正式 APK。
- **安装包：** Windows x64/ARM64、macOS Intel/Apple Silicon、Linux x64/ARM64 DEB 和 Arch Linux x64。

### macOS 安装

将 Jupiter.app 拖入“应用程序”。如果提示无法打开或文件已损坏，请在终端运行，然后重新打开：

```sh
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
```

## English

- **Context and compaction recovery:** Unifies model windows and request budgets, separates checkpoints from raw history, and improves overflow recovery, cross-turn state, shared-session baselines and cancellation safety.
- **Scheduled tasks:** One-time, interval, daily and weekly tasks with isolated result sessions, pause/resume, manual runs and cancellation. The host Jupiter runtime must remain running. Public Web is read-only; unattended tasks never auto-approve confirmations.
- **Local voice input:** Desktop adds multilingual Whisper transcription, model download/verification, microphone permissions and recording cancellation. Models are downloaded separately; recognition quality depends on hardware and audio conditions.
- **Web and mobile:** Improves durable attachments, file picking/export, idle connections and session snapshots. Includes Android on-device runtime, sharing and native speech source. Android remains a QA build; no public APK is included.
- **Installers:** Windows x64/ARM64, macOS Intel/Apple Silicon, Linux x64/ARM64 DEB and Arch Linux x64.

### macOS Installation

Move Jupiter.app to Applications. If macOS blocks the app or reports it as damaged, run this in Terminal, then reopen it:

```sh
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
```

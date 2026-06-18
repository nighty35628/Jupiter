# Jupiter desktop-v1.0.4

## 中文

Jupiter 1.0.4 主要补强 CLI 自动化、slash 命令维护和诊断安全性：`jupiter run` 可以输出 JSONL 事件流，TUI 与桌面端共享同一份 slash registry，doctor 能看清 endpoint 来源和可选组件状态，shell allowlist 也更严格。

### 主要更新

- `jupiter run` 新增 `--format json` 与 `--json`，输出 `session_start`、assistant delta/final、tool start/result、usage、error 和 done 等 JSONL 事件。
- JSON 事件、工具参数和 transcript 记录统一使用敏感信息脱敏，覆盖 API key、Authorization、cookie、password 等字段。
- CLI/TUI slash 命令抽出共享 registry，桌面端 slash 命令列表由同一份 `SLASH_COMMANDS` 生成。
- `/ask` handler 接入 TUI dispatcher，可在当前交互会话中执行无工具快速问答。
- `doctor` 增加 endpoint source 检查，显示 base URL/API key 来自环境变量还是配置文件，并提示被遮蔽的来源。
- CLI doctor 现在也会检测 Chrome、Edge、Chromium、LibreOffice、FFmpeg、Tesseract OCR 和 Pandoc 等可选组件。
- `stats history` 的 JSON/表格输出补齐更多历史用量字段，方便脚本和外部面板读取。
- shell 解析新增操作符检测和高风险参数降级，避免 `git branch -D`、重定向输出、`find -exec/-delete` 等命令误判为只读。
- 新增 run JSON、doctor JSON、shell、usage、transcript 和 desktop slash registry 测试。
- 桌面端、根包、Tauri、Cargo、CHANGELOG、README 和 release notes 版本统一为 `1.0.4`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.4_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.4_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.4_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.4_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.4_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.4_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.4_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.4 focuses on CLI automation, slash-command maintainability, and safer diagnostics: `jupiter run` can emit JSONL events, TUI and desktop share one slash registry, doctor reports endpoint sources and optional components, and the shell allowlist is stricter.

### Highlights

- `jupiter run` now supports `--format json` and `--json` for JSONL events covering `session_start`, assistant delta/final, tool start/result, usage, error, and done.
- JSON events, tool arguments, and transcript records now share secret redaction for API keys, Authorization headers, cookies, passwords, and related fields.
- CLI/TUI slash commands now live in a shared registry, and the desktop slash command list is generated from the same `SLASH_COMMANDS` source.
- The `/ask` handler is wired into the TUI dispatcher for quick no-tool questions inside the current interactive session.
- `doctor` now reports endpoint source details, showing whether base URL/API key values came from environment variables or config files, including shadowed sources.
- CLI doctor now also detects optional components such as Chrome, Edge, Chromium, LibreOffice, FFmpeg, Tesseract OCR, and Pandoc.
- `stats history` JSON/table output fills in more usage-history fields for scripts and external dashboards.
- Shell parsing now detects operators and demotes risky allowlisted arguments, so `git branch -D`, output redirects, and `find -exec/-delete` are not treated as read-only.
- Added tests for run JSON, doctor JSON, shell parsing, usage history, transcripts, and the desktop slash registry.
- Desktop, root package, Tauri, Cargo, CHANGELOG, README, and release notes are aligned on `1.0.4`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.4_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.4_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.4_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.4_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.4_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.4_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.4_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

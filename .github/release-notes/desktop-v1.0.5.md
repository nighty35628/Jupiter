# Jupiter desktop-v1.0.5

## 中文

Jupiter 1.0.5 于 2026-06-28 重新发布，补齐桌面端会话命名和可选组件检测修复，并保留外部链接打开边界、composer 菜单点击行为和 macOS release workflow 签名回退保护。

### 主要更新

- 新增 `openExternalUrl` 桌面 helper，只允许 `http:` 与 `https:` 链接打开系统浏览器。
- 更新提示中的 Gitee/GitHub 按钮会忽略空字符串、`about:blank`、相对路径和非网页协议。
- 模型与 reasoning effort 菜单阻止点击事件冒泡，切换模型或 effort 时不会误触发外层点击处理。
- 修复切换 composer 模型时可能打开外部浏览器的问题。
- 自动会话命名改为从用户首句本地生成标题，不再为标题额外调用模型。
- 会话标题会保留路径、mention、URL 与命令文本，同时避免空标题和标点标题。
- 浏览器自动化组件检测只检查 Chrome/Edge/Chromium 可执行文件是否存在，不再执行浏览器二进制读取版本。
- FFmpeg 等命令行可选组件仍会读取版本，设置页可继续展示 CLI 组件版本。
- 避免 Windows 默认浏览器 shim 或 GUI 浏览器在可选组件检测时被意外拉起。
- 补充桌面流测试，覆盖模型切换和空 release URL 场景。
- 补充会话标题和可选组件检测测试，覆盖本地标题生成、重名后缀和跳过浏览器版本探测。
- macOS release workflow 只有在 Apple 证书、证书密码、签名身份、Apple ID、app-specific password 和 Team ID 全部存在时才执行签名与 notarization。
- Apple signing secrets 只配置一部分时，macOS 构建会回退到 unsigned DMG，避免 release job 失败。
- 桌面端、根包、Tauri、Cargo、CHANGELOG、README 和 release notes 版本统一为 `1.0.5`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.5_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.5_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.5_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.5_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.5_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.5_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.5_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.5 was republished on 2026-06-28 with additional fixes for desktop session naming and optional component detection, while keeping the external-link guard, composer menu click fix, and macOS signing fallback protection.

### Highlights

- Added a desktop `openExternalUrl` helper that only opens `http:` and `https:` links in the system browser.
- The update prompt's Gitee/GitHub buttons now ignore empty strings, `about:blank`, relative paths, and non-web protocols.
- Model and reasoning-effort menus stop click propagation, so changing the model or effort does not trigger outer click handlers.
- Fixed a case where switching the composer model could open the external browser.
- Automatic session naming now derives titles locally from the user's first sentence instead of making an extra model call.
- Session titles preserve paths, mentions, URLs, and command text while avoiding empty or punctuation-only titles.
- Browser automation component detection now only checks whether Chrome, Edge, or Chromium executables exist instead of running browser binaries for versions.
- Command-line optional components such as FFmpeg still report versions in settings.
- This avoids launching Windows default-browser shims or GUI browsers during optional component detection.
- Added desktop streaming tests for model switching and empty release URL handling.
- Added session-title and optional-component tests for local title generation, collision suffixes, and skipped browser version probes.
- The macOS release workflow now signs and notarizes only when the Apple certificate, certificate password, signing identity, Apple ID, app-specific password, and Team ID are all present.
- Partial Apple signing secret setup now falls back to unsigned DMGs instead of failing the release job.
- Desktop, root package, Tauri, Cargo, CHANGELOG, README, and release notes are aligned on `1.0.5`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.5_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.5_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.5_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.5_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.5_linux-x64.deb`
- Arch Linux x64: `Jupiter_desktop-v1.0.5_linux-x64.pkg.tar.zst`
- Linux ARM64: `Jupiter_desktop-v1.0.5_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

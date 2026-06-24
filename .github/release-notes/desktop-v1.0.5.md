# Jupiter desktop-v1.0.5

## 中文

Jupiter 1.0.5 修正桌面端外部链接打开边界和 composer 菜单点击行为，并让 macOS release workflow 在 Apple 签名材料未配完整时自动回退到 unsigned DMG，避免发布失败。

### 主要更新

- 新增 `openExternalUrl` 桌面 helper，只允许 `http:` 与 `https:` 链接打开系统浏览器。
- 更新提示中的 Gitee/GitHub 按钮会忽略空字符串、`about:blank`、相对路径和非网页协议。
- 模型与 reasoning effort 菜单阻止点击事件冒泡，切换模型或 effort 时不会误触发外层点击处理。
- 修复切换 composer 模型时可能打开外部浏览器的问题。
- 补充桌面流测试，覆盖模型切换和空 release URL 场景。
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

Jupiter 1.0.5 fixes desktop external-link boundaries and composer menu click behavior, and makes the macOS release workflow fall back to unsigned DMGs when Apple signing material is only partially configured.

### Highlights

- Added a desktop `openExternalUrl` helper that only opens `http:` and `https:` links in the system browser.
- The update prompt's Gitee/GitHub buttons now ignore empty strings, `about:blank`, relative paths, and non-web protocols.
- Model and reasoning-effort menus stop click propagation, so changing the model or effort does not trigger outer click handlers.
- Fixed a case where switching the composer model could open the external browser.
- Added desktop streaming tests for model switching and empty release URL handling.
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

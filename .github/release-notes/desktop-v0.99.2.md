# Jupiter desktop-v0.99.2

## 中文

### 主要更新

- 桌面设置页新增浏览器自动化状态检测，优先识别 Chrome、Edge 或 Chromium。
- 未检测到支持浏览器时继续使用 WebView fallback，并提供 Chrome 与 Edge 安装入口。
- Skills 支持配置多个 skill pack source，可通过配置文件、桌面设置或 `JUPITER_SKILL_PACK_SOURCES` 提供。
- Skill pack 搜索、安装和更新会保留来源 ID、来源名称和 trusted 标记，方便区分内置可信来源与第三方来源。
- 顶栏标签会跟随运行中会话的工作区状态更新，切换多会话时状态更一致。
- 侧栏会话操作按钮改为悬浮操作区，避免和忙碌状态、时间等元数据挤在一起。
- 底部面板默认高度调整为 180px，让桌面工作区初始布局更紧凑。
- README 和文档刷新为“缓存优先 AI 工作台”的中英双语定位说明。
- 桌面端、根包、Tauri 配置和 Release notes 版本统一为 `0.99.2`。

### 安装提示

- Release 资产文件名会继续带平台名，方便区分 Windows x64、Windows ARM64、macOS Intel、macOS Apple Silicon、Linux x64 和 Linux ARM64。
- Windows 安装包仍为未签名版本，首次安装可能触发 SmartScreen 提示。
- macOS 如果提示无法打开或 App 已损坏，可在安装到 `/Applications` 后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

### Highlights

- Desktop settings now detect browser automation readiness, preferring Chrome, Edge, or Chromium.
- When no supported browser is detected, Jupiter keeps the WebView fallback and exposes Chrome and Edge install shortcuts.
- Skills can now use multiple configured skill pack sources from config, desktop settings, or `JUPITER_SKILL_PACK_SOURCES`.
- Skill pack search, install, and update flows preserve source ID, source name, and trusted metadata so bundled trusted sources and third-party sources are easier to distinguish.
- Top tabs now follow live workspace state for running sessions, keeping multi-session switching more consistent.
- Sidebar session action buttons now use an overlay area so busy status, timestamps, and buttons do not collide.
- The bottom panel default height is now 180px for a more compact initial desktop layout.
- README and docs were refreshed around the cache-first AI workbench positioning.
- Desktop, root package, Tauri config, and release notes versions are aligned on `0.99.2`.

### Installer Notes

- Release asset names continue to include platform labels for Windows x64, Windows ARM64, macOS Intel, macOS Apple Silicon, Linux x64, and Linux ARM64.
- Windows installers are still unsigned, so SmartScreen may warn on first launch.
- If macOS reports that Jupiter cannot be opened or is damaged after installing, move it to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

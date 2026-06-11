# Jupiter desktop-v1.0.0

## 中文

Jupiter 1.0.0 正式发布。

Jupiter 是一款 DeepSeek 桌面 agent，也是日常开发、检索与发布的工作台。1.0.0 版本把 README、版本号、桌面更新检查、远程消息通道和发布包一起整理到正式版状态。欢迎给项目点 Star，也欢迎分享给正在用 DeepSeek 做开发、研究或自动化工作的朋友。

### 主要更新

- README 改为正式版说明，去掉单独的“本次更新”板块，突出 DeepSeek desktop agent 定位、下载入口、CLI 使用、开发步骤和 Star/分享入口。
- 新增 DingTalk Stream 机器人通道，支持 `/dingtalk connect/status/disconnect` 与 `/ding` 别名；桌面设置页可配置 Client ID/AppKey、Client Secret 和群聊 @ 策略。
- 钉钉消息会进入当前会话，回复优先使用 Markdown 并回退为文本；通道带单进程锁和消息去重。
- 桌面端新增 Gitee/GitHub release 检查。About 页可手动检查，启动提示可打开 Gitee 或 GitHub release、跳过当前版本或关闭自动提示。
- QQ 与钉钉远程命令支持 `/status`、`/session list`、`/session switch`、`/session new`、`/workspace list` 和 `/workspace switch`。
- 清理关于页、反馈链接、文档站、dsnix 元数据和测试期望中的旧项目链接；除许可证 notice 外不再保留旧上游项目产品痕迹。
- 桌面端、根包、Tauri、Cargo、CHANGELOG 和 release notes 版本统一为 `1.0.0`。

### 安装包

- Windows x64: `Jupiter_desktop-v1.0.0_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.0_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.0_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.0_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.0_linux-x64.deb`
- Linux ARM64: `Jupiter_desktop-v1.0.0_linux-arm64.deb`

Windows 安装包目前未签名。首次安装或启动时，Microsoft Defender SmartScreen 可能提示“无法识别的应用”；如果你确认是从本页下载，可以点 **More info** -> **Run anyway**。

macOS 从 DMG 安装后如果提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

Jupiter 1.0.0 is officially released.

Jupiter is a DeepSeek desktop agent and a workbench for daily development, research, and release work. Version 1.0.0 brings the README, version metadata, desktop update checks, remote messaging channels, and release assets into a formal release state. If Jupiter helps your work, please star the project and share it with people using DeepSeek for development, research, or automation.

### Highlights

- README was rewritten as official release documentation, with the per-version update block removed and the DeepSeek desktop agent positioning, downloads, CLI usage, development steps, and Star/share callout made explicit.
- Added the DingTalk Stream bot channel with `/dingtalk connect/status/disconnect` and `/ding`; desktop settings can configure Client ID/AppKey, Client Secret, and group @mention policy.
- DingTalk messages route into the current session. Replies prefer Markdown with text fallback, and the channel includes single-process locking plus duplicate-message suppression.
- Desktop can now check Gitee and GitHub releases. About supports manual checks, while startup prompts can open Gitee or GitHub releases, skip the current version, or disable automatic prompts.
- QQ and DingTalk remote commands now support `/status`, `/session list`, `/session switch`, `/session new`, `/workspace list`, and `/workspace switch`.
- Cleaned old project links from About, feedback URLs, docs, dsnix metadata, and test expectations; old upstream product traces are removed outside the required license notices.
- Desktop, root package, Tauri, Cargo, CHANGELOG, and release notes are aligned on `1.0.0`.

### Installers

- Windows x64: `Jupiter_desktop-v1.0.0_windows-x64.exe`
- Windows ARM64: `Jupiter_desktop-v1.0.0_windows-arm64.exe`
- macOS Intel: `Jupiter_desktop-v1.0.0_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_desktop-v1.0.0_macos-arm64.dmg`
- Linux x64: `Jupiter_desktop-v1.0.0_linux-x64.deb`
- Linux ARM64: `Jupiter_desktop-v1.0.0_linux-arm64.deb`

The current Windows installers are unsigned. Microsoft Defender SmartScreen may show an "unrecognized app" warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from this release page.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move `Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

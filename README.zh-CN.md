# Jupiter

[![Release](https://img.shields.io/github/v/release/nighty35628/Jupiter?display_name=tag&label=release)](https://github.com/nighty35628/Jupiter/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

Jupiter 是一个本地优先的 AI 编程工作台，面向长时间运行的桌面会话。它把终端编码循环、桌面端外壳、MCP、
Skills、记忆、检查点、浏览器预览、Diff、工作区文件和轻量资料库放在同一个项目里。

## 下载

桌面端安装包发布在 GitHub Releases：

- [最新版本](https://github.com/nighty35628/Jupiter/releases/latest)
- [全部版本](https://github.com/nighty35628/Jupiter/releases)

Release 里的安装包文件名会带平台名，方便选择：

- Windows: `Jupiter_<version>_windows-x64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

Windows 提示：当前 Windows 安装包未做代码签名。首次安装或启动时，Microsoft Defender SmartScreen
可能提示“无法识别的应用”；如果你是从上面的官方 GitHub Releases 下载的，可以点 **更多信息** ->
**仍要运行** 继续安装。

macOS 提示：如果从 DMG 安装后提示无法打开或 App 已损坏，先把 `Jupiter.app` 拖进 `/Applications`，
然后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## 当前版本

**Jupiter Desktop 0.89.6**

### 更新摘要

- 会话切换更稳定：正在运行的对话切换回来后会保留流式内容、思考过程和停止按钮状态。
- 侧栏会话状态后端化：置顶、归档、已读/未读和完成状态写入 session meta，跨窗口和重启更一致。
- 侧栏右键菜单补齐置顶、重命名、归档、标记未读、复制会话信息等常用操作。
- 新增轻量资料库：网页搜索结果、本地文件和手动导入可以添加到工作区资料库。
- 资料库新增后端存储：资料源按工作区保存到 `~/.jupiter/library/`，网页正文会抓取、提取并持久化。
- 资料库入口改为独立搜索浮窗，并支持渐进式加载、内置浏览器打开网页、在文件夹中定位本地资料。
- 搜索入口复用设置里的搜索引擎配置，避免 GUI 搜索和设置不一致。
- 内置 Superpowers skill pack，并加入 Jupiter 工具适配说明。
- Release 说明和 README 保持双语更新；旧 README 快照归档在 `history/readme/`。

完整双语更新记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 当前重点

- 桌面端优先的工作台界面。
- 稳定的长会话体验，并能恢复流式输出状态。
- 面向工作区的资料库，保存资料源和网页正文。
- 图形化 MCP 和 Skill 配置。
- 本地优先的开发、测试、记忆和检查点流程。

## 开发

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm --prefix desktop run build
```

桌面 UI 开发：

```bash
npm --prefix desktop run dev -- --host 127.0.0.1
```

## 发布检查

推送桌面端发布 tag 前，必须先新增双语发布说明：`.github/release-notes/desktop-vX.Y.Z.md`。
如果缺少该文件，桌面端发布工作流会失败；所有平台安装包构建完成后，工作流会把这份说明写入 GitHub Release。

## README 历史

旧 README 快照保存在 [history/readme](./history/readme/)。

## License

MIT。必要的源码级 notice 保留在 `src/legal/upstream-notice.ts`。

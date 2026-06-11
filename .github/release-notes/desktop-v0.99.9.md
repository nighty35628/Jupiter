# Jupiter desktop-v0.99.9

## 中文

### 主要更新

- 修复 macOS Finder 文件粘贴：支持从系统剪贴板读取 `public.file-url` 和 `.file/id=...` 文件引用。
- 粘贴图片、粘贴文件、点加号添加文件/图片，都统一显示为输入框上方的附件卡片，不再把路径硬塞进正文。
- 文件附件卡片更紧凑；设置卡片和右侧 resize guide 也做了小幅布局调整。
- CLI 里粘贴工作区内文件路径时，会自动转成相对 `@mention`。
- 首轮会话标题改用低成本 flash 模型生成，桌面默认会话也能自动命名。
- Linux ARM64 构建从 Ubuntu 24.04 改为 Ubuntu 22.04，降低 glibc 基线，改善 Debian ARM 安装兼容性。
- README 改写为更朴素的个人项目说明；桌面端、根包、Tauri 配置、Cargo 和 Release notes 版本统一为 `0.99.9`。

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

- Fixed macOS Finder file paste by reading `public.file-url` and `.file/id=...` references from the system clipboard.
- Pasted images, pasted files, and plus-button file/image picks now share attachment cards above the composer instead of inserting raw paths into the message body.
- File attachment cards are more compact, with small layout cleanup around the settings card and right resize guide.
- CLI pasted workspace file paths can now become relative `@mentions`.
- First-turn session titles now use the low-cost flash model, including desktop default sessions.
- Linux ARM64 builds now use Ubuntu 22.04 instead of Ubuntu 24.04 to lower the glibc baseline for Debian ARM compatibility.
- README was rewritten in a more direct personal-project voice, and desktop, root package, Tauri config, Cargo, and release notes versions are aligned on `0.99.9`.

### Installer Notes

- Release asset names continue to include platform labels for Windows x64, Windows ARM64, macOS Intel, macOS Apple Silicon, Linux x64, and Linux ARM64.
- Windows installers are still unsigned, so SmartScreen may warn on first launch.
- If macOS reports that Jupiter cannot be opened or is damaged after installing, move it to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

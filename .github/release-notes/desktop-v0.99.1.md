# Jupiter desktop-v0.99.1

## 中文

### 主要更新

- 修复桌面发布包中的飞书 SDK 运行时依赖问题：`@larksuiteoapi/node-sdk` 现在会随 CLI bundle 一起内联。
- 安装后的桌面端启动飞书通道时，不再因为飞书 SDK 未随发布包一起打包而失败。
- 修复 desktop CLI chunk 在 Node ESM 环境直接导入时缺少 `__dirname` 的问题，避免打包后的 desktop 入口遇到 CommonJS 全局变量缺失。
- 设置页新增 API key 退出登录入口。
- 退出登录会清除保存的 API key、重置 setup 状态，并同步清理当前进程中的 `DEEPSEEK_API_KEY`。
- 保存新 API key 时会标记 setup 已完成，避免设置状态和 key 状态不一致。
- bundle smoke test 现在检查飞书 SDK 不会被误标为 external，并验证 desktop chunk 可以被 Node ESM 直接导入。
- 桌面端、根包、Tauri 配置和 Release notes 版本统一为 `0.99.1`。

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

- Fixed the Feishu SDK runtime dependency in desktop release packages: `@larksuiteoapi/node-sdk` is now inlined into the CLI bundle.
- Installed desktop builds can now start the Feishu channel without failing on a missing Feishu SDK dependency.
- Fixed desktop CLI chunk imports in Node ESM environments where `__dirname` was missing, avoiding bundled desktop entrypoint failures on unavailable CommonJS globals.
- Added an API-key sign-out path in settings.
- Signing out clears the saved API key, resets setup state, and removes the current process `DEEPSEEK_API_KEY`.
- Saving a new API key now marks setup as completed so settings state and key state stay aligned.
- Bundle smoke tests now verify that the Feishu SDK is not marked external and that the desktop chunk can be imported directly by Node ESM.
- Desktop, root package, Tauri config, and release notes versions are aligned on `0.99.1`.

### Installer Notes

- Release asset names continue to include platform labels for Windows x64, Windows ARM64, macOS Intel, macOS Apple Silicon, Linux x64, and Linux ARM64.
- Windows installers are still unsigned, so SmartScreen may warn on first launch.
- If macOS reports that Jupiter cannot be opened or is damaged after installing, move it to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

# Jupiter desktop-v0.99.0

## 中文

### 主要更新

- 飞书机器人通道进入完整工作流：桌面设置页可以配置 App ID、App Secret 和群聊策略。
- CLI/TUI 新增 `/feishu connect [appId appSecret [mention|all]]`、`/feishu status` 和 `/feishu disconnect`。
- 飞书通道支持保存配置后自动启动，也支持通过 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和 `FEISHU_REQUIRE_MENTION_IN_GROUP` 提供凭据与策略。
- 飞书私聊会直接进入 Jupiter；群聊默认只响应 @ 机器人的消息，也可以切换为接收全部群消息。
- 来自飞书的消息会进入当前会话，助手最终回复会回传到对应飞书聊天。
- 桌面端飞书远程命令支持 `/help`、`/status`、`/session list`、`/session switch`、`/session new`、`/workspace list` 和 `/workspace switch`。
- 飞书回复优先使用 Markdown 卡片，卡片发送失败时自动回退为普通文本。
- 通道增加事件去重和单进程锁，减少重复投递或多个 Jupiter 进程同时消费同一飞书机器人。
- 飞书配置、消息策略、远程命令和 `/feishu` slash handler 增加测试覆盖。
- README 更新为覆盖当前项目能力的中英双语说明，旧 README 快照已归档到 `history/readme/2026-06-09/`。
- 桌面端、根包、Tauri 配置和 Release notes 版本统一为 `0.99.0`。

### 安装提示

- Release 资产文件名会继续带平台名，方便区分 Windows、macOS Intel、macOS Apple Silicon、Linux x64 和 Linux ARM64。
- Windows 安装包仍为未签名版本，首次安装可能触发 SmartScreen 提示。
- macOS 如果提示无法打开或 App 已损坏，可在安装到 `/Applications` 后执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## English

### Highlights

- Feishu bot integration now has a complete workflow: Desktop settings can configure App ID, App Secret, and group policy.
- CLI/TUI now includes `/feishu connect [appId appSecret [mention|all]]`, `/feishu status`, and `/feishu disconnect`.
- Feishu can auto-start from saved configuration and can also read `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_REQUIRE_MENTION_IN_GROUP`.
- Direct Feishu messages route into Jupiter; group chats require an @mention by default and can be switched to accept all group messages.
- Messages from Feishu enter the active session, and the assistant's final reply is sent back to the matching Feishu chat.
- Desktop Feishu remote commands now support `/help`, `/status`, `/session list`, `/session switch`, `/session new`, `/workspace list`, and `/workspace switch`.
- Feishu replies prefer Markdown cards and automatically fall back to plain text if the card payload is rejected.
- The channel now de-duplicates events and uses a single-process lock to reduce duplicate delivery and multiple Jupiter processes consuming the same bot.
- Tests cover Feishu config, message policy, remote commands, and the `/feishu` slash handler.
- README was rewritten as bilingual current-project documentation, and the previous README snapshot was archived under `history/readme/2026-06-09/`.
- Desktop, root package, Tauri config, and release notes versions are aligned on `0.99.0`.

### Installer Notes

- Release asset names continue to include platform labels for Windows, macOS Intel, macOS Apple Silicon, Linux x64, and Linux ARM64.
- Windows installers are still unsigned, so SmartScreen may warn on first launch.
- If macOS reports that Jupiter cannot be opened or is damaged after installing, move it to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

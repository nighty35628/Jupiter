# Jupiter desktop-v1.0.11

## 中文

Jupiter 1.0.11 于 2026-10-27 发布，新增共享会话多标签、长历史分页和独立 DeepSeek Search/Fetch，并改善压缩、取消与提示词预测。

### 更新内容

- 同一会话可在多个标签中独立执行。完成回合按提交顺序汇入共享历史，各标签保留草稿和运行状态；私有回合暂存、提交边界和恢复校验保护中断后的数据。
- Desktop 与 Web 向上滚动分页加载旧轮次，保留绝对回滚目标与历史身份。超大内容提供原会话导出提示，只读客户端可浏览历史但不能修改会话。
- 可分别配置 DeepSeek 直连 Search 与 Fetch，旧搜索和读取默认行为保持兼容；服务调用次数独立统计，未知服务费用不显示为零。
- 官方 DeepSeek 模型统一为 `deepseek-flash` 和 `deepseek-v4-pro`，官方请求自动升级旧 Flash/Vision 及退役 ID；第三方模型 ID 保持原样。
- 上下文超限后的压缩恢复共享重试预算和截止时间，取消或最终替换仍超限时保留原历史。
- 停止操作会中断 Agent 前置命令识别及本轮辅助请求，阻止迟到结果继续执行；未接收的消息恢复到草稿，并清除重复回合占位。
- 本轮提交后的延迟历史刷新不再误清有效的提示词预测；会话切换、压缩、回滚或其他标签更新仍会使过期建议失效。
- 改善 Companion Cube 设置预览和加载失败回退；发布流程自动补全每版说明中的 macOS 安装指令。

### 安装包

Windows x64/ARM64 提供 EXE，macOS Intel/Apple Silicon 提供 DMG，Linux x64/ARM64 提供 DEB，Arch Linux x64 提供 pacman 包。图片对话、Web 与 Computer Use 继续为 Beta；直连 Search/Fetch 需要可用的 DeepSeek 服务凭据。

### macOS 无法打开时

将 Jupiter.app 拖到“应用程序”后，如果未签名版本提示无法打开或文件已损坏，在终端运行以下命令，然后重新打开 Jupiter：

```sh
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
```

## English

Jupiter 1.0.11 was released on 2026-10-27 with shared-session tabs, paged history and independent DeepSeek Search/Fetch, plus compaction, cancellation and prompt-prediction improvements.

### Changes

- Run independent turns in multiple tabs of the same session. Completed turns enter shared history in commit order, while each tab retains its draft and running state. Private staging, commit boundaries and recovery checks protect interrupted work.
- Desktop and Web load earlier turns as you scroll upward, preserving absolute rollback targets and history identities. Oversized content offers original-session export notices; read-only clients can browse history without mutation privileges.
- Configure direct DeepSeek Search and Fetch independently while preserving existing defaults. Service-call counts are recorded separately and unknown service charges are not reported as zero.
- Official DeepSeek choices are `deepseek-flash` and `deepseek-v4-pro`. Official requests normalize legacy Flash/Vision and retired IDs, while third-party model IDs remain unchanged.
- Context-limit compaction recovery shares a retry budget and deadline, preserving original history on cancellation or if the final replacement is still too large.
- Stopping cancels Agent command classification and turn-owned auxiliary requests, preventing late routing. Unaccepted messages return to the draft and duplicate turn placeholders are removed.
- Delayed history snapshots of a newly committed turn no longer clear its valid prompt prediction. Session switching, compaction, rollback and sibling updates still invalidate stale suggestions.
- Improves the Companion Cube settings preview and load-failure fallback. Release publishing automatically includes the macOS installation command in each release.

### Installers

EXE installers are available for Windows x64/ARM64, DMGs for Intel/Apple Silicon macOS, DEBs for Linux x64/ARM64, and a pacman package for Arch Linux x64. Image conversations, Web and Computer Use remain Beta. Direct Search/Fetch requires usable DeepSeek service credentials.

### If macOS Blocks the App

After moving Jupiter.app to Applications, if the unsigned build is blocked or reported as damaged, run this in Terminal, then reopen Jupiter:

```sh
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
```

# 飞书机器人连接指南

Jupiter 可以通过飞书企业自建应用机器人，把桌面端当前活动会话延伸到飞书。第一版飞书通道是轻量实现：接收文本消息、把消息送入当前桌面会话、把最终回复发回同一个飞书聊天，并支持确认、选择、plan checkpoint 这类二次交互。

## 功能范围

- 私聊机器人：普通文本消息会进入当前活动桌面会话。
- 群聊机器人：默认只处理包含 @ 机器人的文本消息。
- 回复：Jupiter 的最终回答会以文本消息发回飞书。
- 交互：当 Jupiter 需要 shell、文件访问、plan 或 choice 确认时，可以在飞书里回复 `1`、`2`、`3` 继续处理。

暂不支持图片、文件、语音、交互卡片、独立飞书会话管理和前端设置页。

## 飞书侧准备

在飞书开放平台创建企业自建应用，并启用机器人能力。需要准备：

- `App ID`
- `App Secret`

还需要在事件订阅里开启 `im.message.receive_v1`（接收消息 v2.0）。如果要在群里使用，确保应用权限和事件范围允许接收群聊中 @ 机器人的消息。

## Jupiter 配置

飞书第一版配置写在 Jupiter 配置文件的 `feishu` 字段里：

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "enabled": true,
    "requireMentionInGroup": true
  }
}
```

也可以用环境变量覆盖凭据：

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export FEISHU_REQUIRE_MENTION_IN_GROUP=1
```

配置好并把 `enabled` 设为 `true` 后，启动桌面端 sidecar 时会自动连接飞书。

## 当前活动标签页

飞书消息会进入桌面端当前活动标签页：

- 你正在看的标签页会接收飞书新消息。
- 该 turn 的最终回复会发回触发它的飞书聊天。
- 如果本地正在运行一个 turn，飞书会提示等待或回复当前确认项。

## 排障

如果收不到消息，优先检查：

- 飞书应用是否已经启用机器人能力。
- 事件订阅是否包含 `im.message.receive_v1`。
- 应用是否已安装到目标企业或群聊。
- `App ID` 和 `App Secret` 是否正确。
- 群聊里是否 @ 了机器人，或把 `requireMentionInGroup` 改为 `false`。

如果能收到飞书消息但没有回复，检查本地桌面端是否仍在运行，以及当前会话是否卡在需要确认的状态。

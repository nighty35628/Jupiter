# Jupiter Web Beta 访问指南

Web Beta 复用 Jupiter Desktop 的 React 界面和同一套 agent 运行时，但把原生窗口能力替换为浏览器语义。桌宠、自动更新、全局快捷键和内嵌原生 WebView 不会出现在 Web；文件通过授权工作区或浏览器上传/下载处理，网页在用户点击后交给外部浏览器打开。

## 浏览器布局

Web 与 Desktop 共用会话、设置和工具界面，但不显示原生窗口圆角、阴影、红绿灯留白或窗口控制按钮。
按可用布局宽度适配：640px 以下为临时抽屉；640–1119px 默认固定左侧栏，右侧工具与信息面板以临时覆盖层打开；1120px 起可同时固定左右面板。
浏览器缩放与应用字号会影响可用宽度，输入区另外按主栏宽度换行。

左栏仍可手动收起、拖动宽度。设置保留快捷卡片与完整设置两层入口，打开设置不会收起左栏；小屏关闭设置会回到原来的抽屉。
临时关闭抽屉不保存为侧栏偏好，窗口变窄只限制实际显示宽度，不覆盖保存的宽度。Web 新版左栏偏好首次默认展开，不沿用旧版可能由自动收起写入的记录；其他面板尺寸继续沿用。

## 本机模式

```bash
jupiter web /path/to/project
```

默认绑定随机端口的 `127.0.0.1`。启动输出中的一次性配对链接只应在当前机器打开。多个标签页可以观察状态，但只有持有写入租约的页面能够发送消息或执行操作。

## 局域网模式

```bash
jupiter web /path/to/project \
  --access lan \
  --port 1420 \
  --origin http://192.168.1.20:1420 \
  --approved-root /path/to/another-project
```

LAN 模式只接受回环或私有网段来源，并使用一次性链接配对设备。默认不开放终端、Git 写入、MCP 管理和密钥写入；确认局域网及设备可信后，可显式添加 `--enable-high-risk`。该开关等同于向已配对控制设备授予主机级能力，不应在访客网络使用。

## 设备与通知

已配对设备可以在 **设置 → 通用 → Web 访问** 中生成另一条一次性配对链接，也可以撤销不再使用的设备。配对链接只使用一次，
不要发到群聊或长期保存。多个设备可以同时查看会话，但只有当前写入设备能够发送消息或执行操作；另一台设备接管前会明确显示控制权状态。

浏览器通知可以在 **设置 → 通用 → 浏览器通知** 中启用。首次启用时需要确认浏览器权限；除 `localhost` 外，浏览器通常只在 HTTPS 页面允许通知。拒绝权限后，需要从浏览器的网站权限中重新开启。

## 公网模式

公网模式不直接监听公网网卡。它要求：

- Jupiter 继续绑定 `127.0.0.1`；
- 外层代理提供 HTTPS 和用户身份验证；
- 代理向上游注入一个至少 32 字符的 `X-Jupiter-Proxy-Secret`，浏览器不能直接得到该值；
- 代理保留外部 `Host`、转发 WebSocket，并关闭 SSE 缓冲。

先创建仅当前用户可读的代理密钥：

```bash
umask 077
openssl rand -hex 32 > ~/.jupiter/web-proxy-secret
```

启动 Jupiter：

```bash
jupiter web /path/to/project \
  --access public \
  --port 1420 \
  --origin https://jupiter.example.com \
  --proxy-secret-file ~/.jupiter/web-proxy-secret \
  --no-open
```

下面是 Caddy 的上游示例。身份验证应由 Caddy Security、Authelia、oauth2-proxy 或同类组件在 `reverse_proxy` 前完成：

```caddyfile
jupiter.example.com {
  # 在这里配置身份验证中间件。
  reverse_proxy 127.0.0.1:1420 {
    header_up Host {host}
    header_up X-Jupiter-Proxy-Secret {$JUPITER_WEB_PROXY_SECRET}
    flush_interval -1
  }
}
```

启动 Caddy 的环境变量值必须与 `~/.jupiter/web-proxy-secret` 相同。不要把密钥写入仓库、URL、浏览器 JavaScript 或公开日志。

公网模式是受限工作台：允许对话、会话管理、只读资料和浏览器上传/下载，但固定禁用终端、Git 写入、MCP 写入、密钥写入和 full-control agent 模式。`--enable-high-risk` 在公网模式会直接报错。

---

# Jupiter Web Beta Access Guide

Web Beta reuses the Jupiter Desktop React UI and agent runtime, replacing native-window behavior with browser semantics. Pets, auto-update, global shortcuts, and the native embedded WebView are omitted. Files use approved workspaces or browser upload/download flows, and links open externally only after a user action.

## Browser layout

The browser shares Desktop components without native window corners, shadows, traffic-light spacing, or window controls. Below 640px the left sidebar is a temporary drawer; at 640–1119px it is docked by default and right-side tools/info open as overlays; from 1120px both sides can be docked. Available width accounts for application font scaling, and the composer adapts to its own column.

Opening settings preserves the sidebar. Drawer dismissal does not overwrite docked preferences, and temporary width limits do not overwrite saved sizes. The versioned Web left-sidebar preference starts expanded because the old value could be written by automatic drawer closes; other saved panel dimensions are retained.

## Local

```bash
jupiter web /path/to/project
```

The default listener is an ephemeral port on `127.0.0.1`. Open the one-time pairing link only on the current machine. Multiple tabs can observe state, but only the page holding the writer lease can mutate it.

Each browser has its own login session: the Codex sidebar and Chrome do not share it. Opening the bare address in an unpaired browser shows a pairing form, not a backend startup error. Paste a fresh full pairing link there, or open that link directly. After pairing, bookmark the bare address; reopening a used link in the same authenticated browser also works. Restarting the Web service requires pairing again.

## LAN

```bash
jupiter web /path/to/project \
  --access lan \
  --port 1420 \
  --origin http://192.168.1.20:1420 \
  --approved-root /path/to/another-project
```

LAN mode accepts only loopback or private-network peers and pairs devices with one-time links. Terminal, Git writes, MCP management, and secret writes remain disabled by default. Add `--enable-high-risk` only when the network and paired devices are trusted; it grants host-level capabilities to the controlling device.

## Devices and notifications

Use **Settings → General → Web access** on a paired device to create another one-time pairing link or revoke a device that is no
longer trusted. Do not post pairing links to group chats or retain them as permanent bookmarks. Several devices may
observe a session, but only the current writer can send messages or run actions; the UI shows the controller state
before another device takes control.

Enable browser notifications under **Settings → General → Browser notifications**. The browser asks for
permission the first time. Outside `localhost`, notifications normally require HTTPS. If permission was denied, enable
it again from the browser's site-permission controls.

## Public

Public mode never listens directly on a public interface. It requires Jupiter on `127.0.0.1`, an authenticated HTTPS reverse proxy, a 32-character-or-longer `X-Jupiter-Proxy-Secret` injected upstream by that proxy, preserved external `Host` headers, WebSocket forwarding, and unbuffered SSE.

```bash
umask 077
openssl rand -hex 32 > ~/.jupiter/web-proxy-secret

jupiter web /path/to/project \
  --access public \
  --port 1420 \
  --origin https://jupiter.example.com \
  --proxy-secret-file ~/.jupiter/web-proxy-secret \
  --no-open
```

Example Caddy upstream, with an identity middleware such as Caddy Security, Authelia, or oauth2-proxy configured before `reverse_proxy`:

```caddyfile
jupiter.example.com {
  # Configure identity authentication here.
  reverse_proxy 127.0.0.1:1420 {
    header_up Host {host}
    header_up X-Jupiter-Proxy-Secret {$JUPITER_WEB_PROXY_SECRET}
    flush_interval -1
  }
}
```

The Caddy environment value must match `~/.jupiter/web-proxy-secret`. Never place it in the repository, a URL, browser JavaScript, or public logs.

Public mode is deliberately restricted. Conversation, session management, read-only sources, and browser uploads/downloads remain available; terminal, Git writes, MCP writes, secret writes, and full-control agent mode are always disabled. Passing `--enable-high-risk` in public mode fails closed.

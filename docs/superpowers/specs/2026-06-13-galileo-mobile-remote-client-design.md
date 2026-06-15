# Galileo Product Spec

Status: Draft
Date: 2026-06-13
Owner: Jupiter

## Decision

Build Galileo as a Jupiter-native mobile client and host-control layer. Do not fork Comote.

The corrected product direction is: Galileo owns the UI. Feishu/Lark is the command/event transport layer. The mobile app should look and behave like a simplified Jupiter, not like Feishu chat cards.

Comote is still useful research, but it solves a different problem. It uses IM as the user interface. Galileo needs a first-class mobile UI with Jupiter concepts: workspace, session, model, reasoning effort, edit mode, active turn, approval, and compact result review. Reusing Comote would pull in a separate daemon, separate state model, and IM-first assumptions that fight this direction.

## Research Update

### Comote

Comote is an MIT project for controlling local Codex Desktop/CLI through IM platforms. Current repository metadata at research time:

- Repository: `GavinYangAI/Comote`
- Created: 2026-05-25
- Latest GitHub release visible in README page: v0.6.1 on 2026-06-08
- Package version at cloned HEAD: 0.6.2
- Primary implementation: JavaScript + Tauri shell
- Size inspected locally: about 36.7k source/test/public lines and 84 `node:test` files
- Shape: local daemon, channel adapters, Codex app-server connector, small settings UI

Good ideas to borrow:

- Normalize each messaging platform behind an adapter.
- Keep the host local-first and avoid public app-server exposure.
- Gate unknown identities before any state is returned.
- Represent approvals with short codes and explicit decisions.
- Compress long-running agent events into mobile-safe milestones.
- Persist routing state so restarts do not lose current session binding.

Wrong parts for Galileo:

- IM is the UI. Galileo needs its own UI.
- Comote owns its own daemon and state. Jupiter already has a long-running desktop sidecar.
- Comote talks to Codex app-server directly. Galileo should control Jupiter's own tab/session runtime.
- Comote's Web UI is configuration-first, not a mobile workbench.
- Comote does not solve standalone mobile app transport; it assumes the user is inside IM.

### Feishu/Lark Transport Reality

Feishu is viable as a server-side command/event transport. It should carry structured Galileo packets, not the product UI.

What Feishu supports well:

- A server-side app can create a `Client` using `appId` and `appSecret`, then send IM messages.
- A local server can use `WSClient` long-connection mode to receive event subscriptions without a public callback URL.
- Long-connection mode avoids public IP/domain setup and intranet tunneling for receiving events.
- Feishu can carry text, file, and compact JSON payloads disguised as messages.
- Feishu can notify the user and provide a fallback command surface.
- Feishu can carry batched stream deltas if Galileo treats them as transport packets rather than visible chat content.

What Feishu does not solve cleanly:

- A standalone Galileo mobile app should not embed Feishu `appSecret`.
- Feishu long connection is a server-side SDK pattern, not a mobile-client socket for arbitrary app state.
- Long-connection event delivery is not broadcast; with multiple clients for one app, only one random client receives a given event.
- The 3-second event-processing expectation means inbound packet handlers must ack quickly and push work into Jupiter's own queue.
- If the mobile UI is not inside Feishu, Feishu does not magically provide a bidirectional app socket between phone and host.

Conclusion: Feishu can be the V1 command transport, but only if Galileo defines its own packet protocol, buffering, encryption, dedupe, and stream reassembly. UI must not depend on Feishu UI primitives.

## Revised Recommendation

Self-write Galileo in Jupiter with a pluggable command transport layer.

V1 should ship:

1. Galileo Host Controller inside the existing Jupiter desktop sidecar.
2. Galileo Mobile UI as a responsive web/PWA first, then optionally native shell.
3. Feishu Command Transport for mobile actions, streaming deltas, approval decisions, settings changes, workspace/session switching, and fallback text commands.
4. Direct local transport for development, diagnostics, and same-network use.
5. Desktop Galileo panel inside Jupiter for pairing, transport status, authorized devices, and mobile permissions.

Do not promise "Feishu-only standalone mobile app" as the default V1 transport. It is possible only with compromises:

- Feishu H5/WebView app: UI is ours, but it runs inside Feishu.
- A custom relay service: mobile talks to relay, relay/host bridge over Feishu or direct sockets.
- Unsafe mobile embedding of app secrets: reject.

The clean architecture keeps Feishu as a packet pipe. The product identity is Galileo.

## Problem

Jupiter is powerful on desktop, but mobile usage is currently not a first-class experience. The user wants a small Jupiter on the phone: same mental model, less density, fewer review details, and quick controls for long-running agent work.

The current Feishu integration is useful but text-command oriented and anchored to the active desktop tab. That is not enough for a visual client. Galileo should let the user see and steer work without thinking in slash commands.

## Product Shape

Galileo is Jupiter's satellite:

- It orbits the desktop host; it does not replace it.
- It shows simplified state, not all internals.
- It controls core runtime settings, not advanced desktop-only panels.
- It can fall back to Feishu, but it is not a Feishu interface.

## Goals

- Provide a Jupiter-like mobile UI for active work: sessions, messages, status, controls, and approvals.
- Let users switch workspace, session, model, reasoning effort, and edit mode graphically.
- Let users start a new session or continue an existing one from mobile.
- Let users approve/deny actions from mobile with concise risk context.
- Keep files, credentials, tools, MCP servers, and execution local to the Jupiter host.
- Support Feishu as the V1 command/event transport without coupling UI to Feishu cards.

## Non-Goals

- No full mobile diff viewer in V1.
- No mobile file tree or editor in V1.
- No Comote fork.
- No public exposure of Jupiter app-server or desktop sidecar.
- No Feishu app secret stored in the mobile client.
- No team/multi-operator collaboration in V1 unless it falls out naturally from pairing.

## Success Metrics

- Pairing: connect phone to host in under 3 minutes after Feishu or direct transport credentials are ready.
- Mobile task start: create a new mobile-started session and see the first running-state update in under 10 seconds p95 on a healthy connection.
- Control reliability: settings changes from mobile are reflected in desktop state in 99% of attempts.
- Safety: every privileged action from mobile is tied to an authorized device/user and an explicit decision.
- Dogfood usage: at least half of long-running Jupiter tasks receive one mobile interaction after launch.

## UX Direction

### Mobile UI

Galileo mobile should share Jupiter's workbench language but reduce density:

- Top host/status strip: host name, online/offline, busy state.
- Workspace switcher: current workspace and recent workspaces.
- Session list: recent sessions with status, summary, and last activity.
- Thread view: compact chat timeline, real streaming replies, current step, and final answer.
- Control drawer: model, reasoning effort, edit mode, budget indicator if enabled.
- Approval card/sheet: command/file action summary, risk label, approve/deny.
- Composer: prompt input, optional attach/screenshot later, send/cancel.

Mobile should hide:

- Full diff blocks.
- Full file tree.
- Dense context panels.
- Deep MCP/skill internals.
- Verbose terminal logs unless explicitly expanded.

### Desktop Galileo Panel

Integrated into Jupiter desktop, not a standalone app.

It manages:

- Pairing QR / pairing code.
- Paired devices/users.
- Feishu transport status.
- Feishu command transport status.
- Direct/LAN diagnostic transport status.
- Mobile permissions: allow settings switch, allow workspace switch, allow `yolo` from mobile, allow approvals from mobile.
- Recent mobile actions and failures.

## Architecture

### 1. Galileo Host Controller

Runs inside `src/cli/commands/desktop.ts` sidecar runtime, then can be split into separate modules.

Responsibilities:

- Maintain mobile-visible snapshot.
- Apply validated mobile actions.
- Emit mobile-safe events.
- Map mobile session/workspace choices to Jupiter tabs.
- Gate actions when a tab is busy.
- Own authorization and device bindings.

Core types:

```ts
type GalileoSnapshot = {
  host: { id: string; name: string; online: boolean };
  activeWorkspace: string;
  recentWorkspaces: string[];
  activeSession?: { id: string; title: string; busy: boolean; summary?: string };
  sessions: Array<{ id: string; title: string; workspace: string; mtime: string; busy?: boolean }>;
  settings: {
    model: string;
    reasoningEffort: "low" | "medium" | "high" | "max";
    editMode: "review" | "auto" | "yolo" | "plan";
  };
  pendingApprovals: Array<{ id: string; kind: "command" | "file" | "network"; summary: string; risk: "low" | "medium" | "high" }>;
};

type GalileoAction =
  | { type: "send_message"; text: string; sessionId?: string }
  | { type: "new_session"; workspace?: string; title?: string; initialText?: string }
  | { type: "switch_session"; sessionId: string }
  | { type: "switch_workspace"; path: string }
  | { type: "set_model"; model: string }
  | { type: "set_reasoning"; effort: GalileoSnapshot["settings"]["reasoningEffort"] }
  | { type: "set_edit_mode"; mode: GalileoSnapshot["settings"]["editMode"] }
  | { type: "resolve_approval"; approvalId: string; decision: "approve" | "deny" }
  | { type: "cancel_turn"; sessionId?: string };
```

### 2. Galileo Transport Interface

UI and host communicate through a stable interface. Feishu is one adapter, not the UI model.

```ts
interface GalileoTransport {
  id: string;
  capabilities: {
    realtime: boolean;
    binary: boolean;
    push: boolean;
    requiresRelay: boolean;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
  sendToHost(packet: GalileoPacket): Promise<void>;
  sendToClient(packet: GalileoPacket): Promise<void>;
  onPacket(handler: (packet: GalileoPacket) => void): void;
}
```

Transport modes:

- `feishu-command`: Feishu bot/app carries encrypted action/event packets as message payloads. This is the intended V1 remote transport.
- `direct-local`: WebSocket to Jupiter host on LAN/VPN with QR-paired token. Best for development, diagnostics, and same-network use.
- `relay`: future Jupiter relay service for full remote mobile UI away from LAN. Feishu can still be used for identity and notifications.

### 3. Galileo Mobile Client

Recommended V1 implementation: responsive React/PWA using Jupiter design tokens and a narrow component subset. Later wrap with Capacitor or React Native if native push/background behavior is needed.

Rationale:

- Fastest way to reuse Jupiter UI thinking.
- Can run in mobile browser, in a native WebView wrapper, or inside Feishu H5 if that becomes useful.
- Keeps one UI codebase while transport decisions mature.

### 4. Feishu Command Transport Adapter

Feishu is a command/event middle layer:

- Jupiter host uses `@larksuiteoapi/node-sdk` `WSClient` to receive Feishu events.
- Host sends event packets through `client.im.message.create`.
- Packets are encrypted, signed, sequenced, and deduped at Galileo level before being placed into Feishu message content.
- Streaming replies are sent as batched `assistant_delta` packets, not one packet per token.
- Approval requests are sent as `approval_requested` packets; Galileo mobile renders the approval card/sheet and sends `approval_decision`.
- Model/workspace/reasoning/edit-mode changes are `settings_patch`, `workspace_switch`, and `session_switch` packets.
- Feishu message text/card appearance is treated as transport envelope, not product UI.
- If the user opens Feishu directly, it can show a plain fallback summary and deep link into Galileo.

Feishu transport should not:

- Render the main Galileo UI.
- Store product state as card templates.
- Be required for same-LAN/direct mode.
- Require secrets inside the mobile app.

### 5. Galileo Packet Protocol

Feishu packets are not slash commands. Slash commands are only a human fallback. The normal path is structured packet exchange.

```ts
type GalileoPacket =
  | { kind: "hello"; deviceId: string; protocol: number }
  | { kind: "snapshot_request"; requestId: string }
  | { kind: "snapshot"; requestId: string; snapshot: GalileoSnapshot }
  | { kind: "action"; requestId: string; action: GalileoAction }
  | { kind: "ack"; requestId: string; status: "accepted" | "rejected"; reason?: string }
  | { kind: "assistant_delta"; sessionId: string; itemId: string; seq: number; text: string }
  | { kind: "turn_event"; sessionId: string; event: GalileoEvent }
  | { kind: "approval_requested"; approval: GalileoSnapshot["pendingApprovals"][number] }
  | { kind: "approval_decision"; approvalId: string; decision: "approve" | "deny" }
  | { kind: "error"; requestId?: string; code: string; message: string };
```

Transport rules:

- Every packet has `deviceId`, `hostId`, `packetId`, `seq`, `sentAt`, and signature metadata in the envelope.
- Deltas are batched by time or size, for example every 250-500 ms or every few KB.
- Receiver applies deltas by `(sessionId, itemId, seq)` and ignores duplicates.
- Host sends periodic snapshot corrections so mobile can recover from missed packets.
- Feishu fallback text commands map into the same `GalileoAction` path.

## Data Flow

### Direct Mode

1. User scans pairing QR in Jupiter desktop.
2. Mobile Galileo gets a short-lived pairing token.
3. Mobile opens a WebSocket to the host over LAN/VPN.
4. Host sends `GalileoSnapshot`.
5. Mobile sends `GalileoAction`.
6. Host applies action and streams `GalileoEvent` updates.

### Feishu Command Mode

1. Host starts Feishu long connection with app credentials.
2. Galileo mobile UI sends a structured packet through the configured Feishu command path.
3. Host receives the packet via Feishu event, verifies identity/signature/sequence, and immediately acks.
4. Host applies the action in the Jupiter sidecar.
5. Host sends `assistant_delta`, `turn_event`, `approval_requested`, and `snapshot` packets back through Feishu.
6. Mobile reassembles packets into the Jupiter-like UI.

This is enough for practical streaming replies if deltas are batched. It should not try to mirror every desktop event or token; it should stream the user-visible assistant answer and compact process state.

## Security Model

- Pairing is explicit and initiated from desktop.
- Each device has an id, display name, transport, created time, last seen time, and permissions.
- Unknown Feishu identities and unknown direct clients receive no state.
- Mobile actions are allowlisted.
- `yolo` from mobile is disabled by default and requires a desktop toggle.
- Approval decisions require fresh device auth; stale packets are rejected with nonce/timestamp checks.
- Feishu packets are encrypted/signature-checked by Galileo, not trusted just because they came from Feishu.
- Direct mode binds to local interface by default; non-loopback access requires pairing token and visible desktop consent.

## Build vs Fork

### Option A: Fork Comote

Reject.

It gets a working IM daemon, but the center of gravity is wrong. The rewrite required to make it a Jupiter-like UI and Jupiter-native sidecar would discard most of the fork advantage.

### Option B: Self-write Galileo inside Jupiter, borrow Comote patterns

Choose this.

This preserves Jupiter's state/runtime model, gives full control over UI, and lets transports be pluggable. Comote remains a useful reference for Feishu/IM edge cases.

### Option C: Build Galileo as a separate standalone app that controls Jupiter externally

Reject for V1.

It creates a second product surface and another daemon boundary before the host protocol is stable. A separate native wrapper can come later after the internal controller and transport protocol settle.

## Rollout Plan

Phase 0: Host control plane

- Introduce `GalileoSnapshot`, `GalileoAction`, `GalileoEvent`, and `GalileoTransport`.
- Refactor current Feishu slash remote handling to call the controller.
- Add tests for settings switching, workspace/session switching, busy gates, and approval decisions.

Phase 1: Desktop panel and direct mobile PWA

- Add Galileo desktop panel for pairing and permissions.
- Implement responsive Jupiter-like mobile UI.
- Include real streaming reply UI, approval cards/sheets, workspace switcher, session switcher, model selector, reasoning selector, and edit-mode selector.
- Use direct WebSocket transport in development to validate UI and controller quickly.

Phase 2: Feishu command transport adapter

- Add encrypted packet envelope over Feishu messages/events.
- Use Feishu for action packets, batched assistant deltas, approval requests/decisions, settings changes, notifications, wakeups, and fallback commands.
- Add deep links from Feishu notifications into Galileo UI.
- Keep Feishu UI minimal and non-product.

Phase 3: Remote transport decision

- Evaluate whether direct LAN/VPN plus Feishu notification is enough.
- If not, design a Jupiter relay service or Feishu H5 deployment path.
- Keep the mobile UI unchanged; swap/add transport.

## User Stories

1. Given my desktop Jupiter is running, when I open Galileo on my phone, then I see the active workspace, sessions, current model, reasoning effort, edit mode, and busy state.
2. Given I am on mobile, when I switch reasoning effort from medium to high, then Jupiter desktop reflects the setting and the next turn uses it.
3. Given a task is running, when it reaches an approval, then Galileo shows a concise approval sheet and lets me approve or deny.
4. Given I receive a Feishu notification that a task needs attention, when I tap it, then it opens Galileo rather than asking me to operate inside Feishu.
5. Given direct transport is unavailable, when Galileo uses Feishu command transport, then Jupiter still streams batched replies and handles approvals/settings changes through the same UI.

## Open Questions

- Should the first mobile UI be PWA-only, or PWA wrapped with Capacitor from day one?
- Is LAN/VPN direct mode acceptable for the first internal dogfood, or is remote-away-from-network required immediately?
- What exact mobile-side Feishu command path should V1 use without storing app secrets: Feishu H5 container, a small broker, or another safe credential handoff?
- Should mobile settings changes apply globally or per desktop tab?
- Should Galileo expose multiple desktop tabs or collapse them into one active host/session model in V1?

## Spec Self-Review

- Corrected the prior mistake: Feishu cards are no longer the UI.
- UI and transport are explicitly decoupled.
- Feishu is treated as a command/event transport for Galileo packets, not a UI surface.
- Streaming replies, approval UI, and graphical setting/workspace/model controls are first-class Galileo UI requirements.
- The spec rejects unsafe mobile storage of Feishu app secrets.
- The first implementation path is feasible without solving internet relay immediately.
- Forking Comote remains rejected, now for the more precise reason that it is IM-UI-first.

## Sources

- Comote repository and README: https://github.com/GavinYangAI/Comote
- Comote source inspected locally from `GavinYangAI/Comote` main at commit `7ae5386`.
- Feishu/Lark Node SDK: https://github.com/larksuite/node-sdk
- Feishu message API overview: https://open.feishu.cn/document/server-docs/im-v1/introduction
- Feishu send message API: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create
- Feishu event subscription / long connection docs: https://open.feishu.cn/document/server-docs/event-subscription-guide/overview
- Feishu H5 app integration docs: https://open.feishu.cn/document/uQjL04CN/uAzM3QjLwMzN04CMzcDN
- OpenAI Codex remote connections: https://developers.openai.com/codex/remote-connections

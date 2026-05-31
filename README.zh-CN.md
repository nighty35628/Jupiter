# Jupiter

Jupiter 是一个本地 AI 编程工作台，主要用于个人二次开发。它把终端编码循环、桌面壳、MCP 接线、Skills、Memory、Checkpoints 和 Dashboard 流程放在同一个仓库里。

## 当前重点

- 桌面优先的 workbench UI。
- 图形化 MCP 和 Skills 配置。
- 面向 DeepSeek 长会话的编码体验。
- 本地优先开发和测试。

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

## License

MIT。必要的源码级 notice 保留在 `src/legal/upstream-notice.ts`。

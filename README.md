# Jupiter

Jupiter is a local AI coding workbench for personal development. It keeps the fast terminal loop, desktop shell, MCP wiring, skills, memory, checkpoints, and dashboard flows in one repo.

## Current Focus

- Desktop-first workbench UI.
- Graphical MCP and skills configuration.
- DeepSeek-oriented coding sessions with long-running context.
- Local-first development and testing.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm --prefix desktop run build
```

For desktop UI development:

```bash
npm --prefix desktop run dev -- --host 127.0.0.1
```

## License

MIT. Required source-only notice is kept in `src/legal/upstream-notice.ts`.

# Jupiter

[![Release](https://img.shields.io/github/v/release/nighty35628/Jupiter?display_name=tag&label=release)](https://github.com/nighty35628/Jupiter/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

Jupiter は、長時間動くデスクトップセッション向けのローカルファースト AI コーディングワークベンチです。
ターミナルのコーディングループ、デスクトップシェル、MCP、Skills、Memory、Checkpoints、ブラウザプレビュー、
Diff、ワークスペースファイル、軽量なナレッジライブラリをひとつのリポジトリにまとめています。

## Download

Desktop installers are published on GitHub Releases:

- [Latest Release](https://github.com/nighty35628/Jupiter/releases/latest)
- [All Releases](https://github.com/nighty35628/Jupiter/releases)

Release asset names include the platform:

- Windows: `Jupiter_<version>_windows-x64.exe`
- macOS Intel: `Jupiter_<version>_macos-x64.dmg`
- macOS Apple Silicon: `Jupiter_<version>_macos-arm64.dmg`
- Linux x64: `Jupiter_<version>_linux-x64.deb`
- Linux ARM64: `Jupiter_<version>_linux-arm64.deb`

Windows installers are currently unsigned. Microsoft Defender SmartScreen may show an "unrecognized app"
warning on first launch; choose **More info** -> **Run anyway** if you downloaded Jupiter from the official
GitHub Releases page above.

If macOS reports that Jupiter cannot be opened or is damaged after installing from the DMG, move
`Jupiter.app` to `/Applications` and run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app
open /Applications/Jupiter.app
```

## Current Release

**Jupiter Desktop 0.89.6**

- Session switching is steadier: running conversations keep live content, reasoning, and stop-button state.
- Sidebar session state is backend-backed through session metadata.
- The workspace library can save web search results, local files, and manual imports.
- Web library sources are fetched, extracted, and persisted under `~/.jupiter/library/`.
- The library add flow uses a dedicated search popover and the configured search engine.
- The Superpowers skill pack is bundled with Jupiter-specific tool guidance.
- Previous README snapshots are archived under `history/readme/`.

For the full bilingual changelog, see [CHANGELOG.md](./CHANGELOG.md).

## Focus

- Desktop-first workbench UI.
- Stable long-running sessions with recoverable streaming state.
- Workspace library for saved sources and extracted web content.
- Graphical MCP and skills configuration.
- Local-first development, testing, memory, and checkpoints.

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

## README History

Older README snapshots are kept under [history/readme](./history/readme/).

## License

MIT. Required source-only notice is kept in `src/legal/upstream-notice.ts`.

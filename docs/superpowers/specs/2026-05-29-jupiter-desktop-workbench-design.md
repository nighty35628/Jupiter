# Jupiter Desktop Workbench Design

## Goal

Turn the Jupiter desktop client into a Jupiter-branded, Codex-style workbench with a first-class graphical MCP and Skills configuration experience, while keeping upstream MIT attribution out of the primary product surface and preserved in a minimal source notice.

## Scope

This design is desktop-first. The Tauri desktop client becomes the primary target for the UI redesign and configuration workflow. The browser dashboard remains functional but is not redesigned in this phase, except where shared configuration services or protocol fields need to stay compatible.

The project name shown in the product becomes `Jupiter`. The UI must not claim to be OpenAI Codex or an official Codex client. "Codex-aligned" means the product should borrow the workbench pattern: dense shell, command palette, left navigation, central agent thread, right context/tools panel, restrained visual treatment, and predictable settings flows.

## Product Shape

The desktop app uses a three-column workbench:

- Left rail: workspace selector, session list, global navigation, settings entry, and lightweight status.
- Center: active agent thread, pending approvals, active plan/task cards, and the composer.
- Right panel: context files, active tools, MCP server health, skills, jobs, usage, and session metadata.

The primary screen should feel like a working tool, not a marketing page. It should avoid decorative hero sections, oversized cards, and bright brand gradients. The UI should use compact rows, panels, stable dimensions, predictable icon buttons, and restrained dark/light themes.

## MCP Configuration

The desktop Settings modal gets a stronger MCP page. It should support:

- Listing live servers, installed specs, and bridged state.
- Showing server label, transport, tool count, health/latency, disabled/enabled state, and reconnect status.
- Installing from the existing registry/marketplace flow.
- Removing installed specs.
- Enabling and disabling known servers.
- Reconnecting a server when the current session can hot-reload MCP.
- Manually adding a spec string for advanced users.

The implementation should reuse existing MCP helpers wherever possible:

- `src/mcp/registry-fetch.ts` for registry data.
- existing config `mcp` entries in `~/.jupiter/config.json`.
- existing CLI semantics from `/mcp` for enable, disable, reconnect, install, and uninstall.

Any new server-side helper should expose structured results suitable for both desktop and future dashboard reuse. The UI must surface failures directly instead of silently falling back.

## Skills Configuration

The desktop Settings modal gets a stronger Skills page. It should support:

- Listing builtin, project, global, and custom-root skills.
- Showing name, scope, run mode, description, path, and path status.
- Creating a new project or global skill from a name.
- Adding and removing custom skill paths.
- Setting subagent model overrides for specific skills.
- Viewing skill details without editing the skill body in this first phase.

This phase intentionally avoids a rich markdown editor for skill bodies. Creating and path management are in scope; full skill editing can be a follow-up once the UI shell is stable.

The implementation should reuse:

- `src/skills.ts` and `SkillStore` for discovery and creation.
- `src/config.ts` skill path helpers for normalization and persistence.
- existing `subagentModels` settings shape.

## Branding

All primary product-facing labels should use `Jupiter`.

Remove `Jupiter` branding from:

- desktop title text,
- empty states,
- settings titles where product name appears,
- command palette labels where product name appears,
- setup/welcome copy,
- generated user-visible desktop strings.

Do not rename internal package metadata, npm package names, or protocol identifiers in this phase unless a visible string depends on them. A full package rename is a separate release-engineering task.

## MIT Attribution

The UI, README, and About surfaces should not display upstream author information in this phase. The project must still preserve MIT attribution in source.

Add a minimal source notice file:

`src/legal/upstream-notice.ts`

The file should contain:

- upstream project name,
- upstream repository URL,
- MIT license identifier,
- upstream copyright notice from the MIT license.

The file should not be imported into user-facing UI. It exists so source distributions retain the required attribution. If Jupiter is later packaged or published, the release process must include this notice or an equivalent license file in the distributed artifact.

Do not delete `LICENSE` unless it is replaced by an equivalent license file that still includes the required upstream MIT notice.

## Architecture

Create a small shared configuration service layer rather than duplicating CLI logic inside React components.

Recommended units:

- `src/config/mcp-settings.ts`: read/write MCP specs, add/remove specs, toggle disabled state, and return structured summaries.
- `src/config/skill-settings.ts`: list skill roots and skills, add/remove skill paths, create skills, update subagent model overrides.
- desktop protocol additions: request/response shapes for MCP and Skills settings mutations.
- desktop UI components: focused MCP and Skills settings panels that call the structured protocol.

The desktop React layer should stay presentation-oriented. It should not parse config files directly or reimplement skill path normalization.

## UI Detail

Use a Codex-like workbench shell:

- Compact title bar with `Jupiter`, workspace, command palette entry, and status.
- Left rail with icon plus text navigation, 8px-or-less radius, stable row heights.
- Center thread with clear user/assistant/tool/approval rows and a composer fixed to the bottom.
- Right panel with tabs or segmented controls for Context, Tools, MCP, Skills, Jobs, and Usage.
- Settings modal with a two-column layout: page list on the left, dense configuration form on the right.

Controls should use icons where obvious, toggles for binary state, segmented controls for view modes, inputs for raw spec/path values, and clear destructive buttons for remove actions. Avoid visible instructional copy that explains the whole app; use concise labels, helper text, and tooltips.

## Error Handling

Boundary operations validate and report errors:

- malformed MCP spec,
- duplicate MCP spec,
- registry fetch failure,
- MCP reload failure,
- invalid or duplicate skill path,
- skill creation failure,
- config write failure.

Internal presentation code should not wrap everything in catch blocks. Errors from the service layer should become visible status rows or inline field errors.

## Testing

Add Vitest coverage for the shared service layer:

- add/remove MCP spec preserves unrelated config.
- duplicate MCP add returns a structured no-op.
- enable/disable updates the disabled list consistently.
- add/remove skill path normalizes relative paths against the workspace.
- creating a project/global skill delegates to `SkillStore` and returns path/scope.
- subagent model override persistence preserves existing settings.
- upstream notice file exports or contains the required minimal fields.

Add focused UI tests where existing desktop test infrastructure supports it:

- Settings opens MCP page and renders servers/specs.
- Settings opens Skills page and renders builtin/custom/project skill rows.
- Add/remove controls call the expected handlers with stable values.

Run at least:

- `npm run typecheck`
- targeted Vitest tests for new service/UI modules

For visual verification, run the desktop app or a browser-rendered equivalent and inspect the main shell and Settings modal at desktop viewport size. Check for text overflow, broken columns, and unreadable contrast.

## Non-Goals

- Do not build a full skill markdown editor in this phase.
- Do not redesign the browser dashboard in this phase.
- Do not rename the npm package or all internal `jupiter` identifiers.
- Do not add non-DeepSeek model support.
- Do not remove MIT attribution from source or distributed legal files.
- Do not copy OpenAI or Codex marks, logos, or claims of official affiliation.

## Acceptance Criteria

- The desktop client primary UI presents as `Jupiter`.
- The desktop shell follows the three-column workbench structure.
- The Settings modal includes usable MCP and Skills management pages.
- MCP install/remove/enable/disable/reconnect flows write through shared config helpers.
- Skills list/create/path/subagent-model flows write through shared config helpers.
- Upstream attribution is absent from primary UI and retained in a minimal source notice.
- Existing CLI behavior remains compatible with the config changes.
- Relevant tests and typecheck pass.

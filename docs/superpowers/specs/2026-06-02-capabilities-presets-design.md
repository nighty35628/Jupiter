# Capabilities Presets Design

## Goal

Add a user-facing "Capabilities" experience that makes Jupiter feel like it can simply do more things, without asking users to understand MCP servers, skill paths, plugins, or preset packages. Internally, each capability is a preset that maps to MCP specs and skills. Externally, the UI speaks in tasks: browser automation, front-end validation, documents, spreadsheets, presentations, research, desktop control, and Superpowers workflows.

## User Experience

Settings gets a new `Capabilities` page. The page shows compact capability rows or cards with:

- Name and one-line outcome-oriented description.
- Status: `Enabled`, `Partially enabled`, `Needs setup`, or `Unavailable`.
- A primary action: `Enable`, `Configure`, or `Open details`.
- A details drawer that shows what Jupiter will enable, but only after the user asks for details.

The default view does not mention "preset", "MCP", or "skill path". Those details are available for debugging and advanced users, but they are not the primary vocabulary.

## First Capability Set

The initial set should mirror common Codex desktop/plugin expectations and add Jupiter-specific workflow help:

- `Browser automation`: browser, Chrome, and computer-use skills when available.
- `Front-end validation`: Playwright-oriented workflow, screenshot verification, and browser automation support.
- `Documents`: document editing and render verification skills.
- `Spreadsheets`: spreadsheet creation, analysis, charts, and workbook verification skills.
- `Presentations`: slide deck creation, rendering, and export skills.
- `Research and writing`: academic research, OpenAI docs, docs page/report skills.
- `Creative media`: image generation, speech, poster/card/deck creative skills.
- `Superpowers workflow`: brainstorming, worktrees, TDD, systematic debugging, verification, branch finishing, and planning skills.

Each capability can include zero or more MCP templates. Account-bound tools such as GitHub, Figma, Notion, or remote browser services should be marked `Needs setup` and show configuration guidance instead of being silently enabled.

## Internal Model

Add a typed catalog, likely under `desktop/src/tool-capabilities.ts` or `desktop/src/capabilities/catalog.ts`.

Each capability definition contains:

- `id`
- i18n label and description keys
- `skillNames`: skill ids or stable name fragments to detect from loaded skills
- `skillPathHints`: optional local paths that can be added if present
- `mcpSpecs`: optional raw MCP specs or spec templates
- `requiredConfig`: optional fields such as tokens or account setup
- `risk`: `low`, `medium`, or `high`, used only in details

The catalog is static for v1. It should not fetch remote registries during settings render.

## Status Calculation

Status is derived from current runtime state:

- `Enabled`: all required local skills are loaded and all required MCP specs are present and enabled.
- `Partially enabled`: at least one required item is present, but some are missing.
- `Needs setup`: required account, environment variable, local app, or MCP template config is missing.
- `Unavailable`: the capability depends on a skill/plugin that is not present locally and cannot be enabled by writing current settings.

Detection must be tolerant. Skills can be detected by exact name first and by known aliases second. MCP specs should be compared by parsed server name when possible, falling back to raw-string comparison.

## Enabling

Clicking `Enable` applies only changes Jupiter can safely perform locally:

- Add missing MCP specs through the existing `mcp_specs_add` path.
- Add missing skill paths through the existing `skill_path_add` path, but only for paths that already exist locally.
- Avoid duplicate MCP specs and duplicate skill paths.
- Do not install npm packages, pip packages, browser binaries, plugins, or external credentials in v1.

After enabling, Jupiter should refresh MCP and skills using existing events. If a capability needs restart or reconnect, show a small inline status message rather than a modal.

## Settings Integration

Add `capabilities` to the settings page list, with icon `sparkles` or `zap` if available. The page should live beside Integrations and Skills, but it should be the friendly entry point. Existing `Integrations` and `Skills` pages remain as advanced detail pages.

Capability detail actions can deep-link mentally rather than technically in v1: show "Manage MCP in Integrations" or "Manage skills in Skills" buttons that switch the page state to the relevant existing tab.

## Data Flow

`SettingsModal` receives existing `mcpSpecs`, `mcpBridged`, `skills`, and `skillRoots`.

The capabilities page computes view models from:

- static capability catalog
- current MCP specs
- loaded skills
- configured skill roots

For enable actions, `SettingsModal` calls new callbacks that can fan out to existing `onAddMcpSpec` and `onAddSkillPath`. This keeps persistence in the current desktop RPC path instead of creating a parallel settings writer.

## Error Handling

If an enable action cannot complete, the row should remain visible and show a concise reason:

- Missing local skill path.
- MCP template needs manual configuration.
- Existing MCP add returned an error.
- Capability requires a plugin that is not installed.

Errors should not block the whole page. One failed item should make the capability `Partially enabled` or `Needs setup`.

## Testing

Add focused tests for:

- Capability status calculation: enabled, partial, needs setup, unavailable.
- MCP duplicate detection by parsed server name.
- Skill detection by exact name and alias.
- Enable action calls the existing add handlers only for missing items.
- Settings page renders the user-facing "Capabilities" copy without exposing "preset" as primary UI text.

Avoid end-to-end network or package installation tests in v1.

## Out of Scope For V1

- Remote plugin installation.
- Downloading MCP packages or browser binaries.
- Per-workspace capability profiles.
- Auto-enabling capabilities based on task text.
- Removing capability packs and pruning shared dependencies.
- Marketplace search inside the capability page.

## Follow-Up Direction

After v1 is stable, capabilities can become workspace-aware: a front-end repo can enable front-end validation by default, a writing repo can enable documents and research, and a data repo can enable spreadsheets. The catalog should be designed so that future workspace-level state can wrap it without changing the user-facing concept.

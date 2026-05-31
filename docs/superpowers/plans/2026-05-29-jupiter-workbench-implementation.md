# Jupiter Workbench Implementation Plan

## Visual Thesis

Jupiter should feel like a calm Codex-style desktop workbench: muted chrome, dense scan-friendly panels, crisp tool surfaces, and one restrained accent for active agent state.

## Content Plan

- Primary workspace: keep the conversation and composer as the center of gravity.
- Navigation: retain sessions/workspace on the left, but make the brand read as Jupiter.
- Context: expose files, MCP, Skills, memory, jobs, and usage from the right rail/settings instead of hiding them behind text-only configuration.
- Legal: keep upstream MIT attribution in source only, not as a visible product surface.

## Interaction Thesis

- Settings actions should be direct controls: enable/disable, reconnect, add/remove, create, and select model overrides.
- Status should be visible at the row level with compact pills and icon buttons.
- Layout should stay stable under long specs, paths, model names, and empty states.

## Steps

1. Add failing tests for shared MCP/Skill settings mutations and the minimal upstream notice.
2. Implement shared configuration helpers for MCP spec add/remove/enable/disable and Skill path/create/model actions.
3. Wire desktop RPC commands through those helpers and refresh the existing `$mcp_specs` / `$skills` events.
4. Upgrade the MCP and Skills settings pages to graphical management surfaces.
5. Rebrand visible desktop UI strings from Jupiter to Jupiter while leaving internal package identifiers alone.
6. Tighten desktop shell styling toward the Codex workbench direction without broad rewrites.
7. Run targeted tests, typecheck, and a desktop/browser smoke verification where feasible.

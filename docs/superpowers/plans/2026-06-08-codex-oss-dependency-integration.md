# Codex OSS Dependency Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selectively integrate high-value open-source dependencies observed in Codex.app into Jupiter without copying the entire dependency surface.

**Architecture:** Treat Codex's `THIRD_PARTY_NOTICES.txt` as a candidate catalog, not as a target manifest. Add small wrapper modules around new dependencies so Jupiter keeps stable internal APIs and can remove or replace libraries later without broad UI rewrites. Ship in risk-ordered batches: security first, then UI primitives, then rendering and interaction upgrades.

**Tech Stack:** React 19, Tauri 2, Vite, Vitest, Testing Library, `dompurify`, `@braintree/sanitize-url`, `@floating-ui/react-dom`, `shiki`, `@xterm/addon-web-links`, `@xterm/addon-clipboard`, `fuse.js`, `@dnd-kit/core`, `@dnd-kit/sortable`.

---

## Source Inventory

Codex source inspected:
- `/Applications/Codex.app/Contents/Resources/THIRD_PARTY_NOTICES.txt`

Observed counts:
- 948 notice entries
- 853 unique project names
- 237 projects already overlap with Jupiter's current dependency tree

Jupiter already has:
- Markdown/rendering basics: `react-markdown`, `remark-gfm`, `remark-math`, `rehype-katex`, `katex`
- Current code highlighting: `prism-react-renderer`, root dev dependency `highlight.js`
- Terminal basics: `@xterm/xterm`, `@xterm/addon-fit`, Tauri Rust PTY backend via `portable_pty`
- Core React app stack: React 19, Tauri APIs, Vitest

Do not integrate in the first batch:
- `node-pty`: Jupiter already has a Rust PTY backend; adding Node native PTY increases packaging risk.
- `better-sqlite3`: native packaging cost is not justified until session or memory indexing is redesigned.
- `@sentry/*`, `@segment/*`, `@statsig/*`, `@opentelemetry/*`: telemetry requires a separate privacy and opt-in design.
- `pdfjs-dist`, `react-pdf`, `docx-preview`, `mermaid`: useful, but heavier. Add in a second feature batch after security wrappers are in place.
- `three`, `mapbox-gl`, `cytoscape`, `d3`, `lottie`: not core to the current agent workbench UI.

---

## Target File Structure

Create:
- `desktop/src/ui/safe-content.ts`: URL and HTML sanitization wrapper.
- `desktop/src/ui/safe-content.test.ts`: security tests for unsafe URL and HTML cases.
- `desktop/src/ui/floating-layer.tsx`: shared floating positioning primitives based on Floating UI.
- `desktop/src/ui/floating-layer.test.tsx`: close, focus, and anchor behavior tests.
- `desktop/src/ui/shiki-highlighter.ts`: async Shiki highlighter adapter returning token lines, not raw HTML.
- `desktop/src/ui/shiki-highlighter.test.ts`: language fallback and theme tests.
- `desktop/src/ui/xterm-addons.ts`: xterm addon factory for fit, links, clipboard.
- `desktop/src/ui/xterm-addons.test.ts`: addon selection tests.
- `desktop/src/ui/fuzzy.ts`: Fuse-backed ranking helpers for commands and local lists.
- `desktop/src/ui/fuzzy.test.ts`: deterministic ranking tests.
- `desktop/src/ui/sortable-list.tsx`: small app-styled wrapper over `@dnd-kit` for future queue/tab/card ordering.
- `desktop/src/ui/sortable-list.test.tsx`: pure reorder behavior tests.

Modify:
- `desktop/package.json`: add first-batch dependencies.
- `desktop/src/Markdown.tsx`: route links through `safe-content`, keep file pills and HTML file preview behavior.
- `desktop/src/CodeView.tsx`: migrate highlighting through the Shiki adapter with a safe fallback.
- `desktop/src/CommandPalette.tsx`: replace substring filtering with `fuzzy.ts`.
- `desktop/src/ui/file-action-menu.tsx`: migrate manual anchored menu to `floating-layer.tsx`.
- `desktop/src/ui/context-panel.tsx`: use terminal addon factory and keep Tauri PTY backend.
- `desktop/src/ui/settings.tsx`: use shared floating layer only for menus/popovers touched by the first batch; do not redesign settings layout here.
- `desktop/src/styles.css`: add minimal styles for floating layer, Shiki token classes if needed, and sortable drag state.
- `desktop/src/i18n/en.ts`, `desktop/src/i18n/zh-CN.ts`, `desktop/src/i18n/ja.ts`, `desktop/src/i18n/de.ts`: add strings only for user-visible new labels or error messages.

---

## Task 1: Add First-Batch Dependencies

**Files:**
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`

- [ ] **Step 1: Install desktop dependencies**

Run:

```bash
npm --prefix desktop install dompurify @braintree/sanitize-url @floating-ui/react-dom shiki fuse.js @xterm/addon-web-links @xterm/addon-clipboard @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

Expected:
- `desktop/package.json` contains the new dependencies.
- `desktop/package-lock.json` is updated.
- No root workspace dependency is added unless a root CLI feature uses it.

- [ ] **Step 2: Verify package graph**

Run:

```bash
npm --prefix desktop ls dompurify @braintree/sanitize-url @floating-ui/react-dom shiki fuse.js @xterm/addon-web-links @xterm/addon-clipboard @dnd-kit/core @dnd-kit/sortable
```

Expected:
- Command exits with code `0`.
- Each package is resolved under `desktop`.

- [ ] **Step 3: Commit dependency baseline**

Run:

```bash
git add desktop/package.json desktop/package-lock.json
git commit -m "chore(desktop): add codex-inspired ui dependencies"
```

Expected:
- Commit contains only dependency manifest changes.

---

## Task 2: Harden Markdown Links and HTML Surfaces

**Files:**
- Create: `desktop/src/ui/safe-content.ts`
- Create: `desktop/src/ui/safe-content.test.ts`
- Modify: `desktop/src/Markdown.tsx`
- Modify: `desktop/src/Markdown.test.tsx`

- [ ] **Step 1: Write security tests**

Add tests covering these cases:

```ts
import { describe, expect, it } from "vitest";
import { sanitizeHtmlFragment, sanitizeUserUrl } from "./safe-content";

describe("safe-content", () => {
  it("blocks javascript urls", () => {
    expect(sanitizeUserUrl("javascript:alert(1)")).toBe(null);
  });

  it("allows http, https, mailto, and file urls", () => {
    expect(sanitizeUserUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(sanitizeUserUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(sanitizeUserUrl("mailto:test@example.com")).toBe("mailto:test@example.com");
    expect(sanitizeUserUrl("file:///tmp/index.html")).toBe("file:///tmp/index.html");
  });

  it("removes script tags and event handlers from html fragments", () => {
    const html = sanitizeHtmlFragment(`<img src="x" onerror="alert(1)"><script>alert(2)</script>`);
    expect(html).toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm --prefix desktop run build -- --mode test
npm --prefix desktop exec vitest run src/ui/safe-content.test.ts src/Markdown.test.tsx
```

Expected:
- `safe-content.test.ts` fails because `safe-content.ts` does not exist.

- [ ] **Step 3: Implement wrapper**

Implementation rules:
- `sanitizeUserUrl(value)` returns `string | null`.
- Allowed schemes: `http`, `https`, `mailto`, `file`.
- Relative paths without a protocol are allowed because Jupiter uses local file references.
- `sanitizeHtmlFragment(html)` returns sanitized HTML for future preview/rendering use.
- Do not expose DOMPurify directly outside `safe-content.ts`.

- [ ] **Step 4: Wire Markdown links**

Update `SafeLink` in `desktop/src/Markdown.tsx` to call `sanitizeUserUrl(href)`.

Expected behavior:
- Unsafe links render as plain text or an inert anchor without `href`.
- Existing file pills still call `onOpenHtmlFile` for `.html` and `.htm`.
- Existing `SafeLink` click behavior for normal URLs remains unchanged.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/safe-content.test.ts src/Markdown.test.tsx
```

Expected:
- Tests pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add desktop/src/ui/safe-content.ts desktop/src/ui/safe-content.test.ts desktop/src/Markdown.tsx desktop/src/Markdown.test.tsx
git commit -m "fix(desktop): sanitize markdown links and html fragments"
```

---

## Task 3: Add Shared Floating Layer Primitive

**Files:**
- Create: `desktop/src/ui/floating-layer.tsx`
- Create: `desktop/src/ui/floating-layer.test.tsx`
- Modify: `desktop/src/ui/file-action-menu.tsx`
- Modify: `desktop/src/ui/file-action-menu.test.tsx`
- Modify: `desktop/src/styles.css`

- [ ] **Step 1: Write tests for shared floating behavior**

Test cases:
- Renders content anchored to an element.
- Calls `onClose` on Escape.
- Calls `onClose` on outside pointer down.
- Does not close when pointer down happens inside the floating content.

Use Testing Library and a mocked `getBoundingClientRect`.

- [ ] **Step 2: Implement `FloatingLayer`**

Public API:

```tsx
export type FloatingLayerPlacement = "bottom-start" | "bottom-end" | "top-start" | "right-start";

export function FloatingLayer(props: {
  anchor: HTMLElement | { left: number; top: number } | null;
  open: boolean;
  placement?: FloatingLayerPlacement;
  className?: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement | null;
```

Implementation rules:
- Use `@floating-ui/react-dom` for positioned element anchors.
- For coordinate anchors, position with fixed `left/top` because some existing menus open from context menu coordinates.
- Use `requestAnimationFrame` for first measurement to avoid layout jumps.
- Keep z-index and surface style in CSS, not inline styles except computed position.

- [ ] **Step 3: Migrate file action menu first**

Update `desktop/src/ui/file-action-menu.tsx` to use `FloatingLayer`.

Expected:
- Same menu items.
- Same keyboard close behavior.
- Right-click coordinate menu continues to work from file pills.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/floating-layer.test.tsx src/ui/file-action-menu.test.tsx
```

Expected:
- Tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add desktop/src/ui/floating-layer.tsx desktop/src/ui/floating-layer.test.tsx desktop/src/ui/file-action-menu.tsx desktop/src/ui/file-action-menu.test.tsx desktop/src/styles.css
git commit -m "feat(desktop): add shared floating layer primitive"
```

---

## Task 4: Replace Command Palette Substring Search with Fuse Ranking

**Files:**
- Create: `desktop/src/ui/fuzzy.ts`
- Create: `desktop/src/ui/fuzzy.test.ts`
- Modify: `desktop/src/CommandPalette.tsx`
- Modify: `desktop/src/ui/source-search-popover.tsx` if it has local substring ranking.

- [ ] **Step 1: Write ranking tests**

Test cases:
- Exact label match ranks first.
- Hint match ranks after label match.
- Empty query preserves original order.
- Chinese labels are preserved and searchable by exact substring.

Example:

```ts
import { describe, expect, it } from "vitest";
import { rankItems } from "./fuzzy";

describe("rankItems", () => {
  const items = [
    { id: "settings", label: "Settings", hint: "Open preferences" },
    { id: "files", label: "Files", hint: "Browse project files" },
    { id: "side-chat", label: "侧边聊天", hint: "临时 session" },
  ];

  it("keeps original order for empty query", () => {
    expect(rankItems(items, "", ["label", "hint"]).map((x) => x.id)).toEqual(["settings", "files", "side-chat"]);
  });

  it("ranks label matches first", () => {
    expect(rankItems(items, "files", ["label", "hint"])[0]?.id).toBe("files");
  });

  it("supports Chinese substring matches", () => {
    expect(rankItems(items, "聊天", ["label", "hint"])[0]?.id).toBe("side-chat");
  });
});
```

- [ ] **Step 2: Implement `rankItems`**

Public API:

```ts
export function rankItems<T extends Record<string, unknown>>(
  items: T[],
  query: string,
  keys: Array<keyof T>,
): T[];
```

Implementation rules:
- Use `fuse.js`.
- Return original order for empty queries.
- Configure `threshold` around `0.35`.
- Keep exact case-insensitive substring matches ahead of fuzzy-only matches.

- [ ] **Step 3: Wire CommandPalette**

Replace the current lower-case substring filter in `desktop/src/CommandPalette.tsx` with `rankItems(commands, query, ["label", "hint"])`.

- [ ] **Step 4: Run tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/fuzzy.test.ts src/CommandPalette.test.tsx
```

If `src/CommandPalette.test.tsx` does not exist, run:

```bash
npm --prefix desktop exec vitest run src/ui/fuzzy.test.ts
```

Expected:
- Ranking tests pass.
- Manual command palette behavior remains keyboard-compatible.

- [ ] **Step 5: Commit**

Run:

```bash
git add desktop/src/ui/fuzzy.ts desktop/src/ui/fuzzy.test.ts desktop/src/CommandPalette.tsx desktop/src/ui/source-search-popover.tsx
git commit -m "feat(desktop): add fuzzy ranking for command search"
```

---

## Task 5: Add Xterm Link and Clipboard Addons

**Files:**
- Create: `desktop/src/ui/xterm-addons.ts`
- Create: `desktop/src/ui/xterm-addons.test.ts`
- Modify: `desktop/src/ui/context-panel.tsx`

- [ ] **Step 1: Write addon tests**

Test cases:
- Factory returns fit, web links, and clipboard addons.
- Web links addon is included only when `window.open` is available.
- Clipboard addon is included only when `navigator.clipboard` is available.

- [ ] **Step 2: Implement addon factory**

Public API:

```ts
import type { ITerminalAddon } from "@xterm/xterm";

export function createTerminalAddons(): {
  addons: ITerminalAddon[];
  fitAddon: { fit: () => void } | null;
};
```

Implementation rules:
- Keep `FitAddon` behavior unchanged.
- Add `WebLinksAddon` with the app's current external URL open path if available.
- Add `ClipboardAddon` only in browser contexts that expose clipboard APIs.
- Do not introduce `node-pty`.

- [ ] **Step 3: Wire CtxTerminal**

Update terminal setup in `desktop/src/ui/context-panel.tsx`:
- Use `createTerminalAddons()`.
- Load every addon once per terminal instance.
- Keep resize logic using the returned `fitAddon`.

- [ ] **Step 4: Run tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/xterm-addons.test.ts src/ui/context-panel.test.tsx
```

Expected:
- Existing terminal tests pass.
- Links in terminal output open through the configured URL opener during manual verification.

- [ ] **Step 5: Commit**

Run:

```bash
git add desktop/src/ui/xterm-addons.ts desktop/src/ui/xterm-addons.test.ts desktop/src/ui/context-panel.tsx
git commit -m "feat(desktop): enable terminal links and clipboard addon"
```

---

## Task 6: Add Shiki Highlighter Adapter

**Files:**
- Create: `desktop/src/ui/shiki-highlighter.ts`
- Create: `desktop/src/ui/shiki-highlighter.test.ts`
- Modify: `desktop/src/CodeView.tsx`
- Modify: `desktop/src/styles.css`

- [ ] **Step 1: Write highlighter tests**

Test cases:
- TypeScript code produces at least one highlighted token.
- Unknown languages fall back to `text`.
- Light and dark themes return different token colors.
- Output is token data, not unsanitized HTML.

- [ ] **Step 2: Implement adapter**

Public API:

```ts
export type HighlightTheme = "light" | "dark";

export type HighlightToken = {
  content: string;
  color?: string;
  fontStyle?: number;
};

export type HighlightedLine = HighlightToken[];

export async function highlightCode(
  code: string,
  lang: string,
  theme: HighlightTheme,
): Promise<HighlightedLine[]>;
```

Implementation rules:
- Use Shiki tokenization APIs instead of `dangerouslySetInnerHTML`.
- Cache the highlighter promise at module level.
- Use a small language/theme set at first: TypeScript, JavaScript, JSON, Markdown, CSS, HTML, Bash, Python, Rust, Go, text.
- Map Jupiter light/dark theme to Shiki themes that resemble the current UI.

- [ ] **Step 3: Update CodeView**

Behavior:
- Render existing Prism output immediately as fallback.
- Replace with Shiki token output after async highlight resolves.
- Cancel stale async results when `text`, `lang`, or theme changes.
- Preserve line numbers, start line, and `CollapsibleCode`.

- [ ] **Step 4: Run tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/shiki-highlighter.test.ts src/Markdown.test.tsx
npm --prefix desktop run build
```

Expected:
- Tests pass.
- Build does not pull Shiki into a blocking synchronous path.

- [ ] **Step 5: Commit**

Run:

```bash
git add desktop/src/ui/shiki-highlighter.ts desktop/src/ui/shiki-highlighter.test.ts desktop/src/CodeView.tsx desktop/src/styles.css
git commit -m "feat(desktop): add shiki-backed code highlighting"
```

---

## Task 7: Add Sortable List Primitive for Future Queue/Card Ordering

**Files:**
- Create: `desktop/src/ui/sortable-list.tsx`
- Create: `desktop/src/ui/sortable-list.test.tsx`
- Modify: no production call sites in this task unless queue ordering is implemented in the same branch.

- [ ] **Step 1: Write reorder tests**

Test pure helper behavior:

```ts
import { describe, expect, it } from "vitest";
import { reorderItems } from "./sortable-list";

describe("reorderItems", () => {
  it("moves an item from one index to another", () => {
    expect(reorderItems(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("returns the same order when ids are missing", () => {
    expect(reorderItems(["a", "b"], "x", "b")).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Implement wrapper**

Public API:

```tsx
export function reorderItems<T extends string>(items: T[], activeId: T, overId: T): T[];

export function SortableList<T extends { id: string }>(props: {
  items: T[];
  className?: string;
  itemClassName?: string;
  onReorder: (items: T[]) => void;
  renderItem: (item: T, state: { dragging: boolean }) => React.ReactNode;
}): React.ReactElement;
```

Implementation rules:
- Use `@dnd-kit/core` and `@dnd-kit/sortable`.
- Pointer and keyboard sensors must both work.
- Do not wire queue behavior until the primitive is verified.

- [ ] **Step 3: Run tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/sortable-list.test.tsx
```

Expected:
- Pure reorder tests pass.
- Rendering tests verify children appear in order.

- [ ] **Step 4: Commit**

Run:

```bash
git add desktop/src/ui/sortable-list.tsx desktop/src/ui/sortable-list.test.tsx
git commit -m "feat(desktop): add sortable list primitive"
```

---

## Task 8: Full Verification and Manual UI Pass

**Files:**
- Modify only if verification exposes concrete defects.

- [ ] **Step 1: Run full desktop checks**

Run:

```bash
npm --prefix desktop run build
npm --prefix desktop exec vitest run
```

Expected:
- Build passes.
- Vitest passes.

- [ ] **Step 2: Run root checks if desktop changes affect shared packages**

Run:

```bash
npm run typecheck
npm run test --silent
```

Expected:
- Typecheck passes.
- Tests pass.

- [ ] **Step 3: Manual app verification**

Run:

```bash
npm --prefix desktop run tauri dev
```

Manual checks:
- Markdown link to `https://example.com` opens normally.
- Markdown link to `javascript:alert(1)` does not execute.
- File pill for `index.html` still opens side browser preview.
- File action menu opens at the correct location from click and right-click.
- Command palette ranks exact matches first.
- Terminal recognizes URLs and copy/paste behavior remains usable.
- Code blocks render immediately and settle into Shiki highlighting without layout jumps.
- Existing side panel, bottom panel, settings modal, and context info popover are visually unchanged unless touched by the task.

- [ ] **Step 4: Commit verification fixes**

If manual verification required fixes, commit them:

```bash
git add desktop/src desktop/package.json desktop/package-lock.json
git commit -m "fix(desktop): polish codex dependency integration"
```

Expected:
- Commit is skipped when no fixes were needed.

---

## Batch 2: Final Capability Expansion

This is the only follow-up integration batch. After Batch 2, remaining Codex notice packages are explicitly out of scope unless a later product requirement independently justifies them.

Batch 2 should integrate:
- File preview packages: `pdfjs-dist`, `react-pdf`, `docx-preview`.
- Mermaid packages: `mermaid`, `@mermaid-js/parser`.
- Composer/editor packages: `codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/autocomplete`, `@codemirror/search`, `@codemirror/lint`, `@codemirror/lang-markdown`, `@codemirror/lang-javascript`, `@codemirror/lang-html`, `@codemirror/lang-css`.
- Scoped state helpers: `zustand`, `immer`.
- Optional data-list helpers if settings pages are being rebuilt in the same cycle: `@tanstack/react-query`, `@tanstack/react-table`.

Batch 2 should not integrate:
- `better-sqlite3`: do not add native storage until there is a storage migration plan.
- `isomorphic-git`: Jupiter already has shell-backed Git flows; replacing those is not justified here.
- `node-pty`: terminal remains on the existing Tauri Rust PTY backend.
- `@sentry/*`, `@segment/*`, `@statsig/*`, `@opentelemetry/*`: telemetry requires a separate privacy and opt-in design.
- `yjs`, `y-protocols`, `prosemirror-*`: collaboration and rich document editing are not current Jupiter requirements.
- `three`, `mapbox-gl`, `cytoscape`, `d3`, `roughjs`, Lottie packages: visualizations are not central enough to justify core bundle impact.
- `express`, `hono`: no internal HTTP server should be added for this work.

---

## Task 9: Add Batch 2 Dependencies

**Files:**
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`

- [ ] **Step 1: Install final capability dependencies**

Run:

```bash
npm --prefix desktop install pdfjs-dist react-pdf docx-preview mermaid @mermaid-js/parser codemirror @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/autocomplete @codemirror/search @codemirror/lint @codemirror/lang-markdown @codemirror/lang-javascript @codemirror/lang-html @codemirror/lang-css zustand immer
```

Expected:
- `desktop/package.json` and `desktop/package-lock.json` update.
- No root `package.json` dependency is added.
- No native Node dependency is introduced.

- [ ] **Step 2: Install optional data-list helpers only if Task 13 is accepted**

Run this only if settings data-list refactoring is included:

```bash
npm --prefix desktop install @tanstack/react-query @tanstack/react-table
```

Expected:
- These packages are present only when Task 13 is implemented.

- [ ] **Step 3: Commit dependency baseline**

Run:

```bash
git add desktop/package.json desktop/package-lock.json
git commit -m "chore(desktop): add final codex-inspired capability dependencies"
```

Expected:
- Commit contains only dependency manifest changes.

---

## Task 10: Add Rich File Preview Renderers

**Files:**
- Create: `desktop/src/ui/file-preview-renderers.tsx`
- Create: `desktop/src/ui/file-preview-renderers.test.tsx`
- Modify: `desktop/src/file-preview.ts`
- Modify: `desktop/src/ui/context-panel.tsx`
- Modify: `desktop/src/styles.css`

- [ ] **Step 1: Write renderer selection tests**

Test cases:
- `.pdf` selects the PDF renderer.
- `.docx` selects the DOCX renderer.
- `.doc` is shown as unsupported with an explicit message unless conversion support exists.
- Unknown extensions fall back to the existing text/placeholder preview.
- Renderer loading is lazy and does not block the side panel shell.

- [ ] **Step 2: Implement preview renderer registry**

Public API:

```tsx
export type PreviewRendererKind = "text" | "image" | "pdf" | "docx" | "unsupported";

export function previewRendererKind(path: string, mime?: string | null): PreviewRendererKind;

export function FilePreviewRenderer(props: {
  path: string;
  url: string;
  mime?: string | null;
  text?: string | null;
}): React.ReactElement;
```

Implementation rules:
- Use dynamic imports for `react-pdf`, `pdfjs-dist`, and `docx-preview`.
- Keep PDF worker configuration inside `file-preview-renderers.tsx`.
- Render DOCX into an isolated container; do not allow arbitrary script execution.
- Preserve existing HTML behavior: `.html` and `.htm` still open through the side browser preview, not this renderer.
- Show a compact loading state inside the existing side panel dimensions.

- [ ] **Step 3: Wire the side file preview**

Update `desktop/src/ui/context-panel.tsx`:
- Keep current text preview behavior.
- Use `FilePreviewRenderer` only when the selected file is PDF or DOCX.
- Ensure closing/reopening the side panel preserves preview state.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/file-preview-renderers.test.tsx src/ui/context-panel.test.tsx
npm --prefix desktop run build
```

Expected:
- Tests pass.
- Build passes with lazy chunks for heavy preview packages.

- [ ] **Step 5: Commit**

Run:

```bash
git add desktop/src/ui/file-preview-renderers.tsx desktop/src/ui/file-preview-renderers.test.tsx desktop/src/file-preview.ts desktop/src/ui/context-panel.tsx desktop/src/styles.css
git commit -m "feat(desktop): add pdf and docx side preview renderers"
```

---

## Task 11: Render Mermaid Blocks Safely

**Files:**
- Create: `desktop/src/ui/mermaid-renderer.tsx`
- Create: `desktop/src/ui/mermaid-renderer.test.tsx`
- Modify: `desktop/src/Markdown.tsx`
- Modify: `desktop/src/Markdown.test.tsx`
- Modify: `desktop/src/styles.css`

- [ ] **Step 1: Write Mermaid tests**

Test cases:
- A fenced `mermaid` code block renders a diagram container.
- Invalid Mermaid syntax falls back to a normal code block with an error label.
- Rendered SVG is passed through `sanitizeHtmlFragment` from `desktop/src/ui/safe-content.ts`.
- The diagram does not overflow horizontally outside `.markdown`.

- [ ] **Step 2: Implement Mermaid renderer**

Public API:

```tsx
export function MermaidBlock(props: {
  source: string;
  idSeed: string;
}): React.ReactElement;
```

Implementation rules:
- Dynamically import `mermaid`.
- Initialize Mermaid with `securityLevel: "strict"`.
- Sanitize generated SVG before injecting it.
- Use deterministic IDs derived from `idSeed`, not random IDs, so React rerenders do not recreate diagrams unnecessarily.
- Keep raw source visible behind a disclosure button when rendering fails.

- [ ] **Step 3: Wire Markdown code blocks**

Update the `pre` component in `desktop/src/Markdown.tsx`:
- If `extractFencedLang(children)` returns `mermaid`, render `MermaidBlock`.
- Otherwise keep the existing `CodeBlock` path.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/mermaid-renderer.test.tsx src/Markdown.test.tsx
npm --prefix desktop run build
```

Expected:
- Mermaid tests pass.
- Markdown tests pass.
- Build passes.

- [ ] **Step 5: Commit**

Run:

```bash
git add desktop/src/ui/mermaid-renderer.tsx desktop/src/ui/mermaid-renderer.test.tsx desktop/src/Markdown.tsx desktop/src/Markdown.test.tsx desktop/src/styles.css
git commit -m "feat(desktop): render mermaid markdown blocks safely"
```

---

## Task 12: Add CodeMirror Composer Behind a Stable Adapter

**Files:**
- Create: `desktop/src/ui/prompt-editor.tsx`
- Create: `desktop/src/ui/prompt-editor.test.tsx`
- Modify: `desktop/src/ui/composer.tsx`
- Modify: `desktop/src/ui/composer-at-popup.test.tsx`
- Modify: `desktop/src/styles.css`

- [ ] **Step 1: Write composer adapter tests**

Test cases:
- Plain typing updates the same draft value as the current composer.
- Enter submits when the current composer would submit.
- Shift+Enter inserts a newline.
- Pasted files still become attachments.
- Slash commands and `@` mention popup triggers still work.
- IME composition does not submit mid-composition.

- [ ] **Step 2: Implement `PromptEditor`**

Public API:

```tsx
export function PromptEditor(props: {
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onFilesPasted: (files: File[]) => void;
  onSlashTrigger: (query: string) => void;
  onMentionTrigger: (query: string) => void;
}): React.ReactElement;
```

Implementation rules:
- Use CodeMirror for text editing only.
- Keep command execution, attachments, model selector, and send button in `composer.tsx`.
- Use Markdown language support because the prompt is Markdown-like text.
- Do not add a full file editor in this task.
- Keep a feature flag or fallback path so the old textarea can be restored quickly during testing.

- [ ] **Step 3: Wire composer**

Update `desktop/src/ui/composer.tsx`:
- Replace the textarea body with `PromptEditor`.
- Preserve existing props and callbacks.
- Keep visual height behavior from `composer-sizing.ts`.
- Verify the bottom input does not create horizontal scrollbars.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/prompt-editor.test.tsx src/ui/composer-at-popup.test.tsx src/ui/composer-mode.test.tsx
npm --prefix desktop run build
```

Expected:
- Composer tests pass.
- Build passes.
- Manual IME typing and paste-file behavior work.

- [ ] **Step 5: Commit**

Run:

```bash
git add desktop/src/ui/prompt-editor.tsx desktop/src/ui/prompt-editor.test.tsx desktop/src/ui/composer.tsx desktop/src/ui/composer-at-popup.test.tsx desktop/src/styles.css
git commit -m "feat(desktop): add codemirror-backed prompt editor"
```

---

## Task 13: Isolate Panel State with a Small Store

**Files:**
- Create: `desktop/src/ui/panel-store.ts`
- Create: `desktop/src/ui/panel-store.test.ts`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/ui/context-panel.tsx`
- Modify: `desktop/src/ui/sidebar.tsx`

- [ ] **Step 1: Write store tests**

Test cases:
- Opening context info closes the side panel when required by current UI rules.
- Opening the side panel closes context info.
- Side panel width and context info width stay synchronized.
- Bottom panel state is independent from the right panel state.
- File preview/browser tab state survives panel collapse.

- [ ] **Step 2: Implement scoped Zustand store**

Public API:

```ts
export type PanelKind = "none" | "side" | "contextInfo";

export type PanelStoreState = {
  rightPanel: PanelKind;
  rightPanelWidth: number;
  bottomPanelOpen: boolean;
  openSidePanel: () => void;
  openContextInfo: () => void;
  closeRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  setBottomPanelOpen: (open: boolean) => void;
};

export const usePanelStore: import("zustand").UseBoundStore<
  import("zustand").StoreApi<PanelStoreState>
>;
```

Implementation rules:
- Use `zustand` for the store.
- Use `immer` only for nested updates if needed; avoid adding Immer where plain object updates are clearer.
- Do not migrate global app state into this store.
- Keep RPC/session/message state in `App.tsx`.

- [ ] **Step 3: Wire right and bottom panel state**

Update `desktop/src/App.tsx`, `desktop/src/ui/context-panel.tsx`, and `desktop/src/ui/sidebar.tsx`:
- Replace duplicated right-panel booleans with `rightPanel`.
- Keep the same user-visible behavior for side panel, info panel, width resize, and bottom panel.
- Preserve current localStorage keys if width or panel state is persisted.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/panel-store.test.ts src/ui/context-panel-layout.test.ts src/ui/sidebar-workspace.test.ts
npm --prefix desktop run build
```

Expected:
- Panel state tests pass.
- Build passes.

- [ ] **Step 5: Commit**

Run:

```bash
git add desktop/src/ui/panel-store.ts desktop/src/ui/panel-store.test.ts desktop/src/App.tsx desktop/src/ui/context-panel.tsx desktop/src/ui/sidebar.tsx
git commit -m "refactor(desktop): isolate panel layout state"
```

---

## Task 14: Optional Settings Data Lists with TanStack

**Files:**
- Create: `desktop/src/ui/query-client.tsx`
- Create: `desktop/src/ui/data-table.tsx`
- Create: `desktop/src/ui/data-table.test.tsx`
- Modify: `desktop/src/main.tsx`
- Modify: `desktop/src/ui/settings.tsx`

- [ ] **Step 1: Accept or skip this task**

Accept this task only if settings pages for MCP, skills, memory, or model lists are being actively rebuilt in the same cycle.

Skip this task when Batch 2 is focused only on preview, Mermaid, composer, and panel state.

- [ ] **Step 2: Write data table tests**

Test cases:
- Empty state renders.
- Rows render in stable order.
- Column labels are accessible.
- Row actions remain keyboard reachable.

- [ ] **Step 3: Implement query and table wrappers**

Public APIs:

```tsx
export function QueryProvider(props: { children: React.ReactNode }): React.ReactElement;

export function DataTable<T>(props: {
  rows: T[];
  getRowId: (row: T) => string;
  columns: Array<{
    id: string;
    header: string;
    cell: (row: T) => React.ReactNode;
  }>;
  emptyLabel: string;
}): React.ReactElement;
```

Implementation rules:
- Use `@tanstack/react-query` only for read-heavy RPC data that can be refreshed.
- Use `@tanstack/react-table` only for tables that need sorting, row actions, or stable keyboard navigation.
- Do not wrap the whole app's streaming conversation state in React Query.

- [ ] **Step 4: Wire only one settings page first**

Preferred first target:
- `PageSkills` in `desktop/src/ui/settings.tsx`, because skill lists are read-heavy and refreshable.

Expected:
- Existing skill install/update buttons still work.
- Refresh behavior is explicit and visible.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm --prefix desktop exec vitest run src/ui/data-table.test.tsx src/ui/settings.test.tsx
npm --prefix desktop run build
```

Expected:
- Tests pass.
- Build passes.

- [ ] **Step 6: Commit or skip**

If implemented:

```bash
git add desktop/src/ui/query-client.tsx desktop/src/ui/data-table.tsx desktop/src/ui/data-table.test.tsx desktop/src/main.tsx desktop/src/ui/settings.tsx desktop/package.json desktop/package-lock.json
git commit -m "feat(desktop): add query-backed settings data lists"
```

If skipped:
- Do not install `@tanstack/react-query` or `@tanstack/react-table`.
- Do not commit any changes for this task.

---

## Success Criteria

- The whole Codex OSS dependency integration is complete after Batch 1 and Batch 2; no implicit third batch remains.
- First-batch dependency additions are justified by a direct Jupiter feature or bug class.
- Second-batch dependency additions are justified by file preview, Mermaid rendering, composer editing, or panel-state isolation.
- No new telemetry dependency ships.
- No new native Node dependency ships.
- Unsafe Markdown links are blocked.
- Floating UI behavior has one shared primitive for newly touched menus.
- Terminal link and clipboard behavior improves without changing the Rust PTY backend.
- Command search improves without changing command definitions.
- Shiki integration does not use raw unsanitized HTML.
- PDF and DOCX preview renderers lazy-load heavy packages.
- Mermaid rendering is sanitized and failure-tolerant.
- CodeMirror composer preserves paste-file, slash command, mention, Enter, Shift+Enter, and IME behavior.
- Panel state is isolated without migrating conversation streaming state out of `App.tsx`.
- `npm --prefix desktop run build` passes.
- Focused Vitest suites pass.

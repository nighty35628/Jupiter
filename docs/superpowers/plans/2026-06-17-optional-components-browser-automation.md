# Optional Components and Browser Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings page for optional runtime components and enable Playwright browser automation automatically when Chrome, Edge, or Chromium is already installed.

**Architecture:** Keep browser/runtime detection in the desktop backend, expose it through structured desktop RPC events, and render it in a new Settings page. Jupiter will depend on `playwright-core` only; it will not bundle or auto-download Chromium in the installer.

**Tech Stack:** TypeScript, Tauri desktop RPC, React settings UI, Vitest, existing `detectBrowserAutomation()` helpers.

---

## Scope

First version:
- Detect Chrome, Edge, Chromium, LibreOffice, FFmpeg, Tesseract, and Pandoc.
- Prefer Chrome/Edge/Chromium for Playwright automation.
- Add a Settings page named "Optional Components" / "可选组件".
- Provide actions: refresh detection, open install page/instructions, copy install command, and show executable path.
- Add `playwright-core` as a runtime dependency.
- Do not bundle Chromium.
- Do not run system package managers automatically.

Out of scope for this plan:
- Using an existing user Chrome profile or login state.
- Remote browser/CDP attach.
- Auto-installing apt/pacman/brew/winget packages.
- Download progress UI for Chromium.
- A full browser automation tool exposed to the model. This plan only makes runtime detection and settings visible; tool integration can follow once this foundation is stable.

---

## File Structure

Create:
- `src/desktop/optional-components.ts`
  - Owns optional component metadata, detection, install links, and install command hints.
- `tests/optional-components.test.ts`
  - Unit tests for component detection and platform-specific install hints.
- `desktop/src/ui/optional-components.test.tsx`
  - UI tests for the Settings page component.

Modify:
- `src/desktop/browser-automation.ts`
  - Keep existing browser detection, but export reusable browser candidate details if needed by optional components.
- `src/cli/commands/desktop.ts`
  - Add `$optional_components` event and `optional_components_get` command.
  - Include `optionalComponents` in `$settings` so Settings opens with data immediately.
- `desktop/src/protocol.ts`
  - Add `OptionalComponentStatus`, `OptionalComponentsEvent`, and outgoing command type.
- `desktop/src/App.tsx`
  - Store optional component statuses in state.
  - Request refresh when Settings opens the component page.
  - Dispatch `optional_components_get`.
- `desktop/src/ui/settings.tsx`
  - Add page id `components`.
  - Move the existing `BrowserAutomationSection` from Integrations into the new page.
  - Add `PageOptionalComponents`.
- `desktop/src/i18n/en.ts`
- `desktop/src/i18n/zh-CN.ts`
- `desktop/src/i18n/ja.ts`
- `desktop/src/i18n/de.ts`
  - Add page labels and component copy.
- `package.json`
- `package-lock.json`
  - Add `playwright-core`.

---

## Data Model

Use one normalized shape for all optional components:

```ts
export type OptionalComponentId =
  | "browser-chrome"
  | "browser-edge"
  | "browser-chromium"
  | "libreoffice"
  | "ffmpeg"
  | "tesseract"
  | "pandoc";

export type OptionalComponentCapability =
  | "browser-automation"
  | "office-preview"
  | "media-processing"
  | "ocr"
  | "document-conversion";

export type OptionalComponentStatus = {
  id: OptionalComponentId;
  name: string;
  capability: OptionalComponentCapability;
  state: "available" | "missing" | "unsupported";
  version?: string;
  executablePath?: string;
  homepageUrl?: string;
  installHint?: string;
  recommended?: boolean;
};
```

Browser automation resolver:

```ts
export type BrowserAutomationStatus =
  | {
      state: "available";
      browser: "chrome" | "edge" | "chromium";
      name: string;
      executablePath: string;
      launchMode: "system";
    }
  | {
      state: "unavailable";
      reason: "no-browser";
    };
```

---

## Task 1: Add Optional Component Detection Backend

**Files:**
- Create: `src/desktop/optional-components.ts`
- Test: `tests/optional-components.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests:

```ts
import { describe, expect, it } from "vitest";
import { detectOptionalComponents, installHintFor } from "../src/desktop/optional-components.js";

describe("detectOptionalComponents", () => {
  it("marks Chrome available when a Chrome executable exists", () => {
    const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const components = detectOptionalComponents({
      platform: "darwin",
      env: { HOME: "/Users/test", PATH: "/usr/bin" },
      exists: (path) => path === chromePath,
      which: () => null,
      runVersion: () => null,
    });

    expect(components.find((c) => c.id === "browser-chrome")).toMatchObject({
      state: "available",
      executablePath: chromePath,
      capability: "browser-automation",
      recommended: true,
    });
  });

  it("detects command-line tools through PATH", () => {
    const components = detectOptionalComponents({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: () => false,
      which: (command) => (command === "ffmpeg" ? "/usr/bin/ffmpeg" : null),
      runVersion: (path) => (path === "/usr/bin/ffmpeg" ? "ffmpeg version 6.1" : null),
    });

    expect(components.find((c) => c.id === "ffmpeg")).toMatchObject({
      state: "available",
      version: "ffmpeg version 6.1",
      executablePath: "/usr/bin/ffmpeg",
    });
  });

  it("returns platform-specific install hints", () => {
    expect(installHintFor("ffmpeg", "darwin")).toContain("brew install ffmpeg");
    expect(installHintFor("ffmpeg", "win32")).toContain("winget install");
    expect(installHintFor("ffmpeg", "linux")).toContain("apt install ffmpeg");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test -- --pool=threads --maxWorkers=1 --minWorkers=1 tests/optional-components.test.ts
```

Expected: fail because `src/desktop/optional-components.ts` does not exist.

- [ ] **Step 3: Implement component detection**

Create `src/desktop/optional-components.ts`:

```ts
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";

export type OptionalComponentId =
  | "browser-chrome"
  | "browser-edge"
  | "browser-chromium"
  | "libreoffice"
  | "ffmpeg"
  | "tesseract"
  | "pandoc";

export type OptionalComponentCapability =
  | "browser-automation"
  | "office-preview"
  | "media-processing"
  | "ocr"
  | "document-conversion";

export type OptionalComponentStatus = {
  id: OptionalComponentId;
  name: string;
  capability: OptionalComponentCapability;
  state: "available" | "missing" | "unsupported";
  version?: string;
  executablePath?: string;
  homepageUrl?: string;
  installHint?: string;
  recommended?: boolean;
};

type DetectorOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  which?: (command: string) => string | null;
  runVersion?: (path: string, args?: string[]) => string | null;
};

type ComponentSpec = {
  id: OptionalComponentId;
  name: string;
  capability: OptionalComponentCapability;
  commands: string[];
  paths?: (env: NodeJS.ProcessEnv) => string[];
  versionArgs?: string[];
  homepageUrl: string;
  recommended?: boolean;
};

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function pathWhich(command: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null {
  const pathVar = env.PATH || env.Path || "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, command);
    if (exists(full)) return full;
  }
  return null;
}

function defaultRunVersion(path: string, args: string[] = ["--version"]): string | null {
  try {
    return execFileSync(path, args, { encoding: "utf8", timeout: 1500 }).split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function specsFor(platform: NodeJS.Platform): ComponentSpec[] {
  return [
    {
      id: "browser-chrome",
      name: "Google Chrome",
      capability: "browser-automation",
      recommended: true,
      commands: platform === "win32" ? ["chrome.exe", "chrome"] : ["google-chrome", "google-chrome-stable", "chrome"],
      paths: (env) =>
        platform === "darwin"
          ? unique([
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              env.HOME && `${env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
            ])
          : platform === "win32"
            ? unique([
                env.ProgramFiles && `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
                env["ProgramFiles(x86)"] && `${env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
                env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
              ])
            : [],
      homepageUrl: "https://www.google.com/chrome/",
    },
    {
      id: "browser-edge",
      name: "Microsoft Edge",
      capability: "browser-automation",
      recommended: true,
      commands: platform === "win32" ? ["msedge.exe", "msedge"] : ["microsoft-edge", "microsoft-edge-stable", "msedge"],
      paths: (env) =>
        platform === "darwin"
          ? unique([
              "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
              env.HOME && `${env.HOME}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
            ])
          : platform === "win32"
            ? unique([
                env.ProgramFiles && `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
                env["ProgramFiles(x86)"] && `${env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
                env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
              ])
            : [],
      homepageUrl: "https://www.microsoft.com/edge/download",
    },
    {
      id: "browser-chromium",
      name: "Chromium",
      capability: "browser-automation",
      commands: ["chromium", "chromium-browser"],
      homepageUrl: "https://playwright.dev/docs/browsers",
    },
    {
      id: "libreoffice",
      name: "LibreOffice",
      capability: "office-preview",
      commands: platform === "darwin" ? ["soffice", "libreoffice"] : ["libreoffice", "soffice"],
      homepageUrl: "https://www.libreoffice.org/download/download-libreoffice/",
    },
    { id: "ffmpeg", name: "FFmpeg", capability: "media-processing", commands: ["ffmpeg"], homepageUrl: "https://ffmpeg.org/download.html" },
    { id: "tesseract", name: "Tesseract OCR", capability: "ocr", commands: ["tesseract"], homepageUrl: "https://tesseract-ocr.github.io/" },
    { id: "pandoc", name: "Pandoc", capability: "document-conversion", commands: ["pandoc"], homepageUrl: "https://pandoc.org/installing.html" },
  ];
}

export function installHintFor(id: OptionalComponentId, platform: NodeJS.Platform = process.platform): string {
  const hints: Record<OptionalComponentId, Record<string, string>> = {
    "browser-chrome": { darwin: "Download Chrome from google.com/chrome.", win32: "winget install Google.Chrome", linux: "Install google-chrome-stable from Google's Linux repository." },
    "browser-edge": { darwin: "Download Edge from microsoft.com/edge/download.", win32: "winget install Microsoft.Edge", linux: "Install microsoft-edge-stable from Microsoft's Linux repository." },
    "browser-chromium": { darwin: "npm exec playwright install chromium", win32: "npm exec playwright install chromium", linux: "Use your package manager, or run npm exec playwright install chromium." },
    libreoffice: { darwin: "brew install --cask libreoffice", win32: "winget install TheDocumentFoundation.LibreOffice", linux: "sudo apt install libreoffice" },
    ffmpeg: { darwin: "brew install ffmpeg", win32: "winget install Gyan.FFmpeg", linux: "sudo apt install ffmpeg" },
    tesseract: { darwin: "brew install tesseract", win32: "winget install UB-Mannheim.TesseractOCR", linux: "sudo apt install tesseract-ocr" },
    pandoc: { darwin: "brew install pandoc", win32: "winget install JohnMacFarlane.Pandoc", linux: "sudo apt install pandoc" },
  };
  return hints[id][platform] ?? hints[id].linux;
}

export function detectOptionalComponents(options: DetectorOptions = {}): OptionalComponentStatus[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((command: string) => pathWhich(command, env, exists));
  const runVersion = options.runVersion ?? defaultRunVersion;

  return specsFor(platform).map((spec) => {
    const path = [...(spec.paths?.(env) ?? []), ...spec.commands.map((command) => which(command)).filter(Boolean) as string[]].find((candidate) => exists(candidate) || !candidate.includes("/") && !candidate.includes("\\") ? false : exists(candidate));
    const commandPath = path ?? spec.commands.map((command) => which(command)).find(Boolean) ?? undefined;
    const executablePath = path ?? commandPath;
    if (!executablePath) {
      return {
        id: spec.id,
        name: spec.name,
        capability: spec.capability,
        state: "missing",
        homepageUrl: spec.homepageUrl,
        installHint: installHintFor(spec.id, platform),
        recommended: spec.recommended,
      };
    }
    return {
      id: spec.id,
      name: spec.name,
      capability: spec.capability,
      state: "available",
      executablePath,
      version: runVersion(executablePath, spec.versionArgs) ?? undefined,
      homepageUrl: spec.homepageUrl,
      installHint: installHintFor(spec.id, platform),
      recommended: spec.recommended,
    };
  });
}
```

During implementation, simplify the executable resolution loop if the pasted snippet is too dense; keep the tests above passing and avoid probing commands more than once.

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
npm run test -- --pool=threads --maxWorkers=1 --minWorkers=1 tests/optional-components.test.ts
```

Expected: pass.

---

## Task 2: Add Playwright Core Dependency and Browser Resolver

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/desktop/playwright-browser.ts`
- Test: `tests/playwright-browser.test.ts`

- [ ] **Step 1: Install dependency**

Run:

```bash
npm install playwright-core
```

Expected:
- `package.json` has `"playwright-core"` in `dependencies`.
- `package-lock.json` updates.
- No browser binaries are downloaded by npm install.

- [ ] **Step 2: Write failing resolver tests**

Add `tests/playwright-browser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolvePlaywrightBrowser } from "../src/desktop/playwright-browser.js";

describe("resolvePlaywrightBrowser", () => {
  it("uses Chrome executable path when Chrome is available", () => {
    expect(
      resolvePlaywrightBrowser([
        {
          id: "browser-chrome",
          name: "Google Chrome",
          capability: "browser-automation",
          state: "available",
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          recommended: true,
        },
      ]),
    ).toEqual({
      browser: "chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      launchMode: "system",
    });
  });

  it("falls back to Edge before Chromium", () => {
    const result = resolvePlaywrightBrowser([
      { id: "browser-chromium", name: "Chromium", capability: "browser-automation", state: "available", executablePath: "/usr/bin/chromium" },
      { id: "browser-edge", name: "Microsoft Edge", capability: "browser-automation", state: "available", executablePath: "/usr/bin/msedge" },
    ]);
    expect(result?.browser).toBe("edge");
  });
});
```

- [ ] **Step 3: Implement resolver**

Create `src/desktop/playwright-browser.ts`:

```ts
import type { OptionalComponentStatus } from "./optional-components.js";

export type PlaywrightBrowserResolution =
  | { browser: "chrome" | "edge" | "chromium"; executablePath: string; launchMode: "system" }
  | null;

const ORDER = ["browser-chrome", "browser-edge", "browser-chromium"] as const;

export function resolvePlaywrightBrowser(
  components: readonly OptionalComponentStatus[],
): PlaywrightBrowserResolution {
  for (const id of ORDER) {
    const found = components.find((component) => component.id === id);
    if (found?.state === "available" && found.executablePath) {
      return {
        browser:
          id === "browser-chrome" ? "chrome" : id === "browser-edge" ? "edge" : "chromium",
        executablePath: found.executablePath,
        launchMode: "system",
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test -- --pool=threads --maxWorkers=1 --minWorkers=1 tests/playwright-browser.test.ts
```

Expected: pass.

---

## Task 3: Expose Optional Components Through Desktop RPC

**Files:**
- Modify: `desktop/src/protocol.ts`
- Modify: `src/cli/commands/desktop.ts`
- Test: `tests/desktop-optional-components.test.ts`

- [ ] **Step 1: Write protocol-level test**

Create `tests/desktop-optional-components.test.ts` with a direct unit test for event payload shape if there is no existing easy harness:

```ts
import { describe, expect, it } from "vitest";
import { detectOptionalComponents } from "../src/desktop/optional-components.js";

describe("desktop optional component payload", () => {
  it("returns stable component ids for the settings UI", () => {
    const ids = detectOptionalComponents({
      platform: "linux",
      env: { PATH: "" },
      exists: () => false,
      which: () => null,
      runVersion: () => null,
    }).map((component) => component.id);

    expect(ids).toEqual([
      "browser-chrome",
      "browser-edge",
      "browser-chromium",
      "libreoffice",
      "ffmpeg",
      "tesseract",
      "pandoc",
    ]);
  });
});
```

- [ ] **Step 2: Update `desktop/src/protocol.ts`**

Add:

```ts
export type OptionalComponentStatus = {
  id:
    | "browser-chrome"
    | "browser-edge"
    | "browser-chromium"
    | "libreoffice"
    | "ffmpeg"
    | "tesseract"
    | "pandoc";
  name: string;
  capability:
    | "browser-automation"
    | "office-preview"
    | "media-processing"
    | "ocr"
    | "document-conversion";
  state: "available" | "missing" | "unsupported";
  version?: string;
  executablePath?: string;
  homepageUrl?: string;
  installHint?: string;
  recommended?: boolean;
};

export type OptionalComponentsEvent = {
  type: "$optional_components";
  items: OptionalComponentStatus[];
};
```

Add `OptionalComponentsEvent` to `IncomingEvent`.

Add:

```ts
| { cmd: "optional_components_get" }
```

to `OutgoingCommand`.

- [ ] **Step 3: Update backend event emission**

In `src/cli/commands/desktop.ts`:

```ts
import { detectOptionalComponents } from "../../desktop/optional-components.js";
import { resolvePlaywrightBrowser } from "../../desktop/playwright-browser.js";
```

Add helper:

```ts
function emitOptionalComponents(tab: Tab): void {
  const items = detectOptionalComponents();
  emit({ type: "$optional_components", items }, tab.id);
}
```

In `emitSettings(tab)`, include:

```ts
const optionalComponents = detectOptionalComponents();
const browserResolution = resolvePlaywrightBrowser(optionalComponents);
```

Then emit:

```ts
browserAutomation: browserResolution
  ? {
      state: "available",
      browser: browserResolution.browser,
      name: optionalComponents.find((c) => c.executablePath === browserResolution.executablePath)?.name ?? browserResolution.browser,
      executablePath: browserResolution.executablePath,
      launchMode: browserResolution.launchMode,
    }
  : { state: "unavailable", reason: "no-browser" },
optionalComponents,
```

Add message handler:

```ts
if (msg.cmd === "optional_components_get") {
  emitOptionalComponents(tab);
  return;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test -- --pool=threads --maxWorkers=1 --minWorkers=1 tests/desktop-optional-components.test.ts
npm run typecheck
```

Expected: pass.

---

## Task 4: Add Settings Optional Components Page

**Files:**
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/ui/settings.tsx`
- Test: `desktop/src/ui/optional-components.test.tsx`
- Test: `desktop/src/ui/settings.test.tsx`

- [ ] **Step 1: Write UI tests**

Create `desktop/src/ui/optional-components.test.tsx`:

```tsx
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OptionalComponentsList } from "./settings";

describe("OptionalComponentsList", () => {
  it("shows available browser automation component details", () => {
    render(
      <OptionalComponentsList
        items={[
          {
            id: "browser-chrome",
            name: "Google Chrome",
            capability: "browser-automation",
            state: "available",
            executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            recommended: true,
          },
        ]}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText("Google Chrome")).toBeTruthy();
    expect(screen.getByText(/available|已安装/i)).toBeTruthy();
    expect(screen.getByText("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBeTruthy();
  });

  it("shows install hint for missing Chromium", () => {
    render(
      <OptionalComponentsList
        items={[
          {
            id: "browser-chromium",
            name: "Chromium",
            capability: "browser-automation",
            state: "missing",
            installHint: "npm exec playwright install chromium",
            homepageUrl: "https://playwright.dev/docs/browsers",
          },
        ]}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText("Chromium")).toBeTruthy();
    expect(screen.getByText("npm exec playwright install chromium")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Update settings page metadata**

In `desktop/src/ui/settings.tsx`, add page id:

```ts
export type PageId =
  | "general"
  | "models"
  | "rules"
  | "mcp"
  | "skills"
  | "components"
  | "memory"
  | "archives"
  | "storage"
  | "appearance"
  | "billing"
  | "shortcuts";
```

Add metadata:

```ts
{ id: "components", icon: "cpu" },
```

Place it after `skills` or after `mcp`; recommended: after `skills`.

- [ ] **Step 3: Add Settings props**

Add:

```ts
optionalComponents: OptionalComponentStatus[];
onRefreshOptionalComponents: () => void;
```

to `SettingsModal` props.

- [ ] **Step 4: Implement exported `OptionalComponentsList`**

In `desktop/src/ui/settings.tsx`:

```tsx
export function OptionalComponentsList({
  items,
  onRefresh,
}: {
  items: OptionalComponentStatus[];
  onRefresh: () => void;
}) {
  return (
    <section className="section">
      <div className="settings-section-head">
        <div>
          <div className="stitle">{t("settings.optionalComponentsTitle")}</div>
          <div className="muted">{t("settings.optionalComponentsHint")}</div>
        </div>
        <button type="button" className="btn" onClick={onRefresh}>
          {t("settings.optionalComponentsRefresh")}
        </button>
      </div>
      <div className="skill-root-grid">
        {items.map((item) => (
          <div className="scard skill-root" key={item.id}>
            <div className="top">
              <span className="ico"><I.cpu size={14} /></span>
              <div className="mcp-spec-body">
                <div className="nm">
                  {item.name}
                  {item.recommended ? <span className="status-pill" data-status="configured">{t("settings.optionalComponentRecommended")}</span> : null}
                </div>
                <div className="sub">{t(`settings.optionalCapability.${item.capability}` as never)}</div>
              </div>
              <span className="status-pill" data-status={item.state === "available" ? "connected" : "configured"}>
                {item.state === "available" ? t("settings.optionalComponentAvailable") : t("settings.optionalComponentMissing")}
              </span>
            </div>
            {item.version ? <div className="desc">{item.version}</div> : null}
            {item.executablePath ? <div className="mono-path">{item.executablePath}</div> : null}
            {item.installHint ? <div className="mono-path">{item.installHint}</div> : null}
            {item.homepageUrl ? (
              <button type="button" className="btn" onClick={() => void openUrl(item.homepageUrl!)}>
                {t("settings.optionalComponentOpenInstall")}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
```

If the current translation helper does not accept dynamic nested keys, replace `t(...)` with a local `capabilityLabel()` switch.

- [ ] **Step 5: Add page component**

```tsx
function PageOptionalComponents({
  items,
  onRefresh,
}: {
  items: OptionalComponentStatus[];
  onRefresh: () => void;
}) {
  return <OptionalComponentsList items={items} onRefresh={onRefresh} />;
}
```

Render when `page === "components"`.

Remove `BrowserAutomationSection` from `PageMcp` / Integrations after the new page displays browser components. Do not keep duplicate status in two pages.

- [ ] **Step 6: Update App state and refresh command**

In `desktop/src/App.tsx`, add state:

```ts
optionalComponents: [],
```

Handle event:

```ts
case "$optional_components":
  return { ...state, optionalComponents: ev.items };
```

When applying `$settings`, set:

```ts
optionalComponents: ev.optionalComponents ?? state.optionalComponents,
```

Pass:

```tsx
optionalComponents={state.optionalComponents}
onRefreshOptionalComponents={() => sendRpc({ cmd: "optional_components_get" })}
```

to `SettingsModal`.

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test -- --pool=threads --maxWorkers=1 --minWorkers=1 desktop/src/ui/optional-components.test.tsx desktop/src/ui/settings.test.tsx
npm run typecheck
```

Expected: pass.

---

## Task 5: Add I18n Copy

**Files:**
- Modify: `desktop/src/i18n/en.ts`
- Modify: `desktop/src/i18n/zh-CN.ts`
- Modify: `desktop/src/i18n/ja.ts`
- Modify: `desktop/src/i18n/de.ts`

- [ ] **Step 1: Add English and Chinese first**

English:

```ts
pageComponentsLabel: "Optional Components",
pageComponentsDesc: "Browser automation, document preview, OCR, and media helpers",
optionalComponentsTitle: "Optional components",
optionalComponentsHint: "Jupiter uses installed system components when available. Nothing here is bundled unless you install it yourself.",
optionalComponentsRefresh: "Refresh",
optionalComponentRecommended: "recommended",
optionalComponentAvailable: "installed",
optionalComponentMissing: "not installed",
optionalComponentOpenInstall: "Open install page",
optionalCapabilityBrowserAutomation: "Browser automation",
optionalCapabilityOfficePreview: "Office preview",
optionalCapabilityMediaProcessing: "Media processing",
optionalCapabilityOcr: "OCR",
optionalCapabilityDocumentConversion: "Document conversion",
```

Chinese:

```ts
pageComponentsLabel: "可选组件",
pageComponentsDesc: "浏览器自动化、文档预览、OCR 和媒体处理",
optionalComponentsTitle: "可选组件",
optionalComponentsHint: "Jupiter 会优先使用系统里已经安装的组件；除非你主动安装，否则不会把这些组件打进安装包。",
optionalComponentsRefresh: "重新检测",
optionalComponentRecommended: "推荐",
optionalComponentAvailable: "已安装",
optionalComponentMissing: "未安装",
optionalComponentOpenInstall: "打开安装页",
optionalCapabilityBrowserAutomation: "浏览器自动化",
optionalCapabilityOfficePreview: "Office 预览",
optionalCapabilityMediaProcessing: "媒体处理",
optionalCapabilityOcr: "OCR",
optionalCapabilityDocumentConversion: "文档转换",
```

- [ ] **Step 2: Add Japanese and German**

Use concise equivalent translations. If unsure, copy English strings for technical terms like OCR and FFmpeg rather than inventing wording.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

---

## Task 6: Verification and Manual QA

**Files:**
- No new files unless tests reveal issues.

- [ ] **Step 1: Run focused tests**

```bash
npm run test -- --pool=threads --maxWorkers=1 --minWorkers=1 tests/optional-components.test.ts tests/playwright-browser.test.ts tests/desktop-optional-components.test.ts desktop/src/ui/optional-components.test.tsx desktop/src/ui/settings.test.tsx
```

Expected: pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Run diff check**

```bash
git diff --check -- src/desktop/optional-components.ts src/desktop/playwright-browser.ts src/cli/commands/desktop.ts desktop/src/protocol.ts desktop/src/App.tsx desktop/src/ui/settings.tsx desktop/src/i18n/en.ts desktop/src/i18n/zh-CN.ts desktop/src/i18n/ja.ts desktop/src/i18n/de.ts package.json package-lock.json
```

Expected: no output.

- [ ] **Step 4: Manual desktop check**

Run:

```bash
npm --prefix desktop run tauri -- dev
```

Manual expected behavior:
- Settings sidebar has "Optional Components" / "可选组件".
- Page lists Chrome, Edge, Chromium, LibreOffice, FFmpeg, Tesseract, and Pandoc.
- Installed Chrome or Edge shows `installed` and executable path.
- Missing Chromium shows install hint rather than silently failing.
- Integrations page no longer duplicates the browser automation block.
- Browser automation status in Settings still reports available when Chrome/Edge exists.

---

## Self-Review

Spec coverage:
- Chrome/Edge automatic enablement: covered by Task 1 and Task 2.
- No bundled Chromium: covered by scope and dependency choice (`playwright-core` only).
- Settings page for installable components: covered by Task 4 and Task 5.
- Other useful components: LibreOffice, FFmpeg, Tesseract, Pandoc covered by Task 1 and UI list.

Placeholder scan:
- No TBD/TODO placeholders remain.
- System package installation is explicitly out of scope for first version.

Type consistency:
- `OptionalComponentStatus` is defined in backend and mirrored in desktop protocol.
- Browser resolver consumes the backend status shape.
- Settings page consumes protocol status shape.


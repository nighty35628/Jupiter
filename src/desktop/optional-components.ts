import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

function pathWhich(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | null {
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
    return (
      execFileSync(path, args, {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)[0]
        ?.trim() || null
    );
  } catch {
    return null;
  }
}

function browserChromeSpec(platform: NodeJS.Platform): ComponentSpec {
  return {
    id: "browser-chrome",
    name: "Google Chrome",
    capability: "browser-automation",
    recommended: true,
    commands:
      platform === "win32"
        ? ["chrome.exe", "chrome"]
        : ["google-chrome", "google-chrome-stable", "chrome"],
    paths: (env) =>
      platform === "darwin"
        ? unique([
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            env.HOME && `${env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
          ])
        : platform === "win32"
          ? unique([
              env.ProgramFiles && `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
              env["ProgramFiles(x86)"] &&
                `${env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
              env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            ])
          : [],
    homepageUrl: "https://www.google.com/chrome/",
  };
}

function browserEdgeSpec(platform: NodeJS.Platform): ComponentSpec {
  return {
    id: "browser-edge",
    name: "Microsoft Edge",
    capability: "browser-automation",
    recommended: true,
    commands:
      platform === "win32"
        ? ["msedge.exe", "msedge"]
        : ["microsoft-edge", "microsoft-edge-stable", "msedge"],
    paths: (env) =>
      platform === "darwin"
        ? unique([
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            env.HOME && `${env.HOME}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
          ])
        : platform === "win32"
          ? unique([
              env.ProgramFiles && `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
              env["ProgramFiles(x86)"] &&
                `${env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
              env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
            ])
          : [],
    homepageUrl: "https://www.microsoft.com/edge/download",
  };
}

function specsFor(platform: NodeJS.Platform): ComponentSpec[] {
  return [
    browserChromeSpec(platform),
    browserEdgeSpec(platform),
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
    {
      id: "ffmpeg",
      name: "FFmpeg",
      capability: "media-processing",
      commands: ["ffmpeg"],
      homepageUrl: "https://ffmpeg.org/download.html",
    },
    {
      id: "tesseract",
      name: "Tesseract OCR",
      capability: "ocr",
      commands: ["tesseract"],
      homepageUrl: "https://tesseract-ocr.github.io/",
    },
    {
      id: "pandoc",
      name: "Pandoc",
      capability: "document-conversion",
      commands: ["pandoc"],
      homepageUrl: "https://pandoc.org/installing.html",
    },
  ];
}

export function installHintFor(
  id: OptionalComponentId,
  platform: NodeJS.Platform = process.platform,
): string {
  const hints: Record<OptionalComponentId, Record<string, string>> = {
    "browser-chrome": {
      darwin: "Download Chrome from google.com/chrome.",
      win32: "winget install Google.Chrome",
      linux: "Install google-chrome-stable from Google's Linux repository.",
    },
    "browser-edge": {
      darwin: "Download Edge from microsoft.com/edge/download.",
      win32: "winget install Microsoft.Edge",
      linux: "Install microsoft-edge-stable from Microsoft's Linux repository.",
    },
    "browser-chromium": {
      darwin: "npm exec playwright install chromium",
      win32: "npm exec playwright install chromium",
      linux: "Use your package manager, or run npm exec playwright install chromium.",
    },
    libreoffice: {
      darwin: "brew install --cask libreoffice",
      win32: "winget install TheDocumentFoundation.LibreOffice",
      linux: "sudo apt install libreoffice",
    },
    ffmpeg: {
      darwin: "brew install ffmpeg",
      win32: "winget install Gyan.FFmpeg",
      linux: "sudo apt install ffmpeg",
    },
    tesseract: {
      darwin: "brew install tesseract",
      win32: "winget install UB-Mannheim.TesseractOCR",
      linux: "sudo apt install tesseract-ocr",
    },
    pandoc: {
      darwin: "brew install pandoc",
      win32: "winget install JohnMacFarlane.Pandoc",
      linux: "sudo apt install pandoc",
    },
  };
  return hints[id][platform] ?? hints[id].linux ?? "";
}

function resolveExecutable(
  spec: ComponentSpec,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  which: (command: string) => string | null,
): string | undefined {
  for (const path of spec.paths?.(env) ?? []) {
    if (exists(path)) return path;
  }
  for (const command of spec.commands) {
    const path = which(command);
    if (path) return path;
  }
  return undefined;
}

export function detectOptionalComponents(options: DetectorOptions = {}): OptionalComponentStatus[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((command: string) => pathWhich(command, env, exists));
  const runVersion = options.runVersion ?? defaultRunVersion;

  return specsFor(platform).map((spec) => {
    const executablePath = resolveExecutable(spec, env, exists, which);
    const base = {
      id: spec.id,
      name: spec.name,
      capability: spec.capability,
      homepageUrl: spec.homepageUrl,
      installHint: installHintFor(spec.id, platform),
      recommended: spec.recommended,
    };
    if (!executablePath) {
      return {
        ...base,
        state: "missing" as const,
      };
    }
    return {
      ...base,
      state: "available" as const,
      executablePath,
      version: runVersion(executablePath, spec.versionArgs) ?? undefined,
    };
  });
}

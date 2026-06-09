import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type BrowserAutomationBrowser = "chrome" | "edge" | "chromium";

export type BrowserAutomationStatus =
  | {
      state: "available";
      browser: BrowserAutomationBrowser;
      name: string;
      executablePath: string;
    }
  | { state: "unavailable" };

type DetectorPlatform = NodeJS.Platform;

type DetectorOptions = {
  platform?: DetectorPlatform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  which?: (command: string) => string | null;
};

type BrowserCandidate = {
  browser: BrowserAutomationBrowser;
  name: string;
  paths?: string[];
  commands?: string[];
};

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function pathWhich(command: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean) {
  const pathVar = env.PATH || env.Path || "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, command);
    if (exists(full)) return full;
  }
  return null;
}

function macCandidates(env: NodeJS.ProcessEnv): BrowserCandidate[] {
  const home = env.HOME;
  return [
    {
      browser: "chrome",
      name: "Google Chrome",
      paths: unique([
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        home && `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      ]),
      commands: ["google-chrome", "chrome"],
    },
    {
      browser: "edge",
      name: "Microsoft Edge",
      paths: unique([
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        home && `${home}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
      ]),
      commands: ["microsoft-edge", "msedge"],
    },
  ];
}

function windowsCandidates(env: NodeJS.ProcessEnv): BrowserCandidate[] {
  const programFiles = env.ProgramFiles;
  const programFilesX86 = env["ProgramFiles(x86)"];
  const localAppData = env.LOCALAPPDATA;
  return [
    {
      browser: "edge",
      name: "Microsoft Edge",
      paths: unique([
        programFilesX86 && `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        programFiles && `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        localAppData && `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]),
      commands: ["msedge.exe", "msedge"],
    },
    {
      browser: "chrome",
      name: "Google Chrome",
      paths: unique([
        programFiles && `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        programFilesX86 && `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
        localAppData && `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      ]),
      commands: ["chrome.exe", "chrome"],
    },
  ];
}

function linuxCandidates(): BrowserCandidate[] {
  return [
    {
      browser: "chrome",
      name: "Google Chrome",
      commands: ["google-chrome", "google-chrome-stable", "chrome"],
    },
    {
      browser: "chromium",
      name: "Chromium",
      commands: ["chromium", "chromium-browser"],
    },
    {
      browser: "edge",
      name: "Microsoft Edge",
      commands: ["microsoft-edge", "microsoft-edge-stable", "msedge"],
    },
  ];
}

function candidatesFor(platform: DetectorPlatform, env: NodeJS.ProcessEnv): BrowserCandidate[] {
  if (platform === "darwin") return macCandidates(env);
  if (platform === "win32") return windowsCandidates(env);
  return linuxCandidates();
}

export function detectBrowserAutomation(options: DetectorOptions = {}): BrowserAutomationStatus {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((command: string) => pathWhich(command, env, exists));

  for (const candidate of candidatesFor(platform, env)) {
    for (const path of candidate.paths ?? []) {
      if (exists(path)) {
        return {
          state: "available",
          browser: candidate.browser,
          name: candidate.name,
          executablePath: path,
        };
      }
    }
    for (const command of candidate.commands ?? []) {
      const executablePath = which(command);
      if (executablePath) {
        return {
          state: "available",
          browser: candidate.browser,
          name: candidate.name,
          executablePath,
        };
      }
    }
  }

  return { state: "unavailable" };
}

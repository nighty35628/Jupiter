import { loadDesktopUpdateConfig } from "../config.js";
import { compareVersions } from "../version.js";

export type DesktopUpdateSource = "gitee" | "github";

export const DESKTOP_UPDATE_RELEASE_URLS: Record<DesktopUpdateSource, string> = {
  gitee: "https://gitee.com/nighty35628/jupiter/releases",
  github: "https://github.com/nighty35628/Jupiter/releases/latest",
};

const RELEASE_APIS: Array<{ source: DesktopUpdateSource; url: string }> = [
  {
    source: "gitee",
    url: "https://gitee.com/api/v5/repos/nighty35628/jupiter/releases/latest",
  },
  {
    source: "github",
    url: "https://api.github.com/repos/nighty35628/Jupiter/releases/latest",
  },
];

export type DesktopUpdateCheckMode = "auto" | "manual";

export type DesktopUpdateCheckResult =
  | {
      status: "available";
      mode: DesktopUpdateCheckMode;
      currentVersion: string;
      latestVersion: string;
      releaseTag: string;
      releaseName?: string;
      source: DesktopUpdateSource;
      releaseUrls: Record<DesktopUpdateSource, string>;
    }
  | {
      status: "up_to_date";
      mode: DesktopUpdateCheckMode;
      currentVersion: string;
      latestVersion: string;
      releaseTag?: string;
      source?: DesktopUpdateSource;
      releaseUrls: Record<DesktopUpdateSource, string>;
    }
  | {
      status: "suppressed";
      mode: DesktopUpdateCheckMode;
      reason: "disabled" | "skipped";
      currentVersion: string;
      latestVersion?: string;
      releaseTag?: string;
      source?: DesktopUpdateSource;
      releaseUrls: Record<DesktopUpdateSource, string>;
    }
  | {
      status: "error";
      mode: DesktopUpdateCheckMode;
      currentVersion: string;
      message: string;
      releaseUrls: Record<DesktopUpdateSource, string>;
    };

interface ReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
}

interface LatestRelease {
  source: DesktopUpdateSource;
  tag: string;
  version: string;
  name?: string;
}

export interface CheckDesktopUpdateOptions {
  currentVersion: string;
  configPath?: string;
  fetchImpl?: typeof fetch;
  manual?: boolean;
}

export function normalizeReleaseVersion(raw: string): string {
  return raw
    .trim()
    .replace(/^desktop-v/i, "")
    .replace(/^v/i, "");
}

async function fetchLatestRelease(fetchImpl: typeof fetch): Promise<LatestRelease | null> {
  const releases: LatestRelease[] = [];
  for (const endpoint of RELEASE_APIS) {
    try {
      const res = await fetchImpl(endpoint.url, {
        headers: {
          accept: "application/json",
          "user-agent": "Jupiter Update Check",
        },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as ReleasePayload;
      const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : "";
      if (!tag) continue;
      const version = normalizeReleaseVersion(tag);
      if (!version) continue;
      releases.push({
        source: endpoint.source,
        tag,
        version,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
      });
    } catch {}
  }
  return releases.reduce<LatestRelease | null>((best, release) => {
    if (!best) return release;
    return compareVersions(release.version, best.version) > 0 ? release : best;
  }, null);
}

export async function checkDesktopUpdate(
  opts: CheckDesktopUpdateOptions,
): Promise<DesktopUpdateCheckResult> {
  const mode: DesktopUpdateCheckMode = opts.manual ? "manual" : "auto";
  const currentVersion = normalizeReleaseVersion(opts.currentVersion);
  const config = loadDesktopUpdateConfig(opts.configPath);
  if (!opts.manual && config.disabled) {
    return {
      status: "suppressed",
      mode,
      reason: "disabled",
      currentVersion,
      releaseUrls: DESKTOP_UPDATE_RELEASE_URLS,
    };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return {
      status: "error",
      mode,
      currentVersion,
      message: "fetch is not available",
      releaseUrls: DESKTOP_UPDATE_RELEASE_URLS,
    };
  }

  const latest = await fetchLatestRelease(fetchImpl);
  if (!latest) {
    return {
      status: "error",
      mode,
      currentVersion,
      message: "release channel is unreachable",
      releaseUrls: DESKTOP_UPDATE_RELEASE_URLS,
    };
  }

  const diff = compareVersions(currentVersion, latest.version);
  if (diff >= 0) {
    return {
      status: "up_to_date",
      mode,
      currentVersion,
      latestVersion: latest.version,
      releaseTag: latest.tag,
      source: latest.source,
      releaseUrls: DESKTOP_UPDATE_RELEASE_URLS,
    };
  }

  if (!opts.manual && config.skippedVersion === latest.version) {
    return {
      status: "suppressed",
      mode,
      reason: "skipped",
      currentVersion,
      latestVersion: latest.version,
      releaseTag: latest.tag,
      source: latest.source,
      releaseUrls: DESKTOP_UPDATE_RELEASE_URLS,
    };
  }

  return {
    status: "available",
    mode,
    currentVersion,
    latestVersion: latest.version,
    releaseTag: latest.tag,
    releaseName: latest.name,
    source: latest.source,
    releaseUrls: DESKTOP_UPDATE_RELEASE_URLS,
  };
}

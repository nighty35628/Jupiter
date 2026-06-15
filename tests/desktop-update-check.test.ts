import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableDesktopUpdatePrompts,
  loadDesktopUpdateConfig,
  skipDesktopUpdateVersion,
} from "../src/config.js";
import {
  DESKTOP_UPDATE_RELEASE_URLS,
  checkDesktopUpdate,
  normalizeReleaseVersion,
} from "../src/desktop/update-check.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("desktop release update checks", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jupiter-desktop-update-"));
    configPath = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes desktop release tags to semantic versions", () => {
    expect(normalizeReleaseVersion("desktop-v0.99.10")).toBe("0.99.10");
    expect(normalizeReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeReleaseVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  it("reports a newer release and falls back from Gitee to GitHub when needed", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("gitee.com/api/")) return jsonResponse({ error: "offline" }, 502);
      return jsonResponse({
        tag_name: "desktop-v0.99.10",
        name: "Jupiter Desktop 0.99.10",
        html_url: "https://github.com/nighty35628/Jupiter/releases/tag/desktop-v0.99.10",
      });
    }) as typeof fetch;

    const result = await checkDesktopUpdate({
      currentVersion: "0.99.9",
      configPath,
      fetchImpl,
      manual: false,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "available",
      currentVersion: "0.99.9",
      latestVersion: "0.99.10",
      releaseTag: "desktop-v0.99.10",
      source: "github",
      releaseUrls: DESKTOP_UPDATE_RELEASE_URLS,
    });
  });

  it("uses the newest reachable release when mirrors are out of sync", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("gitee.com/api/")) {
        return jsonResponse({
          tag_name: "desktop-v0.99.3",
          name: "Jupiter Desktop 0.99.3",
        });
      }
      return jsonResponse({
        tag_name: "desktop-v0.99.10",
        name: "Jupiter Desktop 0.99.10",
      });
    }) as typeof fetch;

    const result = await checkDesktopUpdate({
      currentVersion: "0.99.9",
      configPath,
      fetchImpl,
      manual: false,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "available",
      latestVersion: "0.99.10",
      source: "github",
    });
  });

  it("does not let a hung mirror block the other release source", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("gitee.com/api/")) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return jsonResponse({
        tag_name: "desktop-v0.99.10",
        name: "Jupiter Desktop 0.99.10",
        html_url: "https://github.com/nighty35628/Jupiter/releases/tag/desktop-v0.99.10",
      });
    }) as typeof fetch;

    const result = await checkDesktopUpdate({
      currentVersion: "0.99.9",
      configPath,
      fetchImpl,
      manual: true,
      fetchTimeoutMs: 25,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "available",
      latestVersion: "0.99.10",
      source: "github",
    });
  });

  it("suppresses automatic prompts for skipped versions but lets manual checks bypass that", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ tag_name: "desktop-v0.99.10", html_url: DESKTOP_UPDATE_RELEASE_URLS.gitee }),
    ) as typeof fetch;
    skipDesktopUpdateVersion("0.99.10", configPath);

    const automatic = await checkDesktopUpdate({
      currentVersion: "0.99.9",
      configPath,
      fetchImpl,
      manual: false,
    });
    const manual = await checkDesktopUpdate({
      currentVersion: "0.99.9",
      configPath,
      fetchImpl,
      manual: true,
    });

    expect(automatic).toMatchObject({ status: "suppressed", reason: "skipped" });
    expect(manual).toMatchObject({ status: "available", latestVersion: "0.99.10" });
  });

  it("does not call the network for disabled automatic prompts", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ tag_name: "desktop-v0.99.10", html_url: DESKTOP_UPDATE_RELEASE_URLS.gitee }),
    ) as typeof fetch;
    disableDesktopUpdatePrompts(configPath);

    const automatic = await checkDesktopUpdate({
      currentVersion: "0.99.9",
      configPath,
      fetchImpl,
      manual: false,
    });

    expect(automatic).toMatchObject({ status: "suppressed", reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadDesktopUpdateConfig(configPath)).toMatchObject({ disabled: true });
  });
});

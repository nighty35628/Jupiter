// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AboutModal } from "./about";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AboutModal", () => {
  it("shows the NightyTech developer line", () => {
    vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

    render(
      <AboutModal
        onClose={() => undefined}
        updateCheck={{ status: "idle", currentVersion: "0.0.0-test", mode: "manual" }}
        onCheckUpdates={() => undefined}
        onOpenRelease={() => undefined}
      />,
    );

    expect(screen.getByText(/nightytech/i)).toBeTruthy();
  });

  it("offers Gitee and GitHub release buttons when a manual check finds an update", () => {
    vi.stubGlobal("__APP_VERSION__", "0.99.9");
    const onCheckUpdates = vi.fn();
    const onOpenRelease = vi.fn();

    render(
      <AboutModal
        onClose={() => undefined}
        updateCheck={{
          type: "$update_check",
          status: "available",
          mode: "manual",
          currentVersion: "0.99.9",
          latestVersion: "0.99.10",
          releaseUrls: {
            gitee: "https://gitee.com/nighty35628/jupiter/releases",
            github: "https://github.com/nighty35628/Jupiter/releases/latest",
          },
        }}
        onCheckUpdates={onCheckUpdates}
        onOpenRelease={onOpenRelease}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /check for updates|检查更新/i }));
    fireEvent.click(screen.getByRole("button", { name: /gitee/i }));
    fireEvent.click(screen.getByRole("button", { name: /github/i }));

    expect(onCheckUpdates).toHaveBeenCalledWith(true);
    expect(onOpenRelease).toHaveBeenCalledWith("gitee");
    expect(onOpenRelease).toHaveBeenCalledWith("github");
  });
});

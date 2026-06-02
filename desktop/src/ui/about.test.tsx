// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AboutModal } from "./about";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AboutModal", () => {
  it("shows the NightyTech developer line", () => {
    vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

    render(<AboutModal onClose={() => undefined} />);

    expect(screen.getByText(/nightytech/i)).toBeTruthy();
  });
});

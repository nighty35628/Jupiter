// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSessionError, authenticateWebSession } from "../dashboard/src/lib/runtime-transport";
import { WebSessionGate } from "../dashboard/src/web-session-gate";
import { setLang } from "../desktop/src/i18n";

vi.mock("../dashboard/src/lib/runtime-transport", () => ({
  authenticateWebSession: vi.fn(),
  WebSessionError: class extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  setLang("en");
});
afterEach(cleanup);

describe("Web pairing entry", () => {
  it("mounts the shared app only after authentication", async () => {
    let complete!: () => void;
    vi.mocked(authenticateWebSession).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    render(
      <WebSessionGate>
        <div>Shared Jupiter app</div>
      </WebSessionGate>,
    );
    expect(screen.queryByText("Shared Jupiter app")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Connecting...");
    complete();
    expect(await screen.findByText("Shared Jupiter app")).toBeTruthy();
  });

  it("offers pairing instead of a misleading desktop backend error, then opens the app", async () => {
    vi.mocked(authenticateWebSession).mockRejectedValueOnce(new WebSessionError("required"));
    render(
      <WebSessionGate>
        <div>Shared Jupiter app</div>
      </WebSessionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Pair this browser" })).toBeTruthy();
    expect(screen.queryByText("Shared Jupiter app")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("not paired");
    expect(
      (screen.getByRole("button", { name: "Connect", exact: true }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Pairing link"), {
      target: { value: "http://localhost/#bootstrap=example-token-1234" },
    });
    vi.mocked(authenticateWebSession).mockResolvedValueOnce();
    fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
    expect(await screen.findByText("Shared Jupiter app")).toBeTruthy();
    expect(authenticateWebSession).toHaveBeenLastCalledWith(
      "http://localhost/#bootstrap=example-token-1234",
    );
  });

  it("shows a recoverable connection error and retries without mounting the app early", async () => {
    vi.mocked(authenticateWebSession).mockRejectedValueOnce(new Error("network failure"));
    render(
      <WebSessionGate>
        <div>Shared Jupiter app</div>
      </WebSessionGate>,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Web service"));
    vi.mocked(authenticateWebSession).mockResolvedValueOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Shared Jupiter app")).toBeTruthy();
    expect(authenticateWebSession).toHaveBeenLastCalledWith(undefined);
  });

  it("retains the link and an inline error when pairing fails", async () => {
    vi.mocked(authenticateWebSession).mockRejectedValueOnce(new WebSessionError("required"));
    render(
      <WebSessionGate>
        <div>Shared Jupiter app</div>
      </WebSessionGate>,
    );
    const input = (await screen.findByLabelText("Pairing link")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "invalid link" } });
    vi.mocked(authenticateWebSession).mockRejectedValueOnce(new WebSessionError("invalidLink"));
    fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("complete pairing link"),
    );
    expect(input.value).toBe("invalid link");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});

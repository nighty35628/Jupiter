// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlanProgressOverlay } from "./plan-progress-overlay";
vi.mock("../Markdown", () => ({
  Markdown: ({ source }: { source: string }) => <div>{source}</div>,
}));
afterEach(cleanup);
it("keeps its disclosure state through live progress updates", () => {
  const plan = {
    plan: "Test plan",
    steps: [
      { id: "a", title: "Inspect", action: "read" },
      { id: "b", title: "Verify", action: "test" },
    ],
    completedStepIds: [] as string[],
    stepResults: {},
  };
  const { rerender } = render(<PlanProgressOverlay plan={plan} />);
  const toggle = screen.getByRole("button");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByRole("list")).toBeTruthy();
  rerender(<PlanProgressOverlay plan={{ ...plan, completedStepIds: ["a"] }} />);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("1/2")).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.queryByRole("list")).toBeNull();
});

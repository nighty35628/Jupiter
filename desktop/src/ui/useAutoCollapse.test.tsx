// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCollapse } from "./useAutoCollapse";

function CollapseProbe({ defaultCollapsed = false }: { defaultCollapsed?: boolean }) {
  const { collapsed } = useAutoCollapse("jupiter.testCollapsed", defaultCollapsed);
  return <div>{collapsed ? "collapsed" : "open"}</div>;
}

describe("useAutoCollapse", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("can default a panel to collapsed when no user preference exists", () => {
    render(<CollapseProbe defaultCollapsed />);
    expect(screen.getByText("collapsed")).toBeTruthy();
  });

  it("lets an explicit saved preference override the default", () => {
    localStorage.setItem("jupiter.testCollapsed", "0");
    render(<CollapseProbe defaultCollapsed />);
    expect(screen.getByText("open")).toBeTruthy();
  });
});

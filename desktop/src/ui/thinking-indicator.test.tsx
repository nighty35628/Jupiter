// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { ThinkingBottomIndicator } from "./thinking-indicator";

afterEach(() => {
  cleanup();
  setLang("en");
});

describe("ThinkingBottomIndicator", () => {
  it("shows a bottom status while the main turn is busy", () => {
    setLang("zh-CN");

    render(<ThinkingBottomIndicator active />);

    expect(screen.getByRole("status").textContent).toBe("正在思考");
  });

  it("keeps the visible footer label generic even when transient tool status is present", () => {
    render(<ThinkingBottomIndicator active label="tool result uploaded" />);

    expect(screen.getByRole("status").textContent).toBe("Thinking");
  });

  it("does not render when the main turn is idle", () => {
    render(<ThinkingBottomIndicator active={false} />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not replay an entrance animation during streaming rerenders", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const indicatorRule = css.match(
      /\.thread-thinking-indicator\s*\{[^}]*\}/,
    )?.[0];

    expect(indicatorRule).toBeTruthy();
    expect(indicatorRule).not.toMatch(/\banimation\s*:/);
  });

  it("reserves enough footer height so the status pill is not clipped by the composer", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const spacerRule = css.match(/\.thread-bottom-spacer\s*\{[^}]*\}/)?.[0];

    expect(spacerRule).toBeTruthy();
    expect(spacerRule).toMatch(/height:\s*5[0-9]px/);
    expect(spacerRule).toMatch(/min-height:\s*5[0-9]px/);
    expect(spacerRule).toMatch(/box-sizing:\s*border-box/);
  });
});

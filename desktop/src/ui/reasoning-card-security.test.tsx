// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReasoningCard } from "./cards";

afterEach(() => cleanup());

describe("ReasoningCard safe inline formatting", () => {
  it("renders HTML-like model output as text while preserving code and bold styling", () => {
    const malicious =
      '<img src=x onerror="globalThis.pwned=true"> **bold <svg onload="pwn()">** `code <script>alert(1)</script>`';
    const { container } = render(<ReasoningCard text={malicious} streaming={false} defaultOpen />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const bold = container.querySelector("strong");
    expect(bold?.querySelector("svg")).toBeNull();
    expect(bold?.textContent).toBe('bold <svg onload="pwn()">');
    expect(container.querySelector(".hl")?.textContent).toBe("code <script>alert(1)</script>");
    expect(container.textContent).toContain('<img src=x onerror="globalThis.pwned=true">');
  });

  it("keeps unmatched formatting delimiters as literal text", () => {
    const { container } = render(
      <ReasoningCard text="unfinished `code and **bold" streaming defaultOpen />,
    );

    expect(container.querySelector(".hl")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("unfinished `code and **bold");
  });
});

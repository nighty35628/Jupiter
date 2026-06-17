// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkillCard } from "./cards";

describe("SkillCard", () => {
  it("shows a dedicated skill usage card for run_skill calls", () => {
    render(
      <SkillCard
        skillName="superpowers:systematic-debugging"
        argumentsSummary="先查清楚为什么渲染没有走 file pill 路径。"
        status="running"
      />,
    );

    expect(screen.getByText(/Using skill|使用技能/)).toBeTruthy();
    expect(screen.getByText("superpowers:systematic-debugging")).toBeTruthy();
    expect(screen.getByText("先查清楚为什么渲染没有走 file pill 路径。")).toBeTruthy();
  });
});

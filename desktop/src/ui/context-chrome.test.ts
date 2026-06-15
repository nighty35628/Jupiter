import { describe, expect, it } from "vitest";
import {
  nextContextInfoToggle,
  nextContextSidebarToggle,
  nextContextTabOpenVisibility,
  nextSideChatSend,
} from "./context-chrome";

describe("nextContextInfoToggle", () => {
  it("opens the info popover and collapses the right sidebar when the sidebar is open", () => {
    expect(nextContextInfoToggle({ infoOpen: false, sidebarCollapsed: false })).toEqual({
      infoOpen: true,
      collapseSidebar: true,
    });
  });

  it("closes the info popover without changing the right sidebar", () => {
    expect(nextContextInfoToggle({ infoOpen: true, sidebarCollapsed: false })).toEqual({
      infoOpen: false,
      collapseSidebar: false,
    });
  });
});

describe("nextContextSidebarToggle", () => {
  it("expands the right sidebar and closes the info popover when the popover is open", () => {
    expect(nextContextSidebarToggle({ infoOpen: true, sidebarCollapsed: true })).toEqual({
      panelMode: null,
      infoOpen: false,
    });
  });

  it("collapses the right sidebar without changing the info popover", () => {
    expect(nextContextSidebarToggle({ infoOpen: true, sidebarCollapsed: false })).toEqual({
      panelMode: null,
      infoOpen: true,
    });
  });
});

describe("nextContextTabOpenVisibility", () => {
  it("moves context-tab content back to the right sidebar when the bottom panel is open", () => {
    expect(
      nextContextTabOpenVisibility({
        bottomCollapsed: false,
        sidebarCollapsed: true,
        infoOpen: true,
      }),
    ).toEqual({
      collapseBottom: true,
      expandSidebar: true,
      infoOpen: false,
    });
  });

  it("keeps an already visible right sidebar in place", () => {
    expect(
      nextContextTabOpenVisibility({
        bottomCollapsed: true,
        sidebarCollapsed: false,
        infoOpen: false,
      }),
    ).toEqual({
      collapseBottom: false,
      expandSidebar: false,
      infoOpen: false,
    });
  });
});

describe("nextSideChatSend", () => {
  it("prepares a blank-slate side chat question without turning it into main input", () => {
    expect(nextSideChatSend({ text: "  what is this API?  ", ready: true })).toEqual({
      question: "what is this API?",
    });
  });

  it("keeps side chat independent of main session busy state", () => {
    expect(nextSideChatSend({ text: "follow up now", ready: true })).toEqual({
      question: "follow up now",
    });
  });

  it("ignores empty or unavailable side chat sends", () => {
    expect(nextSideChatSend({ text: "   ", ready: true })).toBeNull();
    expect(nextSideChatSend({ text: "hello", ready: false })).toBeNull();
  });
});

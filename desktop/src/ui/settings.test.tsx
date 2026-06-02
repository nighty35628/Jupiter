// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings as SettingsType, UsageStats } from "../App";
import { SettingsModal } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

const settings: SettingsType = {
  reasoningEffort: "high",
  editMode: "review",
  budgetUsd: null,
  workspaceDir: "/tmp/Jupiter",
  recentWorkspaces: ["/tmp/Jupiter"],
  model: "deepseek-v4-flash",
  version: "0.0.0-test",
};

const usage: UsageStats = {
  totalCostUsd: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  lastCallCacheHit: null,
  lastCallCacheMiss: null,
  reservedTokens: 0,
  liveLogTokens: 0,
};

function renderSettings(onOpenAbout = vi.fn()) {
  render(
    <SettingsModal
      settings={settings}
      balance={null}
      usage={usage}
      currency="USD"
      theme="dark"
      themeStyle="graphite"
      onSetTheme={vi.fn()}
      onSetThemeStyle={vi.fn()}
      fontScale="medium"
      onSetFontScale={vi.fn()}
      fontFamily="sans"
      onSetFontFamily={vi.fn()}
      customFontFamily=""
      onSetCustomFontFamily={vi.fn()}
      mcpSpecs={[]}
      mcpBridged={false}
      skills={[]}
      skillRoots={[]}
      memory={[]}
      memoryDetail={null}
      qq={null}
      onClose={vi.fn()}
      onSave={vi.fn()}
      onSaveApiKey={vi.fn()}
      onLoadQQ={vi.fn()}
      onConnectQQ={vi.fn()}
      onDisconnectQQ={vi.fn()}
      onSaveQQConfig={vi.fn()}
      onOpenQQApplyLink={vi.fn()}
      onPickWorkspace={vi.fn()}
      onAddMcpSpec={vi.fn()}
      onRemoveMcpSpec={vi.fn()}
      onEnableMcpSpec={vi.fn()}
      onDisableMcpSpec={vi.fn()}
      onReconnectMcpSpecs={vi.fn()}
      onAddSkillPath={vi.fn()}
      onRemoveSkillPath={vi.fn()}
      onCreateSkill={vi.fn()}
      onSetSkillModel={vi.fn()}
      onReadMemory={vi.fn()}
      onOpenAbout={onOpenAbout}
    />,
  );
}

describe("SettingsModal", () => {
  it("opens About from the general settings page", () => {
    const onOpenAbout = vi.fn();
    renderSettings(onOpenAbout);

    fireEvent.click(screen.getByRole("button", { name: /About Jupiter|关于 Jupiter/ }));

    expect(onOpenAbout).toHaveBeenCalledTimes(1);
  });
});

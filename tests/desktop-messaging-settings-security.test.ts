import { describe, expect, it } from "vitest";
import {
  buildDingTalkSettingsEvent,
  buildFeishuSettingsEvent,
  mergeDingTalkSettingsUpdate,
  mergeFeishuSettingsUpdate,
} from "../src/cli/commands/desktop.js";

describe("desktop messaging settings security", () => {
  it("emits only safe Feishu credential status", () => {
    const event = buildFeishuSettingsEvent(
      {
        appId: "cli_a1b2c3d4e5f6",
        appSecret: "feishu-secret-value",
        enabled: true,
        requireMentionInGroup: true,
      },
      { runtimeState: "connected" },
    );

    expect(event).toMatchObject({
      type: "$feishu_settings",
      configured: true,
      appIdPreview: "cli_a1b2...",
      runtimeState: "connected",
    });
    expect(event).not.toHaveProperty("appId");
    expect(event).not.toHaveProperty("appSecret");
    expect(JSON.stringify(event)).not.toContain("feishu-secret-value");
  });

  it("emits only safe DingTalk credential status", () => {
    const event = buildDingTalkSettingsEvent(
      {
        clientId: "ding-client-1234",
        clientSecret: "dingtalk-secret-value",
        enabled: false,
        requireMentionInGroup: false,
      },
      { runtimeState: "failed", lastError: "offline" },
    );

    expect(event).toMatchObject({
      type: "$dingtalk_settings",
      configured: true,
      clientIdPreview: "ding-cli...",
      runtimeState: "failed",
      lastError: "offline",
    });
    expect(event).not.toHaveProperty("clientId");
    expect(event).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(event)).not.toContain("dingtalk-secret-value");
  });

  it("keeps stored Feishu credentials when update fields are blank", () => {
    expect(
      mergeFeishuSettingsUpdate(
        {
          appId: "existing-app-id",
          appSecret: "existing-secret",
          enabled: true,
          requireMentionInGroup: true,
        },
        { appId: " ", appSecret: "", requireMentionInGroup: false },
      ),
    ).toEqual({
      appId: "existing-app-id",
      appSecret: "existing-secret",
      enabled: true,
      requireMentionInGroup: false,
    });
  });

  it("trims replacements and keeps stored DingTalk credentials when omitted", () => {
    expect(
      mergeDingTalkSettingsUpdate(
        {
          clientId: "existing-client",
          clientSecret: "existing-secret",
          enabled: true,
          requireMentionInGroup: true,
        },
        { clientId: "  replacement-client  ", clientSecret: undefined },
      ),
    ).toEqual({
      clientId: "replacement-client",
      clientSecret: "existing-secret",
      enabled: true,
      requireMentionInGroup: true,
    });
  });
});

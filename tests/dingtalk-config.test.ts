import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDingTalkConfig, saveDingTalkConfig } from "../src/config.js";

describe("DingTalk config", () => {
  let dir: string;
  let path: string;
  const oldEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jupiter-dingtalk-config-"));
    path = join(dir, "config.json");
    process.env = { ...oldEnv };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = oldEnv;
  });

  it("loads saved DingTalk credentials and policy defaults", () => {
    saveDingTalkConfig(
      {
        clientId: "ding-cli",
        clientSecret: "secret",
        enabled: true,
        requireMentionInGroup: false,
      },
      path,
    );

    expect(loadDingTalkConfig(path)).toMatchObject({
      clientId: "ding-cli",
      clientSecret: "secret",
      enabled: true,
      requireMentionInGroup: false,
    });
  });

  it("lets environment credentials override saved credentials", () => {
    saveDingTalkConfig({ clientId: "from-config", clientSecret: "from-config-secret" }, path);
    process.env.DINGTALK_CLIENT_ID = "from-env";
    process.env.DINGTALK_CLIENT_SECRET = "from-env-secret";

    expect(loadDingTalkConfig(path)).toMatchObject({
      clientId: "from-env",
      clientSecret: "from-env-secret",
      requireMentionInGroup: true,
    });
  });

  it("also accepts AppKey-style environment aliases", () => {
    process.env.DINGTALK_APP_KEY = "app-key";
    process.env.DINGTALK_APP_SECRET = "app-secret";

    expect(loadDingTalkConfig(path)).toMatchObject({
      clientId: "app-key",
      clientSecret: "app-secret",
    });
  });
});

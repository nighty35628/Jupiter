import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFeishuConfig, saveFeishuConfig } from "../src/config.js";

describe("Feishu config", () => {
  let dir: string;
  let path: string;
  const oldEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jupiter-feishu-config-"));
    path = join(dir, "config.json");
    process.env = { ...oldEnv };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = oldEnv;
  });

  it("loads saved Feishu credentials and policy defaults", () => {
    saveFeishuConfig(
      {
        appId: "cli_a",
        appSecret: "secret",
        enabled: true,
        requireMentionInGroup: false,
      },
      path,
    );

    expect(loadFeishuConfig(path)).toMatchObject({
      appId: "cli_a",
      appSecret: "secret",
      enabled: true,
      requireMentionInGroup: false,
    });
  });

  it("lets environment credentials override saved credentials", () => {
    saveFeishuConfig({ appId: "from-config", appSecret: "from-config-secret" }, path);
    process.env.FEISHU_APP_ID = "from-env";
    process.env.FEISHU_APP_SECRET = "from-env-secret";

    expect(loadFeishuConfig(path)).toMatchObject({
      appId: "from-env",
      appSecret: "from-env-secret",
      requireMentionInGroup: true,
    });
  });
});

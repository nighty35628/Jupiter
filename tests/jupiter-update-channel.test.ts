import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const upstreamUpdaterHost = "pub-147fb53b9c1e4bbf891a257968619ea7.r2.dev";
const upstreamUpdaterPubkey =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI5RkE3RDJDQTgzMkFDNkMKUldSc3JES29MSDM2S1pwcjR2MnZZMW15eG5ydnQrRUJtdjdteFJiaHF6cnE0NzYyb09Wc2k0ZHEK";

describe("Jupiter update channel", () => {
  it("does not inherit the Jupiter updater endpoint or signing key", () => {
    const raw = readFileSync(resolve(__dirname, "../desktop/src-tauri/tauri.conf.json"), "utf8");
    const conf = JSON.parse(raw) as {
      bundle?: { createUpdaterArtifacts?: boolean };
      plugins?: { updater?: unknown };
    };

    expect(raw).not.toContain(upstreamUpdaterHost);
    expect(raw).not.toContain(upstreamUpdaterPubkey);
    expect(conf.bundle?.createUpdaterArtifacts).toBe(false);
    expect(conf.plugins?.updater).toBeUndefined();
  });

  it("does not expose updater permissions while Jupiter has no release channel", () => {
    const raw = readFileSync(
      resolve(__dirname, "../desktop/src-tauri/capabilities/default.json"),
      "utf8",
    );
    const caps = JSON.parse(raw) as { permissions?: Array<string | Record<string, unknown>> };

    expect(caps.permissions).not.toContain("updater:default");
  });
});

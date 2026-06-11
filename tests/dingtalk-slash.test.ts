import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSlash } from "../src/cli/ui/slash/dispatch.js";
import { setLanguageRuntime } from "../src/i18n/index.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../src/index.js";
import { ToolRegistry } from "../src/tools.js";

function makeLoop(): CacheFirstLoop {
  return new CacheFirstLoop({
    client: new DeepSeekClient({ apiKey: "sk-test" }),
    prefix: new ImmutablePrefix({ system: "s", toolSpecs: [] }),
    tools: new ToolRegistry(),
    maxToolIters: 1,
    stream: false,
  });
}

describe("/dingtalk slash handler", () => {
  const posts: string[] = [];

  beforeEach(() => {
    posts.length = 0;
    setLanguageRuntime("EN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLanguageRuntime("EN");
  });

  it("routes /dingtalk connect through the DingTalk host surface", async () => {
    const connect = vi.fn(async () => "DingTalk connected.");
    const result = handleSlash("dingtalk", ["connect", "client-id", "secret"], makeLoop(), {
      postInfo: (msg) => posts.push(msg),
      dingtalk: {
        connect,
        disconnect: async () => "",
        status: () => "",
      },
    });

    expect(result).toEqual({});
    await Promise.resolve();
    expect(connect).toHaveBeenCalledWith(["client-id", "secret"]);
    expect(posts).toContain("DingTalk: connecting…");
    expect(posts).toContain("DingTalk connected.");
  });

  it("returns compact usage for invalid subcommands", () => {
    const result = handleSlash("dingtalk", ["owner"], makeLoop(), {
      dingtalk: {
        connect: async () => "",
        disconnect: async () => "",
        status: () => "",
      },
    });

    expect(result.info).toBe(
      "Usage: /dingtalk connect [clientId clientSecret [mention|all]] | /dingtalk status | /dingtalk disconnect",
    );
  });

  it("bare /dingtalk status returns synchronously", () => {
    const result = handleSlash("dingtalk", ["status"], makeLoop(), {
      dingtalk: {
        connect: async () => "",
        disconnect: async () => "",
        status: () => "DingTalk: connected.",
      },
    });

    expect(result.info).toBe("DingTalk: connected.");
  });
});

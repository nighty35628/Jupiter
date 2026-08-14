import { describe, expect, it } from "vitest";
import { sanitizedChildProcessEnv } from "../src/security/child-process-env.js";
import { runCommand } from "../src/tools/shell.js";

describe("sanitizedChildProcessEnv", () => {
  it("removes provider credentials and credentialed URLs while preserving normal variables", () => {
    expect(
      sanitizedChildProcessEnv({
        PATH: "/usr/bin",
        DEEPSEEK_API_KEY: "secret",
        TELEGRAM_BOT_TOKEN: "token",
        FEISHU_APP_SECRET: "secret",
        HTTPS_PROXY: "https://user:pass@proxy.example",
        SAFE_ENDPOINT: "https://example.com/api",
        DATABASE_URL: "postgres://user:pass@example.com/db",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      SAFE_ENDPOINT: "https://example.com/api",
    });
  });

  it("does not expose provider keys to model-triggered commands", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "must-not-leak";
    try {
      const result = await runCommand(
        "node -e \"process.stdout.write(process.env.DEEPSEEK_API_KEY || 'absent')\"",
        { cwd: process.cwd() },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("absent");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "DEEPSEEK_API_KEY");
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("uses the same sanitized environment for command chains", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "must-not-leak";
    try {
      const result = await runCommand(
        "node -e \"process.stdout.write(process.env.DEEPSEEK_API_KEY || 'absent')\" && node -e \"process.stdout.write('/ok')\"",
        { cwd: process.cwd() },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("absent/ok");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "DEEPSEEK_API_KEY");
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});

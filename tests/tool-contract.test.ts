import { describe, expect, it } from "vitest";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { canonicalizeToolSpecs } from "../src/tool-contract.js";
import { ToolRegistry } from "../src/tools.js";
import type { ToolSpec } from "../src/types.js";

function tool(name: string, parameters: Record<string, unknown> = { type: "object" }): ToolSpec {
  return {
    type: "function",
    function: { name, description: "", parameters },
  };
}

describe("tool contract canonicalization", () => {
  it("sorts tool specs by name", () => {
    expect(canonicalizeToolSpecs([tool("write"), tool("read"), tool("search")])).toEqual([
      tool("read"),
      tool("search"),
      tool("write"),
    ]);
  });

  it("sorts nested schema object keys without changing array order", () => {
    const [spec] = canonicalizeToolSpecs([
      tool("read", {
        required: ["path", "encoding"],
        properties: {
          path: { description: "file", type: "string" },
          encoding: { type: "string", enum: ["utf8", "base64"] },
        },
        type: "object",
      }),
    ]);

    expect(JSON.stringify(spec!.function.parameters)).toBe(
      JSON.stringify({
        properties: {
          encoding: { enum: ["utf8", "base64"], type: "string" },
          path: { description: "file", type: "string" },
        },
        required: ["path", "encoding"],
        type: "object",
      }),
    );
  });

  it("makes registry specs stable across registration order", () => {
    const a = new ToolRegistry();
    a.register({ name: "write", fn: () => "ok" });
    a.register({ name: "read", fn: () => "ok" });

    const b = new ToolRegistry();
    b.register({ name: "read", fn: () => "ok" });
    b.register({ name: "write", fn: () => "ok" });

    expect(a.specs()).toEqual(b.specs());
  });

  it("makes prefix fingerprints stable across schema key order", () => {
    const a = new ImmutablePrefix({
      system: "s",
      toolSpecs: [
        tool("read", {
          type: "object",
          properties: { path: { type: "string" }, encoding: { type: "string" } },
        }),
      ],
    });
    const b = new ImmutablePrefix({
      system: "s",
      toolSpecs: [
        tool("read", {
          properties: { encoding: { type: "string" }, path: { type: "string" } },
          type: "object",
        }),
      ],
    });

    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("keeps ImmutablePrefix toolSpecs canonical after addTool", () => {
    const prefix = new ImmutablePrefix({ system: "s", toolSpecs: [tool("write")] });

    expect(prefix.addTool(tool("read"))).toBe(true);

    expect(prefix.toolSpecs.map((spec) => spec.function.name)).toEqual(["read", "write"]);
  });
});

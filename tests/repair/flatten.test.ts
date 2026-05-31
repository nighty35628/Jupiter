import { describe, expect, it } from "vitest";
import { analyzeSchema, flattenSchema, nestArguments } from "../../src/repair/flatten.js";

describe("analyzeSchema", () => {
  it("does not flatten flat shallow schemas", () => {
    const d = analyzeSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
    });
    expect(d.shouldFlatten).toBe(false);
  });

  it("flags deep schemas", () => {
    const d = analyzeSchema({
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            middle: {
              type: "object",
              properties: { leaf: { type: "string" } },
            },
          },
        },
      },
    });
    expect(d.shouldFlatten).toBe(true);
    expect(d.maxDepth).toBeGreaterThan(2);
  });

  it("flags wide schemas (>10 leaves)", () => {
    const props: Record<string, { type: string }> = {};
    for (let i = 0; i < 12; i++) props[`p${i}`] = { type: "string" };
    const d = analyzeSchema({ type: "object", properties: props });
    expect(d.shouldFlatten).toBe(true);
    expect(d.leafCount).toBe(12);
  });
});

describe("flattenSchema / nestArguments roundtrip", () => {
  it("flattens nested schema and re-nests arguments", () => {
    const schema = {
      type: "object",
      required: ["user"],
      properties: {
        user: {
          type: "object",
          required: ["profile"],
          properties: {
            profile: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" }, age: { type: "integer" } },
            },
          },
        },
      },
    };
    const flat = flattenSchema(schema);
    expect(flat.properties).toHaveProperty("user.profile.name");
    expect(flat.properties).toHaveProperty("user.profile.age");
    expect(flat.required).toEqual(["user.profile.name"]);

    const nested = nestArguments({
      "user.profile.name": "alice",
      "user.profile.age": 30,
    });
    expect(nested).toEqual({ user: { profile: { name: "alice", age: 30 } } });
  });
});

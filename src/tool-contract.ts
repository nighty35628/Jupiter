import type { JSONSchema, ToolSpec } from "./types.js";

const EMPTY_PARAMETERS: JSONSchema = { type: "object", properties: {} };

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry !== undefined) out[key] = canonicalizeJson(entry);
  }
  return out;
}

export function canonicalizeToolSpec(spec: ToolSpec): ToolSpec {
  return {
    type: "function",
    function: {
      name: spec.function.name,
      description: spec.function.description ?? "",
      parameters: canonicalizeJson(spec.function.parameters ?? EMPTY_PARAMETERS) as JSONSchema,
    },
  };
}

export function canonicalizeToolSpecs(specs: readonly ToolSpec[]): ToolSpec[] {
  return specs
    .map((spec) => canonicalizeToolSpec(spec))
    .sort((a, b) => {
      if (a.function.name < b.function.name) return -1;
      if (a.function.name > b.function.name) return 1;
      const aJson = JSON.stringify(a);
      const bJson = JSON.stringify(b);
      if (aJson < bJson) return -1;
      if (aJson > bJson) return 1;
      return 0;
    });
}

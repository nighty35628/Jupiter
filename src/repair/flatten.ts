/** DeepSeek drops args on schemas >2 levels deep or >10 leaves; flatten to dot-paths and re-nest after dispatch. */

import type { JSONSchema } from "../types.js";

export interface FlattenDecision {
  shouldFlatten: boolean;
  leafCount: number;
  maxDepth: number;
}

export function analyzeSchema(schema: JSONSchema | undefined): FlattenDecision {
  if (!schema) return { shouldFlatten: false, leafCount: 0, maxDepth: 0 };
  let leafCount = 0;
  let maxDepth = 0;
  walk(schema, 0, (depth, isLeaf) => {
    if (isLeaf) leafCount++;
    if (depth > maxDepth) maxDepth = depth;
  });
  return {
    shouldFlatten: leafCount > 10 || maxDepth > 2,
    leafCount,
    maxDepth,
  };
}

export function flattenSchema(schema: JSONSchema): JSONSchema {
  const flatProps: Record<string, JSONSchema> = {};
  const required: string[] = [];
  collect("", schema, flatProps, required, true);
  return {
    type: "object",
    properties: flatProps,
    required,
  };
}

export function nestArguments(flatArgs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flatArgs)) {
    setByPath(out, key.split("."), value);
  }
  return out;
}

function walk(
  schema: JSONSchema,
  depth: number,
  visit: (depth: number, isLeaf: boolean) => void,
): void {
  if (schema.type === "object" && schema.properties) {
    for (const child of Object.values(schema.properties)) {
      walk(child, depth + 1, visit);
    }
    return;
  }
  if (schema.type === "array" && schema.items) {
    walk(schema.items, depth + 1, visit);
    return;
  }
  visit(depth, true);
}

function collect(
  prefix: string,
  schema: JSONSchema,
  out: Record<string, JSONSchema>,
  required: string[],
  isRootRequired: boolean,
): void {
  if (schema.type === "object" && schema.properties) {
    const requiredSet = new Set(schema.required ?? []);
    for (const [key, child] of Object.entries(schema.properties)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      const childRequired = isRootRequired && requiredSet.has(key);
      collect(nextPrefix, child, out, required, childRequired);
    }
    return;
  }
  // Treat anything non-object (including arrays) as a leaf for flattening purposes.
  out[prefix] = schema;
  if (isRootRequired) required.push(prefix);
}

function setByPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: any = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]!] = value;
}

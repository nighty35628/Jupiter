import Fuse from "fuse.js";

function fieldText<T extends Record<string, unknown>>(item: T, key: keyof T): string {
  const value = item[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function includesQuery(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query);
}

export function rankItems<T extends Record<string, unknown>>(
  items: T[],
  query: string,
  keys: Array<keyof T>,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return items;

  const exactMatches = items.filter((item) =>
    keys.some((key) => includesQuery(fieldText(item, key), normalizedQuery)),
  );
  const exactSet = new Set(exactMatches);

  const fuse = new Fuse(items, {
    keys: keys as string[],
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
  });
  const fuzzyMatches = fuse
    .search(query)
    .map((result) => result.item)
    .filter((item) => !exactSet.has(item));

  return [...exactMatches, ...fuzzyMatches];
}

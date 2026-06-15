import { setLanguageRuntime } from "../src/i18n/index.js";

setLanguageRuntime("EN");

type StorageLike = Pick<Storage, "clear" | "getItem" | "key" | "removeItem" | "setItem"> & {
  readonly length: number;
};

function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

const storage = globalThis.localStorage as StorageLike | undefined;
if (
  !storage ||
  typeof storage.clear !== "function" ||
  typeof storage.getItem !== "function" ||
  typeof storage.setItem !== "function" ||
  typeof storage.removeItem !== "function"
) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
    writable: true,
  });
}

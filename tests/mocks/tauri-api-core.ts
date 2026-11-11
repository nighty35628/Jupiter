import { vi } from "vitest";
export const invoke = vi.fn();
export class Channel<T> {
  constructor(public onmessage: (message: T) => void = () => {}) {}
}
export const convertFileSrc = vi.fn(
  (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
);

import { vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;

const handlers = new Map<string, Handler[]>();

export const listen = vi.fn((event: string, handler: Handler) => {
  const list = handlers.get(event) ?? [];
  list.push(handler);
  handlers.set(event, list);
  return Promise.resolve(() => {
    const current = handlers.get(event) ?? [];
    handlers.set(
      event,
      current.filter((item) => item !== handler),
    );
  });
});

export function emitMockEvent(event: string, payload: unknown): void {
  for (const handler of handlers.get(event) ?? []) {
    handler({ payload });
  }
}

export function resetMockEvents(): void {
  handlers.clear();
  listen.mockClear();
}

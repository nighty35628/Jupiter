import { vi } from "vitest";

export const currentWindow = {
  label: "main",
  setTitle: vi.fn(),
  onCloseRequested: vi.fn(),
  outerPosition: vi.fn(() => Promise.resolve({ x: 100, y: 100 })),
  scaleFactor: vi.fn(() => Promise.resolve(1)),
  setPosition: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  hide: vi.fn(() => Promise.resolve()),
  unminimize: vi.fn(() => Promise.resolve()),
  setFocus: vi.fn(() => Promise.resolve()),
};

export const getCurrentWindow = vi.fn(() => currentWindow);

export class Window {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

export const WindowEvent = {};

export default {
  getCurrentWindow,
  Window,
};

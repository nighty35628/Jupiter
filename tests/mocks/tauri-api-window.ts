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

export const currentMonitor = vi.fn(() =>
  Promise.resolve({
    name: "Test display",
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    workArea: {
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1040 },
    },
    scaleFactor: 1,
  }),
);

export class Window {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

export const WindowEvent = {};

export default {
  currentMonitor,
  getCurrentWindow,
  Window,
};

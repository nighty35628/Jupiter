import { vi } from "vitest";

export const currentWindow = {
  label: "main",
  setTitle: vi.fn(),
  onCloseRequested: vi.fn(),
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

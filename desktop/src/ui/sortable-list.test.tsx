// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@dnd-kit/core", () => ({
  closestCenter: vi.fn(),
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
  verticalListSortingStrategy: {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: vi.fn(() => undefined) } },
}));

import { reorderItems, SortableList } from "./sortable-list";

afterEach(cleanup);

describe("reorderItems", () => {
  it("moves an item from one index to another", () => {
    expect(reorderItems(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("returns the same order when ids are missing", () => {
    expect(reorderItems(["a", "b"], "x", "b")).toEqual(["a", "b"]);
  });
});

describe("SortableList", () => {
  it("renders children in order", () => {
    render(
      <SortableList
        items={[
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ]}
        onReorder={vi.fn()}
        renderItem={(item) => <span>{item.label}</span>}
      />,
    );

    expect(screen.getAllByText(/Alpha|Beta/).map((node) => node.textContent)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});

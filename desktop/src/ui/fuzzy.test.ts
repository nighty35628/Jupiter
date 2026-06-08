import { describe, expect, it } from "vitest";
import { rankItems } from "./fuzzy";

describe("rankItems", () => {
  const items = [
    { id: "settings", label: "Settings", hint: "Open preferences" },
    { id: "files", label: "Files", hint: "Browse project files" },
    { id: "workspace", label: "Workspace", hint: "Open recent files" },
    { id: "side-chat", label: "侧边聊天", hint: "临时 session" },
  ];

  it("keeps original order for empty query", () => {
    expect(rankItems(items, "", ["label", "hint"]).map((x) => x.id)).toEqual([
      "settings",
      "files",
      "workspace",
      "side-chat",
    ]);
  });

  it("ranks label matches first", () => {
    expect(rankItems(items, "files", ["label", "hint"])[0]?.id).toBe("files");
  });

  it("ranks hint matches after label matches", () => {
    const result = rankItems(items, "files", ["label", "hint"]).map((x) => x.id);
    expect(result.indexOf("files")).toBeLessThan(result.indexOf("workspace"));
  });

  it("supports Chinese substring matches", () => {
    expect(rankItems(items, "聊天", ["label", "hint"])[0]?.id).toBe("side-chat");
  });
});

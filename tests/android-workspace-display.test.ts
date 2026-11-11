import { afterEach, describe, expect, it } from "vitest";
import {
  displayWorkspaceBasename,
  displayWorkspacePath,
  setWorkspaceDisplayNames,
} from "../desktop/src/workspace-display";

afterEach(() => setWorkspaceDisplayNames([]));

describe("Android imported project display names", { retry: 0 }, () => {
  it("uses host-provided names without changing the actual project path", () => {
    const root = "/workspaces/123e4567-e89b-12d3-a456-426614174000";
    setWorkspaceDisplayNames([{ root, name: "Imported project" }]);
    expect(displayWorkspaceBasename(root)).toBe("Imported project");
    expect(displayWorkspaceBasename(`${root}/`)).toBe("Imported project");
    expect(displayWorkspacePath(root)).toBe(root);
    expect(displayWorkspaceBasename(`${root}/src`)).toBe("src");
  });
  it("replaces the presentation cache and retains the normal Desktop fallback", () => {
    setWorkspaceDisplayNames([{ root: "/workspaces/project", name: "Old name" }]);
    setWorkspaceDisplayNames([{ root: "/workspaces/project", name: "New name" }]);
    expect(displayWorkspaceBasename("/workspaces/project")).toBe("New name");
    setWorkspaceDisplayNames([]);
    expect(displayWorkspaceBasename("/workspaces/project")).toBe("project");
    expect(displayWorkspaceBasename("/Users/test/Jupiter")).toBe("Jupiter");
    expect(displayWorkspaceBasename(undefined, "fallback")).toBe("fallback");
  });
});

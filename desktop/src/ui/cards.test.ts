import { describe, expect, it } from "vitest";
import { deriveToolEditPreview } from "./cards";

describe("deriveToolEditPreview", () => {
  it("summarizes edit_file additions and removals from args", () => {
    expect(
      deriveToolEditPreview(
        "edit_file",
        JSON.stringify({
          path: "desktop/src/i18n/en.ts",
          search: "old line\nsecond old line",
          replace: "new line\nsecond new line\nthird new line",
        }),
      ),
    ).toEqual({
      label: "en.ts",
      added: 3,
      removed: 2,
    });
  });

  it("summarizes write_file content from args", () => {
    expect(
      deriveToolEditPreview(
        "write_file",
        JSON.stringify({
          path: "src/index.html",
          content: "<main>\nhello\n</main>",
        }),
      ),
    ).toEqual({
      label: "index.html",
      added: 3,
      removed: 0,
    });
  });

  it("summarizes multi_edit across files", () => {
    expect(
      deriveToolEditPreview(
        "multi_edit",
        JSON.stringify({
          edits: [
            { path: "a.ts", search: "one", replace: "one\ntwo" },
            { path: "b.ts", search: "old\nmore", replace: "new" },
          ],
        }),
      ),
    ).toEqual({
      label: "2 files",
      added: 3,
      removed: 3,
    });
  });
});

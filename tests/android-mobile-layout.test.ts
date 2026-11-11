import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";

const css = parse(readFileSync(new URL("../desktop/src/styles.css", import.meta.url), "utf8"));
const android = 'html[data-host-platform="android"]';

function declarations(selector: string, mobile = false): Record<string, string> {
  const values: Record<string, string> = {};
  css.walkRules(selector, (rule) => {
    const parent = rule.parent;
    expect(parent?.type).toBe(mobile ? "atrule" : "root");
    if (parent?.type === "atrule") expect(parent.params).toBe("(max-width: 760px)");
    rule.walkDecls((decl) => {
      values[decl.prop] = decl.value;
    });
  });
  return values;
}

describe("shared workbench focus boundary", { retry: 0 }, () => {
  it("keeps clipped outer chrome from becoming a focus-scroll container", () => {
    expect(declarations("#root").overflow).toBe("clip");
  });
});

describe("Android-only mobile layout", () => {
  it("overrides full-width desktop buttons with natural-width, touch-sized scroll tabs", () => {
    expect(declarations(".settings-side button.row").width).toBe("100%");
    expect(declarations(`${android} .settings-side button.row`, true)).toMatchObject({
      width: "auto",
      flex: "0 0 auto",
      "white-space": "nowrap",
      "min-height": "48px",
      "min-width": "48px",
    });
    expect(declarations(`${android} .settings-side`, true)).toMatchObject({
      "min-width": "0",
      "overflow-y": "hidden",
      "align-items": "center",
    });
    expect(declarations(`${android} .settings`, true)["grid-template-rows"]).toBe(
      "auto minmax(0, 1fr)",
    );
    let scrollable = false;
    css.walkRules(".settings-side", (rule) => {
      if (rule.parent?.type !== "atrule" || rule.parent.params !== "(max-width: 760px)") return;
      rule.walkDecls("overflow-x", (decl) => {
        scrollable = decl.value === "auto";
      });
    });
    expect(scrollable).toBe(true);
  });

  it("reserves header space and touch targets without changing the browser or desktop header", () => {
    expect(declarations(`${android} .app`)["--web-title-height"]).toBe("50px");
    expect(declarations(`${android} .titlebar .iconbtn`)).toMatchObject({
      width: "48px",
      height: "48px",
      flex: "0 0 48px",
    });
    expect(declarations(`${android} .settings-head .close-btn`)).toMatchObject({
      width: "48px",
      height: "48px",
      flex: "0 0 48px",
    });
    expect(declarations(`${android} .settings-head > div`)).toMatchObject({
      "min-width": "0",
      "overflow-wrap": "anywhere",
    });
    expect(declarations(`${android} .titlebar .crumbs`, true).display).toBe("none");
  });

  it("makes General controls touch-sized and lets long segmented labels wrap on Android only", () => {
    expect(
      declarations(`${android} .settings :is(.btn, .field, .seg-ctrl button, .pet-toggle)`),
    ).toMatchObject({ "min-height": "48px", "min-width": "48px" });
    expect(declarations(`${android} .settings .seg-ctrl`)).toMatchObject({
      "flex-wrap": "wrap",
      "max-width": "100%",
    });
    expect(declarations(`${android} .settings .seg-ctrl button`)["white-space"]).toBe("normal");
  });
});

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../desktop/src/i18n";
import type { SettingsPatch } from "../desktop/src/protocol";
import { PageBilling, WebSearchSection } from "../desktop/src/ui/settings";
import { type UsageHistoryDay, aggregateUsageHistory } from "../src/telemetry/usage.js";

let root: TestRenderer.ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  setLang("en");
  vi.unstubAllGlobals();
});

describe("unknown service charge display", () => {
  it.each([0, 0.125])(
    "does not display unknown charges as a zero/free total (known subtotal %s)",
    async (subtotal) => {
      const month = aggregateUsageHistory([], { now: Date.UTC(2026, 9, 26), monthCount: 1 })
        .months[0]!;
      const day: UsageHistoryDay = {
        ...month.total,
        day: "2026-10-26",
        costUsd: subtotal,
        costKnown: false,
        unknownCostCalls: 1,
        serviceCalls: 1,
      };
      month.total = { ...day, day: month.month };
      month.days = [day];
      await act(async () => {
        root = TestRenderer.create(
          createElement(PageBilling, {
            balance: null,
            currency: "USD",
            usageHistory: {
              type: "$usage_history",
              generatedAt: 1,
              recordCount: 1,
              months: [month],
            },
          }),
        );
      });
      function content() {
        return JSON.stringify(root!.toJSON());
      }
      expect(content()).toContain(subtotal ? "$ 0.1250 + unknown" : "Unknown");
      expect(content()).not.toContain("$ 0.0000");
      for (const mode of ["Week", "Month"]) {
        const button = root!.root
          .findAllByType("button")
          .find((button) => button.children.includes(mode));
        expect(button).toBeDefined();
        await act(() => button!.props.onClick());
        expect(content()).toContain(subtotal ? "$ 0.1250 + unknown" : "Unknown");
        expect(content()).not.toContain("$ 0.0000");
      }
    },
  );
});

async function render(settings: object) {
  const onSave = vi.fn<(patch: SettingsPatch) => void>();
  await act(async () => {
    root = TestRenderer.create(
      createElement(WebSearchSection, {
        settings: settings as Parameters<typeof WebSearchSection>[0]["settings"],
        onSave,
      }),
    );
  });
  return { onSave, selects: root!.root.findAllByType("select") };
}

describe("independent web engine settings controls", () => {
  it("preserves defaults and submits the selected engine only", async () => {
    const { onSave, selects } = await render({});
    expect(selects.map((select) => select.props.value)).toEqual(["bing", "legacy"]);
    await act(() => selects[0]!.props.onChange({ target: { value: "deepseek" } }));
    expect(onSave).toHaveBeenLastCalledWith({ webSearchEngine: "deepseek" });
    await act(() => selects[1]!.props.onChange({ target: { value: "http" } }));
    expect(onSave).toHaveBeenLastCalledWith({ webFetchEngine: "http" });
  });

  it("keeps direct search and HTTP Fetch selected after refresh", async () => {
    const { selects } = await render({ webSearchEngine: "deepseek", webFetchEngine: "http" });
    expect(selects.map((select) => select.props.value)).toEqual(["deepseek", "http"]);
    expect(root!.root.findAllByType("input")).toHaveLength(1);
  });

  it("shows a dedicated DeepSeek key control for Fetch even when search uses Bing", async () => {
    await render({ webSearchEngine: "bing", webFetchEngine: "deepseek" });
    expect(root!.root.findAllByType("input")).toHaveLength(1);
    expect(JSON.stringify(root!.toJSON())).toContain(t("settings.webSearchApiKey.deepseek"));
  });

  it.each(["en", "zh-CN", "de", "ja"] as const)(
    "renders translated choices in %s",
    async (language) => {
      setLang(language);
      const { selects } = await render({});
      const options = selects[1]!.findAllByType("option");
      expect(options.map((option) => option.props.value)).toEqual([
        "legacy",
        "http",
        "ollama",
        "deepseek",
      ]);
      expect(options.every((option) => !String(option.children[0]).startsWith("settings."))).toBe(
        true,
      );
    },
  );
});

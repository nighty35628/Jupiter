import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Oklch = {
  l: number;
  c: number;
  h: number;
};

const STYLE_NAMES = ["porcelain", "sandstone", "graphite", "midnight"] as const;

function parseOklch(value: string): Oklch {
  const match = value.match(/oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)/);
  if (!match) throw new Error(`Expected oklch() color, got ${value}`);
  return {
    l: Number(match[1]) / 100,
    c: Number(match[2]),
    h: Number(match[3]),
  };
}

function oklchToLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const hue = (h * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);

  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = lPrime ** 3;
  const m3 = mPrime ** 3;
  const s3 = sPrime ** 3;

  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ].map((channel) => Math.max(0, Math.min(1, channel))) as [number, number, number];
}

function luminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Oklch, b: Oklch): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

function extractStyleTokens(css: string, style: string): Record<string, Oklch> {
  const refreshCss = css.split("/* Theme palette refresh */")[1];
  if (!refreshCss) throw new Error("Missing theme palette refresh block");
  const block = refreshCss.match(
    new RegExp(`\\[data-theme-style="${style}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  if (!block) throw new Error(`Missing ${style} theme block`);

  return Object.fromEntries(
    Array.from(block.matchAll(/--([\w-]+):\s*(oklch\([^)]+\));/g), ([, name, value]) => [
      name,
      parseOklch(value),
    ]),
  );
}

describe("theme palette contrast", () => {
  const css = readFileSync(join(process.cwd(), "desktop/src/styles.css"), "utf8");

  it.each(STYLE_NAMES)("keeps %s text readable across the main surfaces", (style) => {
    const tokens = extractStyleTokens(css, style);

    for (const surface of ["bg", "panel", "card"]) {
      expect(
        contrast(tokens.fg!, tokens[surface]!),
        `${style} fg on ${surface}`,
      ).toBeGreaterThanOrEqual(12);
      expect(
        contrast(tokens["fg-2"]!, tokens[surface]!),
        `${style} fg-2 on ${surface}`,
      ).toBeGreaterThanOrEqual(8);
      expect(
        contrast(tokens.muted!, tokens[surface]!),
        `${style} muted on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(tokens["muted-2"]!, tokens[surface]!),
        `${style} muted-2 on ${surface}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

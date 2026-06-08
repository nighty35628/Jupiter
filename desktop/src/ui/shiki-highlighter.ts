import type {
  HighlighterCore,
  LanguageRegistration,
  SpecialLanguage,
  ThemedToken,
  ThemeRegistrationRaw,
} from "shiki/core";

export type HighlightTheme = "light" | "dark";

export type HighlightToken = {
  content: string;
  color?: string;
  fontStyle?: number;
};

export type HighlightedLine = HighlightToken[];

const SHIKI_THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const satisfies Record<HighlightTheme, string>;

const SHIKI_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "css",
  "html",
  "bash",
  "python",
  "rust",
  "go",
  "text",
] as const satisfies ReadonlyArray<string | SpecialLanguage>;

const LANG_ALIASES: Record<string, (typeof SHIKI_LANGS)[number]> = {
  cjs: "javascript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  md: "markdown",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

function normalizeLang(lang: string): (typeof SHIKI_LANGS)[number] {
  const normalized = lang.trim().toLowerCase().replace(/^language-/, "");
  const alias = LANG_ALIASES[normalized];
  if (alias) return alias;
  return (SHIKI_LANGS as readonly string[]).includes(normalized)
    ? (normalized as (typeof SHIKI_LANGS)[number])
    : "text";
}

async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/langs/tsx.mjs"),
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/jsx.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/markdown.mjs"),
    import("shiki/langs/css.mjs"),
    import("shiki/langs/html.mjs"),
    import("shiki/langs/bash.mjs"),
    import("shiki/langs/python.mjs"),
    import("shiki/langs/rust.mjs"),
    import("shiki/langs/go.mjs"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ]).then(
    ([
      { createHighlighterCore },
      { createJavaScriptRegexEngine },
      typescript,
      tsx,
      javascript,
      jsx,
      json,
      markdown,
      css,
      html,
      bash,
      python,
      rust,
      go,
      githubLight,
      githubDark,
    ]) =>
      createHighlighterCore({
        engine: createJavaScriptRegexEngine(),
        langs: [
          ...typescript.default,
          ...tsx.default,
          ...javascript.default,
          ...jsx.default,
          ...json.default,
          ...markdown.default,
          ...css.default,
          ...html.default,
          ...bash.default,
          ...python.default,
          ...rust.default,
          ...go.default,
        ] satisfies LanguageRegistration[],
        themes: [
          githubLight.default,
          githubDark.default,
        ] satisfies ThemeRegistrationRaw[],
      }),
  );
  return highlighterPromise;
}

function toHighlightToken(token: ThemedToken): HighlightToken {
  return {
    content: token.content,
    color: token.color,
    fontStyle: token.fontStyle,
  };
}

export async function highlightCode(
  code: string,
  lang: string,
  theme: HighlightTheme,
): Promise<HighlightedLine[]> {
  const highlighter = await getHighlighter();
  const result = highlighter.codeToTokens(code, {
    lang: normalizeLang(lang),
    theme: SHIKI_THEMES[theme],
  });
  return result.tokens.map((line) => line.map(toHighlightToken));
}

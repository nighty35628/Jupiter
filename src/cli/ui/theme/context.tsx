import React from "react";
import {
  DEFAULT_THEME_NAME,
  THEMES,
  type ThemeName,
  type ThemeTokens,
  resolveThemeName,
  setActiveTheme,
} from "./tokens.js";

const ThemeContext = React.createContext<ThemeTokens>(THEMES[DEFAULT_THEME_NAME]);

export function ThemeProvider({
  children,
  name,
}: {
  children: React.ReactNode;
  name?: string | null;
}): React.ReactElement {
  const theme = THEMES[resolveThemeName(name)];
  const restoreActiveTheme = setActiveTheme(theme);

  React.useLayoutEffect(() => restoreActiveTheme, [restoreActiveTheme]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useThemeTokens(): ThemeTokens {
  return React.useContext(ThemeContext);
}

export function useTheme(): ThemeTokens {
  return useThemeTokens();
}

export type { ThemeName, ThemeTokens };

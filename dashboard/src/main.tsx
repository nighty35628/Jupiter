import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "../../desktop/src/styles.css";
import "katex/dist/katex.min.css";
import { createRoot } from "react-dom/client";
import { App } from "../../desktop/src/App";
import {
  THEME,
  defaultStyleForTheme,
  isTheme,
  isThemeStyle,
  themeForStyle,
} from "../../desktop/src/theme";
import { initializeWebSurface, runtimeMode } from "./lib/surface-capabilities";
import { WebSessionGate } from "./web-session-gate";

const stored = localStorage.getItem("jupiter.theme");
const storedStyle = localStorage.getItem("jupiter.themeStyle");
if (isThemeStyle(storedStyle)) {
  document.documentElement.dataset.themeStyle = storedStyle;
  document.documentElement.dataset.theme = themeForStyle(storedStyle);
} else if (isTheme(stored)) {
  document.documentElement.dataset.theme = stored;
  document.documentElement.dataset.themeStyle = defaultStyleForTheme(stored);
} else {
  document.documentElement.dataset.theme = THEME.LIGHT;
  document.documentElement.dataset.themeStyle = defaultStyleForTheme(THEME.LIGHT);
}

initializeWebSurface();

const platform = /Mac|macOS/i.test(navigator.userAgent)
  ? "macos"
  : /Windows/i.test(navigator.userAgent)
    ? "windows"
    : "default";
document.documentElement.dataset.platform = platform;
document.body.dataset.platform = platform;

const host = document.getElementById("root");
if (!host) throw new Error("#root missing");

createRoot(host).render(
  runtimeMode.mode === "web" ? <WebSessionGate><App /></WebSessionGate> : <App />,
);

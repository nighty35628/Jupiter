import { FitAddon } from "@xterm/addon-fit";
import type { ITerminalAddon } from "@xterm/xterm";
import { sanitizeUserUrl } from "./safe-content";

export type TerminalFitAddon = Pick<FitAddon, "fit">;

function canOpenLinks(): boolean {
  return typeof window !== "undefined" && typeof window.open === "function";
}

function canUseClipboard(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.clipboard);
}

export async function createTerminalAddons(): Promise<{
  addons: ITerminalAddon[];
  fitAddon: TerminalFitAddon | null;
}> {
  const fitAddon = new FitAddon();
  const addons: ITerminalAddon[] = [fitAddon];

  if (canOpenLinks()) {
    const { WebLinksAddon } = await import("@xterm/addon-web-links");
    addons.push(
      new WebLinksAddon((event, uri) => {
        const safeUri = sanitizeUserUrl(uri);
        if (!safeUri) return;
        event.preventDefault();
        window.open(safeUri, "_blank", "noopener,noreferrer");
      }),
    );
  }

  if (canUseClipboard()) {
    const { ClipboardAddon } = await import("@xterm/addon-clipboard");
    addons.push(new ClipboardAddon());
  }

  return { addons, fitAddon };
}

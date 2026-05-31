import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { render } from "ink";
import React from "react";
import { diffTranscripts, renderMarkdown, renderSummaryTable } from "../../transcript/diff.js";
import { readTranscript } from "../../transcript/log.js";
import { DiffApp } from "../ui/DiffApp.js";

export interface DiffOptions {
  a: string;
  b: string;
  mdPath?: string;
  labelA?: string;
  labelB?: string;
  /** Force stdout summary table (no Ink TUI). Auto when stdout isn't a TTY. */
  print?: boolean;
  /** Force the TUI even when stdout isn't a TTY (rare). */
  tui?: boolean;
}

export async function diffCommand(opts: DiffOptions): Promise<void> {
  const aParsed = readTranscript(opts.a);
  const bParsed = readTranscript(opts.b);

  const report = diffTranscripts(
    { label: opts.labelA ?? basename(opts.a), parsed: aParsed },
    { label: opts.labelB ?? basename(opts.b), parsed: bParsed },
  );

  const wantMarkdown = !!opts.mdPath;
  const wantPrint = opts.print || !process.stdout.isTTY;
  const wantTui = opts.tui || (!wantPrint && !wantMarkdown);

  if (wantMarkdown) {
    // Markdown export implies the user wants an artifact, not a TUI.
    // Still echo the stdout summary to confirm the action.
    console.log(renderSummaryTable(report));
    const md = renderMarkdown(report);
    writeFileSync(opts.mdPath!, md, "utf8");
    console.log(`\nmarkdown report written to ${opts.mdPath}`);
    return;
  }

  if (wantTui) {
    const { waitUntilExit } = render(React.createElement(DiffApp, { report }), {
      exitOnCtrlC: true,
      patchConsole: false,
    });
    await waitUntilExit();
    return;
  }

  // stdout fallback (piped, --print, or non-TTY)
  console.log(renderSummaryTable(report));
}

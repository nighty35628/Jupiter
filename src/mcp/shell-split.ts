/** Quote-aware argv split for `--mcp`; throws on unterminated quotes. NOT a full shell parser. */
export function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  const s = input;

  while (i < s.length) {
    const ch = s[i]!;

    if (quote) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      // backslash escapes inside double quotes only
      if (ch === "\\" && quote === '"' && i + 1 < s.length) {
        cur += s[i + 1];
        i += 2;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      i++;
      continue;
    }

    // Backslash escape ONLY applies inside double quotes (handled above).
    // Outside quotes, backslashes pass through literally — otherwise
    // Windows paths like `C:\path\to\exe` get mangled. POSIX users who
    // want to escape a space outside quotes can use single quotes instead.

    if (ch === " " || ch === "\t") {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      i++;
      continue;
    }

    cur += ch;
    i++;
  }

  if (quote) {
    throw new Error(
      `shellSplit: unterminated ${quote === '"' ? "double" : "single"} quote in input`,
    );
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

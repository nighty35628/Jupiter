/** Hardcoded — fetching this list at runtime would make `mcp list` flaky offline / behind proxies. */

export interface CatalogEntry {
  /** Short name, used as the namespace prefix when suggested. */
  name: string;
  /** One-line description shown in `jupiter mcp list`. */
  summary: string;
  /** npm package id (for `npx -y <pkg>`). */
  package: string;
  /** Extra args the user must supply (e.g. a directory path). */
  userArgs?: string;
  /** Notes the user needs to know — shown dimmed. */
  note?: string;
}

// Every entry below is verified to exist on npm as of this release.
// `fetch` and `sqlite` are deliberately *absent* — their reference
// servers are Python-only (`pip install mcp-server-fetch`), so a Node
// user running `npx -y @modelcontextprotocol/server-fetch` hits a 404
// from the npm registry. We'd rather ship a smaller list that always
// works than a longer list where two options silently 404 on the user.
export const MCP_CATALOG: CatalogEntry[] = [
  {
    name: "filesystem",
    summary: "read/write/search files inside a sandboxed directory",
    package: "@modelcontextprotocol/server-filesystem",
    userArgs: "<dir>",
    note: "the directory is a hard sandbox — the server refuses access outside it",
  },
  {
    name: "memory",
    summary: "persistent key-value memory across sessions",
    package: "@modelcontextprotocol/server-memory",
  },
  {
    name: "github",
    summary: "read issues, PRs, code search (needs GITHUB_PERSONAL_ACCESS_TOKEN)",
    package: "@modelcontextprotocol/server-github",
    note: "set GITHUB_PERSONAL_ACCESS_TOKEN in your env before spawning",
  },
  {
    name: "puppeteer",
    summary: "browser automation — take screenshots, click, type",
    package: "@modelcontextprotocol/server-puppeteer",
    note: "downloads Chromium on first run (~200 MB)",
  },
  {
    name: "everything",
    summary: "official test server — exercises every MCP feature",
    package: "@modelcontextprotocol/server-everything",
    note: "useful for debugging your Jupiter setup",
  },
];

export function mcpCommandFor(entry: CatalogEntry): string {
  const pkg = entry.package;
  const tail = entry.userArgs ? ` ${entry.userArgs}` : "";
  return `--mcp "${entry.name}=npx -y ${pkg}${tail}"`;
}

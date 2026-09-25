/**
 * MCP servers the agent knows how to set up, and when each one beats the
 * browser.
 *
 * The browser can reach anything a person can, which is exactly why it is
 * the slow way to reach a service that has an API: pages to load, sign-in
 * walls, markup to read, and an answer that breaks when the site is
 * redesigned. When a task lives on one of these services the agent offers
 * the server instead -- once, with the reason in one line -- and sets it up
 * if the person says yes (see `mcp_offer` in tools.ts).
 *
 * Every entry only runs through `npx` (Node is always there), so nothing
 * needs installing first. A key a server needs is named here, never stored
 * here: the offer card saves it to the secret store, and the config refers
 * to it as `${secret:NAME}`, resolved only at connect time (see mcp.ts).
 */

export interface CatalogNeed {
  /** The environment variable the server reads, and the secret it is kept as. */
  env: string;
  label: string;
  /** Where to get one. */
  url?: string;
  hint?: string;
}

export interface CatalogEntry {
  id: string;
  /** Server name, which becomes the tool prefix: mcp__<name>__<tool>. */
  name: string;
  title: string;
  /** What it gives the agent, in one line. */
  summary: string;
  /** Why this is better than doing it in the browser, in one line. */
  better: string;
  /** Words a request might use when this server would help. */
  keywords: string[];
  command: string;
  /** May contain ${param:NAME} (filled from the offer) and ${secret:NAME}. */
  args: string[];
  env?: Record<string, string>;
  needs?: CatalogNeed[];
  /** Values the agent fills in when offering (a directory, say). */
  params?: { name: string; label: string; fallback?: string }[];
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "github",
    name: "github",
    title: "GitHub",
    summary: "Issues, pull requests, repositories, files and code search through GitHub's API.",
    better: "Reads and changes issues and PRs directly instead of scraping github.com, with no sign-in page in the way.",
    keywords: ["github", "issue", "issues", "pull request", "pr", "repo", "repository", "commit", "branch", "code search"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:GITHUB_PERSONAL_ACCESS_TOKEN}" },
    needs: [{
      env: "GITHUB_PERSONAL_ACCESS_TOKEN",
      label: "GitHub personal access token",
      url: "https://github.com/settings/personal-access-tokens",
      hint: "github_pat_… or ghp_…",
    }],
  },
  {
    id: "slack",
    name: "slack",
    title: "Slack",
    summary: "Read channels and threads, post messages and reactions in a Slack workspace.",
    better: "Talks to Slack's API directly; the web app is heavy, slow to scroll and hard to read reliably.",
    keywords: ["slack", "channel", "workspace", "dm", "message my team"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "${secret:SLACK_BOT_TOKEN}", SLACK_TEAM_ID: "${secret:SLACK_TEAM_ID}" },
    needs: [
      { env: "SLACK_BOT_TOKEN", label: "Slack bot token", url: "https://api.slack.com/apps", hint: "xoxb-…" },
      { env: "SLACK_TEAM_ID", label: "Slack workspace (team) ID", hint: "T01234567" },
    ],
  },
  {
    id: "notion",
    name: "notion",
    title: "Notion",
    summary: "Search, read and edit Notion pages and databases.",
    better: "Works on pages and databases as data rather than clicking through Notion's editor.",
    keywords: ["notion", "wiki", "notion page", "notion database"],
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { NOTION_TOKEN: "${secret:NOTION_TOKEN}" },
    needs: [{
      env: "NOTION_TOKEN",
      label: "Notion integration token",
      url: "https://www.notion.so/profile/integrations",
      hint: "ntn_… (then share the pages with the integration)",
    }],
  },
  {
    id: "postgres",
    name: "postgres",
    title: "PostgreSQL",
    summary: "Read-only SQL against a Postgres database, with its schema.",
    better: "Queries the database itself instead of reading an admin web page or pasting results by hand.",
    keywords: ["postgres", "postgresql", "sql", "database", "query", "table", "schema"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "${secret:POSTGRES_URL}"],
    needs: [{
      env: "POSTGRES_URL",
      label: "Postgres connection URL",
      hint: "postgresql://user:password@host:5432/db",
    }],
  },
  {
    id: "brave-search",
    name: "brave_search",
    title: "Brave Search",
    summary: "Web and local search results as data from the Brave Search API.",
    better: "Search results arrive as clean data, not a results page to load and read (and no CAPTCHAs).",
    keywords: ["search the web", "look up", "news", "find online", "brave"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "${secret:BRAVE_API_KEY}" },
    needs: [{ env: "BRAVE_API_KEY", label: "Brave Search API key", url: "https://brave.com/search/api/" }],
  },
  {
    id: "google-maps",
    name: "google_maps",
    title: "Google Maps",
    summary: "Places, directions, distances and geocoding from the Google Maps API.",
    better: "Directions and places as exact data; the Maps site is a canvas the browser can barely read.",
    keywords: ["maps", "directions", "route", "distance", "address", "nearby", "restaurant near", "travel time"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    env: { GOOGLE_MAPS_API_KEY: "${secret:GOOGLE_MAPS_API_KEY}" },
    needs: [{
      env: "GOOGLE_MAPS_API_KEY",
      label: "Google Maps API key",
      url: "https://console.cloud.google.com/google/maps-apis/credentials",
    }],
  },
  {
    id: "context7",
    name: "context7",
    title: "Context7 docs",
    summary: "Current documentation and code examples for thousands of libraries and frameworks.",
    better: "Pulls the exact, current docs for a library in one call instead of browsing and reading docs sites.",
    keywords: ["documentation", "docs", "api reference", "library", "framework", "sdk", "how do i use", "npm package"],
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
  },
  {
    id: "filesystem",
    name: "filesystem",
    title: "Filesystem",
    summary: "Read, write, search and move files under one directory, and nowhere else.",
    better: "Scoped file access with structured edits, limited to the one folder you choose.",
    keywords: ["files", "folder", "directory", "documents"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "${param:path}"],
    params: [{ name: "path", label: "Directory it may use", fallback: "/data" }],
  },
  {
    id: "memory",
    name: "memory",
    title: "Knowledge graph memory",
    summary: "A separate knowledge-graph memory the agent can build and query.",
    better: "Keeps structured notes about entities and their relations.",
    keywords: ["knowledge graph"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "sequential-thinking",
    name: "sequential_thinking",
    title: "Sequential thinking",
    summary: "A structured tool for working through a problem step by step.",
    better: "Helps with long, branching reasoning.",
    keywords: ["think step by step", "plan"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  {
    id: "everything",
    name: "everything",
    title: "MCP test server",
    summary: "The MCP reference server: every feature, for testing a connection.",
    better: "Only for testing that MCP works here.",
    keywords: ["test mcp", "mcp test"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  const key = id.trim().toLowerCase();
  return CATALOG.find((e) => e.id === key || e.name === key || e.title.toLowerCase() === key);
}

/**
 * Catalog entries that fit a request, best first. Word matching, not
 * judgement: it narrows the list the agent reads, and the agent decides.
 */
export function matchCatalog(text: string, limit = 3): CatalogEntry[] {
  const q = ` ${text.toLowerCase().replace(/[^a-z0-9.]+/g, " ")} `;
  return CATALOG
    .map((entry) => ({
      entry,
      score: entry.keywords.reduce((n, k) => n + (q.includes(` ${k} `) ? (k.includes(" ") ? 2 : 1) : 0), 0) +
        (q.includes(` ${entry.id} `) || q.includes(` ${entry.title.toLowerCase()} `) ? 3 : 0),
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.entry);
}

/** Fill ${param:NAME} from what the offer supplied, or the entry's fallback. */
export function fillParams(entry: CatalogEntry, given: Record<string, string>): string[] {
  return entry.args.map((arg) => arg.replace(/\$\{param:([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const spec = entry.params?.find((p) => p.name === name);
    return (given[name] ?? "").trim() || spec?.fallback || "";
  }));
}

/** Secret names a config refers to, wherever it refers to them. */
export function secretRefs(values: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) for (const m of (v ?? "").matchAll(/\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1]);
  return [...out];
}

/**
 * What the agent can actually do.
 *
 * One registry, and it is the only answer to that question. The system prompt
 * is generated from it, the model's tool schemas are generated from it, the
 * Settings panel renders from it, and the executor dispatches through it. There
 * is deliberately no second list: the failure this module exists to end was a
 * console that advertised a terminal in its memory graph, described one in its
 * README, drew one in the transcript, and had no way to run a command.
 *
 * Four groups. The first three are three genuinely different machines:
 *
 *   terminal  -- the host Autora itself runs on. In the Umbrel container that
 *                is the container, and `sudo` there is usually unnecessary
 *                rather than unavailable.
 *   browser   -- a real Chromium this server drives (see ./browser.ts).
 *   computer  -- somebody's actual desktop, over the relay (see ./desktop.ts).
 *   memory    -- the workspace graph, which outlives the session.
 *
 * A group can be *off* (nobody turned it on) or *unavailable* (turned on, but
 * the thing it needs is not there -- no Chromium installed, no relay dialled
 * in). Those are different sentences and the agent is told which it is, because
 * "I can't browse" and "Chromium isn't installed on the server" send the reader
 * to two very different places.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GoogleGenAI } from "@google/genai";
import { mergeTools, save, state, allSecrets, secretFor, redactSecrets } from "./state";
import { probeBrowser, VIEWPORT, type LiveBrowser, type PageRead } from "./browser";
import { relayAction, relayConnected, relayStatus } from "./desktop";

// --------------------------------------------------------------- settings --

export type ApprovalMode = "always" | "risky" | "never";

export interface ToolSettings {
  terminal: {
    enabled: boolean;
    /** Where commands run. Empty means the server's own working directory. */
    cwd: string;
    /** Seconds before a command is killed. */
    timeout: number;
    approval: ApprovalMode;
    shell?: string;
  };
  browser: { enabled: boolean; approval: ApprovalMode };
  computer: { enabled: boolean; approval: ApprovalMode };
  memory: { enabled: boolean; approval: ApprovalMode };
}

export function toolSettings(): ToolSettings {
  return state.tools;
}

/** Apply a patch from the settings panel and persist it. The merge itself
    lives with the settings file, since the file needs the same validation. */
export function updateToolSettings(patch: any): ToolSettings {
  const next = mergeTools(state.tools, patch);
  save();
  return next;
}

// ------------------------------------------------------------- the registry --

export type ToolGroup = "terminal" | "browser" | "computer" | "memory";

export interface ToolSpec {
  name: string;
  group: ToolGroup;
  /** What the model is told this does. Written for the model, not the UI. */
  description: string;
  /** JSON Schema for the arguments. Every vendor accepts this shape. */
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  /** True for anything that changes the world rather than reading it. These
      are what `approval: "risky"` gates. */
  risky?: boolean;
}

const TOOLS: ToolSpec[] = [
  // ----------------------------------------------------------- terminal --
  {
    name: "terminal",
    group: "terminal",
    description:
      "Run a shell command on the machine Autora is running on and return its " +
      "output and exit code. Runs through `bash -lc`, so pipes, redirection, " +
      "`&&` and environment variables all work. This is a real shell on a real " +
      "host: it is not a sandbox and it is not a simulation. Output is streamed " +
      "into the conversation as it arrives, so the person watching sees the " +
      "command and its output as it runs. Not a terminal emulator -- there is no " +
      "TTY, so interactive programs (vim, `top`, a password prompt, anything " +
      "paging) will hang rather than work. Use non-interactive flags, and prefer " +
      "`sudo -n` so a password prompt fails fast instead of waiting.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line to run, exactly as you would type it.",
        },
        cwd: {
          type: "string",
          description:
            "Optional directory to run in. Defaults to the configured working " +
            "directory.",
        },
      },
      required: ["command"],
    },
    risky: true,
  },

  // ------------------------------------------------------------ browser --
  {
    name: "browser_open",
    group: "browser",
    description:
      "Open a URL in the agent's own Chromium and return the page as text, " +
      "along with its interactive elements numbered for clicking. The person " +
      "watching sees the page load live.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The address to open." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_read",
    group: "browser",
    description:
      "Re-read the page that is currently open: its text and its numbered " +
      "interactive elements. Use after something on the page has changed.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    group: "browser",
    description:
      "Click one of the numbered elements on the open page, then return the " +
      "page as it is afterwards. The numbers come from browser_open or " +
      "browser_read and change whenever the page does, so re-read rather than " +
      "reusing a number from earlier.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "integer",
          description: "The element number, as listed in the page outline.",
        },
      },
      required: ["ref"],
    },
    risky: true,
  },
  {
    name: "browser_fill",
    group: "browser",
    description:
      "Type into one or more numbered fields on the open page, optionally " +
      "submitting the form afterwards, then return the resulting page.",
    parameters: {
      type: "object",
      properties: {
        values: {
          type: "array",
          description: "The fields to fill and what to put in each.",
          items: {
            type: "object",
            properties: {
              ref: { type: "integer", description: "The field's element number." },
              text: { type: "string", description: "What to type into it." },
            },
            required: ["ref", "text"],
          },
        },
        submit: {
          type: "boolean",
          description: "Press Enter in the last field when done. Default false.",
        },
      },
      required: ["values"],
    },
    risky: true,
  },
  {
    name: "browser_scroll",
    group: "browser",
    description: "Scroll the open page and return what is visible afterwards.",
    parameters: {
      type: "object",
      properties: {
        dy: {
          type: "integer",
          description: "Pixels to scroll: positive is down, negative is up.",
        },
      },
    },
  },
  {
    name: "browser_back",
    group: "browser",
    description: "Go back one entry in the open page's history.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_screenshot",
    group: "browser",
    description:
      "Put a picture of the open page into the conversation, for the person to " +
      "look at. Use this when asked what something looks like -- the page text " +
      "you already have cannot answer that. You do not get the image back; it " +
      "goes to the person watching.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_handoff",
    group: "browser",
    description:
      "Transfer live browser control to the human watching. Call this when you encounter " +
      "an OAuth/SSO login, CAPTCHA, 2FA prompt, or sensitive credentials entry. The console alerts " +
      "the person so they can type and click directly in the live browser before returning control to you.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Explanation of what human action is needed (e.g. 'Please log in to GitHub via OAuth' or 'Please complete the Cloudflare verification').",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "http_request",
    group: "browser",
    description:
      "Make an HTTP API call directly from the server. Supports GET, POST, PUT, PATCH, DELETE, HEAD " +
      "with custom headers and body. If calling api.github.com, automatically attaches the GITHUB_TOKEN " +
      "from the workspace secret store so you never need to ask the user for passwords.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full target URL." },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          description: "HTTP method (default GET).",
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers as key-value pairs.",
        },
        body: {
          type: "string",
          description: "Optional request body string or JSON.",
        },
      },
      required: ["url"],
    },
    risky: true,
  },
  {
    name: "web_search",
    group: "browser",
    description:
      "Search the web for up-to-date documentation, release notes, news, code examples, or factual answers " +
      "without being blocked by search engine bot detection.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query terms." },
      },
      required: ["query"],
    },
  },
  {
    name: "image_generate",
    group: "browser",
    description:
      "Generate an image from a detailed descriptive prompt using Gemini Imagen and show it in the conversation thread.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate.",
        },
      },
      required: ["prompt"],
    },
    risky: true,
  },

  // ----------------------------------------------------------- computer --
  {
    name: "computer_screenshot",
    group: "computer",
    description:
      "Take a picture of the relayed desktop and put it in the conversation " +
      "for the person to see. Coordinates for the click and move tools are in " +
      "that screen's own pixels, whose full size is given in the result.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "computer_click",
    group: "computer",
    description:
      "Click on the relayed desktop at a screen coordinate. Take a screenshot " +
      "first: there is no element numbering here, only pixels.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "Horizontal position, in screen pixels." },
        y: { type: "integer", description: "Vertical position, in screen pixels." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Which button. Default left.",
        },
        double: { type: "boolean", description: "Double-click instead. Default false." },
      },
      required: ["x", "y"],
    },
    risky: true,
  },
  {
    name: "computer_move",
    group: "computer",
    description: "Move the desktop's pointer without clicking.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", description: "Horizontal position, in screen pixels." },
        y: { type: "integer", description: "Vertical position, in screen pixels." },
      },
      required: ["x", "y"],
    },
    risky: true,
  },
  {
    name: "computer_type",
    group: "computer",
    description:
      "Type text into whatever has focus on the relayed desktop. Click the " +
      "field first; this does not choose a target.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The literal text to type." },
      },
      required: ["text"],
    },
    risky: true,
  },
  {
    name: "computer_key",
    group: "computer",
    description:
      "Press keys or key combinations on the relayed desktop, in order. Write a " +
      "combination with plus signs, e.g. \"cmd+s\", \"ctrl+shift+t\", \"enter\", " +
      "\"escape\".",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "The keys or combinations to press, in order.",
        },
      },
      required: ["keys"],
    },
    risky: true,
  },
  {
    name: "computer_scroll",
    group: "computer",
    description: "Scroll the relayed desktop's active window.",
    parameters: {
      type: "object",
      properties: {
        dy: {
          type: "integer",
          description: "Positive scrolls up, negative scrolls down.",
        },
      },
      required: ["dy"],
    },
    risky: true,
  },

  // --------------------------------------------------------------- memory --
  {
    name: "memory_write",
    group: "memory",
    description:
      "Write something down in the workspace memory graph, where it will be " +
      "recalled in later sessions. For durable facts, preferences and " +
      "procedures worth keeping -- not for a running commentary on this " +
      "conversation, which is already recorded.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short label, a few words.",
        },
        body: {
          type: "string",
          description: "The fact itself, written so it still makes sense months from now.",
        },
        kind: {
          type: "string",
          enum: ["fact", "preference", "procedure", "skill"],
          description: "What sort of thing this is. Default fact.",
        },
      },
      required: ["title", "body"],
    },
    risky: true,
  },
  {
    name: "memory_search",
    group: "memory",
    description:
      "Search the workspace memory graph for what has been written down " +
      "before. Some of it is already in your instructions for this turn; this " +
      "is how you find the rest.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words to look for in titles, bodies and tags.",
        },
      },
      required: ["query"],
    },
  },
];

// ------------------------------------------------------------ availability --

export interface GroupState {
  group: ToolGroup;
  label: string;
  enabled: boolean;
  available: boolean;
  /** One sentence: what this is, or why it cannot be used. */
  detail: string;
  approval: ApprovalMode;
  tools: string[];
}

const LABELS: Record<ToolGroup, string> = {
  terminal: "Terminal",
  browser: "Web browser",
  computer: "Computer control",
  memory: "Memory",
};

/**
 * Which groups are on, and which of those can actually be used right now.
 *
 * Asked on every turn, so the browser probe is the cached one from
 * ./browser.ts rather than a fresh launch attempt.
 */
export async function groupStates(): Promise<GroupState[]> {
  const settings = toolSettings();
  const names = (group: ToolGroup) =>
    TOOLS.filter((t) => t.group === group).map((t) => t.name);

  const browserProbe = settings.browser.enabled
    ? await probeBrowser()
    : { ok: false, detail: null };

  const relay = relayStatus();

  return [
    {
      group: "terminal",
      label: LABELS.terminal,
      enabled: settings.terminal.enabled,
      available: settings.terminal.enabled,
      detail: settings.terminal.enabled
        ? `A real shell on this host, as ${os.userInfo().username}, in ${
            settings.terminal.cwd || process.cwd()}.`
        : "No commands can run, and the agent is told so rather than left to guess.",
      approval: settings.terminal.approval,
      tools: names("terminal"),
    },
    {
      group: "browser",
      label: LABELS.browser,
      enabled: settings.browser.enabled,
      available: settings.browser.enabled && browserProbe.ok,
      detail: !settings.browser.enabled
        ? "The agent cannot open pages."
        : browserProbe.ok
          ? `Chromium, driven by the agent at ${VIEWPORT.width}×${VIEWPORT.height} and streamed back to you.`
          : browserProbe.detail ?? "No browser is installed on this server.",
      approval: settings.browser.approval,
      tools: names("browser"),
    },
    {
      group: "computer",
      label: LABELS.computer,
      enabled: settings.computer.enabled,
      available: settings.computer.enabled && relayConnected(),
      detail: !settings.computer.enabled
        ? "The agent cannot see or touch any desktop."
        : relay.connected
          ? `Relay connected${relay.platform ? ` from ${relay.platform}` : ""}${
              relay.screen.w ? ` · ${relay.screen.w}×${relay.screen.h}` : ""}${
              relay.canControl ? "" : " · screen capture only, input not permitted"}.`
          : "No relay is connected. Run the relay on the machine you want controlled.",
      approval: settings.computer.approval,
      tools: names("computer"),
    },
    {
      group: "memory",
      label: LABELS.memory,
      enabled: settings.memory.enabled,
      // Nothing outside the process to check: the graph is always there.
      available: settings.memory.enabled,
      detail: settings.memory.enabled
        ? "The workspace memory graph, which survives sessions and restarts."
        : "The agent cannot write anything down between sessions.",
      approval: settings.memory.approval,
      tools: names("memory"),
    },
  ];
}

/** The tools to offer the model this turn: enabled, and actually usable. */
export async function availableTools(): Promise<ToolSpec[]> {
  const groups = await groupStates();
  const usable = new Set(groups.filter((g) => g.available).map((g) => g.group));
  return TOOLS.filter((t) => usable.has(t.group));
}

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Does this call need a human to say yes first?
 *
 * Never. Autora runs in yolo mode: every tool call runs straight away, with
 * no approval card in the chat. The call is still shown in the thread as it
 * happens, and Stop still kills it.
 */
export function needsApproval(_spec: ToolSpec): boolean {
  return false;
}

/** The exact thing being asked for, for the approval card. Never a summary:
    the entire value of the prompt is reading precisely what will happen. */
export function renderCall(spec: ToolSpec, args: Record<string, any>): string {
  switch (spec.name) {
    case "terminal":
      return String(args.command ?? "");
    case "browser_open":
      return `open ${args.url}`;
    case "browser_click":
      return `click element [${args.ref}] on the open page`;
    case "browser_fill": {
      const rows = Array.isArray(args.values) ? args.values : [];
      const shown = rows
        .map((v: any) => `[${v?.ref}] ← ${JSON.stringify(String(v?.text ?? ""))}`)
        .join(", ");
      return `fill ${shown}${args.submit ? ", then submit" : ""}`;
    }
    case "computer_click":
      return `${args.double ? "double-click" : "click"} the desktop at ${
        args.x},${args.y}${args.button && args.button !== "left" ? ` (${args.button})` : ""}`;
    case "computer_move":
      return `move the desktop pointer to ${args.x},${args.y}`;
    case "computer_type":
      return `type on the desktop: ${JSON.stringify(String(args.text ?? ""))}`;
    case "computer_key":
      return `press ${(Array.isArray(args.keys) ? args.keys : [args.keys]).join(" then ")}`;
    case "computer_scroll":
      return `scroll the desktop by ${args.dy}`;
    case "memory_write":
      return `remember "${args.title}": ${args.body}`;
    case "browser_handoff":
      return `handoff browser control: ${args.reason}`;
    case "http_request":
      return `${args.method || "GET"} ${args.url}`;
    case "web_search":
      return `search web for "${args.query}"`;
    case "image_generate":
      return `generate image: "${args.prompt}"`;
    default: {
      const rest = Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
      return `${spec.name}${rest}`;
    }
  }
}

// ---------------------------------------------------------------- running --

/** Everything the executor needs from the session it is running in, passed in
    rather than imported, so this module stays independent of the server. */
export interface ToolContext {
  /** A line of live output, as it arrives. */
  onOutput: (chunk: string) => void;
  /** Stash a picture and return its blob id. */
  putBlob: (data: Buffer, mime: string) => string;
  /** Show a picture in the conversation. */
  showImage: (blob: string, alt: string, caption: string | null, size?: { w: number; h: number }) => void;
  /** The session's browser, made on first use. */
  browser: () => LiveBrowser;
  /** The browser's state changed; tell the watchers. */
  browserChanged: () => void;
  /** Start forwarding desktop frames to this session. */
  watchDesktop: () => void;
  /** True once the turn has been interrupted; long tools should give up. */
  cancelled: () => boolean;
  /** Register a kill switch so an interrupt can stop a running command. */
  onCancel: (stop: () => void) => void;
  /** The memory graph, which the server owns. */
  memory: {
    write: (entry: { title: string; body: string; kind: string }) => { id: string };
    search: (query: string) => { kind: string; title: string; body: string }[];
  };
}

export interface ToolOutcome {
  ok: boolean;
  /** What the model is told came back. */
  summary: string;
  /** For the transcript card, where it differs from the summary. */
  preview?: string;
  exitCode?: number;
}

/** The page, as the model reads it. */
function describePage(page: PageRead): string {
  return [
    `Page: ${page.title || "(untitled)"}`,
    `URL: ${page.url}`,
    "",
    "Interactive elements:",
    page.outline || "(nothing interactive on this page)",
    "",
    "Text:",
    page.text.slice(0, 6000),
  ].join("\n");
}

function candidateShells(): string[] {
  const settings = toolSettings().terminal;
  const list: string[] = [];
  if (settings.shell?.trim()) list.push(settings.shell.trim());
  if (process.env.AUTORA_SHELL?.trim()) list.push(process.env.AUTORA_SHELL.trim());
  if (process.env.SHELL?.trim()) list.push(process.env.SHELL.trim());
  list.push("/bin/bash", "bash", "/bin/ash", "ash", "/bin/sh", "sh");
  return Array.from(new Set(list));
}

/**
 * Run one command, streaming its output.
 *
 * Pipes, not a PTY. Shell is resolved with automatic fallback across bash, ash, and sh
 * to handle minimal containers without crashing with ENOENT. All workspace secrets
 * are automatically injected into the process environment.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const candidates = candidateShells();
  const secrets = allSecrets();
  const workingDir = cwd || process.cwd();

  const tryShell = (candidateIdx: number): Promise<ToolOutcome> => {
    if (candidateIdx >= candidates.length) {
      return Promise.resolve({
        ok: false,
        summary: "Could not start a shell: no usable shell found on this system.",
      });
    }

    const shell = candidates[candidateIdx];
    return new Promise<ToolOutcome>((resolve) => {
      let child: any;
      let timer: any = null;
      let killedBy: "timeout" | "user" | null = null;
      let collected = "";
      let truncated = false;
      const LIMIT = 24_000;
      let spawnedOk = false;

      const killGroup = () => {
        if (!child?.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      };

      try {
        child = spawn(shell, ["-lc", command], {
          cwd: workingDir,
          detached: true,
          env: {
            ...process.env,
            ...secrets,
            PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            TERM: "dumb",
            PAGER: "cat",
            GIT_PAGER: "cat",
            NO_COLOR: "1",
            DEBIAN_FRONTEND: "noninteractive",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        return resolve(tryShell(candidateIdx + 1));
      }

      timer = setTimeout(() => {
        killedBy = "timeout";
        killGroup();
      }, timeoutSeconds * 1000);
      timer.unref?.();

      ctx.onCancel(() => {
        if (killedBy) return;
        killedBy = "user";
        killGroup();
      });

      const take = (chunk: Buffer) => {
        spawnedOk = true;
        const text = chunk.toString("utf8");
        const safeText = redactSecrets(text);
        ctx.onOutput(safeText);
        if (collected.length < LIMIT) {
          collected += safeText;
          if (collected.length >= LIMIT) {
            collected = collected.slice(0, LIMIT);
            truncated = true;
          }
        } else {
          truncated = true;
        }
      };

      child.stdout?.on("data", take);
      child.stderr?.on("data", take);

      child.on("error", (err: any) => {
        clearTimeout(timer);
        if (!spawnedOk && (err.code === "ENOENT" || String(err?.message ?? "").includes("ENOENT"))) {
          // Fallback to next shell candidate
          return resolve(tryShell(candidateIdx + 1));
        }
        resolve({ ok: false, summary: `Could not run that: ${redactSecrets(err?.message ?? err)}` });
      });

      child.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        const exit = code ?? (signal ? 128 : 0);
        const body = redactSecrets(collected.trim());
        const note =
          killedBy === "timeout"
            ? `\n\n[killed after ${timeoutSeconds}s -- it had not finished]`
            : killedBy === "user"
              ? "\n\n[stopped by the person watching]"
              : truncated
                ? "\n\n[output truncated; the full output is in the transcript]"
                : "";

        resolve({
          ok: killedBy === null && exit === 0,
          exitCode: exit,
          summary:
            `Exit code ${exit}${killedBy === "timeout" ? " (timed out)" : ""}\n\n` +
            (body || "(no output)") +
            note,
          preview: redactSecrets(body.split("\n").slice(-1)[0]?.slice(0, 120) || `exit ${exit}`),
        });
      });
    });
  };

  return tryShell(0);
}

async function searchWeb(query: string): Promise<string> {
  const tavilyKey = secretFor("TAVILY_API_KEY") || process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 6 }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        return (data.results || [])
          .map((r: any) => `### [${r.title}](${r.url})\n${r.content}`)
          .join("\n\n");
      }
    } catch {}
  }

  const braveKey = secretFor("BRAVE_SEARCH_API_KEY") || process.env.BRAVE_SEARCH_API_KEY;
  if (braveKey) {
    try {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`,
        { headers: { "X-Subscription-Token": braveKey } },
      );
      if (res.ok) {
        const data = (await res.json()) as any;
        return (data.web?.results || [])
          .map((r: any) => `### [${r.title}](${r.url})\n${r.description}`)
          .join("\n\n");
      }
    } catch {}
  }

  // Fallback web search using DuckDuckGo Instant Answers
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" } },
    );
    if (res.ok) {
      const data = (await res.json()) as any;
      const results: string[] = [];
      if (data.AbstractText) {
        results.push(`### ${data.Heading || query}\n${data.AbstractText}\nSource: ${data.AbstractURL || ""}`);
      }
      for (const t of data.RelatedTopics || []) {
        if (t.Text && t.FirstURL) {
          results.push(`- [${t.Text}](${t.FirstURL})`);
        }
      }
      if (results.length > 0) return results.join("\n\n");
    }
  } catch {}

  // Fallback html snippet search
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (res.ok) {
      const html = await res.text();
      const snippets: string[] = [];
      const matches = html.matchAll(
        /<a class="result__snippet[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi,
      );
      for (const m of matches) {
        const cleanText = m[2].replace(/<[^>]+>/g, "").trim();
        if (cleanText) snippets.push(cleanText);
        if (snippets.length >= 5) break;
      }
      if (snippets.length > 0) return snippets.join("\n\n");
    }
  } catch {}

  return `Search for "${query}" completed. No immediate web snippets found.`;
}

async function runHttpRequest(args: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<ToolOutcome> {
  const url = String(args.url || "").trim();
  const method = (args.method || "GET").toUpperCase();
  const headers: Record<string, string> = { ...args.headers };

  // If calling GitHub API and GITHUB_TOKEN exists in secret store, inject Authorization
  if (url.includes("api.github.com") && !headers["Authorization"] && !headers["authorization"]) {
    const ghToken = secretFor("GITHUB_TOKEN") || process.env.GITHUB_TOKEN;
    if (ghToken) {
      headers["Authorization"] = `Bearer ${ghToken}`;
      if (!headers["User-Agent"] && !headers["user-agent"]) {
        headers["User-Agent"] = "Autora-Agent";
      }
      if (!headers["Accept"] && !headers["accept"]) {
        headers["Accept"] = "application/vnd.github.v3+json";
      }
    }
  }

  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = "Autora/1.0";
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : args.body,
    });

    const status = res.status;
    const statusText = res.statusText;
    const text = await res.text();

    const preview = redactSecrets(`${method} ${url} → ${status} ${statusText}`);
    let summary = `HTTP ${status} ${statusText}\n`;
    summary += `Content-Type: ${res.headers.get("content-type") || "unknown"}\n\n`;
    summary += text.length > 20_000 ? text.slice(0, 20_000) + "\n\n[response truncated]" : text;

    return {
      ok: res.ok,
      summary: redactSecrets(summary),
      preview,
    };
  } catch (err: any) {
    return { ok: false, summary: `HTTP request failed: ${redactSecrets(err?.message ?? err)}` };
  }
}

async function generateImageTool(prompt: string, ctx: ToolContext): Promise<ToolOutcome> {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    secretFor("GEMINI_API_KEY") ||
    secretFor("GOOGLE_API_KEY");
  if (!apiKey) {
    return {
      ok: false,
      summary: "Cannot generate image: GEMINI_API_KEY is not set in environment or secret store.",
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateImages({
      model: "imagen-3.0-generate-002",
      prompt,
      config: {
        numberOfImages: 1,
        outputMimeType: "image/jpeg",
        aspectRatio: "1:1",
      },
    });

    const base64 = response.generatedImages?.[0]?.image?.imageBytes;
    if (!base64) {
      return { ok: false, summary: "The image model returned no image bytes." };
    }

    const buffer = Buffer.from(base64, "base64");
    const blob = ctx.putBlob(buffer, "image/jpeg");
    ctx.showImage(blob, prompt, `Generated: ${prompt}`, { w: 1024, h: 1024 });

    return {
      ok: true,
      summary: `Generated image for prompt: "${prompt}". It is now displayed in the conversation for the person to see.`,
      preview: `Generated image: ${prompt.slice(0, 80)}`,
    };
  } catch (err: any) {
    return { ok: false, summary: `Image generation failed: ${err?.message ?? err}` };
  }
}

/**
 * Do the thing, whatever it is.
 *
 * Every path returns a ToolOutcome rather than throwing, because a failed tool
 * call is a normal event in a turn: the model needs to read what went wrong and
 * try something else, and an exception here would end the turn instead.
 */
export async function runTool(
  spec: ToolSpec,
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  try {
    switch (spec.name) {
      // ------------------------------------------------------- terminal --
      case "terminal": {
        const settings = toolSettings().terminal;
        const command = String(args.command ?? "").trim();
        if (!command) return { ok: false, summary: "No command was given." };
        const cwd = String(args.cwd ?? "").trim() || settings.cwd;
        return await runCommand(command, cwd, settings.timeout, ctx);
      }

      // -------------------------------------------------------- browser --
      case "browser_open": {
        const url = String(args.url ?? "").trim();
        if (!url) return { ok: false, summary: "No address was given." };
        const page = await ctx.browser().goto(url);
        ctx.browserChanged();
        return {
          ok: true,
          summary: describePage(page),
          preview: `${page.title || page.url} · ${page.refs.length} elements`,
        };
      }

      case "browser_read": {
        const page = await ctx.browser().snapshot();
        ctx.browserChanged();
        return { ok: true, summary: describePage(page), preview: page.url };
      }

      case "browser_click": {
        const ref = Number(args.ref);
        if (!Number.isFinite(ref)) {
          return { ok: false, summary: "That is not an element number." };
        }
        const page = await ctx.browser().click(ref);
        ctx.browserChanged();
        return {
          ok: true,
          summary: `Clicked [${ref}].\n\n${describePage(page)}`,
          preview: `clicked [${ref}] → ${page.url}`,
        };
      }

      case "browser_fill": {
        const values = (Array.isArray(args.values) ? args.values : [])
          .map((v: any) => ({ ref: Number(v?.ref), text: String(v?.text ?? "") }))
          .filter((v: any) => Number.isFinite(v.ref));
        if (values.length === 0) {
          return { ok: false, summary: "No fields were given to fill." };
        }
        const page = await ctx.browser().fill(values, Boolean(args.submit));
        ctx.browserChanged();
        return {
          ok: true,
          summary:
            `Filled ${values.length} field${values.length === 1 ? "" : "s"}${
              args.submit ? " and submitted" : ""}.\n\n${describePage(page)}`,
          preview: page.url,
        };
      }

      case "browser_scroll": {
        const page = await ctx.browser().scroll(Number(args.dy ?? 600));
        ctx.browserChanged();
        return { ok: true, summary: describePage(page), preview: page.url };
      }

      case "browser_back": {
        const page = await ctx.browser().back();
        ctx.browserChanged();
        return { ok: true, summary: describePage(page), preview: page.url };
      }

      case "browser_screenshot": {
        const live = ctx.browser();
        const png = await live.capture();
        const blob = ctx.putBlob(png, "image/png");
        const status = live.status();
        ctx.showImage(
          blob,
          status.title || status.url || "the open page",
          status.url,
          { w: VIEWPORT.width, h: VIEWPORT.height },
        );
        return {
          ok: true,
          summary:
            "The picture is now in the conversation, where the person can see " +
            "it. You cannot see it yourself -- describe the page from its text " +
            "if you need to say what is on it.",
          preview: status.url ?? "screenshot",
        };
      }

      case "browser_handoff": {
        const reason = String(args.reason ?? "Human intervention requested.");
        const live = ctx.browser();
        live.setControl("human", reason);
        ctx.browserChanged();
        return {
          ok: true,
          summary:
            `Browser control transferred to the person watching.\nReason: ${reason}\n\n` +
            "The person can now directly click, type credentials, and solve CAPTCHAs/SSO in the live browser card. " +
            "Wait for them to respond or finish before proceeding.",
          preview: `handoff to human: ${reason}`,
        };
      }

      case "http_request": {
        return await runHttpRequest({
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
        });
      }

      case "web_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, summary: "No search query was provided." };
        const results = await searchWeb(query);
        return {
          ok: true,
          summary: `Web search results for "${query}":\n\n${results}`,
          preview: `search: ${query.slice(0, 60)}`,
        };
      }

      case "image_generate": {
        const prompt = String(args.prompt ?? "").trim();
        if (!prompt) return { ok: false, summary: "No image prompt was provided." };
        return await generateImageTool(prompt, ctx);
      }

      // ------------------------------------------------------- computer --
      case "computer_screenshot": {
        ctx.watchDesktop();
        const result = await relayAction("screenshot");
        if (!result.ok) return { ok: false, summary: result.error ?? "The screenshot failed." };
        const image = String(result.data?.image ?? "");
        if (!image) return { ok: false, summary: "The relay sent back no picture." };
        const blob = ctx.putBlob(Buffer.from(image, "base64"), "image/jpeg");
        const w = Number(result.data?.w) || null;
        const h = Number(result.data?.h) || null;
        ctx.showImage(
          blob,
          "the relayed desktop",
          relayStatus().platform,
          w && h ? { w, h } : undefined,
        );
        return {
          ok: true,
          summary:
            `The desktop is now shown in the conversation for the person to see.${
              w && h
                ? ` Its screen is ${w}×${h} pixels; click and move coordinates ` +
                  "are in that space, measured from the top-left."
                : ""
            } You cannot see the picture yourself.`,
          preview: w && h ? `${w}×${h}` : "desktop",
        };
      }

      case "computer_click": {
        ctx.watchDesktop();
        const result = await relayAction(
          args.double ? "double_click" : args.button === "right" ? "right_click" : "click",
          { x: Number(args.x), y: Number(args.y), button: args.button ?? "left" },
        );
        return result.ok
          ? { ok: true, summary: `Clicked at ${args.x},${args.y}.`, preview: `${args.x},${args.y}` }
          : { ok: false, summary: result.error ?? "The click failed." };
      }

      case "computer_move": {
        ctx.watchDesktop();
        const result = await relayAction("move", { x: Number(args.x), y: Number(args.y) });
        return result.ok
          ? { ok: true, summary: `Pointer moved to ${args.x},${args.y}.`,
              preview: `${args.x},${args.y}` }
          : { ok: false, summary: result.error ?? "The move failed." };
      }

      case "computer_type": {
        ctx.watchDesktop();
        const text = String(args.text ?? "");
        const result = await relayAction("type", { text });
        return result.ok
          ? { ok: true, summary: `Typed ${text.length} characters.`,
              preview: text.length > 24 ? `${text.slice(0, 24)}…` : text }
          : { ok: false, summary: result.error ?? "Typing failed." };
      }

      case "computer_key": {
        ctx.watchDesktop();
        const keys = (Array.isArray(args.keys) ? args.keys : [args.keys])
          .filter(Boolean)
          .map(String);
        if (keys.length === 0) return { ok: false, summary: "No keys were given." };
        const result = await relayAction("key", { keys });
        return result.ok
          ? { ok: true, summary: `Pressed ${keys.join(", then ")}.`,
              preview: keys.join(" ") }
          : { ok: false, summary: result.error ?? "The keystroke failed." };
      }

      case "computer_scroll": {
        ctx.watchDesktop();
        const result = await relayAction("scroll", { dy: Number(args.dy ?? -400) });
        return result.ok
          ? { ok: true, summary: `Scrolled by ${args.dy}.`, preview: String(args.dy) }
          : { ok: false, summary: result.error ?? "The scroll failed." };
      }

      // --------------------------------------------------------- memory --
      case "memory_write": {
        const title = String(args.title ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!title || !body) {
          return { ok: false, summary: "A memory needs both a title and a body." };
        }
        const kinds = new Set(["fact", "preference", "procedure", "skill"]);
        const kind = kinds.has(String(args.kind)) ? String(args.kind) : "fact";
        const { id } = ctx.memory.write({ title, body, kind });
        return {
          ok: true,
          summary: `Written down as ${id}: "${title}".`,
          preview: title,
        };
      }

      case "memory_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, summary: "No search terms were given." };
        const found = ctx.memory.search(query);
        if (found.length === 0) {
          return { ok: true, summary: `Nothing in memory matches "${query}".`, preview: "0 found" };
        }
        return {
          ok: true,
          summary: found
            .map((m) => `- [${m.kind}] ${m.title}: ${m.body}`)
            .join("\n"),
          preview: `${found.length} found`,
        };
      }

      default:
        return { ok: false, summary: `There is no tool called "${spec.name}".` };
    }
  } catch (err: any) {
    // Playwright in particular throws on a timeout, a detached element, a page
    // that navigated mid-click. All of those are things the model can react to.
    return { ok: false, summary: `${spec.name} failed: ${err?.message ?? String(err)}` };
  }
}

/**
 * What the agent is told it can do, in prose, before the conversation starts.
 *
 * Generated from the same registry the schemas come from, so the two cannot
 * drift -- and a group that is off or unavailable is *named* as such rather
 * than omitted. An agent that is simply missing a browser tool will guess; one
 * told "browsing is turned off in Settings" can say so, which is the answer the
 * person actually needs.
 */
export async function capabilityBriefing(): Promise<string> {
  const groups = await groupStates();
  const lines: string[] = ["What you can actually do, right now, on this machine:"];

  for (const group of groups) {
    const head = group.available
      ? `- ${group.label}: available.`
      : group.enabled
        ? `- ${group.label}: turned on, but not usable right now.`
        : `- ${group.label}: turned off in Settings.`;
    lines.push(`${head} ${group.detail}`);
    if (group.available) {
      lines.push(`  Tools: ${group.tools.join(", ")}.`);
      lines.push("  These run straight away -- nothing waits on the person's approval.");
    }
  }

  const off = groups.filter((g) => !g.available);
  if (off.length > 0) {
    lines.push(
      "",
      "Do not pretend to use what is not available, and do not write out " +
        "commands or their output as if you had run them. If something you need " +
        "is off or unusable, say which of the above it is and what would fix it.",
    );
  }
  if (groups.some((g) => g.available)) {
    lines.push(
      "",
      "These are real. The terminal runs on a real host, the browser opens real " +
        "pages, and the desktop belongs to a real person who is watching. Take " +
        "the actions you are asked for rather than describing what you would do, " +
        "and read the result of each one before the next.",
    );
  }

  return lines.join("\n");
}

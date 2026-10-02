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

import type { TodoResult } from "./todos";
import type { LedgerResult } from "./ledger";
import type { RequirementResult } from "./requirements";
import { checkEntry } from "./mindrules";
import { officeDir, runOfficeTool } from "./office";
import type { Phase } from "./modes";
import { callMcpTool, mcpTools, statusOf as mcpStatusOf } from "./mcp";
import { existing as existingMcp, install as installMcp, noteDeclined, overview as mcpOverview, planOffer, wasDeclined } from "./mcpoffer";
import {
  PREFIX as CUSTOM_PREFIX, customEnv, defineCustomTool, deleteCustomTool, getCustomTool,
  listCustomTools, missingArgs, noteCustomRun,
} from "./customtools";
import { spawn } from "node:child_process";
import { searchCode } from "./codesearch";
import { readFile } from "./readfile";
import type { EditArgs, EditResult } from "./editfile";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { mergeTools, save, state, allSecrets, keyFor, secretFor, redactSecrets as redactStored } from "./state";
import { credentialsBriefing, fillPlaceholders, hasPlaceholder, identityEnv, redactCredentials } from "./credentials";
import type { ChatImage } from "./llm";
import { frameImage, latestFrame } from "./liveview";
import { htmlToText, textParts } from "./pages";
import { describeCaptchas, probeBrowser, VIEWPORT, type LiveBrowser, type PageRead, type UploadFile } from "./browser";
import { parseCookieExport, sitesOf } from "./cookies";
import { recordSignIn, signInBriefing } from "./signins";
import { relayAction, relayConnected, relayStatus } from "./desktop";
import { CONTEXT_CONFIG, readVault } from "./context";
import {
  artifactPath, cleanName, deleteArtifact, formatSize, getArtifact, isText, listArtifacts,
  readArtifact, saveArtifact, MAX_ARTIFACT_BYTES,
} from "./artifacts";
import { checkWidget } from "./widgets";
import { deskHooks } from "./pdfdesk";
import { officeHooks } from "./officedesk";
import { runPdfTool } from "./pdf";
import {
  addEntries, createNotebook, describeNotebook, findNotebook, listNotebooks, moveEntry,
  notebookLine, notebookMarkdown, removeEntry, updateEntry, updateNotebook, type Notebook,
} from "./notebooks";
import { describe as describeJob, findJob, listJobs, readTail, startJob, stopJob } from "./background";
import { addRule, listRules, revoke as revokeRule } from "./autonomy";
import { get as getInventory } from "./inventory";
import { speechStatus } from "./speech";
import {
  MAX_WIDGET_CHARS, WIDGET_DEFAULT_HEIGHT, WIDGET_MAX_HEIGHT, WIDGET_MIN_HEIGHT, widgetDocument,
} from "../src/lib/widget";

/** What one speak call may say: a few paragraphs, the same ceiling the voice
    server route holds a sentence to. */
const MAX_SPOKEN_CHARS = 2_000;

/** The arguments every PDF tool shares. */
const PDF_FILE = {
  type: "string",
  description: "The PDF: an artifact id (file_...), a path on this host, or an artifact's name.",
};
const PDF_PASSWORD = {
  type: "string",
  description: "Its password, if it is password-protected. What the tools save has none.",
};
const PDF_OUTPUT = {
  type: "string",
  description:
    "File name for the result. Default: the original's name with -edited, -redacted... added, " +
    "or your own earlier result, updated.",
};

/** Blank out stored secrets and the person's saved credentials. */
function redactSecrets(text: string): string {
  return redactCredentials(redactStored(text));
}

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
  voice: { enabled: boolean; approval: ApprovalMode };
  widgets: { enabled: boolean };
  app: { enabled: boolean };
  pdf: { enabled: boolean };
  office: { enabled: boolean };
}

export function toolSettings(): ToolSettings {
  return state.tools;
}

/**
 * Where commands run when nothing more specific is asked: the directory
 * chosen in Settings, else AUTORA_WORKDIR, else the server's own.
 *
 * The Umbrel app sets AUTORA_WORKDIR=/host -- the host's filesystem, mounted
 * so the agent can work on the server it lives on -- and nothing read it, so
 * every command started in the app's own install directory instead.
 */
export function terminalDir(): string {
  const chosen = toolSettings().terminal.cwd.trim();
  if (chosen) return chosen;
  const fromEnv = (process.env.AUTORA_WORKDIR || "").trim();
  if (fromEnv) {
    try {
      if (fs.statSync(fromEnv).isDirectory()) return fromEnv;
    } catch {
      // Named but not there: the server's own directory, as before.
    }
  }
  return process.cwd();
}

/** Apply a patch from the settings panel and persist it. The merge itself
    lives with the settings file, since the file needs the same validation. */
export function updateToolSettings(patch: any): ToolSettings {
  const next = mergeTools(state.tools, patch);
  save();
  return next;
}

// ------------------------------------------------------------- the registry --

export type ToolGroup = "terminal" | "browser" | "computer" | "memory" | "voice" | "schedule";

/** A question for the person, drawn as a card in the thread. */
export type AskRequest = {
  /** "browser" is a sign-in or similar handed over in the live page;
      "offer" is the agent offering to set up an MCP server. */
  kind: "question" | "browser" | "offer";
  title: string;
  detail?: string;
  options: { label: string; detail?: string }[];
  multi: boolean;
  allowText: boolean;
  placeholder?: string;
  /** Checked about once a second while the question is open. A string back
      settles it without the person: the thing they were asked to do has
      visibly been done, and saying so would only be a second chore. */
  watch?: () => Promise<string | null>;
  /** For an offer: what would be set up, drawn on the card. */
  offer?: {
    name: string;
    title: string;
    summary: string;
    runs: string;
    kind: string;
    needs: { env: string; label: string; url?: string; hint?: string; optional?: boolean; set: boolean }[];
  };
};
export type AskAnswer = { cancelled: boolean; choices: string[]; text: string; who: string };

export interface ToolSpec {
  name: string;
  /** "person" and "files" are not settings: asking is always possible, and
      so is handing over or reading back an artifact. */
  group: ToolGroup | "person" | "files" | "mcp";
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
      "`sudo -n` so a password prompt fails fast instead of waiting. " +
      "Autora itself is a node process on this machine (in its Umbrel " +
      "container, the main one): killing or restarting it ends this " +
      "conversation and can leave the app offline, and in the container " +
      "files changed under /app are replaced at the next update. To change " +
      "Autora, change its source repository instead.",
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

  {
    name: "run_background",
    group: "terminal",
    description:
      "Start a shell command that keeps running after this turn is over: a " +
      "build, a long test run, a download, a restore, anything that would hit " +
      "the terminal's time limit. Same shell, same secrets and same working " +
      "directory as terminal, but nothing waits for it. You get a job id and " +
      "the file its output is going to; the job carries on when the turn ends, " +
      "and the next turn is told by itself what has become of it. Read it " +
      "later with background_output -- never start it and then sleep or poll " +
      "in this turn. For something that must happen at a time, or be looked at " +
      "again later, use schedule instead: a job there is a prompt and a time, " +
      "and it comes back to you on its own.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line to run in the background, exactly as you would type it.",
        },
        cwd: {
          type: "string",
          description: "Optional directory to run in. Defaults to the configured working directory.",
        },
        note: {
          type: "string",
          description:
            "One line on why it was started, in your own words, e.g. " +
            "\"rebuilding the app bundle\". The next turn reads this.",
        },
      },
      required: ["command"],
    },
    risky: true,
  },
  {
    name: "background_jobs",
    group: "terminal",
    description:
      "List the background commands you started: what each one was, whether " +
      "it is still running or has finished, its exit code and how long it " +
      "ran. Cheap, and the right first call when something you set going " +
      "earlier is needed now.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "background_output",
    group: "terminal",
    description:
      "What a background command has printed, and how it ended. Give the " +
      "job id run_background returned. For a job still running this is what " +
      "it has printed so far, not the finished output.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job id, e.g. job-m7x2k1p4a." },
        lines: {
          type: "number",
          description: "How many lines from the end to return. Default 40, at most 500.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "background_stop",
    group: "terminal",
    description:
      "Stop a background command you started, and anything it started. Use it " +
      "for one that is going wrong, or is no longer wanted.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The job id, e.g. job-m7x2k1p4a." } },
      required: ["id"],
    },
    risky: true,
  },

  {
    name: "schedule",
    group: "schedule",
    description:
      "Set something going that comes back to you later: a task and a cron " +
      "time for it. Use it for anything that should happen at a time (\"every " +
      "weekday at 8am, check the release status and report\") or be watched for " +
      "a change (give `watch` a page, a file or a command, and the task runs " +
      "only when what it watches differs from the last look). The task runs as " +
      "a turn of its own, in a new session, with this workspace's memory and " +
      "tools, and the person sees what it says. Name it after the outcome, and " +
      "write the prompt as an instruction to yourself: say what to do and what " +
      "to tell the person. Prefer a watcher over a schedule that looks again " +
      "and again: a watcher speaks only when something actually changed. " +
      "Nothing runs while the machine or the console is off -- a time missed is " +
      "missed, not made up afterwards. To change one you already set, give its " +
      "id; to see them, use schedules.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "What it is for, in a few words, e.g. \"Release check\".",
        },
        cron: {
          type: "string",
          description:
            "Five-field cron, in the server's local time: \"0 8 * * 1-5\" is " +
            "08:00 on weekdays, \"*/15 * * * *\" is every fifteen minutes. " +
            "@hourly, @daily, @weekly and @monthly also work. For a watcher " +
            "this is how often to look.",
        },
        prompt: {
          type: "string",
          description:
            "What to do when it runs, written as an instruction to yourself, " +
            "ending with what to say to the person.",
        },
        id: {
          type: "string",
          description: "An existing job's id, to change that one instead of making a new one.",
        },
        enabled: { type: "boolean", description: "Whether it should run. Default true." },
        watch: {
          type: "object",
          description:
            "Only for a watcher: what to look at, and the task runs only when " +
            "it differs from the last look. Leave it out for a plain schedule.",
          properties: {
            kind: {
              type: "string",
              description: "page (an http(s) address), file (a path on this machine) or command (a shell command's output).",
            },
            target: { type: "string", description: "The address, the path, or the command." },
          },
          required: ["kind", "target"],
        },
      },
      required: ["name", "cron", "prompt"],
    },
    risky: true,
  },
  {
    name: "schedules",
    group: "schedule",
    description:
      "The scheduled tasks and watchers this workspace has: each one's id, " +
      "when it next runs, when it last ran, and anything that went wrong. " +
      "Read it before creating one that may already exist, and to find the id " +
      "to change or remove.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "unschedule",
    group: "schedule",
    description:
      "Remove a scheduled task or watcher, by id. With keep: true it is paused " +
      "instead -- kept, but never fired -- which is the better choice when it " +
      "may be wanted again.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job's id, as schedules lists it." },
        keep: { type: "boolean", description: "Pause it rather than removing it. Default false." },
      },
      required: ["id"],
    },
    risky: true,
  },

  {
    name: "pre_authorise",
    group: "schedule",
    description:
      "Agree a class of work in advance, so the guard stops asking about it: " +
      "give the tool and a few words that a call of that kind contains. Use it " +
      "when the same harmless hold keeps coming back -- restarting the same " +
      "container, re-running the same deploy -- and say why in the note, " +
      "because the person reads this list. It is not a way round a hold you " +
      "have not explained, and it cannot cover anything irrecoverable: " +
      "formatting a disk, wiping a volume, force-pushing over main and deleting " +
      "the whole tree are asked about every time, however many agreements " +
      "there are.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "terminal, run_background or http_request -- the tools the guard asks about.",
        },
        match: {
          type: "string",
          description:
            "The words a call must contain, e.g. \"docker compose restart kokoro\" " +
            "or \"POST https://api.example.com/deploy\". At least 8 characters, " +
            "and specific enough that it cannot match something else.",
        },
        note: { type: "string", description: "Why it is agreed, in a few words the person will read." },
      },
      required: ["tool", "match"],
    },
    risky: true,
  },
  {
    name: "pre_authorisations",
    group: "schedule",
    description:
      "The standing agreements there are: what is pre-authorised, who added " +
      "each one, and how often it has been used. With revoke, an id, take one " +
      "back.",
    parameters: {
      type: "object",
      properties: {
        revoke: { type: "string", description: "The id of an agreement to take back, e.g. allow-m7x2k-abc." },
      },
    },
    risky: true,
  },

  {
    name: "inventory",
    group: "schedule",
    description:
      "Look at the machine again -- which commands are installed, which are " +
      "not, the shell, the working directory and what is in it, the disk -- " +
      "and answer with it. The first turn of a session is given this by " +
      "itself, so call it only when something may have changed: after " +
      "installing a tool, after a restart, or when a fact about this machine " +
      "turns out not to hold.",
    parameters: { type: "object", properties: {} },
  },

  // ---------------------------------------------------------------- todo --
  {
    name: "todo",
    group: "schedule",
    description:
      "The to-do list the person watches, in the conversation. Write the plan " +
      "on it before you start anything that takes more than one step, then " +
      "rewrite it as you go: an item is in-progress while you work on it and " +
      "completed the moment it is finished. Every call is the WHOLE list as " +
      "it now stands, in order. Keep one item in-progress at a time. The list " +
      "appears by itself on the first call. Use it for programming (many " +
      "items), and for small errands too -- an email is read it, pull the " +
      "attachment, draft the reply, show it, send it. Call it with no " +
      "arguments to read the list back.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description:
            "The whole list, in order. Each item is a short title, or " +
            "{title, status}. Status is not-started (the default), " +
            "in-progress or completed.",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  title: { type: "string", description: "One short line: what this step does." },
                  status: { type: "string", description: "not-started, in-progress or completed." },
                },
                required: ["title"],
              },
            ],
          },
        },
      },
    },
  },

  {
    name: "tools_enable",
    group: "schedule",
    description:
      "Bring in a set of tools that is not in your list yet. The console note says which sets exist and what each " +
      "is for. Call this when the job needs one, then use its tools on your next step; they stay for the rest of " +
      "the chat. You do not need it for tools you can already see.",
    parameters: {
      type: "object",
      properties: {
        family: { type: "string", description: "The set to load, by name (pdf, widgets, mcp, schedule, notebooks)." },
      },
      required: ["family"],
    },
  },

  // -------------------------------------------------------------- ledger --
  {
    name: "ledger",
    group: "schedule",
    description:
      "Your working notes for the job in hand, kept for you across interruptions, stops and restarts " +
      "(a new turn starts without what you worked out in the last one; these are not lost). Record what " +
      "you settle and what you find out as you go, so it is never worked out twice: decided is a choice " +
      "and why; learned is a fact that cost a call to find (where something is, how a file is laid out, " +
      "what a service returned); next is the whole list of what you will do next, in order; goal is the " +
      "job in a line. forget drops any line holding one of the given words; reset starts again. Short " +
      "lines. Autora already records which files and pages you touched. Call with no arguments to read " +
      "the notes back.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The job, in one line." },
        decided: { type: "array", items: { type: "string" }, description: "Choices made, with the reason." },
        learned: { type: "array", items: { type: "string" }, description: "Facts found out that cost a call." },
        next: { type: "array", items: { type: "string" }, description: "What you will do next, in order. Replaces the list." },
        forget: { type: "array", items: { type: "string" }, description: "Drop lines that hold any of these words." },
        reset: { type: "boolean", description: "Start the notes again." },
      },
    },
  },

  // ------------------------------------------------------- requirements --
  {
    name: "requirements",
    group: "schedule",
    description:
      "What the person asked for, kept in their own words so none of it is lost or paraphrased away. " +
      "When a message asks for more than one thing -- features, fixes, changes -- add each ask as its " +
      "own item, worded as they worded it. When they add to it, change their mind or take something " +
      "away mid-conversation (even while you work), record it here: add a new ask, edit one whose " +
      "wording changed, drop one they no longer want (with the reason). Mark an item done only when it " +
      "is, with how you checked it. Before you finish, every item should be done or dropped. This is " +
      "separate from the to-do list, which is your own plan. Call with no arguments to read the list back.",
    parameters: {
      type: "object",
      properties: {
        add: { type: "array", items: { type: "string" }, description: "New asks, one per item, in the person's words." },
        edit: {
          type: "array",
          description: "Asks whose wording changed: [{id, text}].",
          items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
        },
        done: {
          type: "array",
          description: "Asks that are finished: [{id, how}] where how says how you checked.",
          items: { type: "object", properties: { id: { type: "string" }, how: { type: "string" } }, required: ["id"] },
        },
        drop: {
          type: "array",
          description: "Asks no longer wanted or impossible: [{id, why}].",
          items: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id"] },
        },
        reopen: { type: "array", items: { type: "string" }, description: "Ids to open again." },
      },
    },
  },

  // ---------------------------------------------------------- app_preview --
  {
    name: "app_preview",
    group: "schedule",
    description:
      "The app window: show the website or app you are building beside the conversation, live, so the " +
      "person watches it take shape and can select parts of it and say what to change. start runs a " +
      "dev server (command, and cwd if it is not the working folder; port if it does not say) or serves " +
      "a folder of files (dir) or opens something already running (url, localhost only). Start it as " +
      "soon as there is something to see, then keep building: hot reload updates it. reload refreshes; " +
      "look returns a picture of the page and its console errors -- use it to check your own work; " +
      "stop closes it. To test what you built, use it as a person would, in the same window the person is " +
      "watching, with a visible cursor: click and hover take a target (the words on a button or link, a " +
      "field's label or placeholder, or a CSS selector); type puts text into a target (or into the field " +
      "already focused) and submit presses Enter after; press sends a key (Enter, Tab, Escape, ArrowDown); " +
      "scroll moves the page by dy pixels (negative is up). Each returns a picture of the page afterwards, " +
      "so you see what happened. The person's comments come back as one message beginning [Autora: the person " +
      "reviewed the app preview; make those changes in the source.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "start, reload, look, stop, click, hover, type, press or scroll." },
        target: { type: "string", description: "click, hover, type: what to act on -- words on it, a label, a placeholder, or a CSS selector." },
        text: { type: "string", description: "type: the text to type." },
        key: { type: "string", description: "press: a key, e.g. Enter, Tab, Escape, ArrowDown, Control+A." },
        dy: { type: "number", description: "scroll: pixels down (negative for up). Default 500." },
        submit: { type: "boolean", description: "type: press Enter afterwards." },
        command: { type: "string", description: "start: the dev server command, e.g. npm run dev." },
        cwd: { type: "string", description: "start: where to run it." },
        dir: { type: "string", description: "start: a folder of static files to serve." },
        url: { type: "string", description: "start: an address on this machine that is already running." },
        port: { type: "number", description: "start: the port the command serves on, if it does not print one." },
      },
      required: ["action"],
    },
  },

  // ------------------------------------------------------------ set_mode --
  {
    name: "set_mode",
    group: "schedule",
    description:
      "Agent mode only: switch between planning and building. Planning is " +
      "read-only -- you look, search and write the to-do list, and anything " +
      "that changes something is refused. Building does the work. Every " +
      "turn starts in planning. Switch to build once the plan is on the " +
      "to-do list (or straight away for a very simple task), and back to plan " +
      "if the work turns out to need a new plan. The person sees each switch " +
      "in the chat with your reason, so give one, in a few words.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "build or plan." },
        reason: { type: "string", description: "Why, in a few words: shown to the person." },
      },
      required: ["to"],
    },
  },

  // ------------------------------------------------------------ browser --
  {
    name: "tool_create",
    group: "terminal",
    description:
      "Save a shell script as a tool of your own, for work you expect to do " +
      "again: once saved it is offered as my_<name> in every later session. " +
      "The script runs like a terminal command (bash -lc, same directory and " +
      "secrets); each parameter arrives as the environment variable " +
      "ARG_<NAME> (uppercase), and all of them as JSON in TOOL_ARGS. Saving " +
      "under an existing name replaces that tool. Only save what has already " +
      "worked in the terminal.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase, underscores, e.g. check_backup." },
        description: { type: "string", description: "What it does and when to use it, for your future self." },
        parameters: {
          // The handler takes either: a list of {name, ...} or a JSON Schema
          // object, which is what models reach for first.
          type: ["array", "object"],
          description: "The arguments it takes: a list of {name, description, required}, or a JSON Schema object.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean" },
            },
            required: ["name"],
          },
        },
        script: { type: "string", description: "The shell script." },
      },
      required: ["name", "description", "script"],
    },
    risky: true,
  },
  {
    name: "tool_delete",
    group: "terminal",
    description: "Delete a tool you wrote with tool_create, by its my_<name>.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "e.g. my_check_backup" } },
      required: ["name"],
    },
    risky: true,
  },
  {
    name: "browser_open",
    group: "browser",
    description:
      "Open a web page in the live browser the person watches, and return its " +
      "main content as text (a part at a time on long pages) with the numbered " +
      "elements that are on screen. This is how to look at or use any website: " +
      "reading an article, checking a product, signing in, filling a form. For " +
      "finding pages use web_search first; for APIs that answer in JSON use " +
      "http_request.",
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
      "Re-read the page that is currently open: the numbered elements on screen " +
      "(with what each field is for, what it holds, its choices and any error " +
      "the page shows on it), where the page is scrolled to, and a part of its " +
      "main text. Long pages come in parts; ask for the next one with `part` to " +
      "read further. Scrolling is only needed to reach elements, never to read text.",
    parameters: {
      type: "object",
      properties: {
        part: {
          type: "integer",
          description: "Which part of the page's text to return, from 1. Default 1.",
        },
      },
    },
  },
  {
    name: "browser_click",
    group: "browser",
    description:
      "Click one of the numbered elements on the open page, then return the " +
      "page as it is afterwards (after any navigation it started has loaded). " +
      "An element keeps its number while the page stays the same, however far " +
      "it is scrolled, and one that is off screen is scrolled into view first. " +
      "If something is drawn over the element (a cookie bar, a pop-up) the click " +
      "is held back and the result says what covers it and how to dismiss it. " +
      "If the page did not change, the result says so. " +
      "After the page changes, use the numbers from the latest result. To " +
      "choose from a dropdown or tick a checkbox, browser_fill is surer.",
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
      "Fill one or more numbered fields on the open page in one go, optionally " +
      "submitting the form afterwards, then return the resulting page with what " +
      "each field now holds. Works for every kind of field: text is typed into " +
      "boxes; a dropdown (combobox with options) gets the option whose text " +
      "matches; a checkbox or switch is ticked for \"yes\" and cleared for " +
      "\"no\"; a radio button is selected; a date field takes the date in any " +
      "clear form (2031-04-05 is safest). Match each value to what the field " +
      "is for -- its (purpose), type, section and hint -- not only its label: " +
      "\"Name\" marked (first name) takes the first name alone. Read the " +
      "result: a field that reformatted, refused or shows INVALID needs fixing " +
      "before you submit. The person's saved details and sign-ins go in as " +
      "placeholders such as {{cred:first_name}} or {{cred:github.com:password}}; " +
      "the value is typed in for you and you never see it.",
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
              text: {
                type: "string",
                description: "What to put in it: the text, the dropdown option's text, yes/no for a checkbox, or a date.",
              },
            },
            required: ["ref", "text"],
          },
        },
        submit: {
          type: "boolean",
          description: "Submit the form when done (Enter in the last text field). Default false.",
        },
      },
      required: ["values"],
    },
    risky: true,
  },
  {
    name: "browser_upload",
    group: "browser",
    description:
      "Attach files from the Artifacts to an upload field on the open page -- " +
      "a CV on a job application, a photo, a document a form asks for. Give " +
      "the field's number, or the number of the button that opens the file " +
      "picker (\"Upload CV\", \"Attach\", \"Choose file\"), or the " +
      "drag-and-drop box itself (\"Drop your CV here\") -- a box with no file " +
      "input gets the files dropped onto it -- and the " +
      "artifact ids (see artifact_list). The files go in as if chosen in the " +
      "picker. Returns the page afterwards: check the site shows the file " +
      "attached before submitting.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "integer",
          description: "The upload field's element number, or the button that opens its file picker.",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Artifact ids of the files to attach, e.g. [\"file_0123456789abcdef\"]. Usually one.",
        },
      },
      required: ["ref", "ids"],
    },
    risky: true,
  },
  {
    name: "browser_scroll",
    group: "browser",
    description:
      "Scroll to bring other elements on screen, and return what is there " +
      "afterwards and where that left you (how far down, how much is left, or " +
      "that nothing moved because you are already at the end). Scrolls " +
      "whatever actually scrolls -- the page, or the pane that does on app-like " +
      "sites. Give `text` to jump straight to where some text is (asking again " +
      "moves on to the next place it appears), `ref` to scroll inside that " +
      "element (a list, a side panel, a dialog), `to` for the top or bottom, " +
      "or `screens` to move by screenfuls. Not needed for reading: browser_read " +
      "returns the text in parts.",
    parameters: {
      type: "object",
      properties: {
        screens: {
          type: "number",
          description: "How far, in screens: 1 is down one screen, -1 up one. Default 1.",
        },
        to: { type: "string", enum: ["top", "bottom"], description: "Go straight to the top or the bottom." },
        text: { type: "string", description: "Scroll to where this text appears on the page." },
        ref: {
          type: "integer",
          description: "Scroll inside this element (or its scrolling container) rather than the page; alone, just bring it into view.",
        },
      },
    },
  },
  {
    name: "browser_press",
    group: "browser",
    description:
      "Press keys on the open page, as at a keyboard: Escape to close a " +
      "dialog or menu, Enter to submit or pick, Tab to move to the next " +
      "field, ArrowDown/ArrowUp to walk a suggestion list (then Enter to " +
      "choose), PageDown, Backspace, or a combination such as Control+A. " +
      "Give `ref` to focus that element first. Returns the page afterwards.",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Keys in order, e.g. [\"ArrowDown\", \"Enter\"]. Names as Playwright spells them: Enter, Escape, Tab, ArrowDown, PageDown, Backspace, Control+A.",
        },
        ref: { type: "integer", description: "Focus this element before pressing." },
      },
      required: ["keys"],
    },
    risky: true,
  },
  {
    name: "browser_signin_import",
    group: "browser",
    description:
      "Sign the browser in to a site with the person's own sign-in, brought " +
      "over as a cookie export they uploaded. Use this when a site refuses to " +
      "let this browser sign in (\"This browser or app may not be secure\", " +
      "\"browser not supported\", a sign-in that keeps bouncing): ask the " +
      "person to sign in to that site in their own browser, export its " +
      "cookies (the Cookie-Editor extension: open it on the site, Export, " +
      "JSON), and upload the file here; then call this with the file's " +
      "artifact id. The sign-in lasts until the site expires it. The uploaded " +
      "file is deleted after a successful import, since it is a live key to " +
      "the account.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The uploaded cookie file's artifact id (see artifact_list)." },
        keep_file: {
          type: "boolean",
          description: "Keep the uploaded file instead of deleting it after import. Default false.",
        },
      },
      required: ["id"],
    },
    risky: true,
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
      "Take a picture of the open page. You get it back in the result, so this " +
      "is how to see a page rather than read it: use it when asked what " +
      "something looks like, when a page is stuck or half drawn, or when " +
      "something is on it that its text does not mention. The person sees it " +
      "too, on the browser screen. It is the last picture kept: an earlier one " +
      "is dropped when a new one arrives. To keep a screenshot -- as evidence, " +
      "for a report, because the person asked for one -- give save_as (and " +
      "notebook to file it there); full_page, selector or area choose what is in it.",
    parameters: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "The whole page, scrolled top to bottom, not just the window." },
        ref: { type: "number", description: "Only this numbered element, from the page's element list." },
        selector: { type: "string", description: "Only this element, by CSS selector (e.g. main, #invoice, table.results)." },
        area: {
          type: "object",
          description: "Only this rectangle of the window, in pixels from its top-left.",
          properties: {
            x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
          },
        },
        save_as: { type: "string", description: "Keep it as an artifact with this file name (.png is added)." },
        notebook: { type: "string", description: "Also file it in this notebook (id or title; a new title makes one)." },
        note: { type: "string", description: "With save_as: one line on what it shows -- its annotation in the notebook." },
      },
    },
  },
  {
    name: "browser_eval",
    group: "browser",
    description:
      "Run JavaScript in the open page, and get back what it returned with the page " +
      "as it is afterwards. This is how to reach what the numbered outline cannot " +
      "see: a dialog drawn by script (no refs anywhere), a control with no label, a " +
      "value that lives only in the DOM, or a list too long to read. Use it when a " +
      "read comes back unchanged, when a click by number does nothing, or when two " +
      "reads have told you the same thing twice. `script` is the whole script: an " +
      "expression (`document.title`), or statements with a return (`const b = " +
      "__autora.all(\"button\"); return b.length;`). The page has helpers: " +
      "__autora.byText(\"Save as draft\") finds the element that says those words " +
      "(also matching aria-label, title and placeholder), __autora.all(css) lists " +
      "elements, __autora.el(css) is one, and __autora.click(anything) really clicks " +
      "it - the click is drawn on the person's screen and reported back with what it " +
      "hit. A click that finds nothing says so rather than clicking the wrong thing. " +
      "Scripts are given 8 seconds. Everything the script does is real: it can " +
      "change the page, so click once and read the result.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "The JavaScript to run in the page. E.g. " +
            "__autora.click(__autora.byText(\"Save as draft\")) to click a button no " +
            "outline lists, or __autora.all(\"button\").map((b) => b.innerText) to see " +
            "what the buttons on the page say.",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "browser_captcha",
    group: "browser",
    description:
      "Tick a checkbox CAPTCHA on the open page -- reCAPTCHA's \"I'm not a robot\", " +
      "hCaptcha, or Cloudflare Turnstile -- using humanlike mouse movement (curved path, " +
      "varying speed, off-centre landing, natural press timing). These checkboxes sit in " +
      "iframes and never appear in the numbered outline, so use this instead of " +
      "browser_click. It also finds one the page draws itself, with no widget frame at " +
      "all -- a look-alike box that says it is a checkbox. When there is a picture " +
      "challenge to answer -- a grid of images to pick from, or a piece to drag -- this " +
      "answers that too, whether the widget draws it or the page does, using the " +
      "backends set in Settings, and reports which one did it. Call it again for a " +
      "challenge that is still there; hand the browser to the person with browser_handoff " +
      "only when it says it has given up.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_handoff",
    group: "browser",
    description:
      "Hand the live browser to the person watching and wait for them. Call this when you " +
      "reach a sign-in (OAuth/SSO, a password, a 2FA code), a CAPTCHA that browser_captcha " +
      "could not pass, or anything on the page only they should do. Not for a site that " +
      "refuses this browser's sign-in outright -- they will be refused too; use " +
      "browser_signin_import for that. They get a card " +
      "explaining what is needed and can then tap and type directly in the page. This " +
      "call returns when they say they are done (with the page as it is then) or that " +
      "they cannot do it. For a CAPTCHA it also returns by itself the moment the page " +
      "shows it passed, so never ask the person whether they have finished one.",
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
      "with custom headers and body. For APIs and data files, not for looking at websites: use " +
      "browser_open for those, which the person can watch. A web page fetched here comes back as " +
      "its readable text, not its HTML. If calling api.github.com, automatically attaches the " +
      "GITHUB_TOKEN from the workspace secret store so you never need to ask the user for passwords. " +
      "The person's saved details and sign-ins go in as placeholders -- {{cred:first_name}}, " +
      "{{cred:github.com:password}} -- in the url, in any header value or in the body; the real " +
      "value is substituted for you and never appears in the transcript. A sign-in is only " +
      "substituted into a request to a site it belongs to.",
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
      "without being blocked by search engine bot detection. Then open the result you need with " +
      "browser_open.",
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
      "Take a picture of the relayed desktop. You get it back in the result, so " +
      "this is how to see the screen; the person sees it too. Coordinates for " +
      "the click and move tools are in that screen's own pixels, whose full " +
      "size is given in the result.",
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

  // --------------------------------------------------------------- person --
  {
    name: "ask_user",
    group: "person",
    description:
      "Stop and ask the person a question, shown to them as a card they answer " +
      "with a tap. The turn waits until they answer. Use it when you genuinely " +
      "cannot proceed well without them: a real ambiguity in what they want, a " +
      "choice between approaches with different costs, missing information only " +
      "they have, or confirmation before something irreversible. Do not use it " +
      "for things you can find out yourself, and do not ask for passwords here " +
      "(use browser_handoff so they type them into the page). Prefer offering " +
      "2-5 concrete options, each with a short label and a one-line detail; keep " +
      "allow_text on so they can answer in their own words.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question itself, one short sentence.",
        },
        context: {
          type: "string",
          description: "Optional: one or two sentences on why you are asking or what you found.",
        },
        options: {
          type: "array",
          description: "Suggested answers. Omit for an open question.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "A few words." },
              detail: { type: "string", description: "Optional one-line explanation." },
            },
            required: ["label"],
          },
        },
        multi_select: {
          type: "boolean",
          description: "Let them pick more than one option. Default false.",
        },
        allow_text: {
          type: "boolean",
          description: "Let them type their own answer. Default true.",
        },
        placeholder: {
          type: "string",
          description: "Hint text for the typed answer.",
        },
      },
      required: ["question"],
    },
  },

  {
    name: "camera_look",
    group: "person",
    description:
      "Look through the person's camera, while they have live view on in talk " +
      "mode. You get the newest frame back as a picture -- which is the only " +
      "frame there is: the view is a stream at about a frame a second and only " +
      "the most recent one exists, so there is nothing to rewind to. Use it " +
      "when you need to see again mid-turn: something moved, a step has been " +
      "done, or you have been asked what you see now. While live view is on, " +
      "the newest frame also arrives by itself with each message, so a call is " +
      "only needed to refresh. It says so when the view is off, rather than " +
      "returning a stale picture.",
    parameters: { type: "object", properties: {} },
  },

  // ---------------------------------------------------------------- mcp --
  {
    name: "mcp_servers",
    group: "person",
    description:
      "List the MCP servers set up here (with their status and tools) and the ones you " +
      "can offer to set up, each with why it beats doing the same job in the browser. " +
      "Use it when the person asks about MCP servers or integrations, or before offering " +
      "one. Pass `topic` (their request, or a service name) to see the servers that fit.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Optional: what the person wants to do, or a service (github, slack...)." },
      },
    },
  },
  {
    name: "mcp_offer",
    group: "person",
    description:
      "Offer to set up an MCP server, shown to the person as a card with Set it up / Not now; " +
      "it installs and connects only if they agree, and its tools (mcp__<name>__<tool>) are " +
      "yours from your next step. Offer one when a task lives on a service that has an API -- " +
      "GitHub, Slack, Notion, a database, maps, library docs -- and a server would do it more " +
      "reliably than the browser, or when they ask for an integration. Say `why` in one line, " +
      "about their task. Give exactly one of: `server` (a catalog id from mcp_servers), " +
      "`package` (an MCP server on npm, with `name`), `url` (a remote MCP server, with `name`), " +
      "or `tools` (write your own: each {name, description, parameters (JSON schema), code}, " +
      "where code is the body of `async (args, env) => {...}` that returns a string or JSON; " +
      "`fetch` is available, and keys arrive in env). List keys it needs in `needs` " +
      "(env var names); the card collects them into Secrets, so never ask for keys in chat. " +
      "If they say not now, carry on another way and do not offer it again this session.",
    parameters: {
      type: "object",
      properties: {
        why: { type: "string", description: "One line: why this is better for what they asked than what you would otherwise do." },
        server: { type: "string", description: "A catalog server id (see mcp_servers)." },
        path: { type: "string", description: "For the filesystem server: the directory it may use." },
        name: { type: "string", description: "Short name for a server not in the catalog; becomes its tool prefix." },
        title: { type: "string", description: "Human name for the card." },
        summary: { type: "string", description: "One line: what it gives you." },
        package: { type: "string", description: "npm package of an MCP server, run with npx -y." },
        args: { type: "array", items: { type: "string" }, description: "Extra command-line arguments for the package." },
        url: { type: "string", description: "Endpoint of a remote MCP server (streamable HTTP or SSE)." },
        needs: {
          type: "array",
          description: "Keys it needs, collected on the card into Secrets and passed as environment variables (for a url, the first is sent as a Bearer token).",
          items: {
            type: "object",
            properties: {
              env: { type: "string", description: "Environment variable name, e.g. LINEAR_API_KEY." },
              label: { type: "string", description: "What to call it on the card." },
              url: { type: "string", description: "Where to get one." },
              hint: { type: "string", description: "What it looks like." },
              optional: { type: "boolean", description: "True when the server works without it, so the card installs without the key." },
            },
            required: ["env", "label"],
          },
        },
        tools: {
          type: "array",
          description: "For a server you write: its tools.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              parameters: { type: "object", description: "JSON schema: {properties, required}." },
              code: { type: "string", description: "Body of async (args, env) => { ... }; return a string or JSON." },
            },
            required: ["name", "description", "code"],
          },
        },
      },
      required: ["why"],
    },
    risky: true,
  },

  // -------------------------------------------------------------- voice --
  {
    name: "speak",
    group: "voice",
    description:
      "Say something out loud to the person, right now, in the console's own " +
      "voice (a Deepgram API key when there is one, otherwise the browser's " +
      "voice). It plays immediately on the page they have open -- nothing is " +
      "saved and there is no file to hand over. Use it whenever you are asked " +
      "to say, read out, pronounce or speak something, or to try the voice. " +
      "Never make an audio file for this, never call Deepgram yourself " +
      "from the terminal or http_request, and never save or attach a recording: " +
      "this tool is how you speak. Keep each call to what you mean to be heard " +
      "(up to about 2,000 characters), plain words with no markdown.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Exactly what to say aloud." },
      },
      required: ["text"],
    },
  },

  {
    name: "voice_mute",
    group: "voice",
    description:
      "Stop or start the console saying things out loud on this page, at once. " +
      "Call it with muted true the moment the person asks you to stop talking, " +
      "be quiet, or says the voice is annoying: it silences whatever is being " +
      "said mid-sentence and silences the speak tool, and the switch in " +
      "Settings -> Model & tools -> Voice shows it. It does not change whether " +
      "replies are read out in talk mode -- that is the person's own listening " +
      "switch.",
    parameters: {
      type: "object",
      properties: {
        muted: {
          type: "boolean",
          description: "True to go quiet, false to be heard again.",
        },
      },
      required: ["muted"],
    },
  },

  // ------------------------------------------------------------ widgets --
  {
    name: "widget_show",
    group: "person",
    description:
      "Show an interactive explainer widget in the conversation: a small, " +
      "self-contained web page you write (HTML with inline <style> and " +
      "<script>) that runs in a sandboxed frame in the thread. Use it when a " +
      "concept is easier to understand by seeing and playing with it than by " +
      "reading -- how gravity bends orbits, the water cycle, a sorting " +
      "algorithm, compound interest, how a lens focuses light -- and give a " +
      "short written explanation alongside it. For 3D, import Three.js as an " +
      "ES module: `<script type=\"module\">import * as THREE from \"three\"; " +
      "import { OrbitControls } from \"three/addons/controls/OrbitControls.js\";` " +
      "(CSS2DRenderer and CSS2DObject from \"three/addons/renderers/CSS2DRenderer.js\" " +
      "are there too, for labels). For 2D use <canvas> or inline SVG. No other " +
      "libraries are available and the frame has no network access to rely on, " +
      "so write everything inline. Make it interactive: sliders, buttons, " +
      "drag to rotate, play/pause, and label what is on screen. Size to the " +
      "frame: use width 100% and window.innerWidth/innerHeight for canvases " +
      "(and handle the resize event, the person can make it full screen); do " +
      "not use 100vh plus margins. CSS variables --bg, --surface, --text, " +
      "--muted, --accent, --accent-2, --border and --font match the app's " +
      "theme; the page is dark. Buttons, sliders and the body are already " +
      "styled to match. Before the person sees it, it is run in a headless " +
      "browser and tried -- loaded, watched, every control used, the canvas " +
      "dragged -- and you get back a report: errors and when they happened, " +
      "the text, controls and canvases on screen, a map of where the drawing " +
      "is and its colours, whether it animates and whether each control " +
      "changed the picture. A widget with errors or nothing visible is not " +
      "shown: read the report, fix the cause, and call widget_show again with " +
      "the whole corrected widget. When it is shown, read the report too, and " +
      "fix anything that does not look like what you meant (a drawing crammed " +
      "in a corner, a slider that changes nothing). It is also saved as an artifact.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short title shown above the widget, e.g. \"Orbits and gravity\"." },
        html: {
          type: "string",
          description:
            "The widget: the contents of <body> (or a whole HTML document), " +
            "with its CSS and JavaScript inline.",
        },
        height: {
          type: "number",
          description: `Height of the frame in CSS pixels, ${WIDGET_MIN_HEIGHT}-${WIDGET_MAX_HEIGHT}. Default ${WIDGET_DEFAULT_HEIGHT}; the frame also grows to fit content taller than this.`,
        },
      },
      required: ["title", "html"],
    },
  },

  // ---------------------------------------------------------- artifacts --
  {
    name: "artifact_save",
    group: "files",
    description:
      "Save a file you made as an artifact, so the person can find, open and " +
      "download it on the Artifacts page long after this conversation. Use it " +
      "for deliverables -- a report, a document, a spreadsheet, a script, an " +
      "export -- not for scratch output. Give either `content` (the text of " +
      "the file) or `path` (a file on this host, e.g. one you built with the " +
      "terminal). Images from image_generate are saved automatically. Save " +
      "only what is net new or has changed. Do not save a copy of a file that " +
      "is already in the workspace or already on the Artifacts page, and do " +
      "not save a picture you downloaded or found online -- it can be fetched " +
      "again from its own address and the thread already shows it. Check " +
      "artifact_list first when you are unsure. Saving a name that is already " +
      "there replaces that artifact's contents in place, so save again only " +
      "when the file itself is different. If the person asks you to keep " +
      "something, save it.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "File name with extension, e.g. q3-report.md or data.csv.",
        },
        content: { type: "string", description: "The file's text." },
        path: { type: "string", description: "Absolute path of a file on this host to save instead." },
        note: { type: "string", description: "One line on what it is." },
        notebook: {
          type: "string",
          description: "A notebook (id or title) to file it in as well. A title no notebook has makes a new one.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "artifact_list",
    group: "files",
    description:
      "List the artifacts in the workspace: files the person uploaded for you " +
      "(documents, photos, spreadsheets) and files you made earlier. When the " +
      "person mentions something they uploaded, look here first.",
    parameters: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          enum: ["all", "user", "agent"],
          description: "user = uploaded by the person, agent = made by you. Default all.",
        },
      },
    },
  },
  {
    name: "artifact_read",
    group: "files",
    description:
      "Read an artifact by id. Text files come back as text (use offset and " +
      "length for long ones); images are shown in the conversation; for a PDF, " +
      "use pdf_read and pdf_look instead; anything else is reported with the " +
      "path on this host, so the terminal can open it.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The artifact id, e.g. file_0123456789abcdef." },
        offset: { type: "number", description: "Character to start from. Defaults to 0." },
        length: { type: "number", description: "How many characters to return." },
      },
      required: ["id"],
    },
  },
  {
    name: "notebook",
    group: "files",
    description:
      "Notebooks group artifacts by purpose, with notes between them, on the person's Notebooks page. " +
      "Use one for any report, case or dossier built from several sources: file every source (email, " +
      "document, screenshot) as an entry with a line on what it shows, and write findings, rebuttals and " +
      "summaries as notes that cite the files they rest on. Actions: list; create (title, purpose); " +
      "read (the whole notebook, every entry with its id -- read it before saying a notebook is done, " +
      "and check every source is in it and every claim cites one); add (artifacts, or a note with " +
      "title/text/cites; position to insert); edit (entry and title/text/cites, or no entry to change " +
      "the notebook's title/purpose); remove (entry; the file stays an artifact); move (entry, position); " +
      "export (the whole notebook as one Markdown artifact, files as numbered exhibits).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "read", "add", "edit", "remove", "move", "export"],
        },
        notebook: { type: "string", description: "The notebook's id (nb_...) or its title." },
        title: { type: "string", description: "create: the notebook's title. add/edit: a note's heading or a file's caption." },
        purpose: { type: "string", description: "create/edit: what the notebook is for." },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "add: artifact ids (file_...) or names to file, each as its own entry. text becomes their annotation.",
        },
        text: { type: "string", description: "add/edit: a note's body, or a file's annotation, in Markdown." },
        cites: {
          type: "array",
          items: { type: "string" },
          description: "add/edit: artifact ids or names the note's claims rest on.",
        },
        entry: { type: "string", description: "edit/remove/move: the entry id (en_...), from read." },
        position: { type: "number", description: "add/move: where, counting from 1. Default the end." },
        offset: { type: "number", description: "read: character to start from, for a notebook too long to read at once." },
      },
      required: ["action"],
    },
  },

  {
    name: "edit_file",
    group: "terminal",
    description:
      "Change a file in the working folder, or make a new one, without losing anything the person saved to it " +
      "meanwhile. Prefer this to sed or a shell redirect for any file the person might also have open: it " +
      "compares the file with what you last read, keeps their changes next to yours when you touched different " +
      "lines, and writes nothing -- telling you exactly what they did -- when you both changed the same lines. " +
      "edits is a list of {old, new}: old is the exact text to replace (it must be in the file once, or set all), " +
      "new is what it becomes. content makes a whole new file, or with overwrite replaces one. Paths are from the " +
      "terminal's directory. Read the lines you are changing first; keep old short but exact.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, from the terminal's directory." },
        edits: {
          type: "array",
          description: "What to replace, in order.",
          items: {
            type: "object",
            properties: {
              old: { type: "string", description: "The exact text to replace." },
              new: { type: "string", description: "What it becomes." },
              all: { type: "boolean", description: "Replace every place it occurs." },
            },
            required: ["old", "new"],
          },
        },
        content: { type: "string", description: "A whole file: to make a new one." },
        overwrite: { type: "boolean", description: "With content: replace a file that already exists." },
      },
      required: ["path"],
    },
    risky: true,
  },

  {
    name: "code_search",
    group: "terminal",
    description:
      "Find where something is in a folder of code, without reading files one at a time. Plain code does the " +
      "searching, not a model, so it is fast and nothing in it is a guess. Three ways: ranked (the default) finds " +
      "the places most about some words -- \"fetch user\" finds fetchUserById and fetch_user_by_id -- and returns each " +
      "with its best lines; exact finds every line holding some text; regex finds every line matching a pattern. " +
      "Results are path:line, so read just that place afterwards (sed -n 'START,ENDp' file) instead of the whole " +
      "file. It skips node_modules, build output, hidden folders, environment files and binaries. Start here when " +
      "you do not know where something lives; use the terminal's grep only for something this cannot say.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to rank by, or the exact text, or a regular expression." },
        mode: { type: "string", enum: ["ranked", "exact", "regex"], description: "Default ranked." },
        path: { type: "string", description: "A folder to look in, from the terminal's directory. Default: the terminal's directory." },
        glob: { type: "string", description: "Only files matching this: \"*.ts\", \"src/**/*.tsx\"." },
        case_sensitive: { type: "boolean", description: "For exact and regex. Default any case." },
        max: { type: "number", description: "How many places to return (ranked) -- default 8, at most 30." },
      },
      required: ["query"],
    },
  },

  {
    name: "read_file",
    group: "terminal",
    description:
      "Read a text file, or part of one, with line numbers -- without the terminal. By default the first 200 " +
      "lines; start and end read a range. outline lists the file's functions, classes and headings with their " +
      "line numbers, so a large file costs a few lines to understand; symbol returns the whole body of one " +
      "function, class or heading by name. Prefer outline then symbol to cat-ing a big file. Paths are from the " +
      "terminal's directory. Reads only: use edit_file to change a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, from the terminal's directory." },
        start: { type: "number", description: "First line, from 1." },
        end: { type: "number", description: "Last line, inclusive. At most 600 lines at a time." },
        outline: { type: "boolean", description: "List declarations and headings with line numbers." },
        symbol: { type: "string", description: "Return the body of the declaration with this name." },
      },
      required: ["path"],
    },
  },

  {
    name: "research",
    group: "schedule",
    description:
      "Hand a self-contained question to a separate research worker and get a short report back. The worker has a " +
      "clean context and read-only tools (code search, read-only commands, files, PDFs, web search where available), " +
      "does the looking, and returns findings with where it saw each -- none of its searching or reading enters this " +
      "conversation. Use it when answering needs a lot of looking and you only need the conclusion: \"where is X " +
      "handled and what does it do?\", \"which of these files uses Y?\", \"what does this library say about Z?\". " +
      "Do not use it for something one search answers, or for anything that has to change a file: it cannot. Write the " +
      "question so it stands alone -- the worker has not seen this conversation -- and say what you need back.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What to find out, complete in itself, and what form the answer should take." },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "Two or three independent questions, each complete in itself. They are looked into at the same time by separate workers and come back together, so use this instead of calling research several times.",
        },
      },
    },
  },

  // ---------------------------------------------------------------- PDFs --
  {
    name: "pdf_read",
    group: "files",
    description:
      "Read a PDF: its pages and their sizes, its properties, its form fields (name, kind, value, choices, " +
      "and where each one is), its attachments and XFA, and its text page by page. Give find to search it " +
      "instead: each match comes back with its page and box. Positions in all the PDF tools are points " +
      "(1/72 inch) from the top-left corner of the page as it is shown, so what pdf_read reports, pdf_look's " +
      "grid shows and pdf_edit takes all line up. extract saves embedded files (the XML inside an e-invoice, " +
      "say) or an XFA form's XML as artifacts, to read with artifact_read.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        pages: {
          type: "string",
          description: "Which pages' text: \"1-3,7\", \"5-\", \"last\". Default all, as far as fits; the result says how to read on.",
        },
        find: {
          type: "array",
          items: { type: "string" },
          description: "Search instead of reading: plain text (any case), a /regular expression/, or email, phone, ssn, credit_card, date.",
        },
        extract: {
          type: "array",
          items: { type: "string" },
          description: "Embedded files to save as artifacts, by name, or \"all\"; \"xfa\" saves an XFA form's XML.",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_look",
    group: "files",
    description:
      "See a PDF's pages as pictures: in this result, and in the conversation for the person. Use it to read " +
      "a scan, to see where things are before putting something on a page, and to check your own edits " +
      "before saying they are done. grid rules the page, labelled in points from its top-left corner -- the " +
      "coordinates pdf_edit takes. area zooms into part of one page. XFA forms (the kind most viewers only say " +
      "\"please wait\" to) are drawn too.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        pages: { type: "string", description: "Which pages, at most 4 at a time: \"1\", \"2-3\", \"last\". Default 1." },
        grid: { type: "boolean", description: "Rule the page with labelled lines, for reading off positions." },
        area: {
          type: "object",
          description: "Part of the (first) page to look at closely, in points from its top-left.",
          properties: {
            x: { type: "number" }, y: { type: "number" },
            width: { type: "number" }, height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_edit",
    group: "files",
    description:
      "Change a PDF, saving the result as a new artifact shown in the conversation (the person's own file is " +
      "never overwritten; your own earlier result is updated in place). In one call, in this order: fill form " +
      "fields, flatten the form, draw items on pages, add a watermark, number the pages, set or strip the " +
      "document's properties. Items: text, stamp (APPROVED, REJECTED, SIGN_HERE, INITIAL_HERE, DATE, " +
      "CONFIDENTIAL, COPY, or any short word), signature (a picture of one, or a typed name in a handwriting " +
      "font), image, check, cross, rect, ellipse, line, arrow, path, highlight (a box, or every match of some " +
      "text) and note (a comment). Positions are points from the top-left of the page as shown -- read them " +
      "off pdf_read, or pdf_look with grid. Drawing over something hides it but does not remove it: pdf_redact " +
      "takes text out, and pdf_replace_text changes the words a file already has. The file opens in the PDF window beside the conversation, where what you add stays an " +
      "object the person can move, change or remove, and they can add their own; edit the same file again to " +
      "carry on with it. Everything you add, change or remove is marked in the window for the person to accept or " +
      "decline one by one (a declined change is undone and you are told), and each state of the file is kept as a " +
      "version they can go back to. Look at the pages you changed with pdf_look before saying it is done.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        fields: {
          type: "object",
          additionalProperties: true,
          description:
            "Form fields to fill, by the names pdf_read lists: text for a text field, true or false for a " +
            "checkbox, the option for a radio group or dropdown, a list for a multi-select list.",
        },
        flatten: { type: "boolean", description: "Make the form part of the page, so its values can no longer be changed." },
        add: {
          type: "array",
          description: "Things to draw on pages, in order.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["text", "stamp", "signature", "image", "check", "cross", "rect", "ellipse", "line", "arrow", "path", "highlight", "note"],
              },
              page: { type: "string", description: "Page number, or pages like \"1-3\" or \"all\" to put it on each. Default 1." },
              x: { type: "number", description: "Left edge, in points from the page's left." },
              y: { type: "number", description: "Top edge, in points from the page's top." },
              width: { type: "number", description: "Width in points. Text wraps at it; a picture keeps its shape when only one side is given." },
              height: { type: "number", description: "Height in points." },
              x2: { type: "number", description: "Where a line or arrow ends." },
              y2: { type: "number", description: "Where a line or arrow ends." },
              text: {
                type: "string",
                description: "The words: of a text item or note, a typed signature, a stamp's own label, or the text to highlight wherever it is on the page.",
              },
              stamp: {
                type: "string",
                description: "APPROVED, REJECTED, SIGN_HERE, INITIAL_HERE, DATE (today's date), CONFIDENTIAL, COPY, or any short word.",
              },
              image: { type: "string", description: "A picture, as an artifact id or a path: the signature or image to place." },
              field: { type: "string", description: "A form field's name: put the signature or picture in that field's box, instead of at x and y." },
              size: { type: "number", description: "Font size for text (default 12); the box for check and cross (default 14)." },
              color: { type: "string", description: "Ink or outline: a name (black, red, blue, ink...) or #rrggbb; none for no outline." },
              fill: { type: "string", description: "Fill colour for rect, ellipse and path." },
              background: { type: "string", description: "A colour behind text, e.g. white to cover what was there." },
              font: { type: "string", enum: ["helvetica", "times", "courier"] },
              bold: { type: "boolean" },
              italic: { type: "boolean" },
              align: { type: "string", enum: ["left", "center", "right"], description: "Within width." },
              thickness: { type: "number", description: "Line width in points." },
              opacity: { type: "number", description: "0 to 1." },
              d: { type: "string", description: "For path: an SVG path in points from x, y, e.g. \"M 0 10 L 120 10\"." },
            },
            required: ["type"],
          },
        },
        change: {
          type: "array",
          description:
            "Objects already on the pages to alter, by id (from the results of earlier pdf_edit calls): each is " +
            "{id, ...} with only the fields that differ, using the same fields as add items.",
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: true },
        },
        remove: { type: "array", items: { type: "string" }, description: "Ids of objects on the pages to take off." },
        watermark: {
          type: "object",
          description: "Big faint text across pages, e.g. {\"text\": \"DRAFT\"}.",
          properties: {
            text: { type: "string" },
            pages: { type: "string", description: "Default all." },
            color: { type: "string" },
            opacity: { type: "number", description: "Default 0.2." },
            size: { type: "number", description: "Default: as big as fits." },
            rotation: { type: "number", description: "Degrees, counter-clockwise. Default 45." },
          },
          required: ["text"],
        },
        page_numbers: {
          type: "object",
          description: "Number the pages, e.g. {\"format\": \"Page {n} of {total}\"}.",
          properties: {
            format: { type: "string", description: "With {n} and optionally {total}. Default \"Page {n} of {total}\"." },
            position: {
              type: "string",
              enum: ["bottom-center", "bottom-left", "bottom-right", "top-center", "top-left", "top-right"],
            },
            pages: { type: "string", description: "Which pages carry a number, e.g. \"2-\" to skip a cover. Default all." },
            start: { type: "number", description: "The first number shown. Default 1." },
            size: { type: "number" },
            color: { type: "string" },
          },
        },
        metadata: {
          type: "object",
          description: "Document properties to set.",
          properties: {
            title: { type: "string" }, author: { type: "string" }, subject: { type: "string" },
            keywords: { type: "string" }, creator: { type: "string" }, producer: { type: "string" },
          },
        },
        strip_metadata: { type: "boolean", description: "Remove all its document properties (title, author, dates, software, XMP) first." },
        output: PDF_OUTPUT,
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_compose",
    group: "files",
    description:
      "Write a new PDF -- a report, brief, summary, comparison -- from a description of the document, and keep it " +
      "as that description so you can carry on with it. You give headings, paragraphs, lists, tables, quotes, " +
      "code and pictures; the wrapping, page breaks, page numbers and a numbered list of sources are done for you, " +
      "so there are no coordinates to work out. Use this, not pdf_edit, to produce a document with words in it; " +
      "pdf_edit is for marking up a file that exists (stamps, signatures, notes, form fields). The result is shown " +
      "in the PDF window beside the conversation, where pdf_edit's objects can go on top of it and the person can " +
      "add their own. When you find something new, do not start over: send update (change a block by id), insert " +
      "(new blocks after a given block) or remove, and the whole document is laid out again with the same ids. The " +
      "result tells you which heading is on which page and the id of every block. Cite as you go: give a block " +
      "its source (a URL or a note) and it is marked [n] and listed under Sources at the end. In text, **bold**, " +
      "*italic*, `code` and [words](https://link) work; a blank line starts a new paragraph. The built-in fonts " +
      "cover Western European letters only. Look at the pages with pdf_look before saying it is done.",
    parameters: {
      type: "object",
      properties: {
        blocks: {
          type: "array",
          description:
            "The whole document, in order (replaces what there was). Each block has a type and, optionally, an id " +
            "(one is made up otherwise) and a source. Types: heading {text, level 1-3}; paragraph {text}; " +
            "bullets {items: [text or {text, source}], ordered}; table {header: [..], rows: [[..]], widths: [relative " +
            "numbers], align: [left|right|center per column], caption}; quote {text}; code {text}; image {image: " +
            "artifact id or path of a PNG/JPEG, width in points, caption}; rule; page_break.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Names the block for update, insert and remove." },
              type: { type: "string", description: "heading, paragraph, bullets, table, quote, code, image, rule or page_break." },
              text: { type: "string" },
              level: { type: "number", description: "For a heading: 1 (largest) to 3." },
              items: { type: "array", items: {} },
              ordered: { type: "boolean" },
              header: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
              widths: { type: "array", items: { type: "number" } },
              align: { type: "array", items: { type: "string" } },
              image: { type: "string" },
              width: { type: "number" },
              caption: { type: "string" },
              source: {
                description: "Where this came from: a URL or a note (or a list of them). Cited as [n] and listed at the end.",
                anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              },
            },
            required: ["type"],
          },
        },
        update: {
          type: "array",
          description: "Changes to blocks of the document already made: each {id, ...the fields to change}. The type may change too.",
          items: { type: "object", additionalProperties: true },
        },
        insert: {
          type: "array",
          description: "New blocks to put in: each {after: a block id, or \"start\" or \"end\", blocks: [...]}.",
          items: { type: "object", additionalProperties: true },
        },
        remove: { type: "array", items: { type: "string" }, description: "Ids of blocks to take out." },
        title: { type: "string", description: "The title at the top of the first page, and the file's title." },
        subtitle: { type: "string" },
        author: { type: "string" },
        date: { type: "string", description: "Shown beside the author, e.g. \"1 Oct 2026\"." },
        paper: { type: "string", description: "a4 (default) or letter." },
        landscape: { type: "boolean" },
        font: { type: "string", description: "helvetica (default, sans-serif) or times (serif)." },
        size: { type: "number", description: "Body text size in points, 8 to 16 (default 11)." },
        margin: { type: "number", description: "Page margin in points (default 56)." },
        page_numbers: {
          description: "A format with {n} and {total} (default \"Page {n} of {total}\"), or false for none.",
          anyOf: [{ type: "string" }, { type: "boolean" }],
        },
        sources_heading: {
          description: "The title of the list of sources at the end (default \"Sources\"), or false to leave the list out.",
          anyOf: [{ type: "string" }, { type: "boolean" }],
        },
        output: PDF_OUTPUT,
      },
    },
  },
  {
    name: "pdf_pages",
    group: "files",
    description:
      "Rearrange a PDF's pages, saving the result as a new artifact shown in the conversation: keep some, " +
      "drop some, change their order, repeat one, add blank pages, turn pages, add the pages of other PDFs " +
      "after them (merge), or split the result into several files. Page numbers are this file's own, before " +
      "any change. Dropped pages are taken out of the file, not hidden.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        pages: {
          type: "string",
          description:
            "The pages of the result, in order, by number: \"3,1,2\" reorders, \"1-4,6-\" drops page 5, " +
            "\"1,1,2-\" repeats page 1, \"1,blank,2-\" puts a blank page after page 1, \"last-1\" reverses. " +
            "Default all, as they are.",
        },
        rotate: {
          type: "array",
          description: "Turn pages clockwise, e.g. [{\"pages\": \"2\", \"degrees\": 90}].",
          items: {
            type: "object",
            properties: {
              pages: { type: "string", description: "Default all." },
              degrees: { type: "number", description: "90, 180 or 270." },
            },
            required: ["degrees"],
          },
        },
        merge: {
          type: "array",
          items: { type: "string" },
          description: "Other PDFs (artifact ids or paths) whose pages go after these, in order.",
        },
        split: {
          type: "array",
          items: { type: "string" },
          description: "Make several files instead of one, each from pages of the result: [\"1-3\", \"4-\"], or [\"each\"] for one file per page.",
        },
        output: PDF_OUTPUT,
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_replace_text",
    group: "files",
    description:
      "Change words that are already in a PDF -- a name, an amount, a date, a typo -- and save the result as a new " +
      "artifact shown in the conversation. This edits the file's own text: where the page's font can write the new " +
      "words they are rewritten in place, in the same typeface, and stay selectable and searchable; where it cannot " +
      "(a letter the file's cut-down font never drew) the old words are taken out of the file and the new ones drawn in " +
      "a built-in font of the same kind, colour and size. Either way the old words are gone from the bytes, and the " +
      "rest of the page stays vector. Use this, not pdf_edit, to change what a page says: pdf_edit only draws on top, " +
      "and covering words with a white box leaves them in the file. It does not work on a scan (a picture of text has " +
      "no words); pdf_read find shows whether the words are text. find must be the words as pdf_read shows them. " +
      "Words are not reflowed: if the new words are longer or shorter, text the file places separately on the same line stays put. " +
      "Give every change in one call. Look at the result with pdf_look before saying it is done.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        replace: {
          type: "array",
          description: "The changes, each made wherever its words appear.",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "The words as they are now. Spacing between words does not matter." },
              with: { type: "string", description: "What they become. Empty to delete them." },
              ignore_case: { type: "boolean", description: "Match any capitalisation. Default exact." },
            },
            required: ["find", "with"],
          },
        },
        pages: { type: "string", description: "Which pages: \"1-3,7\", \"last\". Default all." },
        output: PDF_OUTPUT,
      },
      required: ["file", "replace"],
    },
  },
  {
    name: "pdf_redact",
    group: "files",
    description:
      "Take text or areas out of a PDF for good, saving the result as a new artifact shown in the " +
      "conversation. Each page with something to remove is redrawn as a picture with black boxes over it, so " +
      "what was under them is gone from the file rather than covered; pages with nothing to remove keep their " +
      "text. find takes plain text, /regular expressions/ and the presets email, phone, ssn, credit_card and " +
      "date; areas take boxes, read off pdf_look with grid. It says what it removed where. Check the result " +
      "with pdf_look.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        find: {
          type: "array",
          items: { type: "string" },
          description: "What to remove wherever it appears: plain text (any case), a /regular expression/, or email, phone, ssn, credit_card, date.",
        },
        areas: {
          type: "array",
          description: "Boxes to remove, in points from the page's top-left.",
          items: {
            type: "object",
            properties: {
              page: { type: "string", description: "A page, or pages like \"all\". Default 1." },
              x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" },
            },
            required: ["x", "y", "width", "height"],
          },
        },
        pages: { type: "string", description: "Only search these pages. Default all." },
        dpi: { type: "number", description: "How sharp the redrawn pages are. Default 150." },
        output: PDF_OUTPUT,
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_compress",
    group: "files",
    description:
      "Make a PDF smaller, saving it as a new artifact shown in the conversation. lossless (the default) " +
      "rewrites it compactly and drops anything unused, changing nothing you can see. images redraws every " +
      "page as a JPEG -- far smaller for scans and picture-heavy files, but the text can no longer be selected " +
      "or searched, and links and form fields are gone; it also turns an XFA form into an ordinary PDF of how " +
      "it looks. Nothing is saved if it does not get smaller.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        mode: { type: "string", enum: ["lossless", "images"] },
        dpi: { type: "number", description: "For images: resolution. Default 110." },
        quality: { type: "number", description: "For images: JPEG quality, 0.1 to 1. Default 0.7." },
        output: PDF_OUTPUT,
      },
      required: ["file"],
    },
  },

  // ---------------------------------------------------------------- Office --
  {
    name: "office_guide",
    group: "files",
    description:
      "How to edit a Word, Excel or PowerPoint file: the operations office_edit takes, with their fields and examples. " +
      "Read it BEFORE your first office_edit or office_create of a kind -- the operation names are exact and a wrong one is " +
      "rejected. domain is docs (Word), sheets (Excel) or slides (PowerPoint). With no topic it lists the operation groups; " +
      "topic is one group (e.g. text, insert, table) or one operation by name (e.g. setText); for slides, topic design or " +
      "spec describes building a new deck.",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "docs, sheets or slides." },
        topic: { type: "string", description: "An operation group or one operation; omit to list the groups." },
      },
      required: ["domain"],
    },
  },
  {
    name: "office_read",
    group: "files",
    description:
      "Read a Word (.docx), Excel (.xlsx) or PowerPoint (.pptx) file. Word: its blocks, each with the [index] edits target; " +
      "range \"0-20\" for part of it; include comments, revisions, styles, header-footer, sections, fields or notes for those. " +
      "Excel: the cells of a sheet and range (values, with each formula alongside), the sheet's features; stats gives counts " +
      "and the sheet list. PowerPoint: every slide's elements with their durable ids (s_1, e_...), positions in EMU (914400 " +
      "to the inch), text and effective font; slide for one slide, full for whole text and speaker notes, layouts for the " +
      "deck's layouts. This reads the file as saved; it cannot show you a page or a slide as a picture.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The document: an artifact id (file_...), a path on this host, or an artifact's name." },
        range: { type: "string", description: "Word: block range like \"0-20\". Excel: cell range like \"A1:D20\"." },
        sheet: { type: "string", description: "Excel: the worksheet (default: the active one)." },
        slide: { type: "number", description: "PowerPoint: only this 0-based slide." },
        full: { type: "boolean", description: "Whole text instead of previews (Word blocks, slide text, tables, notes)." },
        include: {
          type: "array",
          items: { type: "string" },
          description: "Word extras: comments, revisions, styles, header-footer, sections, fields, notes.",
        },
        formats: { type: "boolean", description: "Excel: also return cell formats, column widths and row heights." },
        stats: { type: "boolean", description: "Excel: counts, used range and the sheet list instead of cells." },
        where: { type: "string", description: "Excel: only cells of one kind: formula, error, empty, number or text." },
        layouts: { type: "boolean", description: "PowerPoint: also list the deck's layouts." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_edit",
    group: "files",
    description:
      "Change a Word, Excel or PowerPoint file with operations (call office_guide for the exact names and fields first). " +
      "Only what you edit is rewritten; the rest of the file survives byte for byte. The result is saved as a new artifact " +
      "beside the original (your own earlier result is updated in place). ops is the array of operations, targeted by the ids " +
      "office_read shows (Word: block [index]; PowerPoint: s_/e_ ids; Excel: cell addresses). Excel also takes cells: " +
      "[{cell:\"B2\", value|formula, sheet?, style?}] for plain cell edits -- formulas are recalculated, and the results are " +
      "in the file. Word: track:true records edits as tracked changes the person can accept or reject. dry_run validates and " +
      "reports each step without writing; best_effort applies every operation that can and lists the ones that cannot. " +
      "Check the result with office_check.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The document: an artifact id, a path, or an artifact's name." },
        ops: { type: "array", items: { type: "object" }, description: "The operations, in order. See office_guide." },
        cells: { type: "array", items: { type: "object" }, description: "Excel: [{cell, value|formula, sheet?, style?}]." },
        track: { type: "boolean", description: "Word: record the edits as tracked changes." },
        author: { type: "string", description: "Word with track: the author shown on the changes." },
        dry_run: { type: "boolean", description: "Validate and report without writing." },
        best_effort: { type: "boolean", description: "Apply what can be applied and list what cannot." },
        output: { type: "string", description: "File name for the result. Default: the original's name with -edited added." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_check",
    group: "files",
    description:
      "Look a Word, Excel or PowerPoint file over for problems, in place of seeing it. PowerPoint: text that overflows its " +
      "box, elements off the slide or overlapping, distorted pictures, each with a ready setTransform fix. Excel: formula " +
      "errors, references to sheets that are not there, broken names, chart ranges off the data, columns too narrow to show " +
      "their numbers (###), placeholder text. Word: fields with no result, broken bookmark references, a stale table of " +
      "contents, missing images, heading levels that skip, placeholder text, pending tracked changes, open comments. Run it " +
      "after you build or change a document, and fix what it reports before you say it is done.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The document: an artifact id, a path, or an artifact's name." },
        slide: { type: "number", description: "PowerPoint: only this 0-based slide." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_open",
    group: "files",
    description:
      "Open a Word, PowerPoint or Excel file in the window beside the conversation, in its own editor, so the person can " +
      "read it and change it while you work. A file you make or change with the Office tools opens there by itself; this is " +
      "for one that already exists (an upload, an earlier file). What they change is saved as they go and you are told what.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The file: an artifact id, a path, or an artifact's name." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_look",
    group: "files",
    description:
      "See a Word, PowerPoint or Excel file's pages as they lay out: pictures of its pages (a deck's slides, a workbook's " +
      "printed sheets), drawn by the same editor a person would use, shown in the conversation and handed to you. pages is " +
      "a list like \"1\", \"1-3\" or \"2,4\" (a few at a time); area {x,y,width,height} in points from the page's " +
      "top-left looks closer at part of one page, and grid draws a ruler. Use it after you build or change a file, to check " +
      "it looks right; office_check still finds what looking would not (overflow, broken formulas). A deck or workbook " +
      "takes ten seconds or so to draw.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The file: an artifact id, a path, or an artifact's name." },
        pages: { type: "string", description: "Which pages: \"1\", \"1-3\", \"2,4\". Default 1." },
        area: {
          type: "object",
          description: "Look closer at one part of one page, in points from its top-left.",
          properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        },
        grid: { type: "boolean", description: "Draw a ruler in points over the picture." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_pdf",
    group: "files",
    description:
      "Turn a Word, PowerPoint or Excel file into a PDF, laid out by its own editor (a deck one slide per page, a workbook as printed). The PDF is saved as an artifact and opens " +
      "in the PDF editor, where it can be marked up, signed, redacted or sent on (the PDF tools work on it from there).",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The file: an artifact id, a path, or an artifact's name." },
        output: { type: "string", description: "File name for the PDF. Default: the document's name with .pdf." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_create",
    group: "files",
    description:
      "Make a new Word, Excel or PowerPoint file, saved as an artifact. docx: markdown (headings, lists, tables, bold/italic, " +
      "links) or restricted html. xlsx: rows -- a 2-D array of cells where a string starting with = is a formula, or " +
      "{sheets:[{name, rows}]} for several sheets -- or csv text (header:true to treat the first row as a header). pptx: " +
      "spec, the deck as {pages:[...]} (a 1280x720 px canvas of shapes, text, pictures, tables and charts; call " +
      "office_guide slides design and spec first), or ops for the editing operations. Refine it afterwards with office_edit, " +
      "and check it with office_check.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "docx, xlsx or pptx." },
        name: { type: "string", description: "File name for the result (the extension is added)." },
        markdown: { type: "string", description: "docx: the content as Markdown." },
        html: { type: "string", description: "docx: the content as restricted HTML." },
        rows: { description: "xlsx: a 2-D array, or {sheets:[{name, rows}]}." },
        csv: { type: "string", description: "xlsx: the content as CSV text." },
        header: { type: "boolean", description: "xlsx csv: the first row is a header." },
        spec: { description: "pptx: the deck, {pages:[...]}." },
        ops: { type: "array", items: { type: "object" }, description: "pptx: operations that build the deck." },
      },
      required: ["type"],
    },
  },
  {
    name: "office_convert",
    group: "files",
    description:
      "Convert between formats that need no page layout: .docx to .md or .html; .md to .docx or .html; .html to .docx; " +
      ".csv to .xlsx; .xlsx to .csv (sheet names the worksheet). The result is saved as an artifact. PDF is not here: " +
      "the PDF tools handle PDFs.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The document: an artifact id, a path, or an artifact's name." },
        to: { type: "string", description: "docx, md, html, csv or xlsx." },
        sheet: { type: "string", description: "xlsx to csv: the worksheet (default: the active one)." },
        output: { type: "string", description: "File name for the result." },
      },
      required: ["file", "to"],
    },
  },

  // --------------------------------------------------------------- memory --
  {
    name: "memory_write",
    group: "memory",
    description:
      "Write something down in the workspace memory graph, where it will be " +
      "recalled in later sessions. For durable facts, preferences, procedures and " +
      "references worth keeping -- not for a running commentary on this " +
      "conversation, which is already recorded. One topic per memory, a title that " +
      "names its subject, short. Secrets are refused.",
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
          enum: ["fact", "preference", "procedure", "skill", "reference"],
          description:
            "What sort of thing this is. Default fact. A procedure is how to do " +
            "something here that worked -- the steps, commands and gotchas. A reference is what a product's " +
            "OFFICIAL documentation or help says about how it works (where things are in an interface, what an " +
            "API call is named): it needs subject and source.",
        },
        subject: {
          type: "string",
          description: "What it is about: the product, site, app or project, in a word or two (\"github\", \"google sheets\"). The title is filed under it.",
        },
        facet: {
          type: "string",
          enum: ["interface", "api", "docs", "workflow", "quirk"],
          description: "For knowledge about a product: interface (where things are, what they are called -- goes stale fastest), api, docs, workflow, quirk.",
        },
        source: {
          type: "string",
          description: "A reference's source: the address of the official page you read it from.",
        },
        version: { type: "string", description: "The version it describes, if the page says." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "A few words it should be found by.",
        },
      },
      required: ["title", "body"],
    },
    risky: true,
  },
  {
    name: "memory_update",
    group: "memory",
    description:
      "Correct or extend a memory that is out of date or incomplete, by its id " +
      "(recalled memories and memory_search show ids). Prefer this to writing " +
      "a second memory about the same thing.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory's id, e.g. mem-abc123." },
        title: { type: "string", description: "A new title, if it should change." },
        body: { type: "string", description: "The whole new body, replacing the old one." },
        kind: { type: "string", enum: ["fact", "preference", "procedure", "skill", "reference"] },
        subject: { type: "string", description: "What it is about, if that should change." },
        facet: { type: "string", enum: ["interface", "api", "docs", "workflow", "quirk"] },
        source: { type: "string", description: "For a reference: the page it was read from again. Stamps today as when it was read." },
        version: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
    risky: true,
  },
  {
    name: "memory_forget",
    group: "memory",
    description:
      "Retire a memory that is wrong or no longer true. Name the memory that " +
      "replaces it, if there is one, so the history is kept.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory to retire." },
        replaced_by: { type: "string", description: "The id of the memory that supersedes it, if any." },
      },
      required: ["id"],
    },
    risky: true,
  },
  {
    name: "memory_confirm",
    group: "memory",
    description:
      "Say that a memory still holds, after you have used it and seen it was " +
      "right: the path is still there, the command still works, the release " +
      "still goes that way. It stamps today's date on the record, so the next " +
      "session can tell knowledge that was just checked from knowledge written " +
      "months ago and never looked at again -- and a memory older than a month " +
      "says so when it is recalled. Pass a note when what you found differs in " +
      "detail; it is added to the memory.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory's id, e.g. mem-abc123." },
        note: {
          type: "string",
          description: "What you actually found, if it is worth writing down, e.g. \"still at /data/work/a2, now on 0.9.68\".",
        },
      },
      required: ["id"],
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
  {
    name: "vault_read",
    group: "memory",
    description:
      "Read back a tool output that was too long to keep in context. When a " +
      "result says it was stored as a vault artifact (an id like art_1a2b3c4d), " +
      "only its start and end were shown; this returns any other part of it, " +
      "or every line that contains some text. Vault artifacts last as long as " +
      "this session's server process does.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The artifact id, e.g. art_1a2b3c4d." },
        offset: {
          type: "number",
          description: "Character to start from. Defaults to 0.",
        },
        length: {
          type: "number",
          description: "How many characters to return. Defaults to as many as fit.",
        },
        search: {
          type: "string",
          description:
            "Instead of a range, return every line containing this text " +
            "(case-insensitive), with line numbers.",
        },
      },
      required: ["id"],
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
  voice: "Voice",
  /* Not a setting and so not in groupStates: scheduling, background work and
     the rest of what happens outside the turn are simply always on. */
  schedule: "Beyond the turn",
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
        ? `A real shell on this host, as ${os.userInfo().username}, in ${terminalDir()}.`
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
      group: "voice",
      label: LABELS.voice,
      enabled: settings.voice.enabled,
      available: settings.voice.enabled,
      detail: settings.voice.enabled
        ? "The agent can say something out loud on this page, in the console's own voice."
        : "The agent cannot make this page say anything. Replies read out in talk mode are unaffected.",
      approval: settings.voice.approval,
      tools: names("voice"),
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

/** A tool that lives in a built-in window the Tools page has switched off. */
export function windowOff(name: string, settings: ToolSettings = toolSettings()): boolean {
  if (name === "widget_show") return !settings.widgets.enabled;
  if (name === "app_preview") return !settings.app.enabled;
  if (name.startsWith("pdf_")) return !settings.pdf.enabled;
  // Built by scripts/build-office.mjs; a server without the build does not offer tools that cannot work.
  if (name.startsWith("office_")) return !officeDir() || !settings.office.enabled;
  return false;
}

/** The tools to offer the model this turn: enabled, and actually usable. */
export async function availableTools(): Promise<ToolSpec[]> {
  const groups = await groupStates();
  const usable = new Set(groups.filter((g) => g.available).map((g) => g.group));
  const settings = toolSettings();
  return [
    ...TOOLS.filter((t) => !windowOff(t.name, settings) && (
      t.group === "person" || t.group === "files" || t.group === "schedule" ||
      /* Muting the voice is the one thing that survives having muted it: a
         tool that takes itself away with the thing it turns off would leave
         no way back except the settings panel. */
      t.name === "voice_mute" ||
      usable.has(t.group as ToolGroup))),
    ...(usable.has("terminal") ? customSpecs() : []),
    ...mcpSpecs(),
  ];
}

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name) ??
    customSpecs().find((t) => t.name === name) ??
    mcpSpecs().find((t) => t.name === name);
}

/** Tools the agent wrote (see ./customtools.ts), in the registry's shape. */
function customSpecs(): ToolSpec[] {
  return listCustomTools().map((t) => ({
    name: `${CUSTOM_PREFIX}${t.name}`,
    group: "terminal" as const,
    description: `${t.description} (A tool you wrote earlier; runs a saved shell script.)`,
    parameters: {
      type: "object" as const,
      properties: Object.fromEntries(t.params.map((p) => [p.name, { type: "string", description: p.description }])),
      required: t.params.filter((p) => p.required).map((p) => p.name),
    },
    risky: true,
  }));
}

/** Tools from connected MCP servers, in the registry's own shape. */
function mcpSpecs(): ToolSpec[] {
  return mcpTools().map((t) => ({
    name: t.name,
    group: "mcp" as const,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Does this call need a human to say yes first?
 *
 * No: Autora runs in yolo mode, from one call to the next, with no card in
 * the chat. This reads the per-group setting ("always", "risky", "never"),
 * but mergeTools in server/state.ts pins every group to "never", so an older
 * settings file that says otherwise cannot bring the cards back.
 *
 * Asking is the chat's own choice instead (server/modes.ts), applied in
 * server.ts. Beyond it, the guard and the irrecoverable tier still stop and
 * ask, exactly as before.
 */
export function needsApproval(spec: ToolSpec): boolean {
  const group = spec.group;
  /* "person", "files", "schedule" and "mcp" are not settings: nobody turns
     handing over, reading an artifact or asking a question off. */
  if (group !== "terminal" && group !== "browser" && group !== "computer" && group !== "memory" && group !== "voice") return false;
  const approval = toolSettings()[group]?.approval;
  if (approval === "always") return true;
  if (approval === "risky") return Boolean(spec.risky);
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
    case "tool_create":
      return `save tool ${CUSTOM_PREFIX}${String(args.name ?? "").replace(CUSTOM_PREFIX, "")}:\n${args.script}`;
    case "memory_update":
      return `update memory ${args.id}`;
    case "memory_forget":
      return `forget memory ${args.id}${args.replaced_by ? ` (replaced by ${args.replaced_by})` : ""}`;
    case "read_file":
      return `read ${args.path}${args.symbol ? ` (${args.symbol})` : args.outline ? " (outline)" : ""}`;
    case "vault_read":
      return args.search
        ? `search vault artifact ${args.id} for "${args.search}"`
        : `read vault artifact ${args.id}`;
    case "browser_captcha":
      return "tick the checkbox CAPTCHA on the open page";
    case "browser_eval":
      return `run in the page: ${String(args.script ?? "").split("\n")[0]}`;
    case "browser_upload":
      return `attach ${(Array.isArray(args.ids) ? args.ids : [args.ids]).join(", ")} to element [${args.ref}] on the open page`;
    case "browser_press":
      return `press ${Array.isArray(args.keys) ? args.keys.join(", ") : args.keys}`;
    case "browser_signin_import":
      return `import a sign-in from uploaded file ${args.id}`;
    case "browser_handoff":
      return `handoff browser control: ${args.reason}`;
    case "http_request":
      return `${args.method || "GET"} ${args.url}`;
    case "web_search":
      return `search web for "${args.query}"`;
    case "image_generate":
      return `generate image: "${args.prompt}"`;
    case "artifact_save":
      return `save artifact ${args.name}${args.notebook ? ` into notebook "${args.notebook}"` : ""}`;
    case "notebook":
      return `notebook ${args.action ?? ""}${args.notebook ? ` "${args.notebook}"` : args.title ? ` "${args.title}"` : ""}`;
    case "widget_show":
      return `show widget "${args.title}"`;
    case "speak":
      return `say aloud: ${JSON.stringify(String(args.text ?? ""))}`;
    case "voice_mute":
      return String(args.muted) === "false"
        ? "unmute the voice"
        : "mute the voice: stop saying things out loud";
    case "camera_look":
      return "look through the camera";
    case "artifact_read":
      return `read artifact ${args.id}`;
    default: {
      const rest = Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
      return `${spec.name}${rest}`;
    }
  }
}

// ---------------------------------------------------------------- running --

/** Everything the executor needs from the session it is running in, passed in
    rather than imported, so this module stays independent of the server. */
/** A scheduled task or watcher, as the agent sees it. The records are the
    server's; this is what it is told about them. */
export interface AgentJob {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  watch: { kind: string; target: string } | null;
  next_run: number | null;
  last_run: number | null;
  last_error: string | null;
  cron_error: string | null;
  running: boolean;
}

/** What the agent asks of a job: only the fields it may set. */
export interface AgentJobInput {
  name?: string;
  cron?: string;
  prompt?: string;
  watch?: { kind: string; target: string } | null;
  enabled?: boolean;
}

export interface ToolContext {
  /** A line of live output, as it arrives. */
  onOutput: (chunk: string) => void;
  /** Stash a picture and return its blob id. */
  putBlob: (data: Buffer, mime: string) => string;
  /** Show a picture in the conversation. */
  showImage: (blob: string, alt: string, caption: string | null, size?: { w: number; h: number }) => void;
  /** Show a file a tool made (an artifact) in the conversation, to open or download. */
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
  /** Say something aloud on the page the person has open. */
  speak?: (text: string) => void;
  /** Stop or start the page saying things aloud, at once -- what the speak
      tool's own mute does, so the sound stops in the same breath as the
      setting rather than at the next turn. */
  mute?: (muted: boolean) => void;
  /** Show an interactive widget in the conversation. */
  showWidget: (widget: { title: string; html: string; height: number; artifact?: string }) => void;
  /** Show a picture of the browser or desktop in the card already showing
      that screen, rather than as a card of its own beside it. */
  showScreen: (source: "browser" | "desktop", blob: string, size?: { w: number; h: number }) => void;
  /** The session's browser, made on first use. */
  browser: () => LiveBrowser;
  /** The browser's state changed; tell the watchers. */
  browserChanged: () => void;
  /** Start forwarding desktop frames to this session. */
  watchDesktop: () => void;
  /** Change a file so that what the person saved meanwhile is kept (see
      server/editfile.ts). Absent where there is no folder to work in. */
  code?: { edit: (args: EditArgs) => EditResult };
  /** Why something the person is using may not be touched right now (see
      server/presence.ts), or null. `subject` is an object id or a file. */
  held?: (surface: "pdf" | "office" | "app" | "browser" | "code", subject: string) => string | null;
  /** Hand a question to a research worker with its own context (see
      server/subagent.ts) and get its report back. Absent inside the worker. */
  research?: (question: string) => Promise<string>;
  /** True once the turn has been interrupted; long tools should give up. */
  cancelled: () => boolean;
  /** Register a kill switch so an interrupt can stop a running command. */
  onCancel: (stop: () => void) => void;
  /** The memory graph, which the server owns. */
  memory: {
    /** True in an incognito chat: a read is fine, a write is refused, because
        nothing in that chat is written down anywhere. */
    incognito?: boolean;
    write: (entry: {
      title: string; body: string; kind: string; tags?: string[]; subject?: string; facet?: string;
      source?: string; version?: string; status?: "confirmed" | "provisional";
    }) => { id: string; action: string };
    search: (query: string) => {
      id: string; kind: string; title: string; body: string; status: string; subject?: string; source?: string; fetched?: number;
    }[];
    /** true when changed, false when there is no such memory, or why the change was refused. */
    update: (id: string, patch: {
      title?: string; body?: string; kind?: string; tags?: string[]; subject?: string; facet?: string; source?: string; version?: string;
    }) => boolean | string;
    /** Say that a memory still holds, and stamp it checked today. */
    confirm: (id: string, note?: string) => boolean;
    forget: (id: string, replacedBy?: string | null) => boolean;
  };
  /** A tool output this session kept out of the prompt, by artifact id. */
  vault: (id: string) => string | null;
  /** The session the call runs in, so what it makes can say where from. */
  session: string;
  /** The Schedule page's jobs, so the agent can set up its own. */
  jobs?: {
    list: () => AgentJob[];
    create: (input: AgentJobInput & { name: string; cron: string; prompt: string }) =>
      { id: string | null; error: string | null };
    update: (id: string, patch: AgentJobInput) => { ok: boolean; error: string | null };
    remove: (id: string) => boolean;
  };
  /** Put a question to the person and wait for the answer. */
  ask: (request: AskRequest) => Promise<AskAnswer>;
  /** The session's to-do list: what the person watches the work tick off.
      Absent where there is no session to show one in. */
  todos?: (action: Record<string, any>) => TodoResult;
  /** Folders that are Autora's own data, never read or edited as the agent's files. */
  protectedPaths?: string[];
  /** Bring in a set of tools (see toolload.ts); says what came in. */
  enableTools?: (family: string) => { ok: boolean; summary: string };
  /** The chat's working notes (see ledger.ts). */
  ledger?: (action: Record<string, any>) => LedgerResult;
  /** What the person asked for, kept whole (see requirements.ts). */
  requirements?: (action: Record<string, any>) => RequirementResult;
  /** The app window: what the agent builds, shown beside the conversation. */
  preview?: {
    start: (args: { command?: string; cwd?: string; dir?: string; url?: string; port?: number }) => Promise<{ ok: boolean; summary: string }>;
    stop: () => Promise<{ ok: boolean; summary: string }>;
    reload: () => Promise<{ ok: boolean; summary: string }>;
    look: () => Promise<{ ok: boolean; summary: string; png?: Buffer }>;
    /** Use the page as a person would: click, hover, type, press a key, scroll. */
    act: (args: { action: string; target?: string; text?: string; key?: string; dy?: number; submit?: boolean }) => Promise<{ ok: boolean; summary: string; png?: Buffer }>;
  };
  /** Agent mode's switch between planning and building. Absent where there is
      no session to switch. */
  setPhase?: (to: Phase, reason: string) => { ok: boolean; summary: string };
}

export interface ToolOutcome {
  ok: boolean;
  /** What the model is told came back. */
  summary: string;
  /** For the transcript card, where it differs from the summary. */
  preview?: string;
  exitCode?: number;
  /** Pictures that came back with the result, which the model is handed
      rather than told about. The tool was asked for a look, and text about a
      picture is not a look. */
  images?: ChatImage[];
  /** Not done because the person is using it: said to the agent, and never
      counted as a failure. */
  held?: boolean;
}

/**
 * The page, as the model reads it: what is on screen to act on, and the
 * page's main content one part at a time. Only browser_read asks for a part
 * past the first; every action answers with the first, which is what a
 * page that has just changed is most likely to have changed.
 */
function describePage(page: PageRead, part = 1): string {
  const parts = textParts(page.text);
  const k = Math.min(Math.max(1, Math.floor(part) || 1), parts.length);
  const head = parts.length === 1
    ? "Text:"
    : k < parts.length
      ? `Text (part ${k} of ${parts.length}; browser_read with part ${k + 1} for the next):`
      : `Text (part ${k} of ${parts.length}, the last):`;
  return [
    `Page: ${page.title || "(untitled)"}`,
    `URL: ${page.url}`,
    "",
    "Interactive elements:",
    page.outline || "(nothing interactive on screen)",
    ...(page.captchas.length ? ["", describeCaptchas(page.captchas)] : []),
    ...(page.challenge ? ["", challengeNote(page.challenge)] : []),
    ...(page.blocked ? ["", refusalNote(page.blocked)] : []),
    "",
    head,
    parts[k - 1] || "(no text)",
  ].join("\n");
}

/**
 * What the model is told when Cloudflare is deciding about this browser.
 *
 * The page is a holding screen with nothing on it, which reads as a broken
 * page: it is not, and it is not the thing to send the person to either --
 * the check passes on its own for a browser it trusts, and it trusts this one
 * more often than it used to.
 */
export function challengeNote(title: string): string {
  return (
    `CLOUDFLARE CHECK: the page is "${title}" -- Cloudflare is deciding about this ` +
    "browser and does not want anything clicked. Give it half a minute: passing on its own is what it " +
    "does when it is going to pass, and there is nothing on the page to act on until it does. If it " +
    "is still there after that, hand the browser to the person with browser_handoff -- a person passing " +
    "it once also earns this profile the site's clearance cookie, which then lasts hours."
  );
}

/** What the model is told when a site turns this browser's sign-in away. */
export function refusalNote(said: string): string {
  return (
    `SIGN-IN REFUSED: the site says "${said}". It is refusing this browser, not ` +
    "the password, so retrying, retyping or handing the page to the person will " +
    "not get past it. Stop and tell the person, and offer the ways that do " +
    "work: they sign in to the site in their own browser, export its cookies " +
    "(Cookie-Editor extension: Export, JSON) and upload the file, which you then " +
    "load with browser_signin_import; or, if their desktop is connected, do it " +
    "on their own computer with the computer tools; or use the service's API " +
    "with a token or app password if it has one."
  );
}

/** What an action did, above the page it left: one line per field filled. */
function withNotes(page: PageRead, lead: string): string {
  const notes = page.notes?.length ? `\n${page.notes.map((n) => `- ${n}`).join("\n")}` : "";
  return `${lead}${notes}\n\n${describePage(page)}`;
}

/** A key as the model might write it, as Playwright names it: "esc" is
    Escape, "ctrl+a" is Control+A, "down" is ArrowDown. */
export function keyName(raw: string): string {
  const alias: Record<string, string> = {
    esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab",
    space: "Space", spacebar: "Space", backspace: "Backspace", delete: "Delete", del: "Delete",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
    pageup: "PageUp", pagedown: "PageDown", pgup: "PageUp", pgdn: "PageDown",
    home: "Home", end: "End", ctrl: "Control", control: "Control", cmd: "Meta",
    command: "Meta", meta: "Meta", alt: "Alt", option: "Alt", shift: "Shift",
  };
  return raw
    .trim()
    .split("+")
    .map((part) => {
      const p = part.trim();
      if (!p) return "";
      return alias[p.toLowerCase().replace(/[\s_-]/g, "")] ?? (p.length === 1 ? p : p[0].toUpperCase() + p.slice(1));
    })
    .filter(Boolean)
    .join("+");
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
  extraEnv: Record<string, string> = {},
): Promise<ToolOutcome> {
  const candidates = candidateShells();
  const secrets = allSecrets();
  const workingDir = cwd || terminalDir();
  /* A missing directory fails the spawn with the same ENOENT as a missing
     shell, which sent this through every shell in the list and ended with
     "no usable shell found" -- true of none of them. */
  if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) {
    return Promise.resolve({
      ok: false,
      summary: `Could not run that: the directory ${workingDir} does not exist on this machine.`,
    });
  }

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
      /* What the model reads back: the start and the end of the output.
         Only the start used to be kept, so a build that printed 30 KB and
         then its error handed the model 24 KB of progress lines and no
         error. The whole of it is in the transcript either way. */
      const HEAD = 8_000;
      const TAIL = 16_000;
      let head = "";
      let tail = "";
      let omitted = 0;
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
            ...identityEnv(),
            ...extraEnv,
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
        let rest = safeText;
        if (head.length < HEAD) {
          const room = HEAD - head.length;
          head += rest.slice(0, room);
          rest = rest.slice(room);
        }
        if (rest) {
          tail += rest;
          if (tail.length > TAIL) {
            omitted += tail.length - TAIL;
            tail = tail.slice(-TAIL);
          }
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
        const collected = omitted > 0
          ? `${head}\n\n[... ${omitted.toLocaleString("en-US")} characters of output omitted here ...]\n\n${tail}`
          : head + tail;
        const body = redactSecrets(collected.trim());
        const note =
          killedBy === "timeout"
            ? `\n\n[killed after ${timeoutSeconds}s -- it had not finished]`
            : killedBy === "user"
              ? "\n\n[stopped by the person watching]"
              : omitted > 0
                ? "\n\n[output shortened: its start and its end are above; the full output is in the transcript]"
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

/**
 * A command run with nobody watching: for a watcher checking a command's
 * output. Same shell, secrets and working directory as the terminal tool.
 */
export async function runShellQuiet(command: string, timeoutSeconds = 60): Promise<{ ok: boolean; output: string }> {
  const quiet: Pick<ToolContext, "onOutput" | "onCancel"> = { onOutput: () => undefined, onCancel: () => undefined };
  const outcome = await runCommand(command, terminalDir(), timeoutSeconds, quiet as ToolContext);
  return { ok: outcome.ok, output: outcome.summary };
}

/**
 * How long a request may take, joined to Stop.
 *
 * These fetches had neither: a search engine or an API that accepted the
 * connection and then said nothing held the turn until the operating system
 * gave up on it, and Stop could not reach it, since nothing was listening.
 */
function requestSignal(ctx: Pick<ToolContext, "onCancel" | "cancelled"> | null, ms: number): AbortSignal {
  // Stop has already been pressed: its callbacks have run and will not again.
  if (ctx?.cancelled()) return AbortSignal.abort();
  const timeout = AbortSignal.timeout(ms);
  if (!ctx) return timeout;
  const stop = new AbortController();
  ctx.onCancel(() => stop.abort());
  return AbortSignal.any([timeout, stop.signal]);
}

/** A failed fetch in words: which of the two limits ended it, or why not. */
function fetchFailure(err: any, ms: number): string {
  if (err?.name === "TimeoutError") return `no answer within ${Math.round(ms / 1000)}s`;
  if (err?.name === "AbortError") return "stopped";
  const cause = err?.cause?.code ?? err?.cause?.message;
  return err?.message === "fetch failed" && cause ? `could not connect (${cause})` : String(err?.message ?? err);
}

/** Up to `limit` bytes of a body. A response of unknown size used to be read
    whole into memory, however big it turned out to be. */
async function readCapped(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(Buffer.from(value.subarray(0, limit - size)));
      await reader.cancel().catch(() => undefined);
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(Buffer.from(value));
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

/**
 * Whether a URL is GitHub's API, and so may be sent the saved GitHub token.
 *
 * Decided on the parsed address. It used to be a substring test, so
 * `https://anywhere.example/?api.github.com` -- an address a web page could
 * talk the agent into requesting -- was sent the token too.
 */
export function isGitHubApi(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "api.github.com";
  } catch {
    return false;
  }
}

const SEARCH_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** More than any page or API answer the model can read; the rest is not fetched. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

async function searchWeb(query: string, ctx: Pick<ToolContext, "onCancel" | "cancelled"> | null = null): Promise<string> {
  const signal = () => requestSignal(ctx, SEARCH_TIMEOUT_MS);
  const tavilyKey = secretFor("TAVILY_API_KEY") || process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 6 }),
        signal: signal(),
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
        { headers: { "X-Subscription-Token": braveKey }, signal: signal() },
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
      { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" }, signal: signal() },
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
      signal: signal(),
    });
    if (res.ok) {
      const { text: html } = await readCapped(res, MAX_RESPONSE_BYTES);
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
}, ctx: Pick<ToolContext, "onCancel" | "cancelled"> | null = null): Promise<ToolOutcome> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, summary: "http_request needs a full http:// or https:// address." };
  }
  const method = (args.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === "object") {
    for (const [k, v] of Object.entries(args.headers)) headers[k] = String(v);
  }
  const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);

  // If calling GitHub API and GITHUB_TOKEN exists in secret store, inject Authorization
  if (isGitHubApi(url) && !has("authorization")) {
    const ghToken = secretFor("GITHUB_TOKEN") || secretFor("GH_TOKEN");
    if (ghToken) {
      headers["Authorization"] = `Bearer ${ghToken}`;
      if (!has("user-agent")) headers["User-Agent"] = "Autora-Agent";
      if (!has("accept")) headers["Accept"] = "application/vnd.github.v3+json";
    }
  }

  if (!has("user-agent")) {
    headers["User-Agent"] = "Autora/1.0";
  }

  /* The person's saved details, in the address, any header value or the
     body: {{cred:github.com:password}}, {{cred:email}}. Filled in here, the
     way they are in a page, and never carried further -- the request goes out
     with the real value, the transcript and the log keep the placeholder.
     Which sign-in may be used is decided by the site the request is going to,
     so a sign-in saved for one site cannot be spent on another. */
  let target = url;
  let body = args.body;
  try {
    target = fillPlaceholders(url, url);
    for (const [name, value] of Object.entries(headers)) {
      headers[name] = fillPlaceholders(value, target);
    }
    if (body) body = fillPlaceholders(body, target);
  } catch (err: unknown) {
    return { ok: false, summary: `http_request: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const res = await fetch(target, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : body,
      signal: requestSignal(ctx, REQUEST_TIMEOUT_MS),
    });

    const status = res.status;
    const statusText = res.statusText;
    const { text: raw, truncated: cut } = await readCapped(res, MAX_RESPONSE_BYTES);
    const type = res.headers.get("content-type") || "unknown";
    /* A web page's HTML is mostly scripts, styles and menus: on a typical
       article the first 20,000 characters hold none of the article at all.
       What the model can use is the text a person would read. */
    const html = /html/i.test(type) || /^\s*(<!doctype html|<html)/i.test(raw);
    const text = html ? htmlToText(raw, url) : raw;
    const cap = html ? 12_000 : 20_000;

    const preview = redactSecrets(`${method} ${url} → ${status} ${statusText}`);
    let summary = `HTTP ${status} ${statusText}\n`;
    summary += `Content-Type: ${type}${html ? " (shown as readable text, not HTML)" : ""}\n\n`;
    summary += text.length > cap || cut
      ? text.slice(0, cap) + (html
        ? "\n\n[page truncated here -- open it with browser_open and read on with browser_read's part]"
        : "\n\n[response truncated]")
      : text;

    return {
      ok: res.ok,
      summary: redactSecrets(summary),
      preview,
    };
  } catch (err: any) {
    return { ok: false, summary: `HTTP request failed: ${redactSecrets(fetchFailure(err, REQUEST_TIMEOUT_MS))}` };
  }
}

/**
 * A picture for the model, or null when it is too big to hand over.
 *
 * Vendors cap a picture at a few megabytes, and a page of photographs shot at
 * the full window can pass that; a call that fails on the request is worse
 * than one that says the picture is only on the person's screen.
 */
function pictureFor(image: Buffer, mime: string): ChatImage | null {
  if (image.byteLength > PICTURE_LIMIT_BYTES) return null;
  return { mime, data: image.toString("base64") };
}

/** Three and a half megabytes: under every vendor's four-to-five, with the
    base64 inflation and the rest of the request to spare. */
const PICTURE_LIMIT_BYTES = 3_500_000;

/** A file name from a sentence: a few lowercase words, hyphenated. */
function slug(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 6);
  return words.join("-").slice(0, 60) || "image";
}

function artifactLine(a: { id: string; origin: string; name: string; mime: string; size: number; ts: number; note?: string }) {
  const who = a.origin === "user" ? "uploaded by the person" : "made by you";
  const when = new Date(a.ts).toISOString().slice(0, 16).replace("T", " ");
  return `- ${a.id}  ${a.name}  (${a.mime}, ${formatSize(a.size)}, ${who}, ${when})${
    a.note ? ` -- ${a.note.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
}

/** A screenshot to keep or to see more than the window of. */
async function keepScreenshot(
  live: LiveBrowser,
  ctx: ToolContext,
  opts: { fullPage: boolean; ref?: number; selector: string; area: any; saveAs: string; notebook: string; note: string },
): Promise<ToolOutcome> {
  const area = opts.area
    ? { x: Number(opts.area.x) || 0, y: Number(opts.area.y) || 0, w: Number(opts.area.width) || 0, h: Number(opts.area.height) || 0 }
    : null;
  if (area && (area.w < 2 || area.h < 2)) return { ok: false, summary: "An area needs a width and height of at least 2 pixels." };
  let png: Buffer | null;
  try {
    png = area ? await live.cropShot(area) : await live.screenshot({ fullPage: opts.fullPage, ref: opts.ref, selector: opts.selector || undefined });
  } catch (err: any) {
    const why = String(err?.message ?? err).split("\n")[0];
    return {
      ok: false,
      summary: opts.ref !== undefined
        ? `Could not take a picture of element [${opts.ref}]: ${why}.`
        : opts.selector
        ? `Could not take a picture of "${opts.selector}": ${why}. Check the selector matches something visible (browser_eval can test it).`
        : `Could not take the screenshot: ${why}`,
    };
  }
  if (!png) return { ok: false, summary: "No page is open to take a picture of." };
  const status = live.status();
  const what = opts.ref !== undefined ? `element [${opts.ref}]` : opts.selector ? `"${opts.selector}"` : area ? "that area" : opts.fullPage ? "the whole page" : "the window";
  const blob = ctx.putBlob(png, "image/png");

  let kept = "";
  let caption = `Screenshot of ${what}`;
  if (opts.saveAs || opts.notebook) {
    /* An unnamed one is stamped with the time: the agent's saves of one name
       replace each other, and a second picture of the same page filed as
       evidence would otherwise take the place of the first. */
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const base = (opts.saveAs || `screenshot-${slug(status.title || status.url || "page")}-${stamp}`).replace(/\.png$/i, "");
    const art = saveArtifact({
      origin: "agent", name: `${base}.png`, data: png, mime: "image/png", session: ctx.session,
      note: opts.note || (status.url ? `Screenshot of ${status.url}` : undefined),
    });
    kept = ` Saved as artifact ${art.id} (${art.name}, ${formatSize(art.size)}).`;
    caption = `Saved as ${art.name}`;
    if (opts.notebook) {
      const { book, made } = notebookFor(opts.notebook);
      addEntries(book.id, [{
        artifact: art.id,
        text: opts.note || (status.url ? `Screenshot of ${status.url}, taken ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.` : undefined),
      }], "agent");
      kept += made ? ` Filed in a new notebook ${book.id}, "${book.title}".` : ` Filed in "${book.title}" (${book.id}).`;
    }
  }
  ctx.showImage(blob, caption, caption);

  // Vendors refuse a picture past about 8000 pixels a side, which a long page passes.
  const tall = png.byteLength >= 24 && (png.readUInt32BE(16) > 7800 || png.readUInt32BE(20) > 7800);
  const picture = tall ? null : pictureFor(png, "image/png");
  return {
    ok: true,
    summary: `A picture of ${what}${status.url ? ` on ${status.url}` : ""} is in the conversation${picture ? " and in this result" : ""}.${kept}` +
      (picture ? "" : " It is too large to hand back to you as a picture; take the window or an element to see it."),
    preview: kept ? caption : status.url ?? "screenshot",
    ...(picture ? { images: [picture] } : {}),
  };
}

/** A notebook named by id or title; a title nobody has makes one. */
function notebookFor(ref: string): { book: Notebook; made: boolean } {
  const found = findNotebook(ref);
  if (found) return { book: found, made: false };
  if (/^nb_[0-9a-f]+$/.test(ref)) throw new Error(`There is no notebook "${ref}". Use notebook list to see what there is.`);
  return { book: createNotebook({ title: ref, by: "agent" }), made: true };
}

const listOf = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.map((v) => String(v).trim()).filter(Boolean)
    : typeof raw === "string" && raw.trim() ? raw.split(",").map((v) => v.trim()).filter(Boolean) : [];

function runNotebook(args: Record<string, any>, ctx: ToolContext): ToolOutcome {
  const action = String(args.action ?? "").trim().toLowerCase();
  const ref = String(args.notebook ?? "").trim();
  const unknownNote = (unknown: string[]) => unknown.length
    ? ` Not found, so not filed: ${unknown.join(", ")} -- check artifact_list for the right id.`
    : "";

  if (action === "list") {
    const all = listNotebooks();
    if (!all.length) return { ok: true, summary: "There are no notebooks yet. Make one with action create.", preview: "0 notebooks" };
    return { ok: true, summary: all.map(notebookLine).join("\n"), preview: `${all.length} notebook${all.length === 1 ? "" : "s"}` };
  }

  if (action === "create") {
    const title = String(args.title ?? ref).trim();
    const had = findNotebook(title);
    if (had) {
      return {
        ok: true,
        summary: `A notebook called "${had.title}" already exists (${had.id}, ${had.entries.length} entries); use it rather than making a second.`,
        preview: had.title,
      };
    }
    const book = createNotebook({ title, purpose: args.purpose, by: "agent" });
    return { ok: true, summary: `Made notebook ${book.id}, "${book.title}". It is on the Notebooks page.`, preview: book.title };
  }

  if (!ref) return { ok: false, summary: "Say which notebook, by id or title (notebook list shows them)." };

  if (action === "add") {
    const { book, made } = notebookFor(ref);
    const files = listOf(args.artifacts);
    const note = { title: args.title, text: args.text, cites: args.cites };
    const inputs = files.length
      ? files.map((artifact) => ({ artifact, title: files.length === 1 ? args.title : undefined, text: args.text, cites: args.cites }))
      : [note];
    const r = addEntries(book.id, inputs, "agent", Number(args.position) || undefined);
    if (!r.added.length && !r.updated.length) {
      return { ok: false, summary: `Nothing was added to "${book.title}": give artifacts, or a note's title or text.${unknownNote(r.unknown)}` };
    }
    const what = [
      r.added.length ? `added ${r.added.map((e) => e.id).join(", ")}` : "",
      r.updated.length ? `updated ${r.updated.map((e) => e.id).join(", ")} (already in it)` : "",
    ].filter(Boolean).join("; ");
    return {
      ok: true,
      summary: `${made ? `Made notebook ${book.id}, "${book.title}", and ` : `In "${book.title}" (${book.id}): `}${what}. ` +
        `It now has ${r.notebook.entries.length} entries.${unknownNote(r.unknown)}`,
      preview: `${book.title} · ${r.notebook.entries.length} entries`,
    };
  }

  const book = findNotebook(ref);
  if (!book) return { ok: false, summary: `There is no notebook "${ref}". Use notebook list to see what there is.` };
  const entry = String(args.entry ?? "").trim();

  switch (action) {
    case "read": {
      const text = describeNotebook(book);
      const room = CONTEXT_CONFIG.maxToolTokens * 4 - 200;
      const offset = Math.max(0, Number(args.offset) || 0);
      const part = text.slice(offset, offset + room);
      const rest = text.length - (offset + part.length);
      return {
        ok: true,
        summary: `${part}${rest > 0 ? `\n\n[${rest} more characters -- read on with offset ${offset + part.length}]` : ""}`,
        preview: `${book.title} · ${book.entries.length} entries`,
      };
    }
    case "edit": {
      if (!entry) {
        const next = updateNotebook(book.id, { title: args.title, purpose: args.purpose });
        return { ok: true, summary: `Updated notebook ${next.id}, "${next.title}".`, preview: next.title };
      }
      const r = updateEntry(book.id, entry, { title: args.title, text: args.text, cites: args.cites });
      return { ok: true, summary: `Updated ${r.entry.id} in "${book.title}".${unknownNote(r.unknown)}`, preview: book.title };
    }
    case "remove": {
      if (!entry) return { ok: false, summary: "Say which entry to remove (its en_... id, from read)." };
      if (!removeEntry(book.id, entry)) return { ok: false, summary: `There is no entry "${entry}" in "${book.title}".` };
      return { ok: true, summary: `Removed ${entry} from "${book.title}". Any file it was stays on the Artifacts page.`, preview: book.title };
    }
    case "move": {
      if (!entry) return { ok: false, summary: "Say which entry to move (its en_... id, from read)." };
      moveEntry(book.id, entry, Number(args.position) || 1);
      return { ok: true, summary: `Moved ${entry} to position ${Number(args.position) || 1} in "${book.title}".`, preview: book.title };
    }
    case "export": {
      const name = `${cleanName(book.title, "notebook").replace(/\.md$/i, "")}.md`;
      const art = saveArtifact({
        origin: "agent", name, data: Buffer.from(notebookMarkdown(book), "utf8"),
        mime: "text/markdown", session: ctx.session, note: `Export of the notebook "${book.title}"`,
      });
      ctx.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
      return { ok: true, summary: `Exported "${book.title}" as artifact ${art.id} (${art.name}, ${formatSize(art.size)}).`, preview: art.name };
    }
    default:
      return { ok: false, summary: `Unknown notebook action "${action}". Use list, create, read, add, edit, remove, move or export.` };
  }
}

async function generateImageTool(prompt: string, ctx: ToolContext): Promise<ToolOutcome> {
  // The Gemini key saved in Settings counts: it used to be only the
  // environment or the secret store, so a key pasted into the provider card
  // -- the way the app asks for one -- could chat but not draw.
  const apiKey =
    keyFor("gemini") ||
    secretFor("GEMINI_API_KEY") ||
    secretFor("GOOGLE_API_KEY");
  if (!apiKey) {
    return {
      ok: false,
      summary: "Cannot generate image: no Google Gemini key is saved in Settings, the environment or the secret store.",
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

    // Kept as an artifact too: the blob goes when the process does.
    let saved = "";
    try {
      const art = saveArtifact({
        origin: "agent", name: `${slug(prompt)}.jpg`, data: buffer,
        mime: "image/jpeg", session: ctx.session, note: prompt,
      });
      saved = ` Saved as artifact ${art.id}.`;
    } catch {
      // The picture is still in the thread; losing the copy is not a failure.
    }

    return {
      ok: true,
      summary: `Generated image for prompt: "${prompt}". It is now displayed in the conversation for the person to see.${saved}`,
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
/**
 * What the agent is told when it tries to write to memory in an incognito
 * chat. An answer in words rather than a silent no: it should say that
 * nothing here is kept, not try the same call again three ways.
 */
function incognitoMemory(): { ok: boolean; summary: string } {
  return {
    ok: false,
    summary:
      "This chat is incognito: nothing in it is saved or recorded, so there is " +
      "nothing to write down and nothing learned here will be remembered. Tell " +
      "the person that, rather than trying again.",
  };
}

export async function runTool(
  spec: ToolSpec,
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  /* Whatever the tool read -- a page that now shows the address it was
     given, a form echoing a username -- goes back to the model with the
     person's saved details blanked out. */
  const outcome = await runToolUnredacted(spec, args, ctx);
  return {
    ...outcome,
    summary: redactSecrets(outcome.summary),
    ...(outcome.preview !== undefined ? { preview: redactSecrets(outcome.preview) } : {}),
  };
}

async function runToolUnredacted(
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
        const asked = String(args.cwd ?? "").trim();
        // A relative directory is taken from the terminal's own, like `cd`.
        const cwd = asked ? path.resolve(terminalDir(), asked) : terminalDir();
        return await runCommand(command, cwd, settings.timeout, ctx);
      }

      case "research": {
        if (!ctx.research) return { ok: false, summary: "A research worker cannot start another one. Answer from what you can look at yourself." };
        const many = (Array.isArray(args.questions) ? args.questions : []).map((q: unknown) => String(q ?? "").trim()).filter(Boolean).slice(0, 3);
        const one = String(args.question ?? "").trim();
        if (one && !many.includes(one)) many.unshift(one);
        const questions = many.slice(0, 3);
        if (questions.length === 0) return { ok: false, summary: "Say what to find out: question, or questions for several at once." };
        if (questions.length === 1) {
          return { ok: true, summary: await ctx.research(questions[0]), preview: "research report" };
        }
        /* Separate workers, at the same time: each has a clean context, so they
           cannot step on one another, and the wait is the slowest one, not the sum. */
        const reports = await Promise.all(questions.map((q: string) => ctx.research!(q).catch((err: Error) => `The worker failed: ${String(err.message).split("\n")[0]}`)));
        return {
          ok: true,
          summary: reports.map((r, i) => `Question ${i + 1}: ${questions[i]}\n${r}`).join("\n\n---\n\n"),
          preview: `${questions.length} research reports`,
        };
      }

      case "edit_file": {
        if (!ctx.code) return { ok: false, summary: "There is no folder to edit files in, in this chat." };
        const r = ctx.code.edit({
          path: String(args.path ?? ""),
          edits: Array.isArray(args.edits) ? args.edits.map((e: any) => ({ old: String(e?.old ?? ""), new: String(e?.new ?? ""), all: e?.all === true })) : undefined,
          content: typeof args.content === "string" ? args.content : undefined,
          overwrite: args.overwrite === true,
        });
        return { ok: r.ok, summary: r.summary, preview: r.ok ? (r.wrote?.created ? "created a file" : "edited a file") : "not written" };
      }

      case "code_search": {
        const where = String(args.path ?? "").trim();
        const found = searchCode({
          root: where ? path.resolve(terminalDir(), where) : terminalDir(),
          query: String(args.query ?? ""),
          mode: args.mode === "exact" || args.mode === "regex" ? args.mode : "ranked",
          glob: typeof args.glob === "string" ? args.glob : undefined,
          caseSensitive: args.case_sensitive === true,
          max: typeof args.max === "number" ? args.max : undefined,
        });
        return { ok: found.ok, summary: found.text, preview: found.ok ? `${found.files} files searched` : "no search" };
      }

      case "read_file": {
        const r = readFile(
          { path: String(args.path ?? ""), start: args.start, end: args.end, outline: args.outline === true, symbol: typeof args.symbol === "string" ? args.symbol : undefined },
          { root: terminalDir(), protect: ctx.protectedPaths ?? [] },
        );
        return { ok: r.ok, summary: r.text, preview: r.ok ? String(args.path ?? "") : "not read" };
      }

      // --------------------------------------------------- background --
      case "run_background": {
        const command = String(args.command ?? "").trim();
        if (!command) return { ok: false, summary: "No command was given." };
        const asked = String(args.cwd ?? "").trim();
        const cwd = asked ? path.resolve(terminalDir(), asked) : terminalDir();
        const started = startJob({ command, cwd, note: String(args.note ?? ""), session: ctx.session });
        if (!started.job) return { ok: false, summary: started.error ?? "It did not start." };
        const job = started.job;
        return {
          ok: true,
          summary:
            `Started ${job.id} in the background, running: ${command}\n` +
            `Working directory: ${cwd}\n` +
            `Its output is going to ${job.log}.\n` +
            "Nothing is waiting for it: this turn is free to carry on, and the " +
            `next turn is told how it ended. Read it with background_output ${job.id}.`,
          preview: `background ${job.id}`,
        };
      }

      case "background_jobs": {
        const list = listJobs();
        if (list.length === 0) {
          return {
            ok: true,
            summary: "No background commands. Start one with run_background.",
            preview: "no background jobs",
          };
        }
        const lines = list.map((j) => {
          const tail = j.last.trim();
          return tail ? `- ${describeJob(j)} Last line: ${tail}` : `- ${describeJob(j)}`;
        });
        return {
          ok: true,
          summary: ["Background commands, newest first:", ...lines].join("\n"),
          preview: `${list.length} background job(s)`,
        };
      }

      case "background_output": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No job id was given." };
        const job = findJob(id);
        if (!job) {
          return {
            ok: false,
            summary: `There is no background job ${id}. background_jobs lists the ones there are.`,
          };
        }
        const wanted = Math.min(Math.max(Number(args.lines ?? 40) || 40, 1), 500);
        const text = readTail(job, 200_000).replace(/\s+$/, "");
        const rows = text.split("\n");
        const shown = rows.slice(-wanted).join("\n");
        const omitted = rows.length > wanted ? `\n[${rows.length - wanted} earlier line(s) not shown]\n` : "\n";
        return {
          ok: job.state === "running" || job.exit === 0,
          exitCode: job.exit ?? undefined,
          summary:
            `${describeJob(job)}\n` +
            (job.state === "running" ? "(still running: this is what it has printed so far)\n" : "") +
            omitted + (shown || "(nothing printed)"),
          preview: `${job.id} · ${job.state}${job.exit === null ? "" : ` · exit ${job.exit}`}`,
        };
      }

      case "background_stop": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No job id was given." };
        const stopped = stopJob(id);
        return { ok: stopped.ok, summary: stopped.message };
      }

      // ------------------------------------------------------ schedule --
      case "schedule": {
        const jobs = ctx.jobs;
        if (!jobs) return { ok: false, summary: "Scheduled tasks are not available here." };
        const name = String(args.name ?? "").trim();
        const cron = String(args.cron ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        const id = String(args.id ?? "").trim();
        if (!prompt) return { ok: false, summary: "A task needs a prompt: what to do when it runs." };
        if (!id && !name) return { ok: false, summary: "Give it a name, so the person knows what it is." };
        if (!cron && !id) return { ok: false, summary: "Give it a time: a five-field cron expression." };
        const watch = args.watch && typeof args.watch === "object"
          ? {
            kind: String((args.watch as any).kind ?? ""),
            target: String((args.watch as any).target ?? "").trim(),
          }
          : null;
        if (watch && !watch.target) return { ok: false, summary: "A watcher needs something to watch." };
        const enabled = args.enabled === undefined ? true : Boolean(args.enabled);
        if (id) {
          const changed = jobs.update(id, { name: name || undefined, cron: cron || undefined, prompt, watch, enabled });
          if (!changed.ok) return { ok: false, summary: changed.error ?? `There is no job ${id}.` };
          return {
            ok: !changed.error,
            summary: changed.error
              ? `Saved, but its time is not valid: ${changed.error}`
              : `Changed ${id}. It runs "${prompt}" on ${cron || "its time"}.`,
            preview: `schedule ${id} changed`,
          };
        }
        const made = jobs.create({ name, cron, prompt, watch, enabled });
        if (!made.id) return { ok: false, summary: made.error ?? "It could not be created." };
        return {
          ok: !made.error,
          summary: made.error
            ? `Made ${made.id}, but its time is not valid: ${made.error}. Change the cron or remove it.`
            : `Made ${made.id}${watch ? ` watching the ${watch.kind} ${watch.target}` : ""}. ` +
              "It runs in a session of its own and what it says appears there; you do not have to wait for it.",
          preview: `schedule ${made.id}`,
        };
      }

      case "schedules": {
        const jobs = ctx.jobs;
        if (!jobs) return { ok: false, summary: "Scheduled tasks are not available here." };
        const list = jobs.list();
        if (list.length === 0) {
          return { ok: true, summary: "Nothing is scheduled. Set something with schedule.", preview: "no schedules" };
        }
        const when = (sec: number | null) =>
          sec ? new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") : "never";
        return {
          ok: true,
          summary: [
            "Scheduled tasks and watchers:",
            ...list.map((j) =>
              `- ${j.id} "${j.name}" -- ${j.cron}, next ${when(j.next_run)}, last ${when(j.last_run)}` +
              `${j.watch ? `, watching the ${j.watch.kind} ${j.watch.target}` : ""}` +
              `${j.enabled ? "" : ", PAUSED"}${j.running ? ", running now" : ""}` +
              `${j.cron_error ? ` -- its time is not valid: ${j.cron_error}` : ""}` +
              `${j.last_error ? ` -- last run failed: ${j.last_error}` : ""}`),
          ].join("\n"),
          preview: `${list.length} scheduled job(s)`,
        };
      }

      case "unschedule": {
        const jobs = ctx.jobs;
        if (!jobs) return { ok: false, summary: "Scheduled tasks are not available here." };
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No job id was given." };
        if (args.keep === true || args.keep === "true") {
          const paused = jobs.update(id, { enabled: false });
          return paused.ok
            ? { ok: true, summary: `Paused ${id}. It stays, and never fires until it is enabled again.` }
            : { ok: false, summary: paused.error ?? `There is no job ${id}.` };
        }
        return jobs.remove(id)
          ? { ok: true, summary: `Removed ${id}.` }
          : { ok: false, summary: `There is no job ${id}. schedules lists the ones there are.` };
      }

      // ----------------------------------------------------- autonomy --
      case "pre_authorise": {
        const tool = String(args.tool ?? "").trim();
        const match = String(args.match ?? "").trim();
        const made = addRule({ tool, match, note: String(args.note ?? ""), by: "agent" });
        if (!made.rule) return { ok: false, summary: made.error ?? "It was not agreed." };
        return {
          ok: true,
          summary:
            `Agreed: ${made.rule.tool} calls containing "${made.rule.match}" run without being held. ` +
            "It is listed in Settings, and the person can take it back. " +
            "It covers the guard only -- nothing irrecoverable is ever covered.",
          preview: `standing agreement ${made.rule.id}`,
        };
      }

      case "pre_authorisations": {
        const revoke = String(args.revoke ?? "").trim();
        if (revoke) {
          return revokeRule(revoke)
            ? { ok: true, summary: `Taken back: ${revoke}. It will be asked about again.` }
            : { ok: false, summary: `There is no standing agreement ${revoke}.` };
        }
        const list = listRules();
        if (list.length === 0) {
          return {
            ok: true,
            summary: "Nothing is pre-authorised. pre_authorise agrees a class of work so the guard stops asking about it.",
            preview: "no standing agreements",
          };
        }
        return {
          ok: true,
          summary: [
            "Standing agreements:",
            ...list.map((r) =>
              `- ${r.id} — ${r.tool}: anything containing "${r.match}"` +
              `${r.note ? ` (${r.note})` : ""}, added by the ${r.by}, used ${r.used} time${r.used === 1 ? "" : "s"}.`),
          ].join("\n"),
          preview: `${list.length} standing agreement(s)`,
        };
      }

      case "inventory": {
        const seen = getInventory(true);
        return {
          ok: true,
          summary: ["What this machine has, as of now:", ...seen.lines].join("\n"),
          preview: "looked at the machine",
        };
      }

      case "app_preview": {
        if (!ctx.preview) return { ok: false, summary: "There is no app window in this chat." };
        const action = String(args.action ?? "").trim().toLowerCase();
        if (action === "start") {
          const r = await ctx.preview.start({
            command: args.command, cwd: args.cwd, dir: args.dir, url: args.url, port: Number(args.port) || undefined,
          });
          return { ok: r.ok, summary: r.summary, preview: r.ok ? "app preview open" : undefined };
        }
        if (action === "reload") return await ctx.preview.reload();
        if (action === "stop") return await ctx.preview.stop();
        if (action === "look") {
          const r = await ctx.preview.look();
          const picture = r.png ? pictureFor(r.png, "image/png") : null;
          return { ok: r.ok, summary: r.summary, preview: r.ok ? "looked at the app" : undefined, ...(picture ? { images: [picture] } : {}) };
        }
        if (["click", "hover", "type", "press", "scroll"].includes(action)) {
          const r = await ctx.preview.act({
            action, target: args.target === undefined ? undefined : String(args.target), text: args.text === undefined ? undefined : String(args.text),
            key: args.key === undefined ? undefined : String(args.key), dy: args.dy === undefined ? undefined : Number(args.dy), submit: args.submit === true,
          });
          const picture = r.png ? pictureFor(r.png, "image/png") : null;
          return { ok: r.ok, summary: r.summary, preview: r.ok ? `${action} in the app` : undefined, ...(picture ? { images: [picture] } : {}) };
        }
        return { ok: false, summary: "action is start, reload, look, stop, click, hover, type, press or scroll." };
      }

      case "set_mode": {
        if (!ctx.setPhase) return { ok: false, summary: "There is no chat to switch here." };
        const to = String(args.to ?? "").trim().toLowerCase();
        if (to !== "build" && to !== "plan") {
          return { ok: false, summary: "to is build or plan." };
        }
        const result = ctx.setPhase(to, String(args.reason ?? "").trim().slice(0, 160));
        return { ok: result.ok, summary: result.summary, preview: result.ok ? to : undefined };
      }

      case "todo": {
        if (!ctx.todos) {
          return { ok: false, summary: "There is no to-do list to write to in this chat." };
        }
        const result = ctx.todos(args as Record<string, any>);
        return {
          ok: result.ok,
          summary: result.summary,
          ...(result.preview ? { preview: result.preview } : {}),
        };
      }

      case "tools_enable": {
        if (!ctx.enableTools) return { ok: false, summary: "There is nothing to load here." };
        const r = ctx.enableTools(String(args.family ?? "").trim().toLowerCase());
        return { ok: r.ok, summary: r.summary, preview: r.ok ? String(args.family) : undefined };
      }

      case "requirements": {
        if (!ctx.requirements) return { ok: false, summary: "There is no requirements list in this chat." };
        const result = ctx.requirements(args as Record<string, any>);
        return { ok: result.ok, summary: result.summary, ...(result.preview ? { preview: result.preview } : {}) };
      }

      case "ledger": {
        if (!ctx.ledger) return { ok: false, summary: "There are no working notes to write to in this chat." };
        const result = ctx.ledger(args as Record<string, any>);
        return { ok: result.ok, summary: result.summary, ...(result.preview ? { preview: result.preview } : {}) };
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
        const part = Number(args.part ?? 1);
        /* A third identical read used to be served as the same page again, and
           looked like progress while the agent went round. It is replaced by
           what to do instead -- the note names the way out rather than the
           problem, which the loop-check already says into the same wind. */
        const again = ctx.browser().lookNote(page, part);
        return {
          ok: true,
          summary: again ? `${again}\n\n(The page, unchanged, for reference:)\n${describePage(page, part)}` : describePage(page, part),
          preview: again ? `unchanged → ${page.url}` : part > 1 ? `${page.url} · part ${part}` : page.url,
        };
      }

      case "browser_click": {
        const ref = Number(args.ref);
        if (!Number.isFinite(ref)) {
          return { ok: false, summary: "That is not an element number." };
        }
        const page = await ctx.browser().click(ref);
        ctx.browserChanged();
        const held = page.notes?.some((n) => n.startsWith("NOT CLICKED")) ?? false;
        return {
          ok: true,
          summary: withNotes(page, held ? "Held back." : `Clicked [${ref}].`),
          preview: held ? `held back [${ref}]: covered` : `clicked [${ref}] → ${page.url}`,
        };
      }

      case "browser_fill": {
        const values = (Array.isArray(args.values) ? args.values : [])
          .map((v: any) => ({ ref: Number(v?.ref), text: String(v?.text ?? "") }))
          .filter((v: any) => Number.isFinite(v.ref));
        if (values.length === 0) {
          return { ok: false, summary: "No fields were given to fill." };
        }
        if (values.some((v: { text: string }) => hasPlaceholder(v.text))) {
          const at = ctx.browser().status().url ?? "";
          try {
            for (const v of values) v.text = fillPlaceholders(v.text, at);
          } catch (err: any) {
            return { ok: false, summary: `Nothing was filled. ${err?.message ?? err}` };
          }
        }
        const page = await ctx.browser().fill(values, Boolean(args.submit));
        ctx.browserChanged();
        return {
          ok: true,
          summary: withNotes(
            page,
            `Filled ${values.length} field${values.length === 1 ? "" : "s"}${args.submit ? " and submitted" : ""}:`,
          ),
          preview: page.url,
        };
      }

      case "browser_upload": {
        const ref = Number(args.ref);
        if (!Number.isFinite(ref)) return { ok: false, summary: "Give the upload field's element number as ref." };
        const ids = (Array.isArray(args.ids) ? args.ids : [args.ids])
          .map((id: unknown) => String(id ?? "").trim())
          .filter(Boolean)
          .slice(0, 10);
        if (ids.length === 0) return { ok: false, summary: "No artifact ids were given. Use artifact_list to find the file." };
        const files: UploadFile[] = [];
        for (const id of ids) {
          const meta = getArtifact(id);
          const data = meta ? readArtifact(id) : null;
          if (!meta || !data) {
            return { ok: false, summary: `There is no artifact "${id}". Use artifact_list to find the file.` };
          }
          files.push({ name: meta.name, mimeType: meta.mime, buffer: data });
        }
        const page = await ctx.browser().upload(ref, files);
        ctx.browserChanged();
        return {
          ok: true,
          summary: withNotes(page, `Attached ${files.map((f) => f.name).join(", ")}:`),
          preview: `attached ${files.map((f) => f.name).join(", ")} → [${ref}]`,
        };
      }

      case "browser_scroll": {
        const to = args.to === "top" || args.to === "bottom" ? args.to : undefined;
        const text = typeof args.text === "string" && args.text.trim() ? args.text.trim() : undefined;
        const ref = Number.isFinite(Number(args.ref)) && args.ref !== null && args.ref !== undefined
          ? Number(args.ref) : null;
        const dy = Number(args.dy);
        const screens = Number(args.screens);
        const page = await ctx.browser().scroll({
          to, text, ref,
          ...(Number.isFinite(screens) && screens !== 0
            ? { screens }
            : Number.isFinite(dy) && dy !== 0
              ? { dy }
              : to || text || ref !== null ? {} : { screens: 1 }),
        });
        ctx.browserChanged();
        return {
          ok: true,
          summary: page.notes?.length ? withNotes(page, "Scrolled.") : describePage(page),
          preview: page.url,
        };
      }

      case "browser_press": {
        const keys = (Array.isArray(args.keys) ? args.keys : [args.keys])
          .map((k: unknown) => keyName(String(k ?? "")))
          .filter(Boolean)
          .slice(0, 20);
        if (keys.length === 0) return { ok: false, summary: "No keys were given." };
        const ref = Number.isFinite(Number(args.ref)) && args.ref !== null && args.ref !== undefined
          ? Number(args.ref) : null;
        const page = await ctx.browser().press(keys, ref);
        ctx.browserChanged();
        return {
          ok: true,
          summary: `Pressed ${keys.join(", ")}.\n\n${describePage(page)}`,
          preview: `pressed ${keys.join(" ")}`,
        };
      }

      case "browser_signin_import": {
        const id = String(args.id ?? "").trim();
        const meta = getArtifact(id);
        const data = meta ? readArtifact(id) : null;
        if (!meta || !data) {
          return { ok: false, summary: `There is no uploaded file "${id}". Use artifact_list to find the cookie file.` };
        }
        let parsed;
        try {
          parsed = parseCookieExport(data.toString("utf8"));
        } catch (err) {
          return { ok: false, summary: `${meta.name}: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (parsed.cookies.length === 0) {
          return {
            ok: false,
            summary: `${meta.name} has no usable cookies in it${
              parsed.expired ? ` (${parsed.expired} had already expired -- the sign-in needs exporting again)` : ""}.`,
          };
        }
        const { added, refused } = await ctx.browser().importCookies(parsed.cookies);
        const sites = sitesOf(parsed.cookies);
        if (added > 0) for (const site of sites) recordSignIn(site, "import");
        const kept = Boolean(args.keep_file);
        if (!kept && added > 0) deleteArtifact(id);
        const extra = [
          refused ? `${refused} were refused by the browser` : "",
          parsed.expired ? `${parsed.expired} had expired` : "",
          parsed.skipped ? `${parsed.skipped} were unreadable` : "",
        ].filter(Boolean).join("; ");
        return {
          ok: added > 0,
          summary:
            `Imported ${added} cookie${added === 1 ? "" : "s"} for ${sites.slice(0, 12).join(", ")}` +
            `${sites.length > 12 ? ` and ${sites.length - 12} more sites` : ""}${extra ? ` (${extra})` : ""}. ` +
            `${!kept && added > 0 ? "The uploaded file has been deleted. " : ""}` +
            "Open the site to check it shows the person signed in; if it still asks " +
            "for a sign-in, the export was from a signed-out browser or for a different address.",
          preview: `signed in: ${sites.slice(0, 4).join(", ")}${sites.length > 4 ? "…" : ""}`,
        };
      }

      case "browser_back": {
        const page = await ctx.browser().back();
        ctx.browserChanged();
        return { ok: true, summary: describePage(page), preview: page.url };
      }

      case "browser_screenshot": {
        const live = ctx.browser();
        const selector = String(args.selector ?? "").trim();
        const ref = Number.isInteger(Number(args.ref)) && args.ref !== null && args.ref !== "" ? Number(args.ref) : undefined;
        const area = args.area && typeof args.area === "object" ? args.area : null;
        const saveAs = String(args.save_as ?? "").trim();
        const filedIn = String(args.notebook ?? "").trim();
        if (ref !== undefined || selector || area || args.full_page === true || saveAs || filedIn) {
          return await keepScreenshot(live, ctx, {
            fullPage: args.full_page === true, ref, selector, area, saveAs, notebook: filedIn,
            note: String(args.note ?? "").trim(),
          });
        }
        const png = await live.capture();
        const blob = ctx.putBlob(png, "image/png");
        const status = live.status();
        ctx.showScreen("browser", blob, { w: VIEWPORT.width, h: VIEWPORT.height });
        /* Four pictures of a page that has not moved a pixel is the same loop
           as four reads of it: the picture is still shown to the person, but
           the model is told what to do instead of handed it again. */
        const unmoved = live.shotNote(png);
        if (unmoved) {
          return { ok: true, summary: unmoved, preview: status.url ?? "screenshot" };
        }
        /* The picture goes to the model as well, in the result. It used to
           say here that she could not see it, which left "what does the page
           look like" answerable only from the text -- and a screenshot asked
           for because a page is stuck, or because something looks wrong, is
           exactly the question the text cannot answer. */
        const picture = pictureFor(png, "image/png");
        return {
          ok: true,
          summary:
            "A picture of the page as it is now is in this result, and on the " +
            "browser screen where the person can see it. This is the only way to " +
            "see the page rather than read it: use it when the person asks what " +
            "something looks like, when a page seems to be stuck, or when a click " +
            "did nothing and the text gives no reason." +
            (picture ? "" : " It is too large to hand back as a picture; it is on the person's screen."),
          preview: status.url ?? "screenshot",
          ...(picture ? { images: [picture] } : {}),
        };
      }

      case "browser_eval": {
        const script = String(args.script ?? "").trim();
        if (!script) {
          return {
            ok: false,
            summary:
              "No script was given. `script` is the JavaScript to run in the page, " +
              "either an expression or statements with a return.",
          };
        }
        const { page, value, hits, elapsed } = await ctx.browser().runScript(script);
        ctx.browserChanged();
        const clicked = hits.length
          ? `\nIt clicked: ${hits.map((h: { label?: string }) => h.label || "an element").join(", ")}.`
          : "";
        return {
          ok: true,
          summary: `${value}${clicked}\n\n${describePage(page)}`,
          preview: `eval${hits.length ? ` (clicked ${hits.map((h: { label?: string }) => h.label || "an element").join(", ")})` : ""} → ${page.url}`,
          ...(elapsed > 4000 ? { notes: [`The script took ${(elapsed / 1000).toFixed(1)}s.`] } : {}),
        };
      }

      case "browser_captcha": {
        const { outcome, kind, page, detail, backend } = await ctx.browser().solveCaptcha();
        ctx.browserChanged();
        const said: Record<typeof outcome, string> = {
          none: "There is no checkbox CAPTCHA on this page.",
          solved: `The ${kind ?? "CAPTCHA"} check passed.` +
            (backend ? ` The picture challenge was answered by the ${backend} backend.` : ""),
          pending:
            `Clicked the ${kind ?? "CAPTCHA"} checkbox, but it has not confirmed yet. ` +
            "Re-read the page in a moment; if it is still unticked, try browser_captcha once more.",
          challenge:
            `The ${kind ?? "CAPTCHA"} checkbox escalated to a picture challenge and the solver did not get it. ` +
            "Hand the browser to the person with browser_handoff to solve it.",
        };
        return {
          ok: outcome === "solved" || outcome === "none",
          summary:
            `${said[outcome]}` +
            (detail ? `\n\nWhat the solver did: ${detail}` : "") +
            `\n\n${describePage(page)}`,
          preview: `captcha: ${outcome}`,
        };
      }

      case "browser_handoff": {
        const reason = String(args.reason ?? "Your help is needed in the browser.");
        const live = ctx.browser();
        live.setControl("human", reason);
        ctx.browserChanged();
        const watch = await captchaWatch(live, reason);
        const answer = await ctx.ask({
          kind: "browser",
          title: reason,
          detail: watch
            ? "Solve it in the page below. Autora carries on by itself as soon as it passes."
            : "Tap and type in the page below. Nothing you type there is saved to the chat.",
          options: [],
          multi: false,
          allowText: false,
          watch,
        });
        live.setControl("agent", null);
        ctx.browserChanged();
        if (answer.cancelled) {
          return {
            ok: false,
            summary:
              answer.who === "user"
                ? "The person said they cannot do this. Tell them what you were " +
                  "trying to reach, and ask how they would like to proceed."
                : "Nobody took over the browser. Stop here and say what is needed.",
            preview: "handoff: not done",
          };
        }
        const page = await live.snapshot();
        /* What the person did in the page is most often a sign-in, and it is
           kept: noted here so no later conversation asks for it again. */
        if (answer.who !== "auto" && !watch && /sign|log ?in|auth|2fa|mfa|verif|code|password|account|sso|oauth/i.test(reason)) {
          recordSignIn(page.url, "handoff");
        }
        if (answer.who === "auto") {
          return {
            ok: true,
            summary:
              "The CAPTCHA passed while the person had the browser -- detected on the page, " +
              "not reported by them. Carry straight on with the task; do not ask whether " +
              "they finished it.\n\n" + describePage(page),
            preview: "handoff: captcha passed",
          };
        }
        return {
          ok: true,
          summary:
            "The person says they are done in the browser" +
            (answer.text ? ` and added: ${answer.text}` : "") +
            ".\n\n" + describePage(page),
          preview: "handoff: done",
        };
      }

      case "ask_user": {
        const question = String(args.question ?? "").trim();
        if (!question) return { ok: false, summary: "No question was given." };
        const options = Array.isArray(args.options)
          ? args.options
              .map((o: any) => typeof o === "string"
                ? { label: o }
                : { label: String(o?.label ?? "").trim(), detail: o?.detail ? String(o.detail) : undefined })
              .filter((o: { label: string }) => o.label)
              .slice(0, 8)
          : [];
        const answer = await ctx.ask({
          kind: "question",
          title: question,
          detail: args.context ? String(args.context) : undefined,
          options,
          multi: Boolean(args.multi_select),
          allowText: args.allow_text !== false || options.length === 0,
          placeholder: args.placeholder ? String(args.placeholder) : undefined,
        });
        if (answer.cancelled) {
          return {
            ok: false,
            summary: answer.who === "user"
              ? "The person dismissed the question without answering. Use your best judgement, and say what you assumed."
              : "The question went unanswered. Stop and say what you need.",
            preview: "no answer",
          };
        }
        const parts: string[] = [];
        if (answer.choices.length) parts.push(`chose: ${answer.choices.join("; ")}`);
        if (answer.text) parts.push(`wrote: ${answer.text}`);
        return {
          ok: true,
          summary: `The person answered. They ${parts.join(", and ")}.`,
          preview: answer.choices.join(", ") || answer.text.slice(0, 80),
        };
      }

      case "mcp_servers": {
        return { ok: true, summary: mcpOverview(String(args.topic ?? "")), preview: "MCP servers" };
      }

      case "mcp_offer": {
        const plan = planOffer(args);
        if (typeof plan === "string") return { ok: false, summary: plan };
        const already = existingMcp(plan.name);
        if (already) {
          const status = mcpStatusOf(already.id);
          if (status.status === "connected") {
            return {
              ok: true,
              summary: `${plan.title} is already set up and connected. Its tools: ` +
                `${status.tools.map((t) => `mcp__${plan.name}__${t.name}`).join(", ") || "(none)"}. Use them.`,
              preview: "already set up",
            };
          }
        }
        if (wasDeclined(ctx.session, plan.name)) {
          return {
            ok: false,
            summary: `The person already said not now to ${plan.title} in this session. Do not offer it again; carry on another way.`,
            preview: "declined earlier",
          };
        }
        const answer = await ctx.ask({
          kind: "offer",
          title: `Set up ${plan.title}?`,
          detail: plan.why,
          options: [{ label: "Set it up" }, { label: "Not now" }],
          multi: false,
          allowText: false,
          offer: {
            name: plan.name, title: plan.title, summary: plan.summary,
            runs: plan.runs, kind: plan.kind, needs: plan.needs,
          },
        });
        if (answer.cancelled || !answer.choices.includes("Set it up")) {
          noteDeclined(ctx.session, plan.name);
          return {
            ok: true,
            summary: `The person chose not to set up ${plan.title} now. Carry on with the tools you have ` +
              "and do not offer it again this session.",
            preview: "not now",
          };
        }
        const result = await installMcp(plan);
        if (!result.ok) {
          return {
            ok: false,
            summary: `${plan.title} was saved but did not connect: ${result.error ?? "unknown error"}` +
              (result.missing.length ? ` Missing secrets: ${result.missing.join(", ")}.` : "") +
              " Tell the person what went wrong in a sentence; it can be fixed on the Integrations page. " +
              "Meanwhile carry on another way.",
            preview: "did not connect",
          };
        }
        return {
          ok: true,
          summary: `${plan.title} is set up and connected. New tools, yours from your next step: ` +
            `${result.tools.map((t) => `mcp__${plan.name}__${t}`).join(", ")}. Use them for the rest of this task.`,
          preview: `${result.tools.length} new tool${result.tools.length === 1 ? "" : "s"}`,
        };
      }

      case "http_request": {
        return await runHttpRequest({
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
        }, ctx);
      }

      case "web_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, summary: "No search query was provided." };
        const results = await searchWeb(query, ctx);
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
        const buffer = Buffer.from(image, "base64");
        const blob = ctx.putBlob(buffer, "image/jpeg");
        const w = Number(result.data?.w) || null;
        const h = Number(result.data?.h) || null;
        ctx.showScreen("desktop", blob, w && h ? { w, h } : undefined);
        const picture = pictureFor(buffer, "image/jpeg");
        return {
          ok: true,
          summary: [
            "The desktop is now shown in the conversation for the person to see,",
            "and the picture is in this result for you to look at.",
            w && h
              ? `Its screen is ${w}×${h} pixels; click and move coordinates are in that` +
                " space, measured from the top-left."
              : "",
            picture ? "" : "It is too large to hand back as a picture; it is on the person's screen.",
          ].filter(Boolean).join(" "),
          preview: w && h ? `${w}×${h}` : "desktop",
          ...(picture ? { images: [picture] } : {}),
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

      // ---------------------------------------------------------- voice --
      case "voice_mute": {
        const muted = args.muted !== false;
        updateToolSettings({ voice: { enabled: !muted } });
        ctx.mute?.(muted);
        return {
          ok: true,
          summary: muted
            ? "Muted: nothing is said out loud on the page any more, and the speak " +
              "tool is off until it is turned back on in Settings -> Model & tools -> Voice."
            : "Unmuted: the speak tool can be heard on the page again.",
        };
      }
      case "speak": {
        const text = String(args.text ?? "").replace(/\s+/g, " ").trim();
        if (!text) return { ok: false, summary: "Nothing to say." };
        if (text.length > MAX_SPOKEN_CHARS) {
          return {
            ok: false,
            summary: `That is ${text.length.toLocaleString("en-US")} characters; say at most ${
              MAX_SPOKEN_CHARS.toLocaleString("en-US")} per call, in more than one call if you need to.`,
          };
        }
        if (!ctx.speak) return { ok: false, summary: "There is no page open to speak on." };
        ctx.speak(text);
        const voice = await speechStatus().catch(() => null);
        return {
          ok: true,
          summary: voice?.available
            ? `Played aloud on the person's page in the ${voice.voice} voice from ${voice.url}. Nothing else to do: do not also make or attach an audio file.`
            : "Played aloud on the person's page in the browser's own voice (no Deepgram key is set up). Nothing else to do: do not also make or attach an audio file.",
          preview: text.slice(0, 80),
        };
      }

      /* ------------------------------------------------------- live view -- */
      case "camera_look": {
        const frame = latestFrame(ctx.session);
        if (!frame) {
          return {
            ok: false,
            summary:
              "Live view is off: nothing is coming in from the camera. It is on only while the " +
              "person is in talk mode with the view switched on, so say so rather than asking again.",
          };
        }
        const image = frameImage(frame);
        if (!image) {
          return { ok: false, summary: "That frame is too large to hand over as a picture." };
        }
        const agoMs = Date.now() - frame.at;
        const ago = agoMs < 1500 ? "just now" : `${Math.round(agoMs / 1000)}s old`;
        return {
          ok: true,
          summary:
            `The newest frame from the person's camera (${ago}) is in this result. It is the only ` +
            "one there is -- earlier frames were never kept -- so anything that has already gone " +
            "from the view is gone.",
          preview: `camera frame (${ago})`,
          images: [image],
        };
      }

      // -------------------------------------------------------- widgets --
      case "widget_show": {
        const html = String(args.html ?? "");
        if (!html.trim()) return { ok: false, summary: "The widget has no HTML." };
        if (html.length > MAX_WIDGET_CHARS) {
          return {
            ok: false,
            summary: `The widget is ${html.length.toLocaleString("en-US")} characters; the limit is ${
              MAX_WIDGET_CHARS.toLocaleString("en-US")}. Generate repetitive geometry or data in script instead of writing it out.`,
          };
        }
        const title = String(args.title ?? "").trim().slice(0, 120) || "Explainer";
        const asked = Number(args.height);
        const height = Number.isFinite(asked) && asked > 0
          ? Math.round(Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, asked)))
          : WIDGET_DEFAULT_HEIGHT;
        const check = await checkWidget({ title, html, height });
        if (!check.ok) {
          return {
            ok: false,
            summary:
              `The widget "${title}" was NOT shown to the person: it failed when it was tried.\n\n${check.report}\n\n` +
              "Fix the cause and call widget_show again with the whole corrected widget.",
            preview: `${title}: failed its check`,
          };
        }

        // A copy that opens on its own, Three.js and all, from the Artifacts page.
        let artifact: string | undefined;
        try {
          artifact = saveArtifact({
            origin: "agent", name: `${slug(title)}.html`,
            data: Buffer.from(widgetDocument({ title, html }), "utf8"),
            mime: "text/html", session: ctx.session, note: `Interactive widget: ${title}`,
          }).id;
        } catch {
          // The widget is still in the thread; losing the copy is not a failure.
        }
        ctx.showWidget({ title, html, height, ...(artifact ? { artifact } : {}) });
        return {
          ok: true,
          summary:
            `The widget "${title}" is now shown in the conversation${artifact ? ` (saved as artifact ${artifact})` : ""}.\n\n` +
            `${check.report}\n\n` +
            (check.checked
              ? "If this is not what you meant it to look like or do, fix it and call widget_show again. "
              : "") +
            "Errors it throws later in the person's browser are reported to you in the conversation.",
          preview: check.checked ? title : `${title} (unchecked)`,
        };
      }

      // ------------------------------------------------------ artifacts --
      case "artifact_save": {
        const name = String(args.name ?? "").trim();
        if (!name) return { ok: false, summary: "An artifact needs a file name." };
        const given = String(args.path ?? "").trim();
        // Relative to where the terminal runs, which is where the agent just
        // made the file -- not to wherever the server was started from.
        const from = given ? path.resolve(terminalDir(), given) : "";
        let data: Buffer;
        if (from) {
          if (!fs.existsSync(from)) return { ok: false, summary: `There is no file at ${from}.` };
          const stat = fs.statSync(from);
          if (!stat.isFile()) return { ok: false, summary: `${from} is not a file.` };
          if (stat.size > MAX_ARTIFACT_BYTES) {
            return { ok: false, summary: `${from} is ${formatSize(stat.size)}; artifacts are capped at ${formatSize(MAX_ARTIFACT_BYTES)}.` };
          }
          data = fs.readFileSync(from);
        } else if (typeof args.content === "string") {
          data = Buffer.from(args.content, "utf8");
        } else {
          return { ok: false, summary: "Give either the file's content or a path to it." };
        }
        // Saving a name that is already up there rewrites that artifact, so
        // say which happened: "saved" reads as a new card beside the old one.
        const had = listArtifacts().find((a) => a.origin === "agent" && a.name === cleanName(name));
        const art = saveArtifact({
          origin: "agent", name, data, session: ctx.session,
          note: String(args.note ?? "").trim() || undefined,
        });
        const filedIn = String(args.notebook ?? "").trim();
        let filed = "";
        if (filedIn) {
          const { book, made } = notebookFor(filedIn);
          addEntries(book.id, [{ artifact: art.id, text: args.note }], "agent");
          filed = made ? ` Filed in a new notebook ${book.id}, "${book.title}".` : ` Filed in "${book.title}" (${book.id}).`;
        }
        return {
          ok: true,
          summary: (had
            ? `Updated the artifact ${art.id} (${art.name}, ${formatSize(art.size)}); there is one copy of it on the Artifacts page, now holding this version.`
            : `Saved as artifact ${art.id} (${art.name}, ${formatSize(art.size)}). The person can open and download it from the Artifacts page.`) + filed,
          preview: `${art.name} · ${formatSize(art.size)}`,
        };
      }

      case "artifact_list": {
        const origin = String(args.origin ?? "all");
        const all = listArtifacts().filter((a) => origin === "all" || a.origin === origin);
        if (all.length === 0) {
          return { ok: true, summary: "There are no artifacts yet.", preview: "0 artifacts" };
        }
        return {
          ok: true,
          summary: all.slice(0, 200).map(artifactLine).join("\n"),
          preview: `${all.length} artifact${all.length === 1 ? "" : "s"}`,
        };
      }

      case "artifact_read": {
        const id = String(args.id ?? "").trim();
        const meta = getArtifact(id);
        const data = meta ? readArtifact(id) : null;
        if (!meta || !data) return { ok: false, summary: `There is no artifact "${id}". Use artifact_list to see what there is.` };
        if (meta.mime.startsWith("image/") && meta.mime !== "image/svg+xml") {
          const blob = ctx.putBlob(data, meta.mime);
          ctx.showImage(blob, meta.name, meta.name);
          return {
            ok: true,
            summary: `${artifactLine(meta)}\nThe image is now shown in the conversation.`,
            preview: meta.name,
          };
        }
        if (!isText(meta.mime)) {
          if (meta.mime === "application/pdf") {
            return {
              ok: true,
              summary: `${artifactLine(meta)}\nA PDF: read it with pdf_read (text, form fields, attachments) and see its pages with pdf_look.`,
              preview: meta.name,
            };
          }
          return {
            ok: true,
            summary: `${artifactLine(meta)}\nNot a text file. It is on this host at ${
              artifactPath(meta.id)} if the terminal can read it (pdftotext, unzip, python...).`,
            preview: meta.name,
          };
        }
        const text = data.toString("utf8");
        const room = CONTEXT_CONFIG.maxToolTokens * 4 - 200;
        const offset = Math.max(0, Number(args.offset) || 0);
        const length = Math.min(room, Math.max(1, Number(args.length) || room));
        const part = text.slice(offset, offset + length);
        const rest = text.length - (offset + part.length);
        return {
          ok: true,
          summary: `${meta.name} (${text.length} characters${offset ? `, from ${offset}` : ""}):\n\n${part}${
            rest > 0 ? `\n\n[${rest} more characters -- read on with offset ${offset + part.length}]` : ""}`,
          preview: meta.name,
        };
      }

      case "notebook":
        return runNotebook(args, ctx);

      // ----------------------------------------------------------- PDFs --
      case "pdf_read":
      case "pdf_look":
      case "pdf_edit":
      case "pdf_compose":
      case "pdf_pages":
      case "pdf_redact":
      case "pdf_replace_text":
      case "pdf_compress":
        return await runPdfTool(spec.name, args, {
          session: ctx.session,
          cwd: terminalDir(),
          room: CONTEXT_CONFIG.maxToolTokens * 4 - 200,
          putBlob: ctx.putBlob,
          showImage: ctx.showImage,
          showFile: ctx.showFile,
          cancelled: ctx.cancelled,
          onCancel: ctx.onCancel,
          // The PDF window shows the work; an incognito chat keeps nothing on
          // disk, so it works on files without one.
          ...(ctx.memory.incognito ? {} : { desk: deskHooks(ctx.session) }),
          ...(ctx.held ? { held: (id: string) => ctx.held!("pdf", id) } : {}),
        });

      // ---------------------------------------------------------- Office --
      case "office_guide":
      case "office_read":
      case "office_edit":
      case "office_check":
      case "office_look":
      case "office_open":
      case "office_pdf":
      case "office_create":
      case "office_convert":
        return await runOfficeTool(spec.name, args, {
          session: ctx.session,
          cwd: terminalDir(),
          room: CONTEXT_CONFIG.maxToolTokens * 4 - 200,
          showFile: ctx.showFile,
          putBlob: ctx.putBlob,
          showImage: ctx.showImage,
          ...(ctx.memory.incognito ? {} : { desk: deskHooks(ctx.session), win: officeHooks(ctx.session) }),
          ...(ctx.held ? { held: (_surface: "office", subject: string) => ctx.held!("office", subject) } : {}),
          cancelled: ctx.cancelled,
          onCancel: ctx.onCancel,
        });

      // --------------------------------------------------------- memory --
      case "memory_write": {
        if (ctx.memory.incognito) return incognitoMemory();
        const title = String(args.title ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!title || !body) {
          return { ok: false, summary: "A memory needs both a title and a body." };
        }
        /* Held to the mind's rules (see mindrules.ts): a subject in the title, one
           topic, nothing about the moment, a reference with its source. The refusal
           says what to change, so the next call can be right. */
        const verdict = checkEntry({
          title, body, kind: args.kind, tags: args.tags, subject: args.subject,
          facet: args.facet, source: args.source, version: args.version,
        });
        if (!verdict.ok) return { ok: false, summary: `Not written down. ${verdict.error}` };
        const e = verdict.entry;
        const { id, action } = ctx.memory.write({
          title: e.title, body: e.body, kind: e.kind, tags: e.tags, subject: e.subject,
          facet: e.facet, source: e.source, version: e.version, status: e.status,
        });
        const asked = verdict.notes.length ? ` ${verdict.notes.join(" ")}` : "";
        return {
          ok: true,
          summary: (action === "merged"
            ? `That was close to ${id}, so ${id} was updated rather than a copy added: "${e.title}".`
            : `Written down as ${id}: "${e.title}".`) + asked,
          preview: e.title,
        };
      }

      case "memory_update": {
        if (ctx.memory.incognito) return incognitoMemory();
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No memory id was given." };
        const patch = {
          title: typeof args.title === "string" ? args.title : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
          kind: typeof args.kind === "string" ? args.kind : undefined,
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          subject: typeof args.subject === "string" ? args.subject : undefined,
          facet: typeof args.facet === "string" ? args.facet : undefined,
          source: typeof args.source === "string" ? args.source : undefined,
          version: typeof args.version === "string" ? args.version : undefined,
        };
        const changed = ctx.memory.update(id, patch);
        if (typeof changed === "string") return { ok: false, summary: `Not changed. ${changed}` };
        if (!changed) {
          return { ok: false, summary: `There is no memory ${id}. memory_search shows the ids.` };
        }
        return { ok: true, summary: `Updated ${id}.`, preview: id };
      }

      case "memory_forget": {
        if (ctx.memory.incognito) return incognitoMemory();
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No memory id was given." };
        const replacedBy = typeof args.replaced_by === "string" ? args.replaced_by.trim() : null;
        if (!ctx.memory.forget(id, replacedBy)) {
          return {
            ok: false,
            summary: `There is no memory ${id}${replacedBy ? ` or ${replacedBy}` : ""}. memory_search shows the ids.`,
          };
        }
        return {
          ok: true,
          summary: replacedBy ? `${id} is retired in favour of ${replacedBy}.` : `${id} is forgotten.`,
          preview: id,
        };
      }

      case "memory_confirm": {
        if (ctx.memory.incognito) return incognitoMemory();
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No memory id was given." };
        const note = typeof args.note === "string" ? args.note.trim() : "";
        if (!ctx.memory.confirm(id, note)) {
          return { ok: false, summary: `There is no memory ${id}. memory_search shows the ids.` };
        }
        return {
          ok: true,
          summary: `Marked ${id} as checked today${note ? ", with what you found added to it" : ""}.`,
          preview: id,
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
            .map((m) => `- ${m.id} [${m.kind}${m.status === "provisional" ? ", unconfirmed" : ""}] ${m.title}: ${m.body}` +
              (m.kind === "reference" && m.source ? ` (source ${m.source}${m.fetched ? `, read ${new Date(m.fetched * 1000).toISOString().slice(0, 10)}` : ""})` : ""))
            .join("\n"),
          preview: `${found.length} found`,
        };
      }

      case "vault_read": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No artifact id was given." };
        const text = ctx.vault(id);
        if (text === null) {
          return {
            ok: false,
            summary:
              `There is no vault artifact "${id}" -- it may have been evicted, ` +
              "or the server restarted. Run the tool again if you still need it.",
          };
        }
        // Kept under the ingestion cap, so what is read back is never itself
        // sent to the vault.
        const room = CONTEXT_CONFIG.maxToolTokens * 4 - 200;
        return { ok: true, summary: readVault(text, args, room), preview: id };
      }

      case "tool_create": {
        try {
          const { tool, replaced, warnings } = defineCustomTool({
            name: args.name, description: args.description, params: args.parameters,
            script: args.script, session: ctx.session,
          });
          return {
            ok: true,
            summary:
              `${replaced ? "Replaced" : "Saved"} ${CUSTOM_PREFIX}${tool.name}. It is offered from the ` +
              "next step on, like any other tool. Try it once now to make sure it works." +
              (tool.params.length ? ` It takes: ${tool.params.map((p) => p.name).join(", ")}.` : " It takes no arguments.") +
              (warnings.length ? `\n\nWARNING: ${warnings.join(" ")}` : ""),
            preview: `${CUSTOM_PREFIX}${tool.name}`,
          };
        } catch (err: any) {
          return { ok: false, summary: err?.message ?? String(err) };
        }
      }

      case "tool_delete": {
        const name = String(args.name ?? "").trim();
        return deleteCustomTool(name)
          ? { ok: true, summary: `Deleted ${name}.`, preview: name }
          : { ok: false, summary: `There is no tool you wrote called ${name}.` };
      }

      default: {
        const custom = spec.name.startsWith(CUSTOM_PREFIX) ? getCustomTool(spec.name) : undefined;
        if (custom) {
          const missing = missingArgs(custom, args);
          if (missing.length) {
            return { ok: false, summary: `${spec.name} needs ${missing.join(", ")}.` };
          }
          const settings = toolSettings().terminal;
          const outcome = await runCommand(custom.script, terminalDir(), settings.timeout, ctx, customEnv(custom, args));
          noteCustomRun(spec.name, outcome.ok);
          return outcome;
        }
        if (spec.group === "mcp") {
          const out = await callMcpTool(spec.name, args);
          return {
            ok: out.ok,
            summary: out.text,
            preview: out.text.replace(/\s+/g, " ").slice(0, 120),
          };
        }
        return { ok: false, summary: `There is no tool called "${spec.name}".` };
      }
    }
  } catch (err: any) {
    // Playwright in particular throws on a timeout, a detached element, a page
    // that navigated mid-click. All of those are things the model can react to.
    return { ok: false, summary: `${spec.name} failed: ${err?.message ?? String(err)}` };
  }
}

/**
 * How to work a page, said once per turn while there is a browser.
 *
 * The tools say what each one does; this says how a careful person uses them
 * together. Without it the agent read a form's labels and nothing else, typed
 * a full name into a first-name box, scrolled a page that was already at the
 * bottom, and retyped a password into a site that was refusing the browser.
 */
const BROWSING_GUIDE = [
  "  Working a web page:",
  "  - Each element line says what the page says about it: (purpose) from its autocomplete hint or " +
    "field name, type=, value= or placeholder=, options: for a dropdown, required, INVALID: with " +
    "the page's own error, hint:, and a -- section -- line above the fields it groups. Use all of " +
    "it. A \"Name\" box marked (first name) takes only the first name; a (last name) box beside it " +
    "takes the surname; two \"Name\" boxes under different sections are different people or " +
    "addresses. Split, join and reformat what you know to fit each field (a phone as the field " +
    "shows it, a date in the order its placeholder uses).",
  "  - Fill a whole form with one browser_fill, dropdowns and checkboxes included, then read what " +
    "each field reports holding. Fix anything reformatted, refused or INVALID before submitting. " +
    "A field that offers suggestions as you type: fill it, then pick the suggestion (click its " +
    "option, or browser_press ArrowDown then Enter). A file the form asks for (a CV, a photo) " +
    "is attached from the Artifacts with browser_upload, given the upload box or its button -- " +
    "including a drag-and-drop box with no file input. Do not work around an upload box by " +
    "studying its scripts or posting the form yourself.",
  "  - An open dialog (cookie notice, sign-up prompt) is named at the top of the elements. " +
    "Answer or close it first; browser_press Escape closes most.",
  "  - The last line says where you are on the page and how much is below. Use browser_scroll " +
    "with text to go to something you know is there, with a ref for a list or panel that scrolls " +
    "on its own, and stop when it says you are at the bottom. Elements not on screen are " +
    "counted, not listed, and can still be clicked by number.",
  "  - When the page will not budge -- two reads come back identical, or the thing you need is a " +
  "dialog drawn by script, with no numbers at all -- stop reading and use browser_eval: JavaScript " +
  "in the page. __autora.click(__autora.byText(\"Save as draft\")) clicks a button by its own " +
  "words, __autora.all(\"button\").map((b) => b.innerText) lists what is there, and the page " +
  "comes back with what the script returned. An identical third read answers with this instead of " +
  "the page. If eval cannot reach it either, browser_handoff: the person can click it in three seconds. " +
  "That is the end of the line, not another read.",
  "  - After each action, check the page did what you meant (the URL, the new text, the field " +
    "values) before the next. When a click seems to do nothing, look for an error or a dialog " +
    "before trying again, and try a different way rather than the same click.",
  "  - Sign-ins: fill the fields yourself when you have the details (a saved sign-in under " +
    "Credentials below counts); hand the page to the person with browser_handoff for passwords " +
    "you do not have, 2FA codes you cannot fill, app approvals and CAPTCHA " +
    "pictures. A sign-in that opens its own window (Sign in with Google, LinkedIn, Microsoft) is " +
    "shown in that window until it closes itself, then you are back on the page that opened it. When the " +
    "result says SIGN-IN REFUSED, the site is refusing this browser: stop, and follow what it says.",
].join("\n");

/**
 * What the agent is told it can do, in prose, before the conversation starts.
 *
 * Generated from the same registry the schemas come from, so the two cannot
 * drift -- and a group that is off or unavailable is *named* as such rather
 * than omitted. An agent that is simply missing a browser tool will guess; one
 * told "browsing is turned off in Settings" can say so, which is the answer the
 * person actually needs.
 */
/* When to reach for the memory, not only that it is there. The tools were
   listed and nothing said when to use them, so the agent searched only when
   asked to, and worked out again on Friday what it had worked out on
   Tuesday -- recall at the start of a turn is made from the person's words,
   and says nothing about the site or service the work turns to halfway. */
const MEMORY_GUIDE =
  "- Using your memory: what was recalled for this turn is in the console note, found by " +
  "the words of the request. When the work turns to a subject, site, service or project " +
  "that note did not cover, memory_search it by name before working it out again: how it " +
  "was done here last time may be written down. Each finished turn is also looked back on " +
  "for you, so there is no need to write down the conversation.\n" +
  "- Know it before you do it: you do not carry current knowledge of products, websites, apps, " +
  "APIs or their interfaces -- they change, and a guess from training is how you end up clicking " +
  "the wrong menu or calling an endpoint that was renamed. Before you start work that depends on " +
  "how one of them works, or answer where something is in one (\"where do I find X in Y\"): " +
  "(1) memory_search its name for a reference; one marked old, or with no official source, is not " +
  "enough; (2) if there is none, or it is old, read the OFFICIAL source -- web_search the vendor's own " +
  "documentation or help pages, then http_request or browser_read the page that covers the task " +
  "(or give the lookup to the research tool, which keeps your context clean); an answer from a forum " +
  "or a blog is not the product's word; (3) write what you learned down with memory_write, kind " +
  "reference, with subject, facet (interface for where things are and what they are called, api for " +
  "calls, docs, workflow, quirk) and source (the page's address): one topic per record, short, as " +
  "exact as the page, with the version if it says; (4) only then do the work, from what you wrote. " +
  "An interface reference older than three weeks is read again before you rely on it; when you " +
  "see in practice that the page was wrong or has changed, fix the reference with memory_update.\n" +
  "- Writing to memory: one topic per record; the title starts with its subject (\"GitHub: where " +
  "repository settings are\"); short; true months from now (nothing about this conversation: the log " +
  "has it); nothing secret; no near-copies -- memory_update the one that exists. Procedures: the " +
  "steps, commands and gotchas that worked. Preferences: what the person told you about how they " +
  "want things done. A write that breaks these is refused with what to change.\n" +
  "A recalled memory that turns out wrong is fixed with memory_update, not worked around.";

/* The one tool that is about the person's ears rather than the work. It is
   named here because the moment it is wanted is the moment somebody is being
   talked over, and an agent that has to look for a way to stop has already
   spent the sentence it should not have said. */
const VOICE_GUIDE =
  "- Speaking out loud: speak says something on the page in the console's own voice, and " +
  "voice_mute(true) stops everything being said on that page at once -- mid-sentence, and " +
  "for every turn after it, with the switch in Settings -> Model & tools -> Voice showing " +
  "it. The moment the person asks you to stop talking, be quiet, or says the voice is " +
  "annoying, call voice_mute(true) first and answer in writing only. Do not argue for the " +
  "voice, do not offer to say it anyway, and do not call speak again in that turn. " +
  "voice_mute(false) is how you are heard again, and only when they ask for it.";

/** The app window, in the instructions: start it early, keep it running, check with look. */
const APP_GUIDE =
  "- The app window: always available. Tool: app_preview. When you build a website or an app, start it " +
  "in the app window as soon as there is anything to see, and keep it running while you build: the person " +
  "watches it take shape, can select elements or regions and leave comments, and what they say comes back " +
  "as one message you act on. Check your own work with look (a picture and the console's errors) before " +
  "you say it is done.";

/**
 * The to-do list, in the instructions.
 *
 * Told as a rule about how work is presented rather than as a tool that
 * happens to exist: a list the person can watch is worth more than a promise
 * to do the steps, and keeping it true is what makes it worth having. The
 * sizes are given because the shape differs -- many items for code, a handful
 * for an errand.
 */
const TODO_GUIDE =
  "- The to-do list: always available. Tool: todo. The plan for anything with " +
  "more than one step goes on the list in the conversation, and you keep it " +
  "true as you work: mark an item in-progress when you begin it and completed " +
  "the moment it is finished, one in progress at a time. Every call writes the " +
  "whole list. Write it before the first step, so the person watches the work " +
  "tick off rather than reading a promise about it. Size it to the job: " +
  "programming may be a dozen items; an errand is a few -- for \"check my " +
  "email and draft a reply to the invoice one\", read the inbox, pull the " +
  "attachment, draft the reply, show it for review, send it. Do not ask " +
  "whether to make a list, and do not wait to be told to tick one off. A " +
  "one-line answer needs no list. Titles are short: one line each. Only you " +
  "change the list; the person watches.";

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

  if (groups.some((g) => g.group === "browser" && g.available)) lines.push(BROWSING_GUIDE, signInBriefing(), credentialsBriefing());
  if (groups.some((g) => g.group === "memory" && g.available)) lines.push(MEMORY_GUIDE);
  if (groups.some((g) => g.group === "voice" && g.available)) lines.push(VOICE_GUIDE);
  const windows = toolSettings();
  const offLine = (what: string) =>
    `- ${what}: turned off by the person on the Tools page; its tools are not yours this turn. ` +
    "If the task needs it, say so and that it is switched on there.";
  lines.push(TODO_GUIDE, windows.app.enabled ? APP_GUIDE : offLine("The app window"));

  const mcp = mcpTools();
  if (mcp.length > 0) {
    lines.push(
      `- MCP servers: ${mcp.length} tool${mcp.length === 1 ? "" : "s"} from connected servers, ` +
        "named mcp__<server>__<tool>. Use them like any other tool, in preference to the browser.",
    );
  }
  lines.push(
    "- Setting up MCP servers: always available. Tools: mcp_servers, mcp_offer. When the " +
      "person asks about MCP servers or integrations, answer from mcp_servers. When a task " +
      "lives on a service with an API (GitHub, Slack, Notion, a database, maps, library docs, " +
      "an internal API) and no connected server covers it, offer one with mcp_offer before " +
      "reaching for the browser -- once, with the reason in a line -- and use its tools if they " +
      "say yes. If there is no ready-made server, you can write a small one (mcp_offer tools=...). " +
      "Do not offer for one-off lookups a page read answers faster, and never ask for keys in chat.",
  );
  lines.push(
    "- Artifacts: always available. Tools: artifact_list, artifact_read, " +
      "artifact_save. Files the person uploaded (documents, photos...) are " +
      "there for you to read; save the deliverables you make with " +
      "artifact_save so they can be found and downloaded later. Artifacts " +
      "are for what would otherwise be lost: a file you wrote, built or " +
      "edited, or one the person asked you to keep. Do not save a copy of a " +
      "file that is already there (yours or theirs), and do not save a " +
      "picture you fetched from the web -- its own address still has it, and " +
      "the thread already shows it. Saving the same name again updates that " +
      "artifact in place, which is right when the file changed and wrong " +
      "when it did not.",
  );
  lines.push(
    "- Notebooks: always available. Tool: notebook (and notebook= on artifact_save " +
      "and browser_screenshot). A notebook is the person's folder for one purpose, " +
      "on their Notebooks page. When asked to compile, assemble or build a case, " +
      "report or dossier from several sources -- emails, documents, pages -- work in " +
      "a notebook: file every source, annotated with what it shows; write each " +
      "finding, rebuttal or answer as a note that cites the files it rests on; " +
      "quote the exact words you rely on. Go through every source, not a sample. " +
      "Before you say it is done, read the notebook back and check each source is " +
      "filed and each claim cites one, then say what is in it.",
  );
  lines.push(windows.pdf.enabled
    ? "- PDFs: always available. Tools: pdf_read, pdf_look, pdf_edit, pdf_compose, " +
      "pdf_pages, pdf_redact, pdf_replace_text, pdf_compress. To write a report or any document as a PDF, " +
      "use pdf_compose (headings, paragraphs, tables, sources; it lays out the pages and keeps " +
      "the document so you can update a section when research turns up something new, " +
      "rather than starting again). For any PDF -- one the person uploaded, one on " +
      "this host, one you made -- use these rather than the terminal: read it " +
      "(text, form fields, attachments, XFA), look at its pages, fill in its form, " +
      "sign, stamp, mark it up, watermark it, number its pages, rearrange, merge or " +
      "split it, redact it for good, and shrink it. Each change is saved as a new " +
      "artifact the person opens from the thread; their original is never changed. " +
      "Look at what you changed with pdf_look before saying it is done."
    : offLine("The PDF editor"));
  lines.push(windows.widgets.enabled
    ? "- Explainer widgets: always available. Tool: widget_show. When someone " +
      "asks how something works -- a physical process, a mechanism, an " +
      "algorithm, a piece of maths -- and seeing it move would help, build a " +
      "small interactive widget (2D canvas/SVG, or 3D with Three.js) and explain " +
      "in text alongside it. Not for plain facts, lists or anything a sentence answers."
    : offLine("The widget window"));
  if (!windows.office.enabled) lines.push(offLine("The Office tools (Word, Excel and PowerPoint)"));
  lines.push(
    "- Your voice: always available. Tool: speak. It plays words aloud on the " +
      "person's page at once, in the voice chosen under Settings -> Voice. When you " +
      "are asked to say or read something out loud, call speak -- do not make an " +
      "audio file, call Deepgram yourself, or present a recording. With " +
      "live voice on, your replies are already read aloud; do not repeat them with speak.",
  );
  lines.push(
    "- Work that happens later: always available. Tools: schedule, schedules, " +
      "unschedule. A scheduled job is a task and a cron time, run as a turn of " +
      "its own in a new session; a watcher looks at a page, a file or a " +
      "command and runs its task only when what it sees changed. Set one " +
      "whenever the thing you were asked for is not due yet, or has to be " +
      "checked again -- instead of a sleep, a poll, or saying you cannot. " +
      "Nothing runs while the machine is off. Say in your answer that you " +
      "set it, and what it will do.",
  );
  lines.push(
    "- Work that outlives the turn: always available. Tools: run_background, " +
      "background_jobs, background_output, background_stop. A background " +
      "command is the same shell as the terminal, detached, so it keeps going " +
      "after the turn ends: use it for a build, a long test run, a download, " +
      "anything slower than the terminal's time limit. Never sleep or poll " +
      "for one in the same turn; read it next turn, or use schedule.",
  );
  lines.push(
    "- The machine you are on: always available. Tool: inventory. What is " +
      "installed, what is not, the shell, the working directory and the disk, " +
      "looked at now. The first turn of a session is given this by itself; " +
      "look again after installing something or a restart, rather than " +
      "guessing or trusting a memory about it that may have moved on.",
  );
  lines.push(
    "- Standing agreements: always available. Tools: pre_authorise, " +
      "pre_authorisations. The console holds a call that looks destructive and " +
      "unasked-for; when the person lets one through, that class of work is " +
      "remembered so it is not put to them again. pre_authorise adds one " +
      "yourself for harmless work you keep being held on, and says why -- they " +
      "read the list. Nothing irrecoverable can ever be covered by one.",
  );
  lines.push(
    "- Asking the person: always available. Tool: ask_user. When you are " +
      "genuinely stuck on something only they can settle, ask with a short " +
      "question and a few concrete options rather than guessing or stopping " +
      "with a question in prose. Sign-ins go through browser_handoff instead.",
  );

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
        "pages -- streamed live into the conversation, so the person watches every " +
        "page load, pointer move and keystroke as you make it -- and the desktop " +
        "belongs to a real person who is watching. Take " +
        "the actions you are asked for rather than describing what you would do, " +
        "and read the result of each one before the next.",
    );
  }

  return lines.join("\n");
}

/** How long a passed CAPTCHA must stay passed before the turn carries on:
    two looks, so a checkbox that flickers ticked on its way to a picture
    challenge does not hand the page back mid-puzzle. */
const CAPTCHA_STEADY_POLLS = 2;

/**
 * A watch for a handoff that is about a CAPTCHA: settles it as soon as the
 * page shows the check passed, so the person solves the puzzle and the agent
 * simply carries on -- nobody has to come back and say "done".
 *
 * Only armed when there is a CAPTCHA to watch: on the page now, or named in
 * the reason (a Cloudflare page can take a moment to draw its widget). A
 * sign-in has no such signal and still waits for the person to say so.
 */
export async function captchaWatch(
  live: { captchaStatus(): Promise<{ present: boolean; passed: boolean; url: string | null }> },
  reason: string,
): Promise<(() => Promise<string | null>) | undefined> {
  const first = await live.captchaStatus().catch(() => null);
  if (!first) return undefined;
  const named = /captcha|recaptcha|hcaptcha|turnstile|cloudflare|verif|robot|human/i.test(reason);
  if (first.passed || (!first.present && !named)) return undefined;

  let seen = first.present;
  let steady = 0;
  return async () => {
    const now = await live.captchaStatus().catch(() => null);
    if (!now) return null;
    if (now.present) seen = true;
    // Passed on the page, or gone from it after being there (a Cloudflare
    // interstitial lets you through by leaving).
    const through = now.passed || (seen && !now.present);
    steady = through ? steady + 1 : 0;
    if (steady < CAPTCHA_STEADY_POLLS) return null;
    return now.passed ? "CAPTCHA passed — carrying on" : "Verification cleared — carrying on";
  };
}

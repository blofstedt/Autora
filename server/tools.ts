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

import { callMcpTool, mcpTools } from "./mcp";
import {
  PREFIX as CUSTOM_PREFIX, customEnv, defineCustomTool, deleteCustomTool, getCustomTool,
  listCustomTools, missingArgs, noteCustomRun,
} from "./customtools";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { GoogleGenAI } from "@google/genai";
import { mergeTools, save, state, allSecrets, secretFor, redactSecrets as redactStored } from "./state";
import { credentialsBriefing, fillPlaceholders, hasPlaceholder, identityEnv, redactCredentials } from "./credentials";
import { htmlToText, textParts } from "./pages";
import { describeCaptchas, probeBrowser, VIEWPORT, type LiveBrowser, type PageRead, type UploadFile } from "./browser";
import { parseCookieExport, sitesOf } from "./cookies";
import { recordSignIn, signInBriefing } from "./signins";
import { relayAction, relayConnected, relayStatus } from "./desktop";
import { CONTEXT_CONFIG, readVault } from "./context";
import {
  artifactPath, deleteArtifact, formatSize, getArtifact, isText, listArtifacts, readArtifact,
  saveArtifact, MAX_ARTIFACT_BYTES,
} from "./artifacts";
import {
  MAX_WIDGET_CHARS, WIDGET_DEFAULT_HEIGHT, WIDGET_MAX_HEIGHT, WIDGET_MIN_HEIGHT, widgetDocument,
} from "../src/lib/widget";

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

/** A question for the person, drawn as a card in the thread. */
export type AskRequest = {
  /** "browser" is a sign-in or similar handed over in the live page. */
  kind: "question" | "browser";
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
          type: "array",
          description: "The arguments it takes.",
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
      "Put a picture of the open page on the browser screen, for the person to " +
      "look at. Use this when asked what something looks like -- the page text " +
      "you already have cannot answer that. You do not get the image back; it " +
      "goes to the person watching.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_captcha",
    group: "browser",
    description:
      "Tick a checkbox CAPTCHA on the open page -- reCAPTCHA's \"I'm not a robot\", " +
      "hCaptcha, or Cloudflare Turnstile -- using humanlike mouse movement (curved path, " +
      "varying speed, off-centre landing, natural press timing). These checkboxes sit in " +
      "iframes and never appear in the numbered outline, so use this instead of " +
      "browser_click. Reports whether it passed, is still thinking, or escalated to a " +
      "picture challenge (hand that one to the person with browser_handoff).",
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
      "GITHUB_TOKEN from the workspace secret store so you never need to ask the user for passwords.",
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
      "Take a picture of the relayed desktop and put it on the desktop screen " +
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
      "styled to match. It is also saved as an artifact.",
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
      "terminal). Images from image_generate are saved automatically.",
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
      "length for long ones); images are shown in the conversation; anything " +
      "else is reported with the path on this host, so the terminal can open it.",
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
          description:
            "What sort of thing this is. Default fact. A procedure is how to do " +
            "something here that worked -- the steps, commands and gotchas.",
        },
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
        kind: { type: "string", enum: ["fact", "preference", "procedure", "skill"] },
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
  return [
    ...TOOLS.filter((t) =>
      t.group === "person" || t.group === "files" || usable.has(t.group as ToolGroup)),
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
    case "tool_create":
      return `save tool ${CUSTOM_PREFIX}${String(args.name ?? "").replace(CUSTOM_PREFIX, "")}:\n${args.script}`;
    case "memory_update":
      return `update memory ${args.id}`;
    case "memory_forget":
      return `forget memory ${args.id}${args.replaced_by ? ` (replaced by ${args.replaced_by})` : ""}`;
    case "vault_read":
      return args.search
        ? `search vault artifact ${args.id} for "${args.search}"`
        : `read vault artifact ${args.id}`;
    case "browser_captcha":
      return "tick the checkbox CAPTCHA on the open page";
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
      return `save artifact ${args.name}`;
    case "widget_show":
      return `show widget "${args.title}"`;
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
export interface ToolContext {
  /** A line of live output, as it arrives. */
  onOutput: (chunk: string) => void;
  /** Stash a picture and return its blob id. */
  putBlob: (data: Buffer, mime: string) => string;
  /** Show a picture in the conversation. */
  showImage: (blob: string, alt: string, caption: string | null, size?: { w: number; h: number }) => void;
  /** Show an interactive widget in the conversation. */
  showWidget: (widget: { title: string; html: string; height: number }) => void;
  /** Show a picture of the browser or desktop in the card already showing
      that screen, rather than as a card of its own beside it. */
  showScreen: (source: "browser" | "desktop", blob: string, size?: { w: number; h: number }) => void;
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
    write: (entry: { title: string; body: string; kind: string; tags?: string[] }) => { id: string; action: string };
    search: (query: string) => { id: string; kind: string; title: string; body: string; status: string }[];
    update: (id: string, patch: { title?: string; body?: string; kind?: string; tags?: string[] }) => boolean;
    forget: (id: string, replacedBy?: string | null) => boolean;
  };
  /** A tool output this session kept out of the prompt, by artifact id. */
  vault: (id: string) => string | null;
  /** The session the call runs in, so what it makes can say where from. */
  session: string;
  /** Put a question to the person and wait for the answer. */
  ask: (request: AskRequest) => Promise<AskAnswer>;
}

export interface ToolOutcome {
  ok: boolean;
  /** What the model is told came back. */
  summary: string;
  /** For the transcript card, where it differs from the summary. */
  preview?: string;
  exitCode?: number;
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
    ...(page.blocked ? ["", refusalNote(page.blocked)] : []),
    "",
    head,
    parts[k - 1] || "(no text)",
  ].join("\n");
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

/**
 * A command run with nobody watching: for a watcher checking a command's
 * output. Same shell, secrets and working directory as the terminal tool.
 */
export async function runShellQuiet(command: string, timeoutSeconds = 60): Promise<{ ok: boolean; output: string }> {
  const quiet: Pick<ToolContext, "onOutput" | "onCancel"> = { onOutput: () => undefined, onCancel: () => undefined };
  const outcome = await runCommand(command, toolSettings().terminal.cwd, timeoutSeconds, quiet as ToolContext);
  return { ok: outcome.ok, output: outcome.summary };
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
    const raw = await res.text();
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
    summary += text.length > cap
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
    return { ok: false, summary: `HTTP request failed: ${redactSecrets(err?.message ?? err)}` };
  }
}

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
        const part = Number(args.part ?? 1);
        return {
          ok: true,
          summary: describePage(page, part),
          preview: part > 1 ? `${page.url} · part ${part}` : page.url,
        };
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
        const png = await live.capture();
        const blob = ctx.putBlob(png, "image/png");
        const status = live.status();
        ctx.showScreen("browser", blob, { w: VIEWPORT.width, h: VIEWPORT.height });
        return {
          ok: true,
          summary:
            "The picture is now on the browser screen, where the person can see " +
            "it. You cannot see it yourself -- describe the page from its text " +
            "if you need to say what is on it.",
          preview: status.url ?? "screenshot",
        };
      }

      case "browser_captcha": {
        const { outcome, kind, page } = await ctx.browser().solveCaptcha();
        ctx.browserChanged();
        const said: Record<typeof outcome, string> = {
          none: "There is no checkbox CAPTCHA on this page.",
          solved: `The ${kind ?? "CAPTCHA"} checkbox is ticked; the check passed.`,
          pending:
            `Clicked the ${kind ?? "CAPTCHA"} checkbox, but it has not confirmed yet. ` +
            "Re-read the page in a moment; if it is still unticked, try browser_captcha once more.",
          challenge:
            `The ${kind ?? "CAPTCHA"} checkbox escalated to a picture challenge. ` +
            "Hand the browser to the person with browser_handoff to solve it.",
        };
        return {
          ok: outcome === "solved" || outcome === "none",
          summary: `${said[outcome]}\n\n${describePage(page)}`,
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
        ctx.showScreen("desktop", blob, w && h ? { w, h } : undefined);
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
        ctx.showWidget({ title, html, height });

        // A copy that opens on its own, Three.js and all, from the Artifacts page.
        let saved = "";
        try {
          const art = saveArtifact({
            origin: "agent", name: `${slug(title)}.html`,
            data: Buffer.from(widgetDocument({ title, html }), "utf8"),
            mime: "text/html", session: ctx.session, note: `Interactive widget: ${title}`,
          });
          saved = ` Saved as artifact ${art.id}.`;
        } catch {
          // The widget is still in the thread; losing the copy is not a failure.
        }
        return {
          ok: true,
          summary:
            `The widget "${title}" is now shown in the conversation, running in the person's browser.${saved} ` +
            "You cannot see it yourself. If it throws an error, the card says so to the person; " +
            "when they report a problem, fix it and call widget_show again with the whole corrected widget.",
          preview: title,
        };
      }

      // ------------------------------------------------------ artifacts --
      case "artifact_save": {
        const name = String(args.name ?? "").trim();
        if (!name) return { ok: false, summary: "An artifact needs a file name." };
        const from = String(args.path ?? "").trim();
        let data: Buffer;
        if (from) {
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
        const art = saveArtifact({
          origin: "agent", name, data, session: ctx.session,
          note: String(args.note ?? "").trim() || undefined,
        });
        return {
          ok: true,
          summary: `Saved as artifact ${art.id} (${art.name}, ${formatSize(art.size)}). The person can open and download it from the Artifacts page.`,
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

      // --------------------------------------------------------- memory --
      case "memory_write": {
        const title = String(args.title ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!title || !body) {
          return { ok: false, summary: "A memory needs both a title and a body." };
        }
        const kinds = new Set(["fact", "preference", "procedure", "skill"]);
        const kind = kinds.has(String(args.kind)) ? String(args.kind) : "fact";
        const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
        const { id, action } = ctx.memory.write({ title, body, kind, tags });
        return {
          ok: true,
          summary: action === "merged"
            ? `That was close to ${id}, so ${id} was updated rather than a copy added: "${title}".`
            : `Written down as ${id}: "${title}".`,
          preview: title,
        };
      }

      case "memory_update": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No memory id was given." };
        const patch = {
          title: typeof args.title === "string" ? args.title : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
          kind: typeof args.kind === "string" ? args.kind : undefined,
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        };
        if (!ctx.memory.update(id, patch)) {
          return { ok: false, summary: `There is no memory ${id}. memory_search shows the ids.` };
        }
        return { ok: true, summary: `Updated ${id}.`, preview: id };
      }

      case "memory_forget": {
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
            .map((m) => `- ${m.id} [${m.kind}${m.status === "provisional" ? ", unconfirmed" : ""}] ${m.title}: ${m.body}`)
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
          const { tool, replaced } = defineCustomTool({
            name: args.name, description: args.description, params: args.parameters,
            script: args.script, session: ctx.session,
          });
          return {
            ok: true,
            summary:
              `${replaced ? "Replaced" : "Saved"} ${CUSTOM_PREFIX}${tool.name}. It is offered from the ` +
              "next step on, like any other tool. Try it once now to make sure it works.",
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
          const outcome = await runCommand(custom.script, settings.cwd, settings.timeout, ctx, customEnv(custom, args));
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

  const mcp = mcpTools();
  if (mcp.length > 0) {
    lines.push(
      `- MCP servers: ${mcp.length} tool${mcp.length === 1 ? "" : "s"} from connected servers, ` +
        "named mcp__<server>__<tool>. Use them like any other tool.",
    );
  }
  lines.push(
    "- Artifacts: always available. Tools: artifact_list, artifact_read, " +
      "artifact_save. Files the person uploaded (documents, photos...) are " +
      "there for you to read; save the deliverables you make with " +
      "artifact_save so they can be found and downloaded later.",
  );
  lines.push(
    "- Explainer widgets: always available. Tool: widget_show. When someone " +
      "asks how something works -- a physical process, a mechanism, an " +
      "algorithm, a piece of maths -- and seeing it move would help, build a " +
      "small interactive widget (2D canvas/SVG, or 3D with Three.js) and explain " +
      "in text alongside it. Not for plain facts, lists or anything a sentence answers.",
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

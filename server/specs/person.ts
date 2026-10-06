/**
 * The asking the person, and what they hand over tools.
 *
 * These were entries in one 81-entry array in server/tools.ts. Nothing about
 * them changed in the move -- each is the same spec, in the same order, and the
 * registry below lists them in the order they were listed before.
 */

import type { ToolSpec } from "../tools";
import { WIDGET_DEFAULT_HEIGHT, WIDGET_MAX_HEIGHT, WIDGET_MIN_HEIGHT } from "../../src/lib/widget";

export const personSPECS: ToolSpec[] = [
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
];

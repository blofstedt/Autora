/**
 * The tools that are programs in their own right: a repository, a data
 * kernel, a library of what the person owns, media, and the browser's
 * developer tools and recorded flows.
 *
 * Each has its own module (gittool, pykernel, library, media, flows, and the
 * network log in browser.ts); this file is only the registry entries -- what
 * the model is told -- and the glue to the turn (where a tool runs, how its
 * pictures and files are shown). Kept out of tools.ts so that file does not
 * grow by a screen for every tool.
 */

import type { ToolContext, ToolOutcome, ToolSpec } from "./tools";
import { runGit, GIT_ACTIONS } from "./gittool";
import { runPython } from "./pykernel";
import { runLibrary } from "./library";
import { runMedia } from "./media";
import {
  cancelRecording, deleteFlow, describeFlow, getFlow, listFlows, noteRun, parametrize, recordExpect, recordStep,
  recordingOf, runFlow, startRecording, stopRecording, validName, type Step,
} from "./flows";
import { networkReport } from "./appcheck";
import { keyFor, secretFor } from "./state";
import { withPdf } from "./pdfrender";
import type { ChatImage } from "./llm";

// ------------------------------------------------------------ the entries --

export const EXTRA_TOOLS: ToolSpec[] = [
  {
    name: "git",
    group: "terminal",
    description:
      "A git repository, worked with as structured actions instead of command text. Reading: status (branch, " +
      "ahead/behind, staged / changed / untracked / conflicted files), diff (stat then patch; staged, from/to " +
      "refs, paths, stat_only), log (limit, ref, paths, search), show (a commit), blame (path, start, end), " +
      "branches, stashes, remotes. Changing: add, commit (message; paths, or all to take every tracked change; " +
      "amend), switch (branch; create), branch (create or delete a merged one), restore (paths: unstages; discard " +
      "to throw away the working copy), stash (push or mode pop), merge. fetch, pull (fast-forward only) and push " +
      "talk to a remote. There is no force push, hard reset, clean or rebase here: they destroy work, so ask the " +
      "person. The repository is found from the terminal's folder (or repo). Use it instead of typing git into " +
      "the terminal: the answers are shorter and cannot be misread.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: `One of: ${GIT_ACTIONS.join(", ")}.` },
        repo: { type: "string", description: "A folder in the repository, if not the terminal's." },
        paths: { type: "array", items: { type: "string" }, description: "Files, for diff, log, show, add, commit, restore." },
        path: { type: "string", description: "One file: blame, or a single path for the others." },
        message: { type: "string", description: "commit: what changed and why." },
        all: { type: "boolean", description: "commit: take every tracked change." },
        amend: { type: "boolean", description: "commit: fold into the last commit (never after a push)." },
        branch: { type: "string", description: "switch, branch, merge, pull, push: the branch." },
        ref: { type: "string", description: "log, show, blame: a commit, tag or branch." },
        from: { type: "string", description: "diff: the older ref (with to); switch/branch with create: where it starts." },
        to: { type: "string", description: "diff: the newer ref." },
        staged: { type: "boolean", description: "diff: what is staged." },
        stat_only: { type: "boolean", description: "diff: only the summary." },
        create: { type: "boolean", description: "switch: make the branch." },
        delete: { type: "boolean", description: "branch: remove it (only if merged)." },
        discard: { type: "boolean", description: "restore: throw away the working copy instead of unstaging." },
        mode: { type: "string", description: "stash: push (default) or pop." },
        untracked: { type: "boolean", description: "stash: include untracked files." },
        limit: { type: "number", description: "log: how many (default 15, at most 100)." },
        search: { type: "string", description: "log: only commits whose message has this." },
        start: { type: "number", description: "blame: first line." },
        end: { type: "number", description: "blame: last line." },
        remote: { type: "string", description: "fetch, pull, push: the remote." },
        set_upstream: { type: "boolean", description: "push: set the upstream." },
      },
      required: ["action"],
    },
    risky: true,
  },

  {
    name: "python",
    group: "terminal",
    description:
      "A Python kernel that remembers, for analysing data the way a notebook does. Every run executes in the " +
      "same namespace for this chat: load a file in one call, look at it in the next, clean it, plot it -- " +
      "variables, imports and open data stay. The value of the last expression comes back as it would in a " +
      "notebook (a DataFrame as its first rows and its shape), what the code printed comes back, an error " +
      "comes back as the traceback and the kernel carries on, and every matplotlib figure that was open is " +
      "returned as a picture. Relative paths are from the terminal's folder; write results to files there " +
      "and hand them over with artifact_save. action vars lists what is defined (names, types, shapes); " +
      "reset starts over. A run past its timeout (default 120 s, at most 600) kills the kernel and the " +
      "namespace is lost, so do slow work in steps. Use the terminal for shell commands and other languages; " +
      "use this for exploring and transforming data. pandas, numpy and matplotlib are used if installed.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "run (default), vars or reset." },
        code: { type: "string", description: "run: the Python to execute." },
        timeout: { type: "number", description: "run: seconds before it is stopped (5 to 600, default 120)." },
      },
    },
    risky: true,
  },

  {
    name: "library",
    group: "files",
    description:
      "The person's own knowledge: PDFs, notes, manuals, contracts and web pages they have given you, searchable " +
      "with the place each answer came from. add puts sources in (path: a file or a whole folder, glob to narrow " +
      "a folder; artifact: an uploaded file's id; url: a web page; tags). search ranks the passages most about a " +
      "question -- plain code, no guessing -- and returns each as a citation like [lease.pdf, p.7] with its best " +
      "lines; quote the citation when you answer from it, and if nothing matches say so rather than answering from " +
      "memory. read gives a whole passage by source and loc. list shows what is there; remove forgets a source " +
      "(never the original file). Use it for questions about the person's documents; memory_search is for what " +
      "you have learned. A scanned PDF with no text needs media ocr first.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "add, search, read, list or remove." },
        query: { type: "string", description: "search: the question, in words." },
        path: { type: "string", description: "add: a file or folder, from the terminal's folder." },
        glob: { type: "string", description: "add, for a folder: only files matching, e.g. \"*.pdf\"." },
        artifact: { type: "string", description: "add: an artifact id." },
        url: { type: "string", description: "add: a web page address." },
        tags: { type: "array", items: { type: "string" }, description: "add: labels, to search or list by." },
        tag: { type: "string", description: "search, list: only sources with this tag." },
        source: { type: "string", description: "search, read, remove: a source's id or name." },
        loc: { type: "string", description: "read: the place, e.g. p.3 or lines 40-79." },
        max: { type: "number", description: "search: how many passages (default 6, at most 20)." },
      },
      required: ["action"],
    },
  },

  {
    name: "media",
    group: "files",
    description:
      "Audio, video and images. info says what is in a file (length, streams, size). frames takes pictures from a " +
      "video (count spread across it, or at times like \"0:30\"), returned for you to look at. transcribe turns " +
      "speech in audio or video into text with timestamps (start and end to do a part; language; needs a Deepgram " +
      "or OpenAI key in Settings) and saves the transcript. ocr reads the text in an image or scanned PDF page " +
      "(pages like \"1-3\"); without OCR installed it hands you the picture to read by eye and says so. audio " +
      "pulls the sound out as a file; trim cuts a start/end; convert changes format (mp4, webm, mp3, wav, gif, " +
      "png, jpg, webp...) and can resize (width, height), crop, rotate and set fps. Files are an artifact id, a " +
      "path, or an artifact's name; results are saved as artifacts and shown.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "info, frames, transcribe, ocr, audio, trim or convert." },
        file: { type: "string", description: "The file: an artifact id, a path, or an artifact's name." },
        count: { type: "number", description: "frames: how many, spread across the video (default 6, at most 12)." },
        at: { type: "array", items: { type: ["number", "string"] }, description: "frames: times, in seconds or m:ss." },
        width: { type: "number", description: "frames, convert: width in pixels." },
        height: { type: "number", description: "convert: height in pixels." },
        start: { type: ["number", "string"], description: "trim, transcribe: where to start, in seconds or m:ss." },
        end: { type: ["number", "string"], description: "trim, transcribe: where to stop." },
        language: { type: "string", description: "transcribe: a language code like en; ocr: a Tesseract code like eng." },
        pages: { type: "string", description: "ocr, for a PDF: pages like 1, 1-3 or 2,4 (at most 10)." },
        layout: { type: "string", description: "ocr: single for one block of text." },
        format: { type: "string", description: "convert, trim, audio: the output format." },
        crop: { type: "object", description: "convert: {x, y, width, height} in pixels.", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } } },
        rotate: { type: "number", description: "convert: 90, 180 or 270." },
        fps: { type: "number", description: "convert: frames per second." },
        output: { type: "string", description: "The result's file name." },
      },
      required: ["action", "file"],
    },
  },

  {
    name: "browser_network",
    group: "browser",
    description:
      "The browser's Network tab: what the open page asked for and what came back, since it loaded. report (the " +
      "default) summarises -- what failed, what was slow or huge, and the API calls the page makes; list shows " +
      "requests (filter by url text, method, type like xhr,fetch,document, status, or failed); body reads one " +
      "response by its #id, JSON laid out. Use it to find the API a page gets its data from and call that " +
      "directly with http_request instead of clicking through pages, and to see why a form did nothing. " +
      "Passwords, cookies and tokens in headers and addresses are blanked. clear forgets what was recorded.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "report (default), list, body or clear." },
        url: { type: "string", description: "Only requests whose address has this text." },
        method: { type: "string", description: "Only this method, e.g. POST." },
        type: { type: "string", description: "Only these kinds, comma-separated: document, xhr, fetch, script, stylesheet, image, font." },
        failed: { type: "boolean", description: "Only requests that failed or came back 4xx/5xx." },
        id: { type: "number", description: "body: the request's #id from list." },
        limit: { type: "number", description: "list: the most recent N (default 40)." },
      },
    },
  },

  {
    name: "browser_flow",
    group: "browser",
    description:
      "Record a browser job once and run it again by name, with no model in the loop. A job you will do more than " +
      "once -- download the monthly statement, check an order, file a report -- is recorded: record starts " +
      "(name, description), then do the job with the usual browser tools, and every open, click, fill, key " +
      "press, scroll and back is kept, each element by what it is (its role and name) rather than its number. " +
      "expect adds a check (words the page must show, or part of the address) so a flow that has drifted fails " +
      "loudly; param turns a literal you typed (a month, an order number) into a named parameter (name, value); " +
      "save finishes it. Text typed into a password field is never kept: it becomes a parameter the run is given. " +
      "run (name, params) replays it and returns the final page; a step that cannot find its element stops and " +
      "says what it found instead. list, show and delete manage them. To do it on a schedule, schedule a job " +
      "whose prompt says to run the flow.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "record, expect, param, save, cancel, run, list, show or delete." },
        name: { type: "string", description: "The flow's name (record, run, show, delete), or the parameter's (param)." },
        description: { type: "string", description: "record: what it does." },
        text: { type: "string", description: "expect: words the page must show." },
        url: { type: "string", description: "expect: part of the address the page must have." },
        value: { type: "string", description: "param: the exact text, as typed or in an address, to turn into the parameter." },
        flow: { type: "string", description: "param: not used; name is the parameter's name." },
        params: { type: "object", additionalProperties: true, description: "run: values for the flow's parameters." },
      },
      required: ["action"],
    },
    risky: true,
  },
];

// -------------------------------------------------------------- recording --

const pictureOf = (data: Buffer, mime: string): ChatImage | null =>
  data.byteLength <= 3_500_000 ? { mime, data: data.toString("base64") } : null;

/**
 * When a flow is being recorded, the browser tools the agent uses are kept as
 * steps. What identifies an element has to be read before the action (the
 * action changes the page), so this returns a function to call with the
 * outcome, or null when there is nothing to record.
 */
export function watchBrowserCall(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
  isSecret: (text: string) => boolean,
): ((outcome: ToolOutcome) => void) | null {
  if (!name.startsWith("browser_") || name === "browser_flow" || name === "browser_network") return null;
  if (!recordingOf(ctx.session)) return null;
  let step: Step | null = null;
  const live = () => ctx.browser();
  switch (name) {
    case "browser_open": {
      const url = String(args.url ?? "").trim();
      if (url) step = { type: "open", url };
      break;
    }
    case "browser_click": {
      const info = live().refInfo(Number(args.ref));
      if (info) step = { type: "click", target: info };
      break;
    }
    case "browser_fill": {
      const rows = (Array.isArray(args.values) ? args.values : []) as { ref: unknown; text: unknown }[];
      const fields = rows.flatMap((v) => {
        const info = live().refInfo(Number(v?.ref));
        return info ? [{ target: info, text: String(v?.text ?? "") }] : [];
      });
      if (fields.length) step = { type: "fill", fields, submit: Boolean(args.submit) };
      break;
    }
    case "browser_press": {
      const keys = (Array.isArray(args.keys) ? args.keys : [args.keys]).map((k: unknown) => String(k ?? "")).filter(Boolean);
      const ref = args.ref !== null && args.ref !== undefined && Number.isFinite(Number(args.ref)) ? Number(args.ref) : null;
      if (keys.length) step = { type: "press", keys, target: ref === null ? null : live().refInfo(ref) };
      break;
    }
    case "browser_scroll": {
      const how: Record<string, unknown> = {};
      if (args.to === "top" || args.to === "bottom") how.to = args.to;
      if (typeof args.text === "string" && args.text.trim()) how.text = args.text.trim();
      if (Number.isFinite(Number(args.screens)) && Number(args.screens)) how.screens = Number(args.screens);
      else if (Number.isFinite(Number(args.dy)) && Number(args.dy)) how.dy = Number(args.dy);
      else if (!how.to && !how.text) how.screens = 1;
      step = { type: "scroll", how };
      break;
    }
    case "browser_back":
      step = { type: "back" };
      break;
    default:
      return null;
  }
  if (!step) return null;
  const made = step;
  return (outcome) => {
    if (!outcome.ok || /held back/i.test(outcome.preview ?? "")) return;
    recordStep(ctx.session, made, { isSecret });
  };
}

// ---------------------------------------------------------------- running --

export interface ExtraEnv {
  terminalDir: string;
  describePage: (page: any, part?: number) => string;
  resolvePlaceholders: (text: string, pageUrl: string) => string;
}

/** PDF pages as pictures, for OCR of a scan. */
async function pdfPages(data: Buffer, pages: number[], scale: number): Promise<{ page: number; png: Buffer }[]> {
  return withPdf(data, undefined, async (view) => {
    const out: { page: number; png: Buffer }[] = [];
    for (const n of pages) {
      if (n < 1 || n > view.pages) continue;
      const pic = await view.render(n, { scale, type: "image/png" });
      out.push({ page: n, png: pic.data });
    }
    return out;
  });
}

const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** A web page's bytes for the library, named by where it is. */
async function fetchPage(url: string): Promise<{ name: string; data: Buffer }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0 (compatible; Autora)", accept: "text/html,text/plain,application/pdf,*/*" } });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > MAX_PAGE_BYTES) throw new Error("that page is over 5 MB");
  const u = new URL(url);
  const type = res.headers.get("content-type") ?? "";
  const base = `${u.hostname}${u.pathname === "/" ? "" : u.pathname.replace(/\/+/g, "-")}`.replace(/[^\w.-]+/g, "-").slice(0, 80);
  const ext = /pdf/.test(type) || data.subarray(0, 8).includes("%PDF") ? ".pdf" : /html/.test(type) ? ".html" : ".txt";
  return { name: /\.(pdf|html?|txt|md)$/i.test(base) ? base : `${base}${ext}`, data };
}

const speechKeys = () => ({ deepgram: secretFor("DEEPGRAM_API_KEY"), openai: keyFor("openai") });

export async function runExtra(name: string, args: Record<string, any>, ctx: ToolContext, env: ExtraEnv): Promise<ToolOutcome> {
  switch (name) {
    case "git": {
      const r = await runGit({ cwd: env.terminalDir, args });
      return { ok: r.ok, summary: r.summary, preview: r.preview ?? (r.ok ? `git ${String(args.action ?? "")}` : "git failed") };
    }

    case "python": {
      const r = await runPython({ session: ctx.session, cwd: env.terminalDir, args, onCancel: ctx.onCancel });
      const images: ChatImage[] = [];
      for (const fig of r.figures) {
        const blob = ctx.putBlob(fig.png, "image/png");
        ctx.showImage(blob, fig.name, "Figure", undefined);
        const p = pictureOf(fig.png, "image/png");
        if (p) images.push(p);
      }
      return { ok: r.ok, summary: r.summary, preview: r.preview, ...(images.length ? { images } : {}) };
    }

    case "library": {
      const r = await runLibrary({ cwd: env.terminalDir, args, protect: ctx.protectedPaths ?? [], fetchPage });
      return { ok: r.ok, summary: r.summary, preview: r.preview ?? (r.ok ? "library" : "not done") };
    }

    case "media": {
      const r = await runMedia({
        cwd: env.terminalDir, session: ctx.session, args, keys: speechKeys(),
        onCancel: ctx.onCancel, cancelled: ctx.cancelled, pdfPages,
      });
      for (const f of r.files) ctx.showFile?.(f);
      const images: ChatImage[] = [];
      for (const img of r.images) {
        const blob = ctx.putBlob(img.data, img.mime);
        ctx.showImage(blob, img.name, null, undefined);
        const p = pictureOf(img.data, img.mime);
        if (p) images.push(p);
      }
      return { ok: r.ok, summary: r.summary, preview: r.preview, ...(images.length ? { images } : {}) };
    }

    case "browser_network": {
      const live = ctx.browser();
      const action = String(args.action ?? "report").trim().toLowerCase();
      if (action === "clear") {
        live.clearNetwork();
        return { ok: true, summary: "The network log is cleared; what loads from now on is recorded.", preview: "cleared" };
      }
      if (action === "body") {
        const id = Number(args.id);
        if (!Number.isFinite(id)) return { ok: false, summary: "body needs the request's id (the # number from list)." };
        const r = await live.networkBody(id);
        return { ok: r.ok, summary: r.text, preview: r.ok ? `body of #${id}` : "no body" };
      }
      if (action !== "report" && action !== "list") return { ok: false, summary: "action is report, list, body or clear." };
      const rows = live.networkLog({
        url: typeof args.url === "string" ? args.url : undefined,
        method: typeof args.method === "string" ? args.method : undefined,
        type: typeof args.type === "string" ? args.type : undefined,
        failed: args.failed === true,
        limit: action === "list" ? Math.min(200, Math.max(1, Number(args.limit) || 40)) : undefined,
      });
      return {
        ok: true,
        summary: action === "list"
          ? rows.length ? rows.map((r) => `#${r.id} ${r.method} ${r.type} ${r.url.slice(0, 140)} -> ${r.failed ?? r.status ?? "pending"}${r.ms !== null ? ` ${r.ms} ms` : ""}${r.size ? ` ${r.size} B` : ""}`).join("\n") : "No requests match."
          : networkReport(rows),
        preview: `${rows.length} requests`,
      };
    }

    case "browser_flow":
      return browserFlow(args, ctx, env);

    default:
      return { ok: false, summary: `${name} is not one of the extra tools.` };
  }
}

async function browserFlow(args: Record<string, any>, ctx: ToolContext, env: ExtraEnv): Promise<ToolOutcome> {
  const action = String(args.action ?? "").trim().toLowerCase();
  const flowName = String(args.name ?? "").trim().toLowerCase();
  switch (action) {
    case "record": {
      const problem = startRecording(ctx.session, flowName, String(args.description ?? ""));
      if (problem) return { ok: false, summary: problem };
      return {
        ok: true,
        summary: `Recording ${flowName}. Do the job now with the browser tools; each step is kept. Add expect checks as you go (what the page should show when it worked), turn typed values you want to vary into parameters with param, then save.`,
        preview: `recording ${flowName}`,
      };
    }
    case "expect": {
      const problem = recordExpect(ctx.session, { text: typeof args.text === "string" ? args.text.trim() : undefined, url: typeof args.url === "string" ? args.url.trim() : undefined });
      return problem ? { ok: false, summary: problem } : { ok: true, summary: "Check added to the recording.", preview: "check added" };
    }
    case "param": {
      const r = parametrize(ctx.session, String(args.name ?? "").trim(), String(args.value ?? ""));
      return { ok: r.ok, summary: r.message, preview: r.ok ? "parameter added" : undefined };
    }
    case "cancel":
      return { ok: true, summary: cancelRecording(ctx.session) ? "The recording was thrown away." : "No flow was being recorded." };
    case "save": {
      const r = stopRecording(ctx.session);
      return { ok: Boolean(r.flow), summary: r.flow ? `${r.message}\n\n${describeFlow(r.flow)}` : r.message, preview: r.flow ? `saved ${r.flow.name}` : undefined };
    }
    case "list": {
      const flows = listFlows();
      const now = recordingOf(ctx.session);
      return {
        ok: true,
        summary: (now ? `Recording ${now.name} now (${now.steps} steps).\n` : "") +
          (flows.length ? flows.map((f) => `${f.name}${f.description ? ` -- ${f.description}` : ""} [${f.steps.length} steps${Object.keys(f.params).length ? `, params: ${Object.keys(f.params).join(", ")}` : ""}]`).join("\n") : "No flows are saved."),
        preview: `${flows.length} flows`,
      };
    }
    case "show": {
      const f = getFlow(flowName);
      return f ? { ok: true, summary: describeFlow(f), preview: f.name } : { ok: false, summary: `There is no flow "${flowName}".` };
    }
    case "delete":
      return deleteFlow(flowName) ? { ok: true, summary: `Deleted ${flowName}.`, preview: "deleted" } : { ok: false, summary: `There is no flow "${flowName}".` };
    case "run": {
      if (!validName(flowName)) return { ok: false, summary: "run needs the flow's name." };
      const flow = getFlow(flowName);
      if (!flow) return { ok: false, summary: `There is no flow "${flowName}". list shows them.` };
      if (recordingOf(ctx.session)) return { ok: false, summary: "A flow is being recorded: save or cancel it before running one." };
      const live = ctx.browser();
      const report = await runFlow(flow, args.params && typeof args.params === "object" ? args.params : {}, live, {
        cancelled: ctx.cancelled,
        resolve: env.resolvePlaceholders,
      });
      ctx.browserChanged();
      noteRun(flow.name, report.ok, report.message);
      const body = `${report.message}\n${report.lines.join("\n")}${report.page ? `\n\n${env.describePage(report.page)}` : ""}`;
      return { ok: report.ok, summary: body, preview: report.ok ? `ran ${flow.name}` : `${flow.name} stopped` };
    }
    default:
      return { ok: false, summary: "action is record, expect, param, save, cancel, run, list, show or delete." };
  }
}


import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentCursor } from "../lib/agentCursor";
import { useBootWatch } from "../lib/bootWatch";
import { useCollab } from "../lib/collab";
import { TakeControl } from "./TakeControl";
import { SaveButton } from "./SaveButton";
import { useFullscreen } from "../lib/fullscreen";
import { along, humanRoute, restMs, routeMs, typingDelays, type Point } from "../lib/humanPath";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import { onVideoCommand, useVideoState, type VideoCommand } from "../lib/opencut";
import { IconMaximize, IconMinimize, IconVideo } from "./Icons";
import { CursorTag } from "./CursorTag";

/**
 * The video window: OpenCut's editor, beside the conversation.
 *
 * The editor is its own build (opencut-editor/), served at /opencut-editor/
 * and run in a frame sandboxed without an origin, so it cannot reach this app
 * or its API. This component is its only way out, and the whole wire between
 * them is `postMessage`:
 *
 *   frame -> here   store requests (where its projects and media are kept: the
 *                   server, see server/opencut.ts), its state, a finished export
 *   here -> frame   the answers, Autora's theme, and the agent's commands
 *
 * The agent does not edit the project behind the editor's back. It asks the
 * editor to, and the editor does it with its own timeline commands. Before it
 * does, the agent's cursor goes to the place the way the other windows' do --
 * an arc, a rest, a click -- and a title is typed a few letters at a time into
 * the project, so the person watches the cut being made and can take over.
 */

/** The theme tokens the editor takes from this page (opencut-editor/src/autora/autora.css, `--a-*`). */
const THEME: Array<[string, string]> = [
  ["--bg", "--a-bg"], ["--s1", "--a-s1"], ["--s2", "--a-s2"], ["--s3", "--a-s3"], ["--s4", "--a-s4"], ["--sink", "--a-sink"],
  ["--border", "--a-border"], ["--border-strong", "--a-border-strong"],
  ["--text", "--a-text"], ["--text-2", "--a-text-2"], ["--text-3", "--a-text-3"],
  ["--accent", "--a-accent"], ["--accent-light", "--a-accent-light"], ["--accent-deep", "--a-accent-deep"], ["--on-accent", "--a-on-accent"],
  ["--accent-soft", "--a-accent-soft"], ["--accent-line", "--a-accent-line"], ["--accent-2", "--a-accent-2"],
  ["--live", "--a-live"], ["--warn", "--a-warn"], ["--danger", "--a-danger"],
  ["--sans", "--a-sans"], ["--mono", "--a-mono"], ["--r-sm", "--a-r-sm"], ["--r", "--a-r"], ["--r-lg", "--a-r-lg"],
];

function themeVars(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const [from, to] of THEME) {
    const v = css.getPropertyValue(from).trim();
    if (v) out[to] = v;
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Commands that change nothing on the screen the person is looking at: they are answered without the cursor. */
const SILENT = new Set([
  "state", "catalog", "frame", "scene_list", "project_list", "keyframes", "play", "pause", "undo", "redo", "copy",
  "ui_read", "ui_press", "ui_scroll", "ui_commit", "locate", "select",
]);

const numArg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Where on the screen a command is about, for the cursor to go to; null for none, {} for the playhead. */
function whereFor(cmd: VideoCommand): Record<string, unknown> | null {
  const a = cmd.args;
  const n = cmd.name;
  if (SILENT.has(n)) return null;
  if (n === "ui_click" || n === "ui_type") {
    const target: Record<string, unknown> = {};
    for (const k of ["ref", "label", "elementId", "trackId", "selector"]) if (a[k] !== undefined) target[k] = a[k];
    return { target };
  }
  if (n === "ui_drag") return null;
  if (typeof a.elementId === "string") return { elementId: a.elementId };
  if (Array.isArray(a.elementIds) && typeof a.elementIds[0] === "string") return { elementId: a.elementIds[0] };
  if (typeof a.trackId === "string") return { trackId: a.trackId };
  if (n === "panel") return { panel: a.tab };
  if (n === "settings") return { panel: "settings" };
  if (n === "import_media") return { panel: "media" };
  if (n === "export") return { target: { label: "Export" } };
  if (n.startsWith("scene_")) return { target: { label: "scene" } };
  const t = numArg(a.start) ?? numArg(a.time) ?? numArg(a.from);
  return t === null ? {} : { time: t };
}

/** How long the editor may take: an export or an import is as long as the file. */
const LONG: Record<string, number> = { export: 31 * 60_000, import_media: 11 * 60_000 };

type Located = { x: number; y: number; view: { w: number; h: number } };
/** A place the editor gives the hand: where, and for a clip how many pixels a second is and where it is in time. */
type HandSpot = Located & { pps?: number; start?: number; duration?: number };

/** The edits done with the editor's own controls when Visible work is on (`byHand`). */
const HAND = new Set(["split", "delete", "move", "trim", "add_clip", "add_text"]);

export function OpenCutWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const desk = useVideoState();
  const frame = useRef<HTMLIFrameElement>(null);
  const [cursorOn] = useAgentCursor();
  const cursorOnRef = useRef(cursorOn);
  cursorOnRef.current = cursorOn;
  /* The project the frame opens on is the one open when the window mounted, and the frame's address never changes
     after that: it moves between projects itself, and a new address would reload it in the middle of the agent's work. */
  const [opening] = useState(desk.projectId ?? null);
  const mine = useCollab().held.includes("video");
  const [full, setFull] = useFullscreen();
  const [trouble, setTrouble] = useState<string | null>(null);

  // The agent's cursor, over the editor.
  const [cursor, setCursor] = useState<Point | null>(null);
  const [ring, setRing] = useState<Point | null>(null);
  const [doing, setDoing] = useState<"" | "press" | "type">("");
  const [gone, setGone] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const cursorAt = useRef<Point | null>(null);

  /** This window's frame has said it is up: until then a command sent to it would be lost, so it claims none. */
  const up = useRef(false);
  /** Goes up when the frame is loaded afresh: a start that failed or stalled is tried once more by itself. */
  const [generation, setGeneration] = useState(0);
  useBootWatch(() => up.current, `${sessionId}:${generation}`, "video editor", setTrouble);

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const query = `session=${encodeURIComponent(sessionId)}`;

  /** What the editor keeps, kept on the server. Media files go as bytes; everything else as JSON. */
  const store = useCallback(async (req: { op: string; ns: string; key?: string; value?: unknown }): Promise<unknown> => {
    const isFiles = req.ns.startsWith("files/");
    if (isFiles && req.op === "get") {
      const res = await fetch(`/api/opencut/file?ns=${encodeURIComponent(req.ns)}&key=${encodeURIComponent(req.key ?? "")}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Autora answered ${res.status}`);
      const meta = JSON.parse(decodeURIComponent(res.headers.get("X-Opencut-Meta") ?? "%7B%7D")) as { name?: string; type?: string; lastModified?: number };
      return { name: meta.name ?? req.key, type: meta.type ?? "", lastModified: meta.lastModified ?? 0, blob: await res.blob() };
    }
    if (isFiles && req.op === "set") {
      const kept = req.value as { name: string; type: string; lastModified: number; blob: Blob };
      const q = new URLSearchParams({ ns: req.ns, key: req.key ?? "", name: kept.name, type: kept.type, modified: String(kept.lastModified) });
      const res = await fetch(`/api/opencut/file?${q}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: kept.blob });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `Autora answered ${res.status}`);
      return null;
    }
    // Not application/json: the app's own parser stops at 5 MB, and a project with its thumbnail is not far off.
    const res = await fetch("/api/opencut/kv", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(req) });
    const body = (await res.json().catch(() => null)) as { value?: unknown; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(body?.error?.message ?? `Autora answered ${res.status}`);
    return body?.value ?? null;
  }, []);

  const send = useCallback((path: string, body: unknown) => {
    void fetch(`/api/opencut/${path}?${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  }, [query]);

  /** Commands in flight to the frame: its answers find their way back here. */
  const waiting = useRef(new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const seq = useRef(0);
  const toFrame = useCallback((name: string, args: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++seq.current;
    const timer = setTimeout(() => {
      waiting.current.delete(id);
      reject(new Error(`The editor did not answer ${name}`));
    }, LONG[name] ?? 120_000);
    waiting.current.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    post({ type: "autora:opencut:command", id, name, args });
  }), [post]);

  // What the frame says.
  useEffect(() => {
    const answer = (id: unknown, run: () => Promise<unknown>) => {
      if (typeof id !== "number") return;
      run().then(
        (value) => post({ type: "autora:opencut:result", id, ok: true, value }),
        (err: unknown) => {
          const message = String((err as Error)?.message ?? err);
          setTrouble(message);
          post({ type: "autora:opencut:result", id, ok: false, value: { message } });
        },
      );
    };
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data as Record<string, unknown> | null;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "autora:opencut:store":
          answer(msg.id, () => store(msg.req as { op: string; ns: string }));
          break;
        case "autora:opencut:deliver":
          answer(msg.id, async () => {
            const q = new URLSearchParams({ session: sessionId, name: String(msg.name ?? "video.mp4"), mime: String(msg.mime ?? "video/mp4") });
            const res = await fetch(`/api/opencut/deliver?${q}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: msg.data as ArrayBuffer });
            const body = (await res.json().catch(() => null)) as { artifact?: string; error?: { message?: string } } | null;
            if (!res.ok || !body?.artifact) throw new Error(body?.error?.message ?? `Autora answered ${res.status}`);
            return { artifact: body.artifact };
          });
          break;
        case "autora:opencut:state":
          send("state", { projectId: msg.projectId ?? null, name: msg.name ?? null });
          break;
        case "autora:opencut:ready":
          up.current = true;
          setTrouble(null);
          post({ type: "autora:opencut:theme", vars: themeVars() });
          send("ready", { ready: true });
          break;
        case "autora:opencut:problem": {
          // The editor could not start, and said why: shown here, and told to the server so the agent hears it at once.
          if (up.current) break;
          const message = String(msg.message ?? "it stopped while starting").slice(0, 300);
          setTrouble(`The video editor could not start: ${message}`);
          send("ready", { ready: false, problem: message });
          break;
        }
        case "autora:opencut:reply": {
          const w = typeof msg.id === "number" ? waiting.current.get(msg.id) : undefined;
          if (!w || typeof msg.id !== "number") break;
          waiting.current.delete(msg.id);
          if (msg.ok) w.resolve(msg.value);
          else w.reject(new Error(String((msg.value as { message?: string } | null)?.message ?? "The editor could not do that")));
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, send, sessionId, store]);

  // A window that has just mounted (or reloaded its frame) has a frame that has not started: the server must not send it
  // commands yet.
  useEffect(() => {
    up.current = false;
    send("ready", { ready: false });
  }, [send, generation]);

  /* Up, it says so again every few seconds: the server forgets when it restarts (an update), and a word said once would
     then leave the agent waiting on an editor that is plainly there. */
  useEffect(() => {
    const beat = window.setInterval(() => { if (up.current) send("ready", { ready: true }); }, 5000);
    return () => window.clearInterval(beat);
  }, [send]);

  /* Not up after half a minute (a fetch that stalled, a start that hung): the frame is loaded once more, as a person would
     reload it. Only once: a second failure is said, not hidden behind more tries. */
  useEffect(() => {
    if (generation > 0) return;
    const timer = window.setTimeout(() => {
      if (up.current) return;
      setTrouble("The video editor is taking a while to start, so it is being loaded again.");
      setGeneration(1);
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [generation]);

  // Autora's theme, followed: another theme, font or text size here is another one in the editor.
  useEffect(() => {
    const push = () => post({ type: "autora:opencut:theme", vars: themeVars() });
    const observer = new MutationObserver(push);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font", "style", "class"] });
    return () => observer.disconnect();
  }, [post]);

  // ----------------------------------------------------- the agent's hand --

  const tween = useCallback((ms: number, step: (p: number) => void) => new Promise<void>((resolve) => {
    const started = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - started) / ms);
      step(p);
      if (p < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  }), []);

  /** Go to a spot the way a hand does, and press there. */
  const goTo = useCallback(async (target: Point, view: { w: number; h: number }) => {
    setGone(false);
    const from = cursorAt.current ?? { x: Math.min(view.w - 8, Math.max(8, target.x + 70)), y: Math.max(6, target.y - 46) };
    setCursor(from);
    const route = humanRoute(from, target);
    await tween(routeMs(Math.hypot(target.x - from.x, target.y - from.y)), (p) => setCursor(along(route, p)));
    cursorAt.current = target;
    await sleep(restMs());
    setRing(target);
    setDoing("press");
    await sleep(160);
    setDoing("");
    await sleep(200);
    setRing(null);
  }, [tween]);

  /** Where the editor says this is on its screen (it moves its playhead or scrolls to it first). */
  const locate = useCallback(async (where: Record<string, unknown>): Promise<Located | null> => {
    try {
      return (await toFrame("locate", where)) as Located | null;
    } catch {
      return null;
    }
  }, [toFrame]);

  /** Words go in a few letters at a time, at a person's pace. */
  const typed = useCallback(async (text: string, at: (shown: string, first: boolean) => Promise<unknown>) => {
    setDoing("type");
    const chars = Array.from(text);
    const gaps = typingDelays(text, 2400);
    const chunk = Math.max(1, Math.ceil(chars.length / 14));
    let last: unknown = null;
    for (let n = chunk; ; n += chunk) {
      const upto = Math.min(chars.length, n);
      last = await at(chars.slice(0, upto).join(""), n === chunk);
      if (upto >= chars.length) break;
      await sleep(gaps.slice(upto - chunk, upto).reduce((a, b) => a + b, 0) || 90);
    }
    setDoing("");
    return last;
  }, []);

  // ------------------------------------------- the agent's hand, live --

  /** Where something is in the editor for the hand (`hand_point`, opencut-editor/src/autora/commands.ts). */
  const handAt = useCallback(async (kind: string, a: Record<string, unknown>) =>
    (await toFrame("hand_point", { kind, ...a }).catch(() => null)) as HandSpot | null, [toFrame]);

  /** Go there and press, with the editor's own mouse events. */
  const press = useCallback(async (p: HandSpot, shift = false) => {
    await goTo({ x: p.x, y: p.y }, p.view);
    await toFrame("hand_tap", { x: p.x, y: p.y, shift });
  }, [goTo, toFrame]);

  /** Take hold at `from` and drag to `to`, the cursor travelling with what it holds. */
  const pull = useCallback(async (from: HandSpot, to: Point) => {
    await goTo({ x: from.x, y: from.y }, from.view);
    const route = humanRoute({ x: from.x, y: from.y }, to);
    const moving = tween(Math.max(420, Math.min(1100, Math.hypot(to.x - from.x, to.y - from.y) * 2.2)), (p) => setCursor(along(route, p)));
    await Promise.all([toFrame("ui_drag", { from: { x: from.x, y: from.y }, to, steps: 30 }), moving]);
    cursorAt.current = to;
    await sleep(220);
  }, [goTo, toFrame, tween]);

  /** A tool by its name: on the tool bar, or in its All tools grid. */
  const tool = useCallback(async (label: string) => {
    const onBar = await locate({ target: { selector: `.rail-bar button[aria-label="${label}"]` } });
    if (onBar) {
      await goTo({ x: onBar.x, y: onBar.y }, onBar.view);
      await toFrame("ui_click", { selector: `.rail-bar button[aria-label="${label}"]` });
      return;
    }
    const grid = await locate({ target: { selector: '.rail-bar button[aria-label="All tools"]' } });
    if (!grid) throw new Error(`${label} is not on the screen`);
    await goTo({ x: grid.x, y: grid.y }, grid.view);
    await toFrame("ui_click", { selector: '.rail-bar button[aria-label="All tools"]' });
    await sleep(300);
    const tile = await locate({ target: { label } });
    if (!tile) throw new Error(`${label} is not in All tools`);
    await goTo({ x: tile.x, y: tile.y }, tile.view);
    await toFrame("ui_click", { label });
  }, [goTo, locate, toFrame]);

  /**
   * One of the agent's edits done with the editor's own controls, as a person does it: the clip picked, the playhead put
   * where the cut goes by a click on the ruler, the tool bar's Split or Delete, a clip dragged by its body or its edge, a
   * tile's "+" in the media or text panel. Where the editor lands somewhere else (snapping, a clip that will not go
   * there), the exact edit is made after, and the answer says so. Undefined when it cannot be done by hand (nothing it
   * needs is on the screen): then the command goes to the editor as it is, at once.
   */
  const byHand = useCallback(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    type Clip = { id: string; start: number; duration: number; trimStart: number; trimEnd: number; type: string };
    type State = { duration: number; playhead: number; tracks: Array<{ id: string; clips: Clip[] }>; media: Array<{ id: string; name: string }> };
    const now = async () => (await toFrame("state", {})) as State;
    const clips = (st: State) => st.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, track: t.id })));
    const clipOf = (st: State, id: string) => clips(st).find((c) => c.id === id);
    const near = (a: number, b: number) => Math.abs(a - b) < 0.06;
    const said = (st: unknown, how: string, fixed?: string) =>
      ({ ...(st as Record<string, unknown>), byHand: `${how}, by hand in the Video window, where the person watched${fixed ? `; then ${fixed}, directly` : ""}` });
    /** Not by hand after all: why, for whoever is looking at the console. */
    const skip = (why: string) => { console.debug(`[video hand] ${name}: not by hand (${why})`); return undefined; };
    const before = await now();
    const id = typeof args.elementId === "string" ? args.elementId : "";

    if (name === "split") {
      const at = typeof args.time === "number" ? args.time : null;
      if (!id || at === null) return skip("1");
      const body = await handAt("clip", { elementId: id });
      if (!body) return skip("2");
      await press(body);
      const cut = await handAt("time", { time: at });
      if (!cut) return skip("3");
      await press(cut);
      await tool("Split");
      const after = await now();
      if (clips(after).length > clips(before).length) return said(after, "picked the clip, clicked the ruler at the cut and pressed Split");
      return said(await toFrame("split", args), "picked the clip and put the playhead there", "the cut was made");
    }

    if (name === "delete") {
      const ids = Array.isArray(args.elementIds) ? args.elementIds.filter((v): v is string => typeof v === "string") : id ? [id] : [];
      if (!ids.length) return skip("4");
      let picked = 0;
      for (const one of ids) {
        const body = await handAt("clip", { elementId: one });
        if (!body) continue;
        await press(body, picked > 0);
        picked++;
      }
      if (!picked) return skip("5");
      await tool("Delete");
      const after = await now();
      const left = ids.filter((one) => clipOf(after, one));
      if (!left.length) return said(after, `picked ${ids.length === 1 ? "the clip" : `the ${ids.length} clips`} and pressed Delete`);
      return said(await toFrame("delete", { elementIds: left }), "picked the clips and pressed Delete", `${left.length} left over were removed`);
    }

    if (name === "move") {
      const to = typeof args.start === "number" ? args.start : null;
      const was = clipOf(before, id);
      if (!was || to === null) return skip("6");
      const body = await handAt("clip", { elementId: id });
      if (!body?.pps) return skip("7");
      let y = body.y;
      if (typeof args.trackId === "string" && args.trackId !== was.track) {
        const row = await handAt("track", { trackId: args.trackId });
        if (!row) return skip("8");
        y = row.y;
      }
      await pull(body, { x: body.x + (to - was.start) * body.pps, y });
      const after = await now();
      const now_ = clipOf(after, id);
      if (now_ && near(now_.start, to) && (typeof args.trackId !== "string" || now_.track === args.trackId)) return said(after, "dragged the clip to its place");
      return said(await toFrame("move", args), "dragged the clip", "it was put exactly where asked");
    }

    if (name === "trim") {
      const was = clipOf(before, id);
      if (!was) return skip("9");
      const body = await handAt("clip", { elementId: id });
      if (!body) return skip("10");
      await press(body);
      const from = typeof args.from === "number" ? args.from : was.trimStart;
      const source = was.trimStart + was.duration + was.trimEnd;
      const to = typeof args.to === "number" ? Math.min(source, args.to) : source - was.trimEnd;
      if (!near(from, was.trimStart)) {
        const left = await handAt("clip", { elementId: id, part: "left" });
        if (left?.pps) await pull(left, { x: left.x + (from - was.trimStart) * left.pps, y: left.y });
      }
      const mid = clipOf(await now(), id);
      if (mid && !near(mid.duration, to - from)) {
        const right = await handAt("clip", { elementId: id, part: "right" });
        if (right?.pps) await pull(right, { x: right.x + ((to - from) - mid.duration) * right.pps, y: right.y });
      }
      const after = await now();
      const end = clipOf(after, id);
      if (end && near(end.trimStart, from) && near(end.duration, to - from)) return said(after, "dragged the clip's edges");
      return said(await toFrame("trim", args), "dragged the clip's edges", "the trim was set exactly");
    }

    if (name === "add_clip" || name === "add_text") {
      const start = typeof args.start === "number" ? args.start : name === "add_clip" ? before.duration : before.playhead;
      // The ruler only reaches the end of what is there: past it, the clip goes in as it is.
      if (start > before.duration + 0.01) return skip("11");
      const tileName = name === "add_text" ? "Default text" : before.media.find((m) => m.id === args.mediaId)?.name;
      if (!tileName) return skip("12");
      const at = await handAt("time", { time: start });
      if (!at) return skip("13");
      await press(at);
      await tool(name === "add_text" ? "Text" : "Media");
      await sleep(300);
      const tile = await handAt("tile", { name: tileName });
      if (!tile) return skip("14");
      await press(tile);
      const known = new Set(clips(before).map((c) => c.id));
      let after = await now();
      const made = clips(after).find((c) => !known.has(c.id));
      if (!made) return said(await toFrame(name, args), `clicked "${tileName}" in its panel`, "it was added");
      const fixed: string[] = [];
      if (name === "add_text") {
        // The words go in a few letters at a time, into the clip the hand just made.
        const text = String(args.text ?? "");
        if (text) await typed(text, (shown, first) => toFrame("set_params", { elementId: made.id, params: { content: shown }, history: first }));
        const rest: Record<string, unknown> = {};
        for (const key of ["color", "fontFamily", "fontSize", "fontWeight", "textAlign"]) if (args[key] !== undefined) rest[key] = args[key];
        if (Object.keys(rest).length) { await toFrame("set_params", { elementId: made.id, params: rest }); fixed.push("its style was set"); }
      }
      const want = typeof args.duration === "number" ? args.duration : name === "add_text" ? 3 : null;
      if (want !== null && !near(made.duration, want)) {
        // Its edges are handles only once it is picked.
        const body = await handAt("clip", { elementId: made.id });
        if (body) await press(body);
        const right = await handAt("clip", { elementId: made.id, part: "right" });
        if (right?.pps) await pull(right, { x: right.x + (want - made.duration) * right.pps, y: right.y });
      }
      after = await now();
      const end = clipOf(after, made.id);
      if (end && !near(end.start, start)) { await toFrame("move", { elementId: made.id, start }); fixed.push("it was put exactly at its time"); }
      if (end && want !== null && !near(end.duration, want)) fixed.push(`it is ${end.duration}s long, not ${want}s (drag its right edge, or trim it)`);
      return said(await now(), `clicked the ruler at ${start}s and pressed "+" on "${tileName}"${name === "add_text" ? ", typed the words" : ""}`, fixed.join(", ") || undefined);
    }
    return skip("15");
  }, [handAt, press, pull, toFrame, tool, typed]);

  /** One command from the agent: pointed at, then done, then answered. */
  const play = useCallback(async (cmd: VideoCommand): Promise<unknown> => {
    let args = cmd.args;
    const name = cmd.name;
    // A file to import comes through the app's own route, by a link the agent's tool made.
    if (name === "import_media" && typeof args.sourceToken === "string") {
      const res = await fetch(`/api/opencut/source/${encodeURIComponent(args.sourceToken)}?${query}`);
      if (!res.ok) throw new Error("The file to import is no longer available");
      const { sourceToken: _t, ...rest } = args;
      args = { ...rest, file: await res.blob() };
      await toFrame("panel", { tab: "media" }).catch(() => undefined);
    }
    // Visible work: the edits a person makes with the timeline and the tool bar are made that way, live.
    if (cursorOnRef.current && HAND.has(name)) {
      const done = await byHand(name, args).catch((err: unknown) => { console.debug(`[video hand] ${name}: ${String((err as Error)?.message ?? err)}`); return undefined; });
      if (done !== undefined) {
        await sleep(400);
        setGone(true);
        return done;
      }
    }
    const where = cursorOnRef.current ? whereFor({ ...cmd, args }) : null;
    let spot: Located | null = null;
    if (where) {
      spot = await locate(where);
      if (spot) await goTo({ x: spot.x, y: spot.y }, spot.view);
    }
    const finish = async <T,>(result: T): Promise<T> => {
      if (spot) {
        await sleep(450);
        setGone(true);
      }
      return result;
    };

    // Typing: a title, a clip's words, a name, or a field on the screen.
    if (name === "add_text" && typeof args.text === "string" && args.text.length > 1 && spot) {
      const full = args.text;
      let clipId: string | undefined;
      const made = await typed(full, async (shown, first) => {
        if (first) {
          const r = (await toFrame("add_text", { ...args, text: shown })) as { tracks?: Array<{ clips: Array<{ id: string; type: string; text?: string }> }> };
          clipId = r.tracks?.flatMap((t) => t.clips).filter((c) => c.type === "text" && c.text === shown).pop()?.id;
          return r;
        }
        return clipId ? toFrame("set_params", { elementId: clipId, params: { content: shown }, history: false }) : null;
      });
      return finish(made);
    }
    if ((name === "set_params" || name === "set") && spot && typeof (args.params as Record<string, unknown> | undefined)?.content === "string" && String((args.params as Record<string, unknown>).content).length > 1) {
      const full = String((args.params as Record<string, unknown>).content);
      const rest = { ...(args.params as Record<string, unknown>) };
      const result = await typed(full, (shown, first) => toFrame("set_params", { ...args, params: { ...rest, content: shown }, history: first }));
      // The last step is the one that is kept as it is, undone in one go.
      return finish(await toFrame("set_params", { ...args, params: { ...rest, content: full }, history: true }).then(() => result).catch(() => result));
    }
    if (name === "rename" && typeof args.name === "string" && args.name.length > 1 && spot) {
      const full = args.name;
      return finish(await typed(full, (shown) => toFrame("rename", { name: shown })));
    }
    if (name === "ui_type" && typeof args.text === "string" && spot) {
      const full = args.text;
      const replace = args.replace !== false;
      const result = await typed(full, (shown, first) => toFrame("ui_type", { ...args, text: shown, replace: first ? replace : true, enter: false, blur: false }));
      if (args.enter === true || args.blur === true) await toFrame("ui_commit", { ...args, how: args.blur === true ? "blur" : "enter" });
      return finish(result);
    }
    if (name === "ui_drag") {
      const from = args.from as { x: number; y: number } | undefined;
      const to = args.to as { x: number; y: number } | undefined;
      if (cursorOnRef.current && from && to) {
        const view = { w: 1280, h: 800 };
        await goTo(from, view);
        const route = humanRoute(from, to);
        const moving = tween(560, (p) => setCursor(along(route, p)));
        const done = toFrame("ui_drag", { ...args, steps: 28 });
        const [result] = await Promise.all([done, moving]);
        cursorAt.current = to;
        setGone(true);
        return result;
      }
    }
    return finish(await toFrame(name, args));
  }, [byHand, goTo, locate, query, toFrame, tween, typed]);

  // The agent's commands for this chat. The first window to claim one does it: the same chat open in two tabs must not cut twice.
  useEffect(() => onVideoCommand((cmd) => {
    if (!up.current) return;
    void (async () => {
      const claim = await fetch(`/api/opencut/claim?${query}&id=${encodeURIComponent(cmd.id)}`, { method: "POST" })
        .then((r) => (r.ok ? (r.json() as Promise<{ won?: boolean }>) : { won: false }))
        .catch(() => ({ won: false }));
      if (!claim.won) return;
      try {
        send("reply", { id: cmd.id, ok: true, value: await play(cmd) });
      } catch (err) {
        send("reply", { id: cmd.id, ok: false, value: { message: String((err as Error)?.message ?? err) } });
      }
    })();
  }), [play, query, send]);

  // Where the cursor is on screen, for the line the agent says beside it.
  useEffect(() => {
    const r = layer.current?.getBoundingClientRect();
    if (cursor && r) reportCursor(r.left + cursor.x, r.top + cursor.y);
  }, [cursor]);
  useEffect(() => clearCursor, []);

  /** Save: the editor writes the project now. A video project is yours across chats, so it stays here (Export makes the
      video file, which goes to Artifacts). */
  const keep = useCallback(async () => {
    await toFrame("save", {});
    return "Saved the project";
  }, [toFrame]);

  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconVideo size={14} /></span>
        <span className="pdf-bar-app">Autora Video</span>
        <span className="pdf-bar-name" title={desk.name ?? undefined}>{desk.name ?? "Video"}</span>
        <span className="pdf-bar-note">Saved as you go</span>
        <div className="spacer" />
        <SaveButton onSave={keep} phone={phone} disabled={!desk.name} />
        <TakeControl sessionId={sessionId} surface="video" mine={mine} phone={phone} thing="video" />
        {phone && (
          <button
            className="btn icon ghost pdf-full-btn"
            onClick={() => setFull(!full)}
            title={full ? "Back to the conversation" : "Full screen"}
            aria-label={full ? "Back to the conversation" : "Full screen"}
            aria-pressed={full}
          >
            {full ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
        )}
      </div>
      {trouble && <div className="pdf-problem" role="status">{trouble}</div>}
      <div className="office-stage">
        <iframe
          ref={frame}
          key={generation}
          className="pdf-frame"
          src={`/opencut-editor/index.html?session=${encodeURIComponent(sessionId)}${opening ? `&project=${encodeURIComponent(opening)}` : ""}${phone ? "&phone=1" : ""}`}
          title={`${desk.name ?? "Video"}, in Autora Video`}
          sandbox="allow-scripts allow-downloads allow-modals allow-popups"
          allow="autoplay; fullscreen"
        />
        {cursor && (
          <div ref={layer} className="office-cursor-layer" aria-hidden="true" data-office-cursor={gone ? "gone" : "on"}>
            {ring && <span className="office-click" style={{ left: ring.x - 14, top: ring.y - 14 }} />}
            {/* Pops in where it starts and dissolves when it is done (.cursor-pop in styles.css), never a cut. */}
            <div className={`office-cursor${doing ? ` is-${doing}` : ""}${gone ? " is-gone" : ""}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}>
              <span className="cursor-pop">
                <svg width="16" height="20" viewBox="0 0 16 20" className="office-cursor-arrow" style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" }}>
                  <path d="M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.5 10.5 L13 10.5 Z" fill="#7c5cff" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
                </svg>
                <CursorTag />
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

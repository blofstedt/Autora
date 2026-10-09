import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ansiToLines } from "../lib/ansi";
import { useFullscreen } from "../lib/fullscreen";
import { every } from "../lib/poll";
import { useTermState } from "../lib/termdesk";
import { IconArrowDown, IconCheck, IconChevron, IconCopy, IconFile, IconFolder, IconMaximize, IconMinimize, IconRotateCcw, IconStop, IconTerminal, IconTrash, IconZap } from "./Icons";

/**
 * The Terminal window: a shell beside the conversation that the person and the agent share (server/termdesk.ts).
 *
 * What is typed here runs on the machine Autora runs on, in the folder the last command left off in; what the agent
 * runs with its terminal tool appears in the same scrollback, marked as the agent's. The line being typed is
 * completed as you go -- commands, files and folders, git and npm scripts, and what you typed before -- so a phone
 * with no Tab key has the same help as a keyboard, and nothing has to be remembered.
 *
 * Like the agent's tool it has no TTY: a full-screen program (vim, top) does not work, and the window says so
 * instead of leaving it to hang.
 */
type Entry = {
  id: number; command: string; cwd: string; by: "person" | "agent";
  output: string; exit: number | null; running: boolean; started: number; ms: number | null; rev: number;
};
type Item = { text: string; kind: "command" | "dir" | "file" | "git" | "script" | "history" | "option"; hint?: string };
type Completion = { from: number; to: number; items: Item[] };

const EXAMPLES = ["ls -la", "pwd", "git status", "df -h", "ps aux | head"];

/** Programs that need a whole screen, and what to do instead. */
const FULL_SCREEN: Record<string, string> = {
  vim: "Ask Autora to edit the file, or print it with cat.",
  vi: "Ask Autora to edit the file, or print it with cat.",
  nano: "Ask Autora to edit the file, or print it with cat.",
  emacs: "Ask Autora to edit the file, or print it with cat.",
  top: "Try top -bn1 | head -20 for a snapshot.",
  htop: "Try top -bn1 | head -20 for a snapshot.",
  less: "Pipe it to cat, or head, instead.",
  more: "Pipe it to cat, or head, instead.",
  ssh: "A login that asks for a password cannot be answered here; use a key and add -o BatchMode=yes.",
  watch: "Run the command once, or ask Autora to keep an eye on it.",
};

const short = (cwd: string, home: string) => {
  let p = home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = p.split("/");
  if (parts.length > 3) p = `…/${parts.slice(-2).join("/")}`;
  return p || "/";
};

const duration = (ms: number | null) => (ms === null ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/** The longest start every item shares. */
const commonStart = (items: Item[]) => items.reduce((a, b) => { let i = 0; while (i < a.length && i < b.text.length && a[i] === b.text[i]) i += 1; return a.slice(0, i); }, items[0]?.text ?? "");

function Output({ text }: { text: string }) {
  const lines = useMemo(() => ansiToLines(text, 4000), [text]);
  return (
    <>
      {lines.map((spans, i) => (
        <div key={i} className="tm-row">
          {spans.length === 0 ? " " : spans.map((sp, j) => (
            sp.color || sp.bg || sp.bold || sp.dim || sp.underline ? (
              <span
                key={j}
                style={{
                  color: sp.color, background: sp.bg, fontWeight: sp.bold ? 650 : undefined,
                  opacity: sp.dim ? 0.65 : undefined, textDecoration: sp.underline ? "underline" : undefined,
                }}
              >{sp.text}</span>
            ) : sp.text
          ))}
        </div>
      ))}
    </>
  );
}

export function TerminalWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const term = useTermState();
  const [full, setFull] = useFullscreen();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [past, setPast] = useState<string[]>([]);
  const [line, setLine] = useState("");
  const [caret, setCaret] = useState(0);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [menu, setMenu] = useState<Completion | null>(null);
  const [pick, setPick] = useState(0);
  const [picked, setPicked] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const [away, setAway] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const seen = useRef(0);
  const loading = useRef(false);
  const again = useRef(false);
  const asked = useRef(0);
  /** Where the history walk is (null: not walking), and the line that was being typed when it began. */
  const walk = useRef<{ at: number; draft: string } | null>(null);
  const api = useCallback((path: string) => `/api/term/${encodeURIComponent(sessionId)}${path}`, [sessionId]);
  const coarse = phone || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);

  // What is on the screen: fetched whenever the server says something moved, never two at once.
  const load = useCallback(async () => {
    if (loading.current) { again.current = true; return; }
    loading.current = true;
    try {
      do {
        again.current = false;
        const res = await fetch(`${api("")}?after=${seen.current}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Autora answered ${res.status}`);
        const body = await res.json() as { cwd: string; home: string; rev: number; entries: Entry[]; known: number[]; history: string[] };
        seen.current = body.rev;
        setCwd(body.cwd);
        setHome(body.home);
        setPast(body.history);
        setEntries((have) => {
          const byId = new Map(have.map((e) => [e.id, e]));
          for (const e of body.entries) byId.set(e.id, e);
          const keep = new Set(body.known);
          return [...byId.values()].filter((e) => keep.has(e.id)).sort((a, b) => a.id - b.id);
        });
        setTrouble(null);
      } while (again.current);
    } catch (err) {
      setTrouble(`The terminal could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      loading.current = false;
    }
  }, [api]);

  useEffect(() => { seen.current = 0; setEntries([]); void load(); }, [load]);
  useEffect(() => { if (term.rev !== undefined) void load(); }, [term.rev, load]);

  // Stay at the bottom while output arrives, unless the person has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [entries]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stuck.current = near;
    setAway(!near);
  };
  const toBottom = () => {
    const el = scroller.current;
    if (el) { el.scrollTop = el.scrollHeight; stuck.current = true; setAway(false); }
  };

  // Autosize the field to its lines.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [line]);

  const running = entries.some((e) => e.running && e.by === "person");
  // A command that is running shows how long, so the clock moves while it does.
  const [, tick] = useState(0);
  const anyRunning = entries.some((e) => e.running);
  useEffect(() => (anyRunning ? every(() => tick((n) => n + 1), 1000) : undefined), [anyRunning]);

  // --------------------------------------------------------------- completion --
  const complete = useCallback(async (text: string, at: number) => {
    const mine = ++asked.current;
    if (!text.trim()) { setMenu(null); return; }
    try {
      const res = await fetch(`${api("/complete")}?line=${encodeURIComponent(text)}&cursor=${at}`);
      if (!res.ok || mine !== asked.current) return;
      const found = await res.json() as Completion;
      if (mine !== asked.current) return;
      // Nothing to offer, or only what is already typed.
      const word = text.slice(found.from, found.to);
      const items = found.items.filter((i) => i.text !== word);
      if (items.length === 0) { setMenu(null); return; }
      setMenu({ ...found, items });
      setPick(0);
      setPicked(false);
    } catch { /* no suggestions this time */ }
  }, [api]);

  useEffect(() => {
    const t = window.setTimeout(() => void complete(line, caret), 70);
    return () => window.clearTimeout(t);
  }, [line, caret, complete]);

  const apply = useCallback((item: Item) => {
    if (!menu) return;
    const tail = item.kind === "dir" ? "" : " ";
    const next = `${line.slice(0, menu.from)}${item.text}${tail}${line.slice(menu.to).replace(/^ /, tail ? "" : " ")}`;
    const at = menu.from + item.text.length + tail.length;
    setLine(next);
    setCaret(at);
    setMenu(null);
    walk.current = null;
    requestAnimationFrame(() => { const el = field.current; if (el) { el.focus(); el.setSelectionRange(at, at); } });
  }, [menu, line]);

  /** What the history would finish this line with (only when the caret is at the end of one line). */
  const ghost = useMemo(() => {
    if (!line || line.includes("\n") || caret !== line.length || menu?.items.length && picked) return "";
    for (let i = past.length - 1; i >= 0; i -= 1) {
      if (past[i].startsWith(line) && past[i].length > line.length && !past[i].includes("\n")) return past[i].slice(line.length);
    }
    return "";
  }, [line, caret, past, menu, picked]);

  // --------------------------------------------------------------------- run --
  const run = useCallback(async (command: string) => {
    const text = command.trim();
    if (!text) return;
    setLine("");
    setCaret(0);
    setMenu(null);
    walk.current = null;
    stuck.current = true;
    setPast((p) => [...p.filter((h) => h !== text), text]);
    try {
      const res = await fetch(api("/run"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: text }) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setTrouble(body.error ?? `Autora answered ${res.status}`);
      } else {
        setTrouble(null);
      }
    } catch (err) {
      setTrouble(`That could not be sent: ${err instanceof Error ? err.message : String(err)}`);
    }
    void load();
  }, [api, load]);

  const stop = useCallback(() => {
    void fetch(api("/stop"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
  }, [api]);

  const clear = useCallback(() => {
    void fetch(api("/clear"), { method: "POST" }).then(() => load()).catch(() => undefined);
  }, [api, load]);

  const copy = (entry: Entry) => {
    void navigator.clipboard?.writeText(entry.output).then(() => {
      setCopied(entry.id);
      window.setTimeout(() => setCopied((c) => (c === entry.id ? null : c)), 1400);
    }).catch(() => undefined);
  };

  const insert = (text: string) => {
    const el = field.current;
    const a = el?.selectionStart ?? line.length;
    const b = el?.selectionEnd ?? line.length;
    const next = line.slice(0, a) + text + line.slice(b);
    setLine(next);
    setCaret(a + text.length);
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(a + text.length, a + text.length); } });
  };

  const recall = (step: -1 | 1) => {
    if (past.length === 0) return;
    const w = walk.current ?? { at: past.length, draft: line };
    const at = Math.max(0, Math.min(past.length, w.at + step));
    walk.current = at === past.length && step === 1 ? null : { at, draft: w.draft };
    const next = at === past.length ? w.draft : past[at];
    setLine(next);
    setCaret(next.length);
    requestAnimationFrame(() => field.current?.setSelectionRange(next.length, next.length));
  };

  const tab = () => {
    if (!menu || menu.items.length === 0) return;
    const word = line.slice(menu.from, menu.to);
    const common = commonStart(menu.items);
    // Several choices that share more than what is typed: take the shared part first, as a shell does.
    if (!picked && menu.items.length > 1 && common.length > word.length && menu.items.every((i) => i.kind === menu.items[0].kind)) {
      const next = line.slice(0, menu.from) + common + line.slice(menu.to);
      const at = menu.from + common.length;
      setLine(next);
      setCaret(at);
      requestAnimationFrame(() => field.current?.setSelectionRange(at, at));
      return;
    }
    apply(menu.items[pick] ?? menu.items[0]);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const open = menu && menu.items.length > 0;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (open && picked) apply(menu.items[pick]);
      else void run(line);
    } else if (e.key === "Tab" && !e.shiftKey) {
      if (open) { e.preventDefault(); tab(); }
      else if (ghost) { e.preventDefault(); setLine(line + ghost); setCaret(line.length + ghost.length); }
      else e.preventDefault();
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); setMenu(null); }
    } else if (e.key === "ArrowUp" || (ctrl && e.key === "p")) {
      if (open) { e.preventDefault(); setPick((i) => (i <= 0 ? menu.items.length - 1 : i - 1)); setPicked(true); }
      else if (!line.slice(0, el.selectionStart).includes("\n")) { e.preventDefault(); recall(-1); }
    } else if (e.key === "ArrowDown" || (ctrl && e.key === "n")) {
      if (open) { e.preventDefault(); setPick((i) => (i + 1) % menu.items.length); setPicked(true); }
      else if (!line.slice(el.selectionEnd).includes("\n") && walk.current) { e.preventDefault(); recall(1); }
    } else if ((e.key === "ArrowRight" || e.key === "End") && ghost && el.selectionStart === line.length) {
      e.preventDefault();
      setLine(line + ghost);
      setCaret(line.length + ghost.length);
    } else if (ctrl && e.key === "c" && el.selectionStart === el.selectionEnd) {
      e.preventDefault();
      if (running) stop();
      else { setLine(""); setCaret(0); setMenu(null); }
    } else if (ctrl && e.key === "l") {
      e.preventDefault();
      clear();
    } else if (ctrl && e.key === "u") {
      e.preventDefault();
      const a = el.selectionStart;
      setLine(line.slice(a));
      setCaret(0);
    }
  };

  const first = line.trim().split(/\s+/)[0] ?? "";
  const tip = FULL_SCREEN[first] && !line.includes("|") ? `${first} needs a whole screen, which this terminal is not. ${FULL_SCREEN[first]}` : null;
  const prompt = short(cwd || term.cwd || "", home);

  return (
    <div
      className={`pdf-window tm-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}
      onClick={(e) => {
        // A tap on the scrollback puts the cursor in the line, unless it is selecting text to copy.
        if ((e.target as HTMLElement).closest("button, a, textarea")) return;
        if (window.getSelection()?.toString()) return;
        field.current?.focus({ preventScroll: true });
      }}
    >
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconTerminal size={14} /></span>
        <span className="pdf-bar-app">Terminal</span>
        <span className="pdf-bar-name tm-cwd" title={cwd}>{prompt}</span>
        {running && <span className="tm-busy" role="status"><span className="attach-spin" aria-hidden="true" />Running</span>}
        <div className="spacer" />
        <button className="btn icon ghost" onClick={clear} title="Clear the screen (Ctrl+L)" aria-label="Clear the screen" disabled={entries.length === 0}>
          <IconTrash size={14} />
        </button>
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

      <div className="tm-scroll" ref={scroller} onScroll={onScroll}>
        {entries.length === 0 && (
          <div className="tm-empty">
            <IconTerminal size={22} />
            <b>A shell you share with Autora</b>
            <p>
              Type a command below. Tab finishes commands, files, git and npm scripts; ↑ brings back what you ran.
              Commands Autora runs show up here too, and the folder you move to is where it starts next.
            </p>
            <div className="tm-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="tm-example" onClick={() => void run(ex)}>{ex}</button>
              ))}
            </div>
          </div>
        )}
        {entries.map((e) => {
          const bad = !e.running && e.exit !== null && e.exit !== 0;
          return (
            <div key={e.id} className={`tm-entry is-${e.by}${e.running ? " is-running" : ""}${bad ? " is-bad" : ""}`}>
              <div className="tm-cmd">
                <span className="tm-ps">{short(e.cwd, home)}</span>
                <span className="tm-dollar">$</span>
                <code className="tm-line">{e.command}</code>
                {e.by === "agent" && <span className="tm-by" title="Autora ran this with its terminal tool">Autora</span>}
                <span className="tm-acts">
                  <button className="tm-act" onClick={() => { setLine(e.command); setCaret(e.command.length); field.current?.focus(); }} title="Put it back in the line" aria-label="Put it back in the line">
                    <IconRotateCcw size={12} />
                  </button>
                  {e.output && (
                    <button className="tm-act" onClick={() => copy(e)} title="Copy the output" aria-label="Copy the output">
                      {copied === e.id ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    </button>
                  )}
                </span>
              </div>
              {e.output && <pre className="tm-out"><Output text={e.output} /></pre>}
              <div className="tm-foot">
                {e.running ? (
                  <>
                    <span className="attach-spin" aria-hidden="true" />
                    <span>running · {duration(Math.max(0, Date.now() - e.started))}</span>
                    {e.by === "person" && <button className="tm-stop" onClick={stop}><IconStop size={11} />Stop</button>}
                  </>
                ) : (
                  <span className={bad ? "tm-bad" : "tm-ok"}>{bad ? `exit ${e.exit}` : "done"}{e.ms !== null ? ` · ${duration(e.ms)}` : ""}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {away && (
        <button className="tm-latest" onClick={toBottom}><IconArrowDown size={12} />Latest</button>
      )}

      <div className="tm-dock">
        {menu && menu.items.length > 0 && (
          <ul className="tm-menu" role="listbox" aria-label="Suggestions">
            {menu.items.slice(0, 40).map((item, i) => (
              <li
                key={`${item.kind}-${item.text}`}
                role="option"
                aria-selected={i === pick}
                className={`tm-item is-${item.kind}${i === pick ? " is-on" : ""}`}
                // Mouse down, not click: the line keeps its focus (and a phone keeps its keyboard) while one is chosen.
                onMouseDown={(ev) => { ev.preventDefault(); apply(item); }}
                ref={(el) => { if (el && i === pick && picked) el.scrollIntoView({ block: "nearest" }); }}
              >
                <span className="tm-item-ico" aria-hidden="true">
                  {item.kind === "dir" ? <IconFolder size={13} /> : item.kind === "file" ? <IconFile size={13} /> : item.kind === "history" ? <IconRotateCcw size={13} /> : <IconZap size={13} />}
                </span>
                <span className="tm-item-text">{item.text}</span>
                {item.hint && <em className="tm-item-hint">{item.hint}</em>}
              </li>
            ))}
          </ul>
        )}
        {tip && <div className="tm-tip" role="note">{tip}</div>}
        {coarse && (
          <div className="tm-keys" role="toolbar" aria-label="Keys">
            {[
              { label: "Tab", on: () => (menu?.items.length ? tab() : ghost ? (setLine(line + ghost), setCaret(line.length + ghost.length)) : undefined), accent: true },
              { label: "↑", on: () => recall(-1) },
              { label: "↓", on: () => recall(1) },
              { label: "Ctrl+C", on: () => (running ? stop() : (setLine(""), setCaret(0), setMenu(null))) },
              { label: "/", on: () => insert("/") },
              { label: "~", on: () => insert("~/") },
              { label: "-", on: () => insert("-") },
              { label: "|", on: () => insert(" | ") },
              { label: ".", on: () => insert(".") },
              { label: "\"", on: () => insert("\"") },
            ].map((k) => (
              // Pointer down, not click: the line must not lose its focus, or the keyboard goes away with it.
              <button key={k.label} type="button" className={`tm-key${k.accent ? " is-accent" : ""}`} onPointerDown={(ev) => { ev.preventDefault(); k.on(); }}>{k.label}</button>
            ))}
          </div>
        )}
        <div className="tm-input">
          <span className="tm-ps" title={cwd}>{prompt}</span>
          <span className="tm-dollar">$</span>
          <div className="tm-field">
            <div className="tm-ghost" aria-hidden="true"><span className="tm-typed">{line}</span>{ghost}{"​"}</div>
            <textarea
              ref={field}
              className="tm-textarea"
              rows={1}
              value={line}
              placeholder="Type a command"
              aria-label="Terminal command"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
              onChange={(e) => { setLine(e.target.value); setCaret(e.target.selectionStart); walk.current = null; }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKey}
              onBlur={() => window.setTimeout(() => setMenu(null), 120)}
            />
          </div>
          {running ? (
            <button className="tm-go is-stop" onClick={stop} aria-label="Stop the command" title="Stop (Ctrl+C)"><IconStop size={14} /></button>
          ) : (
            <button className="tm-go" onClick={() => void run(line)} disabled={!line.trim()} aria-label="Run" title="Run (Enter)"><IconChevron size={14} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

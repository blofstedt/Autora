import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useFullscreen } from "../lib/fullscreen";
import { IconMaximize, IconMinimize, IconTerminal } from "./Icons";

/**
 * The Terminal window: a real terminal beside the conversation, on the machine Autora runs on (server/termdesk.ts).
 *
 * xterm.js draws it and a websocket joins it to a shell on a pseudo-terminal there, so it behaves as a terminal does:
 * the shell's own completion (Tab) and history (↑), colours, full-screen programs (vim, top, less), Ctrl+C, and a
 * program that asks a question. What the agent runs with its terminal tool is printed into it in a dim colour, and the
 * folder you cd into is where the agent's next command starts.
 *
 * The shell outlives the page: closing the tab or reloading reconnects to the same one with its scrollback, and it is
 * ended when the window is put away.
 *
 * A phone has no Esc, Tab, Ctrl or arrows, so a row of those sits under the screen.
 */

/** The colours of the app, read when the terminal is made, so it matches the theme the person chose. */
function themeFromPage() {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: get("--bg", "#0f1115"),
    foreground: get("--text", "#e6e6e6"),
    cursor: get("--accent", "#7c5cff"),
    selectionBackground: get("--accent-line", "rgba(124,92,255,0.35)"),
  };
}

const KEYS: { label: string; send: string; title: string }[] = [
  { label: "Esc", send: "\x1b", title: "Escape" },
  { label: "Tab", send: "\t", title: "Tab: finish the word" },
  { label: "Ctrl+C", send: "\x03", title: "Stop what is running" },
  { label: "Ctrl+D", send: "\x04", title: "End of input" },
  { label: "↑", send: "\x1b[A", title: "Up: the last command" },
  { label: "↓", send: "\x1b[B", title: "Down" },
  { label: "←", send: "\x1b[D", title: "Left" },
  { label: "→", send: "\x1b[C", title: "Right" },
  { label: "|", send: "|", title: "Pipe" },
  { label: "/", send: "/", title: "Slash" },
  { label: "~", send: "~", title: "Home folder" },
];

export function TerminalWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const [full, setFull] = useFullscreen();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [online, setOnline] = useState(false);

  const input = useCallback((data: string) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", d: data }));
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      scrollback: 5000,
      allowProposedApi: false,
      theme: themeFromPage(),
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    term.current = t;
    const measure = () => { try { fit.fit(); } catch { /* not laid out yet */ } };
    measure();

    let dead = false;
    let retry: number | undefined;
    let tries = 0;

    const sendSize = () => {
      const ws = socket.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "size", cols: t.cols, rows: t.rows }));
    };

    const connect = () => {
      if (dead) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/term/ws?session=${encodeURIComponent(sessionId)}&cols=${t.cols}&rows=${t.rows}`);
      socket.current = ws;
      ws.onopen = () => {
        tries = 0;
        setOnline(true);
        // The shell sends its whole scrollback again on a new connection.
        t.reset();
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data)) as { t?: string; d?: string };
          if (msg.t === "out" && typeof msg.d === "string") t.write(msg.d);
        } catch { /* not ours */ }
      };
      ws.onclose = () => {
        setOnline(false);
        if (dead) return;
        retry = window.setTimeout(connect, Math.min(5000, 400 * 2 ** tries++));
      };
    };
    connect();

    const typed = t.onData((data) => input(data));
    const sized = t.onResize(sendSize);
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    // The theme can change under it (Settings).
    const theme = new MutationObserver(() => { t.options.theme = themeFromPage(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    if (!phone) t.focus();

    return () => {
      dead = true;
      window.clearTimeout(retry);
      typed.dispose();
      sized.dispose();
      watch.disconnect();
      theme.disconnect();
      socket.current?.close();
      socket.current = null;
      t.dispose();
      term.current = null;
    };
  }, [sessionId, phone, input]);

  return (
    <div className={`pdf-window tm-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconTerminal size={14} /></span>
        <span className="pdf-bar-app">Autora Terminal</span>
        <span className="pdf-bar-note">{online ? "This machine's shell" : "Connecting…"}</span>
        <div className="spacer" />
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
      <div className="tm-screen" ref={host} onClick={() => term.current?.focus()} />
      {phone && (
        <div className="tm-keys" role="toolbar" aria-label="Keys a phone does not have">
          {KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              className="tm-key"
              title={k.title}
              // Pressing a key must not take the keyboard away from the terminal.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => { input(k.send); term.current?.focus(); }}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

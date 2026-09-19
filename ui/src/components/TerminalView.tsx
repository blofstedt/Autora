import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * Renders the agent's terminal with xterm.js.
 *
 * The PTY bytes are replayed into a real terminal emulator rather than printed
 * as text, which is the difference between seeing a build's progress bar animate
 * and seeing four hundred lines of escape-code soup.
 *
 * Writes are incremental while streaming forward and a full reset when the
 * scrubber moves backward -- a terminal is a state machine, so you cannot
 * un-write bytes; you can only replay from the start.
 */
export function TerminalView({ data }: { data: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      lineHeight: 1.45,
      letterSpacing: 0.2,
      theme: {
        background: "#0e1016",
        foreground: "#c8cedd",
        cursor: "#6e5bff",
        selectionBackground: "rgba(110,91,255,.28)",
        black: "#0e1016", brightBlack: "#626a7e",
        red: "#fb7185", brightRed: "#fda4af",
        green: "#34d399", brightGreen: "#6ee7b7",
        yellow: "#fbbf24", brightYellow: "#fcd34d",
        blue: "#818cf8", brightBlue: "#a5b4fc",
        magenta: "#c084fc", brightMagenta: "#d8b4fe",
        cyan: "#22d3ee", brightCyan: "#67e8f9",
        white: "#c8cedd", brightWhite: "#edeff5",
      },
      convertEol: true,
      scrollback: 20000,
      // The agent is typing, not the viewer. A blinking cursor in a recording
      // reads as though input is expected.
      cursorBlink: false,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* the host can be unmounted mid-observation */
      }
    });
    observer.observe(hostRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (data.length < writtenRef.current) {
      // Scrubbed backward: reset and replay from the beginning.
      term.reset();
      writtenRef.current = 0;
    }
    if (data.length > writtenRef.current) {
      term.write(data.slice(writtenRef.current));
      writtenRef.current = data.length;
    }
  }, [data]);

  return <div className="terminal-host" ref={hostRef} />;
}

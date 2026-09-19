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
      fontSize: 12,
      fontFamily:
        "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
      theme: {
        background: "#0c0d11",
        foreground: "#d7dae0",
        cursor: "#ff3b6b",
        selectionBackground: "#2a2f3a",
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

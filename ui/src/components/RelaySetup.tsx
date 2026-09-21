import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconMonitor } from "./Icons";

export type RelayStatus = {
  connected: boolean;
  platform: string | null;
  screen: { w: number | null; h: number | null };
  since: number | null;
  ws_url: string;
  download: string;
  install: string;
  run: string;
};

/** Ask the server whether a relay is connected, and keep asking. */
export function useRelay(pollMs = 8000): RelayStatus | null {
  const [status, setStatus] = useState<RelayStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () =>
      fetch("/api/relay")
        .then((r) => r.json())
        .then((body) => { if (alive) setStatus(body); })
        .catch(() => undefined);
    read();
    const timer = window.setInterval(read, pollMs);
    return () => { alive = false; window.clearInterval(timer); };
  }, [pollMs]);

  return status;
}

/**
 * How to get the desktop relay running, with this server's address in it.
 *
 * The relay is the one part of Autora that has to be installed somewhere else,
 * and the instructions used to assume Autora was already installed there:
 * `python -m autora.relay` on a machine with no Autora answers "No module
 * named autora", which reads as the feature being broken rather than as a
 * missing download. So the file is served from here with the address already
 * filled in, and these are the three commands that follow, copyable, with the
 * server's own hostname in them rather than THIS_SERVER.
 */
export function RelaySetup() {
  const relay = useRelay();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback((text: string, id: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(id), () => undefined);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!relay) return null;

  const download = `curl -O ${relay.download}`;
  const windows = `curl.exe -O ${relay.download}`;

  return (
    <section className="set-card">
      <h3>Desktop relay</h3>

      <div className={`relay-state ${relay.connected ? "on" : ""}`}>
        <IconMonitor size={14} />
        {relay.connected ? (
          <span>
            <b>Connected</b>
            {relay.platform ? ` · ${relay.platform}` : ""}
            {relay.screen.w ? ` · ${relay.screen.w}×${relay.screen.h}` : ""}
          </span>
        ) : (
          <span><b>No relay connected.</b> The agent cannot see a desktop yet.</span>
        )}
      </div>

      <p className="jf-hint">
        The relay runs on the machine you want the agent to control — your PC,
        not necessarily the machine Autora is running on. It connects out to
        Autora, so nothing needs to be opened up on your side.
      </p>

      <ol className="relay-steps">
        <li>
          <span>Download it — the copy this server hands out already knows its
            own address, so there is nothing to fill in.</span>
          <Cmd id="dl" text={download} alt={windows} altLabel="Windows"
               copied={copied} onCopy={copy} />
        </li>
        <li>
          <span>Install what it needs.</span>
          <Cmd id="pip" text={relay.install}
               alt={`py -m pip install ${relay.install.replace(/^pip install /, "")}`}
               altLabel="Windows" copied={copied} onCopy={copy} />
        </li>
        <li>
          <span>Run it, and leave it running.</span>
          <Cmd id="run" text={relay.run} alt="py relay.py" altLabel="Windows"
               copied={copied} onCopy={copy} />
        </li>
      </ol>

      <p className="jf-hint">
        Already have Autora installed on that machine? <code>autora relay{" "}
        {relay.ws_url.replace(/^wss?:\/\//, "").replace(/\/ws\/desktop-relay$/, "")}</code>{" "}
        does the same thing.
      </p>

      <details className="relay-trouble">
        <summary>It says it cannot connect</summary>
        <ul>
          <li>
            <b>Is this address reachable from that machine?</b> The relay was
            handed <code>{relay.ws_url}</code>. Open{" "}
            <code>{relay.download.replace(/\/relay\.py$/, "")}</code> in a
            browser there — if the page does not load, neither will the relay.
          </li>
          <li>
            <b>Is Autora listening beyond this machine?</b> <code>autora up</code>{" "}
            binds to <code>127.0.0.1</code> by default, which nothing else on the
            network can reach. Start it with <code>--host 0.0.0.0</code>.
          </li>
          <li>
            <b>"No module named autora"</b> means you ran{" "}
            <code>python -m autora.relay</code> on a machine that does not have
            Autora installed. Use the downloaded <code>relay.py</code> above
            instead; it has no Autora imports.
          </li>
          <li>
            <b>https with Autora's own certificate:</b> add{" "}
            <code>--insecure</code>, or install the certificate from{" "}
            <a href="/autora-ca.crt" download>/autora-ca.crt</a> on that machine.
          </li>
          <li>
            <b>macOS:</b> System Settings → Privacy &amp; Security →
            Accessibility, and tick the terminal you ran it from — screen capture
            works without it, clicking and typing do not.
          </li>
        </ul>
      </details>
    </section>
  );
}

function Cmd({
  id, text, alt, altLabel, copied, onCopy,
}: {
  id: string;
  text: string;
  alt?: string;
  altLabel?: string;
  copied: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  const [which, setWhich] = useState<"main" | "alt">("main");
  const shown = which === "alt" && alt ? alt : text;
  return (
    <div className="relay-cmd">
      <code>{shown}</code>
      {alt && (
        <button
          className="cell-act"
          onClick={() => setWhich(which === "alt" ? "main" : "alt")}
          title={`Show the ${which === "alt" ? "macOS / Linux" : altLabel} version`}
        >
          {which === "alt" ? "macOS / Linux" : altLabel}
        </button>
      )}
      <button className="cell-act" onClick={() => onCopy(shown, id)}>
        {copied === id ? <><IconCheck size={11} /> copied</> : "copy"}
      </button>
    </div>
  );
}

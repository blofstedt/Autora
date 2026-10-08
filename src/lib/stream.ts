import type { AutoraEvent, BrowserState, LiveFrame } from "./types";

type Handlers = {
  onEvents: (events: AutoraEvent[]) => void;
  onStatus: (status: StreamStatus) => void;
  /** A frame of live video. Ephemeral: not part of the log, never replayed,
      and dropped on the floor if nothing is showing it. */
  onFrame?: (frame: LiveFrame) => void;
  /** Whether there is a page open to watch, and where it is. */
  onBrowser?: (state: BrowserState) => void;
  /** The app window: whether it is open, and what has been said about it. */
  onPreview?: (state: unknown) => void;
  /** The PDF window: whether a PDF is open, and what is on it. */
  onPdfDesk?: (state: unknown) => void;
  /** One event for the PDF editor: an engine reply, or the document changing
      under it. The window passes on the ones the editor asked for. */
  onSpectra?: (msg: { event: string; payload: unknown }) => void;
  onVideoDesk?: (state: unknown) => void;
  onVideoCommand?: (cmd: { id: string; name: string; args: Record<string, unknown> }) => void;
  /** Autora 3D's window: whether it is open, and what changed last. */
  onCadDesk?: (state: unknown) => void;
  /** The Terminal window: whether it is open, where it is, and that something moved in it. */
  onTermDesk?: (state: unknown) => void;
  /** Autora Music's window: whether it is open, and what changed last. */
  onStudioDesk?: (state: unknown) => void;
  /** Something only a browser can do, asked of the music window: play, stop, bounce. */
  onStudioCommand?: (cmd: { id: string; name: string; args: Record<string, unknown> }) => void;
  onOfficeDesk?: (state: unknown) => void;
  onOfficePush?: (msg: unknown) => void;
  /** Who has hold of what: surfaces the person has taken, and ones in use. */
  onPresence?: (state: unknown) => void;
};

/**
 * The log so far with newly arrived events added, in seq order.
 *
 * They nearly always arrive in order, so the list is only sorted when a
 * batch actually landed out of it -- sorting all of it on every streamed
 * word was work repeated for nothing on a long thread.
 */
export function mergeEvents(prev: AutoraEvent[], fresh: AutoraEvent[]): AutoraEvent[] {
  if (fresh.length === 0) return prev;
  const next = prev.concat(fresh);
  for (let i = Math.max(1, prev.length); i < next.length; i++) {
    if (next[i - 1].seq > next[i].seq) {
      next.sort((a, b) => a.seq - b.seq);
      break;
    }
  }
  return next;
}

export type StreamStatus =
  | { state: "connecting" }
  | { state: "live"; busy: boolean }
  | { state: "recorded"; length: number }
  | { state: "closed"; error?: string };

/**
 * WebSocket client for one session.
 *
 * Two things it must get right, both consequences of the server persisting
 * events before publishing them:
 *
 *  1. Resume. It tracks the highest seq it has seen and reconnects with
 *     `from_seq`, so a dropped connection or a server-side overflow costs
 *     nothing but a round-trip -- no event is ever lost, only delayed.
 *  2. Dedupe. The server registers the subscriber before reading the backlog,
 *     so an event landing in that seam is delivered twice. Filtering on seq is
 *     cheaper and far more robust than trying to make the seam atomic.
 */
export class SessionStream {
  private ws: WebSocket | null = null;
  private highestSeq = -1;
  private seen = new Set<number>();
  private closedByUser = false;
  private retry = 0;
  private retryTimer: number | null = null;
  private heartbeat: number | null = null;
  /** When anything last arrived on the current socket. */
  private lastHeard = 0;

  constructor(private sessionId: string, private handlers: Handlers) {}

  /* How a socket that has quietly died is noticed. A phone that sleeps, a
     network that changes under it, or a proxy that drops a connection it
     thinks is idle (Umbrel's sits in front of every app) all leave a socket
     that still says OPEN and simply never delivers anything again -- no
     close event, possibly for minutes. The thread then stops moving while
     looking connected. So the client pings, and a socket that has said
     nothing for SILENT_MS is replaced rather than waited on. */
  private static PING_MS = 15000;
  private static SILENT_MS = 40000;
  /** Heard from this recently, a socket is trusted on wake without redialing. */
  private static FRESH_MS = 20000;

  connect() {
    this.closedByUser = false;
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.handlers.onStatus({ state: "connecting" });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const from = this.highestSeq + 1;
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/${this.sessionId}?from_seq=${from}`,
    );
    this.ws = ws;
    this.lastHeard = Date.now();
    this.startHeartbeat();

    // Whether this page is on screen, so the server knows if anybody is
    // looking before it sends the phone a "done".
    ws.onopen = () => this.sendVisibility();
    ws.onmessage = (raw) => {
      // A replaced socket can still deliver its last few messages; they are
      // harmless (seq dedupe) but its status must not overwrite the new one.
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "batch":
          this.handlers.onEvents(this.accept(msg.events));
          break;
        case "event":
          this.handlers.onEvents(this.accept([msg]));
          break;
        case "live":
          this.retry = 0;
          this.handlers.onStatus({ state: "live", busy: !!msg.busy });
          break;
        case "frame":
          // Deliberately not run through `accept`: a frame has no seq and is
          // not deduped or resumed. Missing one costs a sixth of a second of
          // video and nothing else.
          this.handlers.onFrame?.({
            source: msg.source === "desktop" ? "desktop" : msg.source === "preview" ? "preview" : "browser",
            ...(msg.source === "preview" ? { w: Number(msg.w) || undefined, h: Number(msg.h) || undefined } : {}),
            data: String(msg.data ?? ""),
            mime: String(msg.mime ?? "image/jpeg"),
            ts: Number(msg.ts ?? Date.now()),
          });
          break;
        case "browser":
          this.handlers.onBrowser?.(msg.state);
          break;
        case "preview":
          this.handlers.onPreview?.(msg.state);
          break;
        case "pdfdesk":
          this.handlers.onPdfDesk?.(msg.state);
          break;
        case "spectra":
          if (typeof msg.event === "string") this.handlers.onSpectra?.({ event: msg.event, payload: msg.payload });
          break;
        case "opencutdesk":
          this.handlers.onVideoDesk?.(msg.state);
          break;
        case "opencut.command":
          if (typeof msg.id === "string" && typeof msg.name === "string") {
            this.handlers.onVideoCommand?.({ id: msg.id, name: msg.name, args: msg.args && typeof msg.args === "object" ? msg.args : {} });
          }
          break;
        case "officedesk.push":
          this.handlers.onOfficePush?.(msg);
          break;
        case "caddesk":
          this.handlers.onCadDesk?.(msg.state);
          break;
        case "termdesk":
          this.handlers.onTermDesk?.(msg.state);
          break;
        case "studiodesk":
          this.handlers.onStudioDesk?.(msg.state);
          break;
        case "studio.command":
          if (typeof msg.id === "string" && typeof msg.name === "string") {
            this.handlers.onStudioCommand?.({ id: msg.id, name: msg.name, args: msg.args && typeof msg.args === "object" ? msg.args : {} });
          }
          break;
        case "officedesk":
          this.handlers.onOfficeDesk?.(msg.state);
          break;
        case "presence":
          this.handlers.onPresence?.(msg.state);
          break;
        case "end":
          this.handlers.onStatus({ state: "recorded", length: msg.length });
          break;
        case "overflow":
          // The server dropped us because we could not keep up. Resume exactly
          // where it says; the log has everything we missed.
          this.highestSeq = msg.resume_from - 1;
          ws.close();
          break;
        case "error":
          this.handlers.onStatus({ state: "closed", error: msg.error });
          this.closedByUser = true;
          break;
      }
    };

    ws.onclose = () => {
      // Only the current socket gets to decide what happens next. A socket
      // that was already replaced closing late used to schedule a second
      // reconnect, and so a second live socket, on top of the new one.
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      if (this.closedByUser) {
        this.handlers.onStatus({ state: "closed" });
        return;
      }
      // Backoff, capped: a harness left open overnight should not hammer a
      // stopped server, but should reconnect quickly when it comes back.
      const delay = Math.min(500 * 2 ** this.retry, 10000);
      this.retry += 1;
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  /**
   * Called when the page comes back: the app is brought to the front, the
   * phone wakes, the network returns. The socket may have died while nobody
   * was looking, and a pending retry may be sitting out a long backoff that
   * timers in a background tab stretched further still. Nobody should wait
   * for either: if the socket is not demonstrably alive, reconnect now.
   */
  wake() {
    if (this.closedByUser) return;
    const ws = this.ws;
    const alive =
      ws?.readyState === WebSocket.OPEN && Date.now() - this.lastHeard < SessionStream.FRESH_MS;
    if (alive) {
      // Probably fine; a ping settles it within one round-trip.
      this.send({ type: "ping" });
      return;
    }
    if (ws?.readyState === WebSocket.CONNECTING && Date.now() - this.lastHeard < SessionStream.FRESH_MS) {
      return;
    }
    this.retry = 0;
    this.replace();
  }

  /** Drop the current socket without waiting for its close event, which on a
      dead connection can take a very long time, and dial a fresh one. */
  private replace() {
    const old = this.ws;
    this.ws = null;
    this.stopHeartbeat();
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      try {
        old.close();
      } catch {
        // already gone
      }
    }
    this.connect();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (Date.now() - this.lastHeard > SessionStream.SILENT_MS) {
        this.replace();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) this.send({ type: "ping" });
    }, SessionStream.PING_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private accept(events: AutoraEvent[]): AutoraEvent[] {
    const fresh: AutoraEvent[] = [];
    for (const event of events) {
      if (this.seen.has(event.seq)) continue;
      this.seen.add(event.seq);
      if (event.seq > this.highestSeq) this.highestSeq = event.seq;
      fresh.push(event);
    }
    return fresh;
  }

  send(message: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  approve(requestId: string, approved: boolean, remember = false) {
    /* remember: the person pressed "do not ask again". The server writes it
       down as their own standing agreement, so the next call of this kind
       runs without a card. */
    this.send({ type: "policy", request_id: requestId, approved, who: "you", remember });
  }

  interrupt() {
    this.send({ type: "interrupt" });
  }

  /** Tell the server whether this page is on screen right now. */
  sendVisibility() {
    this.send({ type: "visibility", visible: document.visibilityState === "visible" });
  }

  close() {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}

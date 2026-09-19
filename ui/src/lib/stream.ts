import type { AutoraEvent } from "./types";

type Handlers = {
  onEvents: (events: AutoraEvent[]) => void;
  onStatus: (status: StreamStatus) => void;
};

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

  constructor(private sessionId: string, private handlers: Handlers) {}

  connect() {
    this.closedByUser = false;
    this.handlers.onStatus({ state: "connecting" });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const from = this.highestSeq + 1;
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/${this.sessionId}?from_seq=${from}`,
    );
    this.ws = ws;

    ws.onmessage = (raw) => {
      const msg = JSON.parse(raw.data);
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

  approve(requestId: string, approved: boolean) {
    this.send({ type: "policy", request_id: requestId, approved, who: "you" });
  }

  interrupt() {
    this.send({ type: "interrupt" });
  }

  close() {
    this.closedByUser = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}

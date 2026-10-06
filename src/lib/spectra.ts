/**
 * The editor's events, on their way into the frame that holds it.
 *
 * Spectra's renderer asks for the events it wants (it used to listen to Rust),
 * and Autora's server pushes them for the session: engine replies, and
 * `app:openFile` when the document changed under the editor. They arrive on the
 * session stream as `spectra` frames; this is where the window subscribes to
 * them, so the window shows the editor only the ones it asked for.
 *
 * Small on purpose: the frame owns its own state, and nothing here is kept
 * after the window closes.
 */

export interface SpectraEvent {
  /** The name the renderer subscribed to, as its Rust side spelled it. */
  event: string;
  payload: unknown;
}

type Listener = (msg: SpectraEvent) => void;

const listeners = new Set<Listener>();

/** Hear every event the server pushes for this session. */
export function onSpectraEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** One event off the session stream (called from App, where the stream lives). */
export function emitSpectraEvent(msg: SpectraEvent): void {
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch (err) {
      // One window failing to take an event must not stop the others.
      console.error("[spectra] a listener threw", err);
    }
  }
}

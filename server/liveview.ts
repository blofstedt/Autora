/**
 * Live view: the camera in talk mode, on the agent's side.
 *
 * What the person sees of it is their own business -- a small picture in the
 * live bar, drawn from the stream in their own browser. This module is the
 * other half: what lets the agent see what they are showing it while they
 * talk. "Look at this" over a camera is a request that arrives with the
 * picture, and without somewhere for the picture to land it arrives as words.
 *
 * Three rules hold it in place, and all three are about it being a stream
 * rather than a file:
 *
 *  - One frame per conversation, in memory. The device sends about one a
 *    second and each replaces the last; nothing is written to disk, nothing is
 *    kept for later, and a restart takes the lot. This is deliberately the
 *    opposite of the artifacts store: a video call is not a document.
 *  - Fresh means on. A frame stops counting the moment it is older than
 *    FRAME_TTL, so the camera going away -- the page closed, the person
 *    turned it off, the phone lost the network -- reads as "the view is off",
 *    rather than as a still picture from a while ago that the agent might
 *    describe as what is happening now.
 *  - It goes with the turn, and only the turn being answered. See historyFor
 *    in ../server.ts: the newest frame rides on the message the agent is
 *    replying to, and is never re-sent on a later turn.
 */
import { type ChatImage } from "./llm";

/** A frame as it arrived: bytes and type, with the moment they landed. */
export type LiveFrame = { data: Buffer; mime: string; at: number };

/**
 * How long a frame counts as "now".
 *
 * Longer than the gap between two frames at one a second, so an ordinary
 * hiccup in the stream does not read as the camera going away; short enough
 * that turning the view off is felt within a second or two, which is what a
 * person expects from a switch.
 */
export const FRAME_TTL_MS = 4_000;

/** Frames are small by construction (the sender scales them), so this is a
    refusal, not a resize: a stream that suddenly sends tens of megabytes is
    something else wearing the same URL. */
export const MAX_FRAME_BYTES = 2_000_000;

/** What the vendors accept as a picture. The device sends JPEG; PNG is here
    because a screenshot from a canvas may arrive as one. */
export const FRAME_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The newest frame per conversation. Never more than one each. */
const frames = new Map<string, LiveFrame>();

/** Keep a frame, replacing whatever was there. Returns false when it is not a
    picture worth keeping, so the route can say so rather than pretending. */
export function putFrame(sessionId: string, data: Buffer, mime: string, now = Date.now()): boolean {
  if (!sessionId || !FRAME_MIMES.has(mime) || data.byteLength === 0) return false;
  if (data.byteLength > MAX_FRAME_BYTES) return false;
  frames.set(sessionId, { data, mime, at: now });
  return true;
}

/** The newest frame, if the view is on -- null once it has gone stale. */
export function latestFrame(sessionId: string, now = Date.now()): LiveFrame | null {
  const frame = frames.get(sessionId);
  if (!frame) return null;
  if (now - frame.at > FRAME_TTL_MS) {
    /* Gone stale: drop it rather than leave it to be found again if the device
       comes back. The bytes were only ever here to be looked at once. */
    frames.delete(sessionId);
    return null;
  }
  return frame;
}

/** Is the camera on in this conversation? */
export function liveViewOn(sessionId: string, now = Date.now()): boolean {
  return latestFrame(sessionId, now) !== null;
}

/** The view stopped, or the conversation did. Whatever is held goes now. */
export function clearFrame(sessionId: string): void {
  frames.delete(sessionId);
}

/** Nothing is held for a conversation that no longer exists, and this is how
    the tests get a clean slate. */
export function forgetAll(): void {
  frames.clear();
}

/** A frame as a picture for the model, or null when it is too large to send
    (the caller still has the frame itself; this is about the vendor's limit). */
export function frameImage(frame: LiveFrame): ChatImage | null {
  if (frame.data.byteLength > 3_500_000) return null;
  return { mime: frame.mime, data: frame.data.toString("base64") };
}

/**
 * The line the model reads beside the picture.
 *
 * It has to do three things words alone cannot: say that this is the camera
 * rather than something the person attached or dug up, say that it is live --
 * so "what is this" is answered about now and not about a still -- and say
 * what is not here, because the agent only ever has the one frame and a person
 * moving the camera around will otherwise be told about what has already gone.
 */
export function liveViewNote(frame: LiveFrame, now = Date.now()): string {
  const ago = Math.max(0, Math.round((now - frame.at) / 1000));
  return `[Autora: live view is on -- the picture with this message is the newest frame from the person's camera, ${ago}s old. It is a stream, so this is the only frame: earlier ones were never kept, and you cannot rewind. Look again with camera_look while the view is on.]`;
}

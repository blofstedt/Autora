/**
 * Live view, from the page's side.
 *
 * The camera the person switches on in talk mode is two things at once: a
 * picture for them -- a small live thumbnail in the bar, drawn in their own
 * browser, so watching yourself costs nothing and no round trip -- and a
 * stream for the agent at about a frame a second, so that "look at this"
 * arrives with the thing being shown rather than as words alone.
 *
 * What goes to the console is deliberately thin: a scaled JPEG, one frame at a
 * time, each replacing the last. No recording, no queue, nothing kept -- the
 * server holds one frame in memory and the rest were never anywhere.
 *
 * Everything is torn down the moment the view is switched off or talk mode
 * ends: the tracks are stopped, the timer cleared, and the console told, so
 * the agent stops being shown a picture nobody is taking any more.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The longer edge of a frame that goes to the console. Big enough that what
    is being held up can be read, small enough to send once a second without
    thinking about it. */
export const FRAME_MAX_EDGE = 640;

/** About a frame a second -- asked for by the person, and enough: the agent
    looks at a thing, it does not watch a video. */
export const FRAMES_PER_SECOND = 1;

const FRAME_QUALITY = 0.6;

export type LiveViewState = {
  /** The camera is open and frames are going. */
  on: boolean;
  /** Why it is not, when it is not. */
  error: string | null;
  facing: "user" | "environment";
  /** The element the picture is drawn into, while the view is on. */
  attach: (el: HTMLVideoElement | null) => void;
  /** Front camera, back camera. A thing held up is usually for the back one. */
  flip: () => void;
};

/**
 * The camera to open, for the one the person has chosen.
 *
 * The back camera is asked for exactly, and that is not pedantry: an inexact
 * `facingMode` is a preference a phone is free to ignore, and the ones that do
 * ignore it hand over the front camera -- which, for a view whose whole purpose
 * is to show the agent the thing in your other hand, is the one camera that is
 * no use. An exact request rather than a constraint on its own, because exact
 * fails outright where nothing can meet it, and that failure is caught below.
 */
function wanted(facing: "user" | "environment") {
  return { facingMode: { exact: facing }, width: { ideal: 1280 }, height: { ideal: 720 } };
}

/** The same camera, asked for as a preference: the fallback for a device with
    only one of them, or a browser that ignores exactness instead of failing. */
function preferred(facing: "user" | "environment") {
  return { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } };
}

/**
 * Open the camera, the exact request first and the preference second. Only the
 * two ways the exact request can be refused for the camera's sake fall
 * through: a permission refusal or a missing camera entirely must still be
 * reported, because asking again cannot fix either.
 */
async function openCamera(facing: "user" | "environment"): Promise<MediaStream> {
  const ask = (video: MediaTrackConstraints) => {
    const devices = navigator.mediaDevices;
    // A page that has no camera API at all fails here rather than being
    // guarded for, and the caller reports it in words.
    if (!devices) throw new Error("no camera here");
    return devices.getUserMedia({ video, audio: false });
  };
  try {
    return await ask(wanted(facing));
  } catch (err: any) {
    const theirFault = err?.name === "NotAllowedError" || err?.name === "SecurityError";
    if (theirFault) throw err;
    return await ask(preferred(facing));
  }
}

/** A JPEG of what the camera has now, scaled to something worth sending. */
async function grab(video: HTMLVideoElement): Promise<Blob | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const paint = canvas.getContext("2d");
  if (!paint) return null;
  paint.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", FRAME_QUALITY));
}

/**
 * The camera, while `on` is true, in the conversation `sessionId` is in.
 *
 * The frames carry no state of their own: the server keeps the newest one for
 * a few seconds and treats it as "the view is on" for that long, which is why
 * turning this off ends with telling the server rather than waiting for it to
 * notice.
 */
export function useLiveView(sessionId: string | null, on: boolean): LiveViewState {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  const video = useRef<HTMLVideoElement | null>(null);
  /** One frame in flight at a time: a slow upload must not queue up behind
      itself, or the console is shown a backlog of moments that are gone. */
  const sending = useRef(false);

  const attach = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
    if (el && stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [stream]);

  const flip = useCallback(() => {
    setFacing((now) => (now === "user" ? "environment" : "user"));
  }, []);

  // Open the camera, and close it again the moment the view goes off or the
  // page leaves. Changing camera restarts it, because facingMode is a
  // constraint on the stream rather than something that can be changed on one.
  useEffect(() => {
    if (!on) return;
    let live = true;
    let opened: MediaStream | null = null;
    setError(null);
    openCamera(facing)
      .then((s) => {
        opened = s;
        // Switched off while the permission prompt was still up.
        if (!live) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        setStream(s);
      })
      .catch((err: any) => {
        if (!live) return;
        const said = err?.name === "NotAllowedError"
          ? "The camera was blocked — allow it in the browser, or leave the view off."
          : "No camera here — leave the view off.";
        setError(said);
      });
    return () => {
      live = false;
      opened?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [on, facing]);

  // Draw the picture, as soon as there is a stream and an element to draw into.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (!stream) {
      el.srcObject = null;
      return;
    }
    el.srcObject = stream;
    void el.play().catch(() => undefined);
  }, [stream]);

  // The frames. One a second, skipping anything while the page is hidden: a
  // camera in a background tab is being sent to nobody.
  useEffect(() => {
    if (!on || !sessionId) return;
    const timer = window.setInterval(() => {
      const el = video.current;
      if (!el || !el.videoWidth || document.hidden || sending.current) return;
      sending.current = true;
      void grab(el)
        .then(async (blob) => {
          if (!blob) return;
          await fetch(`/api/sessions/${sessionId}/frame`, {
            method: "POST",
            headers: { "Content-Type": "image/jpeg", "x-frame-type": "image/jpeg" },
            body: blob,
          });
        })
        .catch(() => undefined)
        .finally(() => { sending.current = false; });
    }, Math.round(1000 / FRAMES_PER_SECOND));
    return () => window.clearInterval(timer);
  }, [on, sessionId]);

  /* Switching the view off -- and leaving talk mode entirely, which unmounts
     this -- tells the console rather than leaving it to work the fact out from
     the frames stopping: otherwise the next turn, up to the length of the
     grace window later, would be handed a picture a few seconds old and taken
     to be now. */
  useEffect(() => {
    if (!on || !sessionId) return;
    const id = sessionId;
    return () => {
      void fetch(`/api/sessions/${id}/frame`, { method: "DELETE" }).catch(() => undefined);
    };
  }, [on, sessionId]);

  return { on: on && stream !== null, error, facing, attach, flip };
}

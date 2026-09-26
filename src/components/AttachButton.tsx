import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCamera, IconPaperclip, IconX } from "./Icons";

/**
 * Two ways to put a file in the message instead of describing it: pick one,
 * or take the photo here.
 *
 * Both end in the same place. The file goes up to the artifacts store as soon
 * as it exists -- a chip appears beside the box while it uploads and stays
 * there until the message goes, so nothing is lost by pressing Send early --
 * and what the message carries is its id. That also means a file picked by
 * mistake is one tap on the chip to drop, rather than something already sent.
 *
 * The camera button is here rather than only on a phone because the thing it
 * is for is showing the agent something in front of you: a screen, a drawing,
 * a part number on a box. Where the browser has no camera API at all -- a page
 * served over plain http, most desktops behind a proxy -- it falls back to the
 * file picker a phone opens straight into the camera, which is the same
 * gesture on the device that has one.
 */

type Picked = {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** Nothing may be added while the turn's upload is still running. */
  busy?: boolean;
  onTrouble?: (message: string) => void;
};

/** Frames taken here are bounded: a photo that shows a part number does not
    need to be twelve megapixels, and every byte of it is read back by the
    model, on this turn and no other. */
const SHOT_MAX = 1600;

export function AttachButton({ onFiles, disabled, busy }: Picked) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Cleared before the hand-off: picking the same file twice in a row
          // fires no change event, and that reads as a button that stopped
          // working.
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <button
        type="button"
        className="btn ghost labeled attach-btn"
        onClick={() => picker.current?.click()}
        disabled={disabled}
        title="Attach a file"
        aria-label="Attach a file"
      >
        {busy ? <span className="attach-spin" aria-hidden="true" /> : <IconPaperclip size={18} />}
        <span className="btn-label">Attach</span>
      </button>
    </>
  );
}

export function CameraButton({ onFiles, disabled, onTrouble }: Picked) {
  const native = useRef<HTMLInputElement>(null);
  const [shooting, setShooting] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const streamable =
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";

  const openPicker = () => {
    const box = native.current;
    if (!box) return;
    setTrouble(null);
    box.click();
  };

  return (
    <>
      {/* The fallback is also the phone's own camera: on a page with no
          getUserMedia this is the only way to take a picture, and with
          `capture` it opens straight into the camera app rather than a file
          browser. */}
      <input
        ref={native}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <button
        type="button"
        className="btn ghost labeled attach-btn"
        onClick={() => (streamable ? setShooting(true) : openPicker())}
        disabled={disabled}
        title={streamable ? "Take a photo" : "Take a photo (opens the camera on a phone)"}
        aria-label="Take a photo and attach it"
      >
        <IconCamera size={18} />
        <span className="btn-label">Photo</span>
      </button>

      {shooting && (
        <CameraSheet
          onShot={(file) => {
            setShooting(false);
            onFiles([file]);
          }}
          onClose={() => setShooting(false)}
          onUsePicker={() => {
            setShooting(false);
            openPicker();
          }}
          onTrouble={(message) => {
            setTrouble(message);
            onTrouble?.(message);
          }}
        />
      )}
      {trouble && !shooting && (
        <button className="hint voice-note" onClick={() => setTrouble(null)} title="Dismiss">
          {trouble}
        </button>
      )}
    </>
  );
}

/**
 * The live picture, over everything, until the shutter or the way out.
 *
 * Portalled to the body for the same reason the image lightbox is: a fixed
 * element inside a card that has an animation on it is positioned against the
 * card, not the window, and lands the right size in the wrong box.
 *
 * The tracks are stopped on the way out however the sheet is closed. A camera
 * light left on after the photo was taken is the kind of thing you only find
 * out from the indicator, days later.
 */
function CameraSheet({
  onShot, onClose, onUsePicker, onTrouble,
}: {
  onShot: (file: File) => void;
  onClose: () => void;
  onUsePicker: () => void;
  onTrouble: (message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const troubleRef = useRef(onTrouble);
  troubleRef.current = onTrouble;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } }, audio: false })
      .then((s) => {
        stream = s;
        // Closed while the permission prompt was still up: nothing to show.
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
        setReady(true);
      })
      .catch((err: any) => {
        const said = err?.name === "NotAllowedError"
          ? "The camera was blocked — allow it in the browser, or attach a file instead."
          : "No camera here — attach a file instead.";
        setError(said);
        troubleRef.current(said);
      });
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const shoot = useCallback(() => {
    const box = video.current;
    if (!box) return;
    const w = box.videoWidth;
    const h = box.videoHeight;
    if (!w || !h) return;
    const scale = Math.min(1, SHOT_MAX / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(box, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("The photo could not be taken — attach a file instead.");
          return;
        }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        onShot(new File([blob], `photo-${stamp}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.85,
    );
  }, [onShot]);

  return createPortal(
    <div className="cam-sheet" role="dialog" aria-modal="true" aria-label="Take a photo">
      <div className="cam-frame">
        <video ref={video} playsInline muted autoPlay />
        {error && <p className="cam-error">{error}</p>}
        <div className="cam-acts">
          <button type="button" className="cam-shutter" onClick={shoot} disabled={!ready || Boolean(error)}
            title="Take the photo" aria-label="Take the photo">
            <span />
          </button>
          {error && (
            <button type="button" className="btn ghost" onClick={onUsePicker}>Attach a file instead</button>
          )}
          <button type="button" className="btn ghost" onClick={onClose} title="Close the camera">
            <IconX size={14} /> Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useCallback, useEffect, useState } from "react";
import { IconArrow, IconX } from "./Icons";

/**
 * "You can install this."
 *
 * Autora is a PWA (public/manifest.webmanifest, public/sw.js) and always has
 * been -- but the README never said so and nothing in the app ever offered it,
 * so the only people who found it were the ones who go looking in a browser
 * menu. This is the offer, made once and then remembered.
 *
 * Two browsers need two different things, which is why this is not one prompt:
 *
 *  - Chrome, Edge and Android fire `beforeinstallprompt`, and the event is the
 *    install: kept until it is used, and handed back by calling prompt() from
 *    the press itself, which is the only place it is allowed.
 *  - Safari on iOS fires nothing and has no API. Share -> Add to Home Screen is
 *    the only route, so that is what the card says, written out.
 *
 * And one state is worth checking first: a page already running installed
 * (display-mode: standalone) has nothing to be told. Nothing appears on a
 * browser that cannot install at all, because a card that says "your browser
 * is not supported" is worse than silence.
 */

const KEY = "autora.install.dismissed";
/** A month: long enough not to nag, short enough to be seen again by anyone
    who changes their mind, on the device they changed it on. */
const FORGET_MS = 30 * 24 * 3600_000;

/** Chrome's event is not in lib.dom yet. */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice?: Promise<{ outcome: string }> };

function dismissedRecently(): boolean {
  try {
    const at = Number(window.localStorage.getItem(KEY) ?? 0);
    return Number.isFinite(at) && at > 0 && Date.now() - at < FORGET_MS;
  } catch {
    return false;
  }
}

function remember() {
  try {
    window.localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* private mode: the card simply comes back next time */
  }
}

function alreadyInstalled(): boolean {
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    // iOS: a home-screen copy reports itself here and nowhere else.
    return Boolean((window.navigator as unknown as { standalone?: boolean }).standalone);
  } catch {
    return false;
  }
}

/** iOS Safari, which fires no install event and has no API for one. */
function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document);
  return ios && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

export function InstallApp() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (alreadyInstalled() || dismissedRecently()) return;

    const onPrompt = (e: Event) => {
      // The browser's own mini-infobar, replaced by this card.
      e.preventDefault();
      setEvent(e as InstallEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    /* Safari is given a moment before the card appears: it lands on top of the
       composer, and the first thing anybody does here is type. A card that is
       there before the page has settled reads as an advertisement. */
    const timer = isIosSafari() ? window.setTimeout(() => { setIos(true); setShow(true); }, 12_000) : null;

    const onInstalled = () => { setShow(false); remember(); };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const install = useCallback(async () => {
    if (!event) return;
    /* Called from the press: the event is spent once, and a prompt() in a
       timeout or a load handler is ignored by every browser that has one. */
    await event.prompt().catch(() => undefined);
    const choice = await event.userChoice?.catch(() => undefined);
    if (choice?.outcome === "accepted") setShow(false);
    else setShow(false);
    setEvent(null);
  }, [event]);

  const dismiss = useCallback(() => {
    remember();
    setShow(false);
  }, []);

  if (!show) return null;

  return (
    <div className="notices install-offer">
      <div className="notice is-info">
        <div className="notice-main" style={{ cursor: "default" }}>
          <b>Install Autora on this device</b>
          <span>
            {ios
              ? "Share, then Add to Home Screen — it opens full screen, with its own icon."
              : "Its own window and icon, and it opens without waiting for the network."}
          </span>
        </div>
        {event && (
          <button className="btn primary notice-act" onClick={() => void install()}>
            Install <IconArrow size={12} />
          </button>
        )}
        <button className="notice-x btn icon ghost" onClick={dismiss} aria-label="Not now">
          <IconX size={13} />
        </button>
      </div>
    </div>
  );
}

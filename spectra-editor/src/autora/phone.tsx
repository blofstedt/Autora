/**
 * The PDF editor on a phone: the paired-down one.
 *
 * Spectra's window is a desktop application (menu bar, toolbar, tabs, a side rail, a tool dock with thirty tools). On a
 * phone that is a screen of chrome around a page you cannot read. This keeps what a thumb does well -- read, mark up,
 * fill and sign, find, undo -- as one bar at the bottom, and `autora.css` (the `.autora-phone` rules) puts the rest away.
 * Everything is still there on a desktop, and the agent can do any of it from the chat. The bar drives Spectra's own
 * commands, so there is no second implementation to keep in step: what it opens is the editor's own tool.
 *
 * Only mounted when the window says it is a phone (`?phone=1`, from components/SpectraWindow.tsx).
 */
import { createRoot } from "react-dom/client";
import { invokeCommand } from "../renderer/commands/context";
import type { CommandId } from "../renderer/commands/registry";

const ICONS: Record<string, string> = {
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  markup: "m4 20 4-1L19 8l-3-3L5 16l-1 4ZM14 7l3 3",
  sign: "M3 17c3-6 5-9 6-9s0 6 2 6 3-4 5-4 2 4 5 4M3 21h18",
  find: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-5-5",
};

const BUTTONS: { id: string; label: string; icon: string; command: CommandId; mark?: string }[] = [
  { id: "undo", label: "Undo", icon: "undo", command: "edit.undo" },
  { id: "redo", label: "Redo", icon: "redo", command: "edit.redo" },
  { id: "markup", label: "Mark up", icon: "markup", command: "tools.open.comment" as CommandId, mark: "comment" },
  { id: "sign", label: "Fill & sign", icon: "sign", command: "tools.open.fillsign" as CommandId, mark: "fillsign" },
  { id: "find", label: "Find", icon: "find", command: "edit.find" },
];

function PhoneBar() {
  return (
    <nav className="autora-phonebar" aria-label="PDF tools" data-testid="phone-bar">
      {BUTTONS.map((b) => (
        <button
          key={b.id}
          type="button"
          className="autora-phonebar-btn"
          data-phone={b.id}
          // A tap on a button must not take the page's focus (and the on-screen keyboard) with it.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => { invokeCommand(b.command); }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ICONS[b.icon]} />
          </svg>
          <span>{b.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** Whether this frame was opened as the phone's. Read once: a window does not change its mind. */
export const isPhone = (): boolean => new URLSearchParams(location.search).get("phone") === "1";

/** The class that turns the desktop chrome off (autora.css), before the first paint, and the bar once there is a page to hold. */
export function installPhone(): void {
  if (!isPhone()) return;
  document.documentElement.classList.add("autora-phone");
  const mount = () => {
    if (document.getElementById("autora-phone-root")) return;
    const host = document.createElement("div");
    host.id = "autora-phone-root";
    document.body.appendChild(host);
    createRoot(host).render(<PhoneBar />);
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
}

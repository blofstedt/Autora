import { useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconFolder, IconMessage, IconX } from "./Icons";

export type Folder = { id: string; name: string; ts: number };

/** Where to move the picked files: a folder, a new one, or back to their chats. */
export type FolderChoice = { folder: string | null; name?: string; chats: boolean };

/**
 * The "Move to folder" dialog of the Artifacts page: one folder to pick (or a
 * new one named here, or none: back in the chat each file came from), and
 * whether the chats those files came from go too, so what they make next
 * lands in the same place.
 */
export function FolderPicker({
  folders, count, onClose, onPick,
}: {
  folders: Folder[];
  count: number;
  onClose: () => void;
  onPick: (choice: FolderChoice) => void;
}) {
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [chats, setChats] = useState(true);
  const fresh = name.trim();
  const ready = fresh.length > 0 || picked !== undefined;
  const title = count === 1 ? "Move 1 file to…" : `Move ${count} files to…`;

  const row = (id: string | null, label: string, meta: string) => {
    const on = !fresh && picked === id;
    return (
      <button
        key={id ?? "chat"}
        type="button"
        className={`lib-row${on ? " is-on" : ""}`}
        role="radio"
        aria-checked={on}
        onClick={() => { setPicked(id); setName(""); }}
      >
        <span className="lib-tick" aria-hidden="true">{on && <IconCheck size={12} />}</span>
        <span className="lib-icon">{id ? <IconFolder size={16} /> : <IconMessage size={16} />}</span>
        <span className="lib-main">
          <b>{label}</b>
          <em>{meta}</em>
        </span>
      </button>
    );
  };

  const confirm = () => {
    if (fresh) onPick({ folder: null, name: fresh, chats });
    else if (picked !== undefined) onPick({ folder: picked, chats });
  };

  return createPortal(
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className="modal lib-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <b>{title}</b>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>
        <div className="modal-body lib-body" role="radiogroup" aria-label="Folders">
          <form className="lib-new" onSubmit={(e) => { e.preventDefault(); confirm(); }}>
            <input
              placeholder="New folder name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              aria-label="New folder name"
            />
          </form>
          {folders.map((f) => row(f.id, f.name, "Folder"))}
          {row(null, "Back to its chat", "Each file in the folder of the chat it came from")}
          <label className="folder-chats">
            <input type="checkbox" checked={chats} onChange={(e) => setChats(e.target.checked)} />
            <span>Move the chats they came from too, so what those chats make next goes there</span>
          </label>
        </div>
        <div className="modal-foot lib-foot">
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready} onClick={confirm}>
            {fresh ? "Make and move" : "Move"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

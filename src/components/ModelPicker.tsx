import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconSearch, IconX } from "./Icons";

/** A model as a vendor's list supplies it. */
type Option = {
  id: string;
  label: string;
  input: number;
  output: number;
  note?: string;
  /** False for a model the vendor listed without publishing a price. */
  priced?: boolean;
};

const cost = (m: Option) =>
  m.priced === false ? "price not published" : `$${m.input} in / $${m.output} out per 1M`;

/**
 * Choose which model a vendor calls.
 *
 * This was a bare <select>, so the one control in Settings that opens
 * something rendered as the operating system's own menu in its own font --
 * light grey over a dark app, no prices, no notes, and nothing to say which
 * model is on now. It is a card over the page like every other picker here
 * (Sessions, a memory, the spend card), each row carrying the two facts the
 * system menu had no room for: what the model costs and what it is for.
 *
 * A long list gets a search box, because OpenRouter's is hundreds of models
 * and a menu you scroll through is not a way to find one of them.
 */
export function ModelPicker({
  vendor, models, model, busy, listable, onPick, onCustom, onRefresh, onClose,
}: {
  vendor: string;
  models: Option[];
  /** The model in use now, ticked in the list. */
  model: string;
  busy: boolean;
  /** Whether this vendor can be asked for a fresh list. */
  listable: boolean;
  onPick: (id: string) => void;
  onCustom: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(".mp-row.on")?.scrollIntoView({ block: "nearest" });
    // Straight into the search box when there is a keyboard -- not on a phone,
    // where focusing it would throw the on-screen keyboard over the list.
    if (models.length > 8 && window.matchMedia?.("(pointer: fine)").matches) search.current?.focus();
  }, [models.length]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((m) =>
      m.label.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle));
  }, [models, query]);

  return createPortal(
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className="modal mp-modal"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a ${vendor} model`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-top">
          <b>Choose a model</b>
          <span className="mp-vendor">{vendor}</span>
          <div className="spacer" />
          {listable && (
            <button className="btn ghost" onClick={onRefresh} disabled={busy}>
              {busy ? "Asking…" : "Refresh"}
            </button>
          )}
          <button className="btn icon ghost" onClick={onClose} aria-label="Close model list">
            <IconX size={14} />
          </button>
        </div>

        {models.length > 8 && (
          <label className="ses-search">
            <IconSearch size={14} />
            <input
              ref={search}
              type="search"
              placeholder={`Search ${models.length} models`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search models"
            />
          </label>
        )}

        <div className="modal-body">
          {models.length === 0 && (
            <p className="jf-hint">
              This vendor has not offered a list. Type a model id instead.
            </p>
          )}
          {models.length > 0 && shown.length === 0 && (
            <p className="jf-hint">No model matches “{query.trim()}”.</p>
          )}
          {shown.map((m) => (
            <button
              key={m.id}
              className={`mp-row ${m.id === model ? "on" : ""}`}
              onClick={() => onPick(m.id)}
              aria-current={m.id === model}
            >
              <span className="mp-main">
                <b>{m.label}</b>
                <em>{m.note ? `${m.note} · ${cost(m)}` : cost(m)}</em>
              </span>
              {m.id === model && <IconCheck size={14} />}
            </button>
          ))}
        </div>

        <div className="modal-foot">
          <button className="setup-more" onClick={onCustom}>
            Type a model id…
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

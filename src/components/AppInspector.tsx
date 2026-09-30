import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { px, toHex, type PreviewApi } from "../lib/appApi";
import type { ElementInfo, Rect, StyleChange } from "../lib/preview";
import { IconX } from "./Icons";

/**
 * What you do with a selection: say what should change, and -- when words are
 * slow -- show it. Text can be retyped and a handful of styles dragged, and the
 * page changes as you do, so the agent is told "make it this" rather than
 * "make it bigger". Whatever was tried is carried with the comment as a list
 * of before and after, because that is the precise version of the request.
 *
 * Changes are experiments on the live page: they last until the page reloads,
 * which is when the agent's edit arrives and replaces them.
 */

type Nav = "parent" | "child" | "prev" | "next";

const WEIGHTS = ["300", "400", "500", "600", "700", "800"];
const ALIGNS = ["left", "center", "right"] as const;

function name(info: ElementInfo): string {
  return `${info.tag}${info.id ? `#${info.id}` : info.classes[0] ? `.${info.classes[0]}` : ""}`;
}

export function AppInspector({
  api, selection, region, epoch, modal, anchor, onNav, onRemove, onAdd, onClose, onTried,
}: {
  api: PreviewApi;
  selection: ElementInfo[];
  region: Rect | null;
  /** Counts up each time something new is picked (not when the selection is
      stepped to a neighbour): a new pick is a new comment, a step is the same
      comment about the element next door. */
  epoch: number;
  /** A centred sheet over the page (a phone, or a window too small to sit
      beside what is selected). */
  modal: boolean;
  /** Where it sits in the window when it is not a sheet. */
  anchor: CSSProperties;
  onNav: (dir: Nav) => void;
  onRemove: (selector: string) => void;
  onAdd: (comment: {
    text: string; textEdit?: { from: string; to: string }; styleChanges: StyleChange[];
  }) => Promise<string | null>;
  onClose: () => void;
  /** A change was tried on the page: the window should draw it. */
  onTried: (info: ElementInfo) => void;
}) {
  const primary = selection[selection.length - 1] ?? null;
  const one = selection.length === 1 && !region;
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [css, setCss] = useState<Record<string, string>>({});
  const [before, setBefore] = useState<Record<string, string>>({});
  const [words, setWords] = useState<string | null>(null);
  /** The words as they were before the first retyping: trying a change updates the
      page, and with it what the element says it holds. */
  const [orig, setOrig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const tried = useRef<number | null>(null);

  /* A new pick is a new comment; stepping to a neighbour keeps what was typed
     and, because the keys that step are still under the person's fingers,
     leaves the focus where it is. */
  useEffect(() => {
    setText("");
    setEditing(false);
    setError(null);
    field.current?.focus({ preventScroll: true });
  }, [epoch]);
  /* What was tried on the page belongs to the element it was tried on. */
  const where = region ? "region" : primary?.selector ?? "";
  useEffect(() => {
    setCss({});
    setBefore({});
    setWords(null);
    setOrig(null);
  }, [where, epoch]);

  const base = primary?.styles ?? {};
  const value = (prop: string, fallback: string) => css[prop] ?? fallback;

  /** Try a style on every selected element, a moment after the last change. */
  const apply = (changes: Record<string, string>) => {
    setCss((c) => ({ ...c, ...changes }));
    if (tried.current) window.clearTimeout(tried.current);
    tried.current = window.setTimeout(async () => {
      let last: ElementInfo | null = null;
      for (const el of selection) {
        const r = await api.style(el.selector, changes);
        if (!r.ok) { setError(r.error); return; }
        setError(null);
        setBefore((b) => {
          const next = { ...b };
          for (const [k, v] of Object.entries(r.data.before ?? {})) if (next[k] === undefined) next[k] = v;
          return next;
        });
        if (el === primary) last = r.data.info;
      }
      if (last) onTried(last);
    }, 120);
  };

  const retype = (next: string) => {
    if (primary) setOrig((o) => o ?? primary.fullText);
    setWords(next);
    if (tried.current) window.clearTimeout(tried.current);
    tried.current = window.setTimeout(async () => {
      if (!primary) return;
      const r = await api.text(primary.selector, next);
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      onTried(r.data.info);
    }, 150);
  };

  const undo = async () => {
    for (const el of selection) await api.reset(el.selector);
    setCss({});
    setBefore({});
    setWords(null);
    setOrig(null);
    if (primary) { const r = await api.sel(primary.selector); if (r.ok && r.data.info) onTried(r.data.info as ElementInfo); }
  };

  const changes: StyleChange[] = useMemo(
    () => Object.entries(css).map(([property, to]) => ({ property, from: before[property] ?? "", to })).filter((c) => c.from !== c.to),
    [css, before],
  );
  const textEdit = one && words !== null && orig !== null && words !== orig
    ? { from: orig, to: words }
    : undefined;
  const ready = text.trim().length > 0 || changes.length > 0 || !!textEdit;

  const add = async () => {
    if (!ready || saving) return;
    setSaving(true);
    const problem = await onAdd({ text: text.trim(), textEdit, styleChanges: changes });
    setSaving(false);
    if (problem) setError(problem);
  };

  const box = (
    <div
      className={`app-pop${modal ? " is-modal" : ""}`}
      style={modal ? undefined : anchor}
      role="dialog"
      aria-label={region ? "Comment on a region" : "Comment on the selection"}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void add(); }
        if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      }}
    >
      <div className="app-pop-head">
        {region ? (
          <b>Region <span>{Math.round(region.w)}×{Math.round(region.h)}</span></b>
        ) : selection.length > 1 ? (
          <b>{selection.length} elements</b>
        ) : primary ? (
          <b title={primary.selector}>{name(primary)} <span>{Math.round(primary.rect.w)}×{Math.round(primary.rect.h)}</span></b>
        ) : null}
        <button type="button" className="app-x" onClick={onClose} aria-label="Cancel"><IconX size={14} /></button>
      </div>

      {!region && (
        <div className="app-nav" role="group" aria-label="Move the selection">
          <button type="button" onClick={() => onNav("parent")} title="The element around it (↑)">↑ Outer</button>
          <button type="button" onClick={() => onNav("child")} title="The element inside it (↓)">↓ Inner</button>
          <button type="button" onClick={() => onNav("prev")} title="The one before it (←)">← Before</button>
          <button type="button" onClick={() => onNav("next")} title="The one after it (→)">After →</button>
        </div>
      )}

      {selection.length > 1 && !region && (
        <div className="app-chips">
          {selection.map((s) => (
            <span className="app-chip" key={s.selector}>
              {name(s)}
              <button type="button" onClick={() => onRemove(s.selector)} aria-label={`Leave out ${name(s)}`}>×</button>
            </span>
          ))}
        </div>
      )}

      {primary && (primary.component || primary.source) && !region && (
        <p className="app-src">{[primary.component, primary.source].filter(Boolean).join(" · ")}</p>
      )}
      {primary && primary.text && !region && selection.length === 1 && <p className="app-said">“{primary.text}”</p>}

      <textarea
        ref={field}
        className="app-say"
        rows={2}
        value={text}
        placeholder={region ? "What should change here?" : "What should change?"}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
      />

      {!region && primary && (
        <div className="app-edit">
          <button type="button" className="app-edit-toggle" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            {editing ? "▾" : "▸"} Try a change on the page
          </button>
          {editing && (
            <div className="app-edit-body">
              {one && primary.editableText && (
                <label className="app-row is-wide">
                  <span>Text</span>
                  <textarea rows={2} value={words ?? primary.fullText} onChange={(e) => retype(e.target.value)} />
                </label>
              )}
              <div className="app-grid">
                <label className="app-row">
                  <span>Colour</span>
                  <input type="color" value={toHex(value("color", base.color))} onChange={(e) => apply({ color: e.target.value })} />
                </label>
                <label className="app-row">
                  <span>Background</span>
                  <input type="color" value={toHex(value("background-color", base.backgroundColor))} onChange={(e) => apply({ "background-color": e.target.value })} />
                </label>
                <label className="app-row">
                  <span>Size</span>
                  <input type="number" min={6} max={200} step={1} value={Math.round(px(value("font-size", base.fontSize)))} onChange={(e) => apply({ "font-size": `${e.target.value || 0}px` })} />
                </label>
                <label className="app-row">
                  <span>Weight</span>
                  <select value={String(Math.round(px(value("font-weight", base.fontWeight)) / 100) * 100)} onChange={(e) => apply({ "font-weight": e.target.value })}>
                    {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                </label>
                <label className="app-row">
                  <span>Corners</span>
                  <input type="number" min={0} max={200} value={Math.round(px(value("border-radius", base.borderRadius)))} onChange={(e) => apply({ "border-radius": `${e.target.value || 0}px` })} />
                </label>
                <label className="app-row">
                  <span>Padding</span>
                  <input type="number" min={0} max={200} value={Math.round(px(value("padding", (base.padding ?? "").split(" ")[0])))} onChange={(e) => apply({ padding: `${e.target.value || 0}px` })} />
                </label>
                <label className="app-row">
                  <span>Margin</span>
                  <input type="number" min={0} max={200} value={Math.round(px(value("margin", (base.margin ?? "").split(" ")[0])))} onChange={(e) => apply({ margin: `${e.target.value || 0}px` })} />
                </label>
                <label className="app-row">
                  <span>Opacity</span>
                  <input type="range" min={0} max={1} step={0.05} value={Number(value("opacity", base.opacity ?? "1"))} onChange={(e) => apply({ opacity: e.target.value })} />
                </label>
                <div className="app-row is-wide">
                  <span>Align</span>
                  <span className="app-seg">
                    {ALIGNS.map((a) => (
                      <button key={a} type="button" className={value("text-align", base.textAlign) === a ? "on" : ""} onClick={() => apply({ "text-align": a })}>{a}</button>
                    ))}
                  </span>
                </div>
                <div className="app-row is-wide">
                  <span>Show</span>
                  <span className="app-seg">
                    <button type="button" className={value("display", base.display) !== "none" ? "on" : ""} onClick={() => apply({ display: css.display === "none" ? (before.display || "block") : (base.display === "none" ? "block" : base.display ?? "block") })}>Visible</button>
                    <button type="button" className={value("display", base.display) === "none" ? "on" : ""} onClick={() => apply({ display: "none" })}>Hidden</button>
                  </span>
                </div>
              </div>
              {(changes.length > 0 || textEdit) && (
                <p className="app-tried">
                  {textEdit ? "Text changed. " : ""}
                  {changes.length > 0 ? `${changes.length} style${changes.length === 1 ? "" : "s"} changed.` : ""}{" "}
                  <button type="button" onClick={() => void undo()}>Undo</button>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="app-err" role="alert">{error}</p>}
      <div className="app-pop-foot">
        <button type="button" className="btn small ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn small primary" disabled={!ready || saving} onClick={() => void add()}>
          {saving ? "Adding…" : "Add to review"}
        </button>
      </div>
    </div>
  );

  return modal ? createPortal(<div className="app-sheet-dim" onPointerDown={onClose}>{box}</div>, document.body) : box;
}

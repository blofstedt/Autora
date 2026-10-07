/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Check, Minus, Plus, SquareDashed, Undo2, X } from 'lucide-react';
import { BevelStyle, DrawForm, DrawSession, RepeatSession } from '../types';
import { MAX_COPIES, spacing, toAround, toPath, withCount, withSpacing } from '../utils/repeat';
import { Segmented, spring } from './controls';
import { formatLength, parseLength } from '../utils/units';

const OPTIONS: { style: BevelStyle; label: string; path: string }[] = [
  { style: 'round', label: 'Curved edge', path: 'M5 25V15C5 9 9 5 15 5h10' },
  { style: 'chamfer', label: 'Flat bevel', path: 'M5 25V13L13 5h12' },
];

/**
 * Two round buttons that pop up beside the yellow edge handle.
 * Press one and drag: the edge takes that profile and the drag sets its size.
 */
export function BevelPicker({
  current,
  onPress,
  onMove,
  onRelease,
}: {
  current: BevelStyle;
  onPress: (style: BevelStyle, e: React.PointerEvent<HTMLElement>) => void;
  onMove: (e: React.PointerEvent<HTMLElement>) => void;
  onRelease: (e: React.PointerEvent<HTMLElement>) => void;
}) {
  return (
    <motion.div className="flex items-center gap-3" exit={{ opacity: 0, transition: { duration: 0.1 } }}>
      {OPTIONS.map((o, i) => (
        <motion.button
          key={o.style}
          type="button"
          aria-label={o.label}
          title={o.label}
          initial={{ opacity: 0, scale: 0.3, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.1 } }}
          transition={{ ...spring, stiffness: 460, damping: 24, delay: i * 0.05 }}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.94 }}
          onPointerDown={(e) => onPress(o.style, e)}
          onPointerMove={onMove}
          onPointerUp={onRelease}
          onPointerCancel={onRelease}
          style={{ touchAction: 'none' }}
          className={`w-14 h-14 rounded-full flex items-center justify-center border shadow-xl shadow-black/50 backdrop-blur-xl cursor-ns-resize ${
            current === o.style ? 'bg-accent-500 border-accent-300 text-white' : 'bg-slate-800/95 border-white/15 text-slate-100'
          }`}
        >
          <svg width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d={o.path} />
          </svg>
        </motion.button>
      ))}
    </motion.div>
  );
}

/**
 * The number for the face you are working on. It shows while dragging and for a few seconds after;
 * tap it to type an exact value (millimetres, or add a unit such as 12cm).
 */
export function MeasureReadout({
  label,
  value,
  onEditStart,
  onEditEnd,
  onCommit,
  onEdges,
}: {
  label: string;
  value: number;
  onEditStart: () => void;
  onEditEnd: () => void;
  onCommit: (mm: number) => void;
  /** Select every edge around this face. */
  onEdges?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const { main, alt } = formatLength(value);

  const finish = (apply: boolean) => {
    const v = draft === null ? null : parseLength(draft);
    setDraft(null);
    onEditEnd();
    if (apply && v !== null && Math.round(v * 10) !== Math.round(value * 10)) onCommit(v);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.35 } }}
      transition={{ ...spring, stiffness: 440, damping: 28 }}
      className="h-12 rounded-full bg-slate-800/95 backdrop-blur-xl border border-white/12 shadow-xl shadow-black/50 flex items-center gap-2.5 pl-4 pr-4"
    >
      <span className="text-[11px] leading-none uppercase tracking-wide text-slate-400">{label}</span>
      {draft === null ? (
        <button
          type="button"
          aria-label={`${label}: ${main}. Tap to type a value`}
          onClick={() => {
            setDraft(String(Math.round(value * 10) / 10));
            onEditStart();
          }}
          className="flex items-center gap-1.5 h-full"
        >
          <span className="text-base leading-none font-semibold text-white tabular-nums">{main}</span>
          {alt && <span className="text-xs leading-none text-slate-400 tabular-nums">· {alt}</span>}
        </button>
      ) : (
        <input
          autoFocus
          type="text"
          inputMode="decimal"
          aria-label={`${label} in millimetres`}
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finish(true);
            if (e.key === 'Escape') {
              e.stopPropagation();
              finish(false);
            }
          }}
          className="w-24 h-8 px-3 rounded-full bg-white/10 border border-accent-400 text-base font-semibold text-white tabular-nums focus:outline-none"
        />
      )}
      {onEdges && draft === null && (
        <>
          <span className="w-px h-6 bg-white/12" />
          <motion.button
            type="button"
            onClick={onEdges}
            aria-label="Select the edges around this face"
            title="Select the edges around this face"
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.9 }}
            transition={spring}
            className="h-9 pl-2.5 pr-3.5 -mr-2 rounded-full bg-white/8 hover:bg-accent-500 text-slate-100 hover:text-white flex items-center gap-1.5 text-[13px] font-medium transition-colors"
          >
            <SquareDashed size={15} strokeWidth={1.8} />
            Edges
          </motion.button>
        </>
      )}
    </motion.div>
  );
}

/**
 * The few things a repeat needs, in one pill under the original shape: how many, how far apart,
 * whether to go round a circle or turn with the path, and Done. Everything else is dragged on the shape.
 */
export function RepeatChip({
  session,
  onChange,
  onDone,
  onCancel,
}: {
  session: RepeatSession;
  onChange: (fn: (s: RepeatSession) => RepeatSession) => void;
  onDone: () => void;
  /** Drop the changes (Esc on a keyboard; this is the way on a phone). */
  onCancel: () => void;
}) {
  const gap = Math.round(spacing(session) * 10) / 10;
  const [draft, setDraft] = useState<string | null>(null);
  const commitGap = () => {
    const v = parseLength(draft ?? '');
    setDraft(null);
    if (v !== null && v > 0) onChange((s) => withSpacing(s, v));
  };
  const pill = (on: boolean) =>
    `h-7 px-3 rounded-full text-xs font-medium transition-colors ${on ? 'bg-accent-500 text-white' : 'bg-white/6 text-slate-200 hover:bg-white/12'}`;
  const step = 'w-7 h-7 rounded-full bg-white/6 hover:bg-white/12 text-slate-100 flex items-center justify-center disabled:opacity-30';
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={spring}
      // Wraps to two rows on a phone, so every control stays on screen.
      className="flex flex-wrap items-center justify-center gap-2 p-1.5 rounded-[1.6rem] bg-slate-900/95 border border-white/10 shadow-xl backdrop-blur max-w-[calc(100vw-1rem)]"
    >
      <button type="button" aria-label="Fewer copies" className={step} disabled={session.count <= 2} onClick={() => onChange((s) => withCount(s, s.count - 1))}>
        <Minus size={14} />
      </button>
      <span className="min-w-[1.5rem] text-center text-sm font-semibold text-white tabular-nums" aria-label="Number of shapes">
        {session.count}
      </span>
      <button type="button" aria-label="More copies" className={step} disabled={session.count >= MAX_COPIES} onClick={() => onChange((s) => withCount(s, s.count + 1))}>
        <Plus size={14} />
      </button>
      <span className="hidden sm:block w-px h-5 bg-white/10" />
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? `${gap} mm apart`}
        onFocus={(e) => {
          setDraft(String(gap));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitGap}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
        aria-label="Distance between copies"
        className="w-[7.5rem] h-7 px-2 rounded-full bg-white/6 text-xs font-medium text-white tabular-nums text-center focus:outline-none focus:ring-1 focus:ring-accent-400"
      />
      <button type="button" aria-pressed={session.kind === 'around'} className={pill(session.kind === 'around')} onClick={() => onChange((s) => (s.kind === 'around' ? toPath(s) : toAround(s)))}>
        Around
      </button>
      <button type="button" aria-pressed={session.follow} className={pill(session.follow)} onClick={() => onChange((s) => ({ ...s, follow: !s.follow }))}>
        Turn
      </button>
      <button type="button" aria-label="Cancel" title="Cancel (Esc)" className="w-8 h-8 rounded-full bg-white/6 text-slate-200 flex items-center justify-center hover:bg-white/12" onClick={onCancel}>
        <X size={16} />
      </button>
      <button type="button" aria-label="Keep the copies" title="Keep the copies (Enter)" className="w-8 h-8 rounded-full bg-accent-500 text-white flex items-center justify-center hover:bg-accent-400" onClick={onDone}>
        <Check size={16} />
      </button>
    </motion.div>
  );
}

/** What is being drawn, as one small pill: corners, a rectangle or a circle, and a way out. Everything else happens on the surface. */
export function DrawChip({
  draw,
  onForm,
  onDone,
  onCancel,
  onUndoCorner,
  onCut,
}: {
  draw: DrawSession;
  onForm: (form: DrawForm) => void;
  onDone: () => void;
  onCancel: () => void;
  /** Take back the last corner (Backspace on a keyboard). */
  onUndoCorner: () => void;
  /** Switch between adding a new shape and cutting a hole in the one being drawn on. */
  onCut: (cut: boolean) => void;
}) {
  const canFinish = draw.form === 'shape' && draw.points.length >= 3;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={spring}
      className="flex flex-wrap items-center justify-center gap-2 p-1.5 rounded-[1.6rem] bg-slate-900/95 border border-white/10 shadow-xl backdrop-blur max-w-[calc(100vw-1rem)]"
    >
      <Segmented
        id="draw-form"
        label="What to draw"
        value={draw.form}
        options={[
          { value: 'shape', label: 'Corners' },
          { value: 'rectangle', label: 'Rectangle' },
          { value: 'circle', label: 'Circle' },
        ]}
        onChange={onForm}
      />
      {draw.hostId && !draw.frame && (
        <Segmented
          id="draw-mode"
          label="Add a shape or cut a hole"
          value={draw.cut ? 'cut' : 'add'}
          options={[
            { value: 'add', label: 'Add' },
            { value: 'cut', label: 'Cut' },
          ]}
          onChange={(v) => onCut(v === 'cut')}
        />
      )}
      {draw.form === 'shape' && draw.points.length > 0 && (
        <button type="button" aria-label="Take back the last corner" title="Take back the last corner (Backspace)" className="w-8 h-8 rounded-full bg-white/6 text-slate-200 flex items-center justify-center hover:bg-white/12" onClick={onUndoCorner}>
          <Undo2 size={15} />
        </button>
      )}
      {canFinish && (
        <button type="button" aria-label="Finish the shape" title="Finish (Enter)" className="w-8 h-8 rounded-full bg-accent-500 text-white flex items-center justify-center hover:bg-accent-400" onClick={onDone}>
          <Check size={16} />
        </button>
      )}
      <button type="button" aria-label="Stop drawing" title="Stop drawing (Esc)" className="w-8 h-8 rounded-full bg-white/6 text-slate-200 flex items-center justify-center hover:bg-white/12" onClick={onCancel}>
        <X size={16} />
      </button>
    </motion.div>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import { parseLength } from '../utils/units';
import type { LucideIcon } from 'lucide-react';

export const stepClass =
  'h-7 min-w-8 px-2 rounded-full bg-white/6 hover:bg-white/12 text-xs font-medium text-slate-200 tabular-nums transition-colors';

export const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n)}`;

/** A labelled number box that applies its value on Enter or when it loses focus. */
export function NumberBox({
  label,
  value,
  step = 1,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onCommit: (v: number) => void;
}) {
  const shown = Math.round(value * 100) / 100;
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    let v = parseLength(draft ?? '');
    setDraft(null);
    if (v === null) return;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (v !== shown) onCommit(v);
  };

  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] leading-none text-slate-400">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? String(shown)}
        onFocus={(e) => {
          setDraft(String(shown));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        aria-label={`${label} in mm`}
        className="w-[4.25rem] h-7 px-2 rounded-full bg-white/6 border border-white/8 text-sm font-semibold text-white tabular-nums focus:outline-none focus:border-accent-400"
      />
    </label>
  );
}

export const spring = { type: 'spring', stiffness: 520, damping: 32, mass: 0.7 } as const;

export function IconButton({
  icon: Icon,
  label,
  onClick,
  danger = false,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active || undefined}
      title={label}
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.88 }}
      transition={spring}
      className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
        active ? 'bg-accent-500/25 text-accent-200' : 'text-slate-300 hover:text-white hover:bg-white/10'
      } ${danger ? 'hover:text-rose-300' : ''}`}
    >
      <Icon size={16} strokeWidth={1.75} />
    </motion.button>
  );
}

/** A small round-ended button, used for nudges like −1 / +10. */
export function StepButton({ children, title, onClick }: { children: React.ReactNode; title?: string; onClick: () => void }) {
  return (
    <motion.button type="button" title={title} onClick={onClick} whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.88 }} transition={spring} className={stepClass}>
      {children}
    </motion.button>
  );
}

/** Pill switch with a highlight that glides between options. */
export function Segmented<T extends string>({
  id,
  value,
  options,
  onChange,
  label,
}: {
  id: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="inline-flex p-0.5 rounded-full bg-white/6" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`relative h-7 px-3.5 rounded-full text-xs font-medium transition-colors ${value === o.value ? 'text-white' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {value === o.value && <motion.span layoutId={`seg-${id}`} transition={spring} className="absolute inset-0 rounded-full bg-accent-500 shadow-md shadow-accent-500/30" />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react';
import { spring } from './controls';

interface MenuButtonProps {
  id: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  label?: string;
  icon?: LucideIcon;
  /** Open downwards from a top bar, or upwards from the bottom bar. */
  placement: 'down' | 'up';
  active?: boolean;
  /** On phones the label sits under the icon in a small round button; from sm up it is a pill. */
  stackedOnMobile?: boolean;
  disabled?: boolean;
  title?: string;
  /** Rendered as a round icon-only button when there is no label. */
  children: React.ReactNode;
}

/** A round button that opens a small rounded menu next to it. One menu is open at a time. */
export default function MenuButton({ id, openId, setOpenId, label, icon: Icon, placement, active, stackedOnMobile, disabled, title, children }: MenuButtonProps) {
  const open = openId === id;
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 8 });

  // Position next to the trigger, kept inside the screen.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const w = popRef.current?.offsetWidth ?? 280;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    setPos(placement === 'down' ? { left, top: r.bottom + 8 } : { left, bottom: window.innerHeight - r.top + 8 });
  }, [open, placement, children]);

  // Click outside or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpenId(null);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [open, setOpenId]);

  const Chevron = placement === 'down' ? ChevronDown : ChevronUp;
  return (
    <>
      <motion.button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title ?? label}
        aria-label={label ?? title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpenId(open ? null : id)}
        whileTap={{ scale: 0.94 }}
        transition={spring}
        className={`shrink-0 rounded-full flex items-center justify-center font-medium transition-colors disabled:text-slate-600 disabled:pointer-events-none ${
          !label
            ? 'h-9 w-9 text-[13px]'
            : stackedOnMobile
              ? 'h-[46px] w-[46px] flex-col gap-0.5 text-[9.5px] leading-none sm:h-9 sm:w-auto sm:flex-row sm:gap-1.5 sm:pl-3.5 sm:pr-2.5 sm:text-[13px]'
              : 'h-9 gap-1.5 pl-3.5 pr-2.5 text-[13px]'
        } ${open || active ? 'bg-accent-500 text-white shadow-md shadow-accent-500/30' : 'bg-white/6 text-slate-200 hover:bg-white/12 hover:text-white'}`}
      >
        {Icon && <Icon size={16} strokeWidth={1.75} />}
        {label && <span className="whitespace-nowrap">{label}</span>}
        {label && <Chevron size={13} className={`opacity-70 ${stackedOnMobile ? 'hidden sm:block' : ''}`} />}
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={popRef}
            role="menu"
            initial={{ opacity: 0, scale: 0.88, y: placement === 'down' ? -8 : 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.1 } }}
            transition={{ ...spring, stiffness: 440, damping: 30 }}
            style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, transformOrigin: placement === 'down' ? '50% 0%' : '50% 100%' }}
            className="z-50 max-w-[calc(100vw-1rem)] max-h-[min(70dvh,34rem)] overflow-y-auto rounded-[1.75rem] bg-slate-800 border border-white/10 shadow-2xl shadow-black/60"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

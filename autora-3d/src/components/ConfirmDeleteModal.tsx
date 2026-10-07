/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { motion } from 'motion/react';
import { Trash2 } from 'lucide-react';
import { spring } from './controls';

export default function ConfirmDeleteModal({
  names,
  onConfirm,
  onCancel,
}: {
  names: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const what = names.length === 1 ? names[0] : `${names.length} shapes`;
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <motion.div
        role="alertdialog"
        aria-label={`Delete ${what}?`}
        initial={{ opacity: 0, scale: 0.85, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.92, y: 8 }}
        transition={{ ...spring, stiffness: 420, damping: 28 }}
        className="w-full max-w-sm rounded-[2rem] bg-slate-800 border border-white/10 shadow-2xl shadow-black/60 p-6 flex flex-col items-center text-center gap-4"
      >
        <div className="w-14 h-14 rounded-full bg-rose-500/20 border border-rose-500/30 text-rose-400 flex items-center justify-center">
          <Trash2 size={24} strokeWidth={1.75} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-white">Delete {what}?</h2>
          <p className="mt-1 text-sm text-slate-400">You can undo this with ⌘Z.</p>
        </div>
        <div className="flex gap-2 w-full">
          <button type="button" onClick={onCancel} className="flex-1 h-11 rounded-full bg-white/8 hover:bg-white/12 text-sm font-medium text-slate-100 transition-colors">
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="flex-1 h-11 rounded-full bg-rose-500 hover:bg-rose-400 text-sm font-semibold text-white shadow-lg shadow-rose-500/25 transition-colors"
          >
            Delete
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

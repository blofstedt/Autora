import React, { useState } from "react";
import { MessageSquare, Trash2, X, Check, Clock, User } from "lucide-react";
import { AnnotationItem } from "../types";
import { triggerHaptic } from "../lib/haptics";

interface StickyNotePopoverProps {
  annotation: AnnotationItem;
  onUpdate: (updated: Partial<AnnotationItem>) => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function StickyNotePopover({
  annotation,
  onUpdate,
  onDelete,
  onClose,
}: StickyNotePopoverProps) {
  const [commentText, setCommentText] = useState(annotation.noteComment || "");
  const [authorName, setAuthorName] = useState(annotation.noteAuthor || "Reviewer");
  const noteColors = [
    { name: "Yellow", bg: "bg-amber-100 dark:bg-amber-950", border: "border-amber-300 dark:border-amber-700", text: "text-amber-900 dark:text-amber-100", hex: "#fef08a" },
    { name: "Blue", bg: "bg-sky-100 dark:bg-sky-950", border: "border-sky-300 dark:border-sky-700", text: "text-sky-900 dark:text-sky-100", hex: "#bae6fd" },
    { name: "Green", bg: "bg-emerald-100 dark:bg-emerald-950", border: "border-emerald-300 dark:border-emerald-700", text: "text-emerald-900 dark:text-emerald-100", hex: "#a7f3d0" },
    { name: "Rose", bg: "bg-rose-100 dark:bg-rose-950", border: "border-rose-300 dark:border-rose-700", text: "text-rose-900 dark:text-rose-100", hex: "#fecdd3" },
  ];

  const currentColor = noteColors.find((c) => c.hex === annotation.noteColor) || noteColors[0];

  const handleSave = () => {
    triggerHaptic("light");
    onUpdate({
      noteComment: commentText,
      noteAuthor: authorName,
    });
    onClose();
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={`absolute z-50 w-72 rounded-2xl shadow-2xl border ${currentColor.border} ${currentColor.bg} p-4 text-xs ${currentColor.text} backdrop-blur-md animate-in fade-in zoom-in-95 duration-150`}
      style={{
        left: Math.min(annotation.x + 35, window.innerWidth - 300),
        top: Math.max(10, annotation.y - 10),
      }}
    >
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-black/10 dark:border-white/10">
        <div className="flex items-center gap-1.5 font-bold">
          <MessageSquare className="w-3.5 h-3.5" />
          <span>Sticky Comment Note</span>
        </div>
        <div className="flex items-center gap-1">
          {noteColors.map((color) => (
            <button
              key={color.hex}
              onClick={() => onUpdate({ noteColor: color.hex })}
              className={`w-3.5 h-3.5 rounded-full border border-black/20 ${
                annotation.noteColor === color.hex ? "ring-2 ring-indigo-500 scale-110" : ""
              }`}
              style={{ backgroundColor: color.hex }}
            />
          ))}
          <button
            onClick={() => {
              triggerHaptic("light");
              onClose();
            }}
            className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded-md transition-colors ml-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-2.5">
        <div>
          <label className="text-[10px] font-bold opacity-70 flex items-center gap-1 mb-1">
            <User className="w-3 h-3" /> Author Tag:
          </label>
          <input
            type="text"
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            className="w-full bg-white/70 dark:bg-black/40 border border-black/10 dark:border-white/15 rounded-lg px-2.5 py-1 text-xs focus:outline-hidden"
            placeholder="Your Name / Role"
          />
        </div>

        <div>
          <label className="text-[10px] font-bold opacity-70 mb-1 block">Comment / Review Note:</label>
          <textarea
            autoFocus
            rows={4}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Type your notes or feedback here..."
            className="w-full bg-white/70 dark:bg-black/40 border border-black/10 dark:border-white/15 rounded-lg p-2.5 text-xs focus:outline-hidden resize-none"
          />
        </div>

        <div className="flex items-center justify-between pt-1">
          <button
            onClick={() => {
              triggerHaptic("warning");
              onDelete();
            }}
            className="px-2.5 py-1.5 text-rose-600 hover:bg-rose-500/10 rounded-lg font-bold text-[11px] flex items-center gap-1 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            <span>Delete Note</span>
          </button>

          <button
            onClick={handleSave}
            className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-[11px] flex items-center gap-1 shadow transition-transform active:scale-95"
          >
            <Check className="w-3 h-3" />
            <span>Done</span>
          </button>
        </div>
      </div>
    </div>
  );
}

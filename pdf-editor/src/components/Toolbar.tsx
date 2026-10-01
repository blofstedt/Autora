import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  MousePointer,
  Type,
  PenTool,
  Award,
  Palette,
  Type as FontIcon,
  Signature,
  Eraser,
  Square,
  Circle,
  Minus,
  MoveRight,
  Highlighter,
  MessageSquare,
  ShieldAlert,
  X,
  X as XIcon,
  Sliders,
  Check,
  CheckCircle,
  XCircle,
  Shield,
  FileSignature,
  UserCircle,
  Calendar,
} from "lucide-react";
import { triggerHaptic } from "../lib/haptics";

export type ToolMode =
  | "select"
  | "text"
  | "draw"
  | "highlighter"
  | "shape"
  | "note"
  | "stamp"
  | "redact"
  | "image";

export type StampType =
  | "APPROVED"
  | "REJECTED"
  | "SIGN_HERE"
  | "INITIAL_HERE"
  | "DATE"
  | "CHECKMARK"
  | "CROSS"
  | "CONFIDENTIAL"
  | "COPY";

export type ShapeType = "rectangle" | "circle" | "line" | "arrow";

interface ToolbarProps {
  activeMode: ToolMode;
  setMode: (mode: ToolMode) => void;
  textFontSize: number;
  setTextFontSize: (size: number) => void;
  textFontColor: string;
  setTextFontColor: (color: string) => void;
  textFontFamily: string;
  setTextFontFamily: (font: string) => void;
  activeStampType: StampType;
  setActiveStampType: (type: StampType) => void;
  activeShapeType: ShapeType;
  setActiveShapeType: (shape: ShapeType) => void;
  highlighterColor: string;
  setHighlighterColor: (color: string) => void;
  highlighterWidth: number;
  setHighlighterWidth: (width: number) => void;
  inkColor?: string;
  setInkColor?: (color: string) => void;
  inkWidth?: number;
  setInkWidth?: (width: number) => void;
  onOpenSignatureModal: () => void;
  onSignatureToolClick?: () => void;
  onOpenFindAndRedactModal?: () => void;
  onOpenWatermarkModal?: () => void;
  onOpenPageOrganizer?: () => void;
  onOpenSecurityModal?: () => void;
  onImageUpload?: (file: File) => void;
  savedSignaturesCount?: number;
  onDeletePage?: () => void;
}

export default function Toolbar({
  activeMode,
  setMode,
  textFontSize,
  setTextFontSize,
  textFontColor,
  setTextFontColor,
  textFontFamily,
  setTextFontFamily,
  activeStampType,
  setActiveStampType,
  activeShapeType,
  setActiveShapeType,
  highlighterColor,
  setHighlighterColor,
  highlighterWidth,
  setHighlighterWidth,
  inkColor = "#dc2626",
  setInkColor,
  inkWidth = 3,
  setInkWidth,
  onOpenSignatureModal,
  onOpenFindAndRedactModal,
}: ToolbarProps) {
  const [isSubConfigDismissed, setIsSubConfigDismissed] = useState(false);

  useEffect(() => {
    setIsSubConfigDismissed(false);
  }, [activeMode]);

  const tools: {
    id: ToolMode;
    title: string;
    label: string;
    icon: React.ReactNode;
    activeBgClass: string;
    inactiveClass: string;
  }[] = [
    {
      id: "select",
      title: "Select & Move (V)",
      label: "Select",
      icon: <MousePointer className="w-5 h-5 md:w-4.5 md:h-4.5" />,
      activeBgClass: "bg-blue-600 shadow-blue-500/30",
      inactiveClass: "text-blue-600 bg-blue-50 dark:bg-blue-900/40 hover:bg-blue-100 dark:hover:bg-blue-800/60",
    },
    {
      id: "text",
      title: "Text Box (T)",
      label: "Text",
      icon: <Type className="w-5 h-5 md:w-4.5 md:h-4.5" />,
      activeBgClass: "bg-emerald-600 shadow-emerald-500/30",
      inactiveClass: "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/40 hover:bg-emerald-100 dark:hover:bg-emerald-800/60",
    },
    {
      id: "highlighter",
      title: "Highlighter (H)",
      label: "Highlight",
      icon: <Highlighter className="w-5 h-5 md:w-4.5 md:h-4.5" />,
      activeBgClass: "bg-amber-500 shadow-amber-500/30",
      inactiveClass: "text-amber-600 bg-amber-50 dark:bg-amber-900/40 hover:bg-amber-100 dark:hover:bg-amber-800/60",
    },
    {
      id: "draw",
      title: "Freehand Pen (P)",
      label: "Draw",
      icon: <PenTool className="w-5 h-5 md:w-4.5 md:h-4.5" />,
      activeBgClass: "bg-purple-600 shadow-purple-500/30",
      inactiveClass: "text-purple-600 bg-purple-50 dark:bg-purple-900/40 hover:bg-purple-100 dark:hover:bg-purple-800/60",
    },
    {
      id: "shape",
      title: "Shapes & Lines (S)",
      label: "Shapes",
      icon: <Square className="w-5 h-5 md:w-4.5 md:h-4.5" />,
      activeBgClass: "bg-indigo-600 shadow-indigo-500/30",
      inactiveClass: "text-indigo-600 bg-indigo-50 dark:bg-indigo-900/40 hover:bg-indigo-100 dark:hover:bg-indigo-800/60",
    },
    {
      id: "note",
      title: "Sticky Note (N)",
      label: "Note",
      icon: <MessageSquare className="w-5 h-5 md:w-4.5 md:h-4.5" />,
      activeBgClass: "bg-sky-600 shadow-sky-500/30",
      inactiveClass: "text-sky-600 bg-sky-50 dark:bg-sky-900/40 hover:bg-sky-100 dark:hover:bg-sky-800/60",
    },
    {
      id: "stamp",
      title: "Stamps & Badges",
      label: "Stamps",
      icon: <Award className="w-5 h-5 md:w-4.5 md:h-4.5" />,
      activeBgClass: "bg-amber-600 shadow-amber-500/30",
      inactiveClass: "text-amber-600 bg-amber-50 dark:bg-amber-900/40 hover:bg-amber-100 dark:hover:bg-amber-800/60",
    },
    {
      id: "redact",
      title: "Redaction & Blackout (R)",
      label: "Redact",
      icon: <Eraser className="w-5 h-5 md:w-4.5 md:h-4.5" />,
      activeBgClass: "bg-rose-600 shadow-rose-500/30",
      inactiveClass: "text-rose-600 bg-rose-50 dark:bg-rose-900/40 hover:bg-rose-100 dark:hover:bg-rose-800/60",
    },
  ];

  const stamps: { type: StampType; icon: React.ReactNode; tooltip: string; color: string }[] = [
    { type: "APPROVED", icon: <CheckCircle className="w-5 h-5 mx-auto" />, tooltip: "Approve", color: "text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60" },
    { type: "REJECTED", icon: <XCircle className="w-5 h-5 mx-auto" />, tooltip: "Reject", color: "text-rose-700 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/60" },
    { type: "CONFIDENTIAL", icon: <Shield className="w-5 h-5 mx-auto" />, tooltip: "Confidential", color: "text-red-700 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800/60" },
    { type: "SIGN_HERE", icon: <FileSignature className="w-5 h-5 mx-auto" />, tooltip: "Sign Here", color: "text-amber-700 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800/60" },
    { type: "INITIAL_HERE", icon: <UserCircle className="w-5 h-5 mx-auto" />, tooltip: "Initial Here", color: "text-purple-700 bg-purple-50 dark:bg-purple-950/40 border-purple-200 dark:border-purple-800/60" },
    { type: "DATE", icon: <Calendar className="w-5 h-5 mx-auto" />, tooltip: "Date", color: "text-sky-700 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-800/60" },
    { type: "CHECKMARK", icon: <Check className="w-5 h-5 mx-auto" />, tooltip: "Checkmark", color: "text-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60" },
    { type: "CROSS", icon: <XIcon className="w-5 h-5 mx-auto" />, tooltip: "Cross", color: "text-rose-800 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/60" },
  ];

  const colors = [
    { name: "Pitch Black", hex: "#0f172a" },
    { name: "Navy Private", hex: "#1d4ed8" },
    { name: "Crimson Secure", hex: "#be123c" },
    { name: "Emerald Signed", hex: "#047857" },
    { name: "Gold Check", hex: "#b45309" },
  ];

  const penColors = [
    { name: "Pitch Black", hex: "#0f172a" },
    { name: "Crimson Red", hex: "#dc2626" },
    { name: "Royal Blue", hex: "#2563eb" },
    { name: "Emerald Green", hex: "#059669" },
    { name: "Purple", hex: "#9333ea" },
    { name: "Amber Gold", hex: "#d97706" },
  ];

  const highlighterColors = [
    { name: "Neon Yellow", hex: "#fde047" },
    { name: "Neon Green", hex: "#86efac" },
    { name: "Neon Pink", hex: "#f472b6" },
    { name: "Sky Blue", hex: "#7dd3fc" },
  ];

  const handleToolSelect = (id: ToolMode) => {
    triggerHaptic("light");
    setIsSubConfigDismissed(false);
    setMode(id);
  };

  const hasSubConfig = ["draw", "highlighter", "shape", "text", "stamp", "redact", "note"].includes(activeMode);

  return (
    <div
      id="editor-floating-toolbar"
      className="flex flex-col-reverse md:flex-row-reverse items-center gap-2 pointer-events-none max-w-full w-full md:w-auto"
    >
      {/* 1. Core Tool Selectors - Mobile Optimized Touch Dock / Desktop Floating Bar */}
      <div className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-1.5 sm:p-2 rounded-2xl md:rounded-3xl shadow-2xl border border-slate-200/90 dark:border-slate-700/90 flex flex-row md:flex-col items-center space-x-1 sm:space-x-1.5 md:space-x-0 space-y-0 md:space-y-1.5 transition-colors pointer-events-auto overflow-x-auto md:overflow-y-auto max-w-[calc(100vw-20px)] md:max-w-none md:max-h-[calc(100vh-140px)] no-scrollbar touch-pan-x shrink-0">
        {tools.map((tool) => {
          const isActive = activeMode === tool.id;
          return (
            <motion.button
              key={tool.id}
              id={`tool-${tool.id}-btn`}
              title={tool.title}
              onClick={() => handleToolSelect(tool.id)}
              whileTap={{ scale: 0.9 }}
              className="relative flex items-center justify-center min-w-[38px] min-h-[38px] w-9.5 h-9.5 sm:min-w-[40px] sm:min-h-[40px] sm:w-10 sm:h-10 md:min-w-[38px] md:min-h-[38px] md:w-9.5 md:h-9.5 rounded-full cursor-pointer select-none shrink-0 transition-transform"
            >
              {isActive && (
                <motion.div
                  layoutId="activeToolPill"
                  className={`absolute inset-0 rounded-full ${tool.activeBgClass} shadow-md`}
                  transition={{
                    type: "spring",
                    stiffness: 500,
                    damping: 32,
                  }}
                />
              )}
              <span
                className={`relative z-10 flex items-center justify-center w-full h-full rounded-full transition-colors ${
                  isActive ? "text-white font-bold" : tool.inactiveClass
                }`}
              >
                {tool.icon}
              </span>
            </motion.button>
          );
        })}

        {/* Signature Action */}
        <motion.button
          id="tool-signature-btn"
          title="Digital Signature (S)"
          onClick={() => {
            triggerHaptic("medium");
            onOpenSignatureModal();
          }}
          whileTap={{ scale: 0.9 }}
          className="flex items-center justify-center min-w-[38px] min-h-[38px] w-9.5 h-9.5 sm:min-w-[40px] sm:min-h-[40px] sm:w-10 sm:h-10 md:min-w-[38px] md:min-h-[38px] md:w-9.5 md:h-9.5 rounded-full cursor-pointer text-cyan-600 bg-cyan-50 dark:bg-cyan-900/40 hover:bg-cyan-100 dark:hover:bg-cyan-800/60 shrink-0"
        >
          <Signature className="w-4.5 h-4.5" />
        </motion.button>
      </div>

      {/* 2. Sub-configuration Trays (Mobile Action Sheet / Desktop Floating Menu) */}
      <div
        id="tool-sub-configuration"
        className="pointer-events-auto flex items-center justify-center md:justify-end max-w-full"
      >
        <AnimatePresence mode="wait">
          {hasSubConfig && !isSubConfigDismissed && (
            <motion.div
              key={activeMode}
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -8 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="w-full"
            >
              {/* Pen / Draw Sub-config */}
              {activeMode === "draw" && (
                <div className="flex flex-col gap-2.5 text-xs bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-3.5 sm:p-4 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 transition-colors min-w-[240px] sm:min-w-[260px] max-w-[94vw]">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="font-extrabold text-xs text-purple-600 dark:text-purple-400 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                      <PenTool className="w-4 h-4 shrink-0" /> Pen
                    </span>
                    <button
                      onClick={() => setIsSubConfigDismissed(true)}
                      className="p-1 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                      title="Close options"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Color Palette Row */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">
                      Color:
                    </span>
                    <div className="flex gap-2">
                      {penColors.map((c) => (
                        <button
                          key={c.hex}
                          title={c.name}
                          onClick={() => {
                            triggerHaptic("light");
                            setInkColor?.(c.hex);
                          }}
                          className={`w-6 h-6 rounded-full border border-black/10 transition-transform cursor-pointer ${
                            inkColor === c.hex
                              ? "ring-2 ring-purple-500 scale-110 shadow-xs"
                              : "hover:scale-105 opacity-80"
                          }`}
                          style={{ backgroundColor: c.hex }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Thickness Slider Row */}
                  <div className="flex items-center justify-between space-x-3">
                    <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">
                      Thickness:
                    </span>
                    <input
                      type="range"
                      min="1"
                      max="16"
                      value={inkWidth || 3}
                      onChange={(e) => setInkWidth?.(Number(e.target.value))}
                      className="flex-1 accent-purple-500 cursor-pointer h-2.5 rounded-lg"
                    />
                    <span className="font-mono font-bold text-xs text-slate-800 dark:text-slate-200 min-w-[36px] text-right">
                      {inkWidth || 3}px
                    </span>
                  </div>
                </div>
              )}

              {/* Highlighter Sub-config */}
              {activeMode === "highlighter" && (
                <div className="flex flex-col gap-2.5 text-xs bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-3.5 sm:p-4 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 transition-colors min-w-[240px] sm:min-w-[260px] max-w-[94vw]">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="font-extrabold text-xs text-amber-600 dark:text-amber-400 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                      <Highlighter className="w-4 h-4 shrink-0" /> Highlighter
                    </span>
                    <button
                      onClick={() => setIsSubConfigDismissed(true)}
                      className="p-1 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                      title="Close options"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Color Palette Row */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">
                      Color:
                    </span>
                    <div className="flex gap-2">
                      {highlighterColors.map((c) => (
                        <button
                          key={c.hex}
                          title={c.name}
                          onClick={() => {
                            triggerHaptic("light");
                            setHighlighterColor(c.hex);
                          }}
                          className={`w-6 h-6 rounded-full border border-black/10 transition-transform cursor-pointer ${
                            highlighterColor === c.hex
                              ? "ring-2 ring-amber-500 scale-110 shadow-xs"
                              : "hover:scale-105 opacity-80"
                          }`}
                          style={{ backgroundColor: c.hex }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Thickness Slider Row */}
                  <div className="flex items-center justify-between space-x-3">
                    <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">
                      Thickness:
                    </span>
                    <input
                      type="range"
                      min="12"
                      max="36"
                      value={highlighterWidth}
                      onChange={(e) => setHighlighterWidth(Number(e.target.value))}
                      className="flex-1 accent-amber-500 cursor-pointer h-2.5 rounded-lg"
                    />
                    <span className="font-mono font-bold text-xs text-slate-800 dark:text-slate-200 min-w-[36px] text-right">
                      {highlighterWidth}px
                    </span>
                  </div>
                </div>
              )}

              {/* Shape Sub-config */}
              {activeMode === "shape" && (
                <div className="flex flex-col gap-2.5 text-xs bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-3.5 sm:p-4 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 transition-colors min-w-[240px] sm:min-w-[280px] max-w-[94vw]">
                  <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-700">
                    <span className="font-extrabold text-xs text-indigo-600 dark:text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Square className="w-4 h-4" /> Shape Type
                    </span>
                    <button
                      onClick={() => setIsSubConfigDismissed(true)}
                      className="p-1 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700"
                      title="Close options"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { id: "rectangle", icon: <Square className="w-5 h-5" />, label: "Box" },
                      { id: "circle", icon: <Circle className="w-5 h-5" />, label: "Oval" },
                      { id: "line", icon: <Minus className="w-5 h-5" />, label: "Line" },
                      { id: "arrow", icon: <MoveRight className="w-5 h-5" />, label: "Arrow" },
                    ].map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          triggerHaptic("light");
                          setActiveShapeType(s.id as ShapeType);
                        }}
                        className={`min-h-[48px] py-2 px-1 rounded-xl border flex flex-col items-center justify-center gap-1 font-bold text-xs transition-all cursor-pointer ${
                          activeShapeType === s.id
                            ? "bg-indigo-600 text-white border-indigo-600 shadow-md scale-105"
                            : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100"
                        }`}
                      >
                        {s.icon}
                        <span className="text-[11px]">{s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Note Sub-config */}
              {activeMode === "note" && (
                <div className="text-xs font-bold text-slate-700 dark:text-slate-300 select-none bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-3.5 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 transition-colors min-w-[220px] max-w-[94vw]">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center">
                      <span className="w-2.5 h-2.5 rounded-full bg-sky-500 mr-2 animate-pulse shrink-0" />
                      <span className="text-sky-600 dark:text-sky-400 font-extrabold uppercase tracking-wider text-xs">
                        Review Note
                      </span>
                    </div>
                    <button
                      onClick={() => setIsSubConfigDismissed(true)}
                      className="p-1 rounded-full text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                    Tap anywhere on the document to place a comment sticky note.
                  </p>
                </div>
              )}

              {/* Text Sub-config */}
              {activeMode === "text" && (
                <div className="flex flex-col gap-2.5 text-xs bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-3.5 sm:p-4 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 transition-colors min-w-[240px] sm:min-w-[280px] max-w-[94vw]">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-700">
                    <span className="font-extrabold text-xs text-emerald-600 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
                      <Palette className="w-4 h-4 shrink-0" /> Text Style
                    </span>
                    <button
                      onClick={() => setIsSubConfigDismissed(true)}
                      className="p-1 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                      title="Close options"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Text Color Row */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">
                      Color:
                    </span>
                    <div className="flex gap-2">
                      {colors.map((c) => (
                        <button
                          key={c.hex}
                          id={`text-color-${c.hex}`}
                          title={c.name}
                          onClick={() => {
                            triggerHaptic("light");
                            setTextFontColor(c.hex);
                          }}
                          className={`w-6 h-6 rounded-full cursor-pointer transition-transform border border-slate-300 dark:border-slate-600 ${
                            textFontColor === c.hex
                              ? "ring-2 ring-emerald-600 dark:ring-emerald-400 ring-offset-2 ring-offset-white dark:ring-offset-slate-900 border border-white scale-110 shadow-xs"
                              : "hover:scale-105 opacity-80"
                          }`}
                          style={{ backgroundColor: c.hex }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between space-x-2">
                    <div className="flex items-center gap-1.5">
                      <FontIcon className="w-4 h-4 text-slate-400 dark:text-slate-500" />
                      <span className="font-bold text-xs text-slate-600 dark:text-slate-300">Font:</span>
                    </div>
                    <select
                      id="font-family-select"
                      value={textFontFamily}
                      onChange={(e) => setTextFontFamily(e.target.value)}
                      className="bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 font-bold focus:outline-hidden cursor-pointer"
                    >
                      <option value="Helvetica">Helvetica (Standard)</option>
                      <option value="Times-Roman">Times New Roman</option>
                      <option value="Courier">Courier Mono</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between space-x-3 pt-1 border-t border-slate-100 dark:border-slate-700">
                    <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">
                      Size:
                    </span>
                    <input
                      id="font-size-range"
                      type="range"
                      min="8"
                      max="36"
                      value={textFontSize}
                      onChange={(e) => setTextFontSize(Number(e.target.value))}
                      className="flex-1 accent-emerald-500 cursor-pointer h-2.5 rounded-lg"
                    />
                    <span className="font-mono font-bold text-xs text-slate-800 dark:text-slate-200 min-w-[36px] text-right">
                      {textFontSize}pt
                    </span>
                  </div>
                </div>
              )}

              {/* Stamp Sub-config */}
              {activeMode === "stamp" && (
                <div className="flex flex-col gap-2 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-3 sm:p-3.5 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 transition-colors max-h-[220px] overflow-y-auto min-w-[200px] max-w-[94vw]">
                  <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-700">
                    <span className="text-xs font-extrabold text-amber-600 dark:text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Award className="w-3.5 h-3.5" /> Stamps
                    </span>
                    <button
                      onClick={() => setIsSubConfigDismissed(true)}
                      className="p-1 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {stamps.map((st) => (
                      <button
                        key={st.type}
                        id={`stamp-choice-${st.type}`}
                        title={st.tooltip}
                        onClick={() => {
                          triggerHaptic("light");
                          setActiveStampType(st.type);
                        }}
                        className={`min-h-[40px] p-2 rounded-xl border flex items-center justify-center transition-all cursor-pointer ${
                          activeStampType === st.type
                            ? "bg-amber-500 text-white border-amber-500 shadow-md scale-105"
                            : `hover:bg-white dark:hover:bg-slate-700 ${st.color}`
                        }`}
                      >
                        {st.icon}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Redact Sub-config */}
              {activeMode === "redact" && (
                <div className="flex flex-col gap-2.5 text-xs font-bold text-slate-700 dark:text-slate-300 select-none bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-3.5 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 transition-colors min-w-[220px] max-w-[94vw]">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-500 mr-2 animate-pulse shrink-0" />
                      <span className="text-rose-600 dark:text-rose-400 font-extrabold uppercase tracking-wider text-xs">
                        Redaction Mode
                      </span>
                    </div>
                    <button
                      onClick={() => setIsSubConfigDismissed(true)}
                      className="p-1 rounded-full text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {onOpenFindAndRedactModal && (
                    <button
                      onClick={() => {
                        triggerHaptic("light");
                        onOpenFindAndRedactModal();
                      }}
                      className="w-full min-h-[44px] py-2 px-3 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-extrabold shadow-sm transition-all cursor-pointer flex items-center justify-center gap-2"
                    >
                      <ShieldAlert className="w-4 h-4" />
                      <span>Find & Auto-Redact Patterns</span>
                    </button>
                  )}
                </div>
              )}

              {/* Select Sub-config */}
              {activeMode === "select" && (
                <div className="hidden md:block text-xs font-bold text-slate-600 dark:text-slate-300 select-none bg-white/95 dark:bg-slate-800/95 backdrop-blur-md p-3.5 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 transition-colors">
                  <div className="flex items-center mb-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500 mr-2 animate-pulse shrink-0" />
                    <span className="text-blue-600 dark:text-blue-400 font-extrabold uppercase tracking-wider text-xs">
                      Pointer Mode
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                    Tap elements to select, move, scale or delete.
                  </p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

import React, { useState } from "react";
import { X, Sparkles, Type, Hash, Check, Eye } from "lucide-react";
import { WatermarkConfig, PageNumberConfig } from "../types";
import { triggerHaptic } from "../lib/haptics";

interface WatermarkModalProps {
  isOpen: boolean;
  onClose: () => void;
  totalPages: number;
  onApplyWatermark: (config: WatermarkConfig) => void;
  onApplyPageNumbers: (config: PageNumberConfig) => void;
}

export default function WatermarkModal({
  isOpen,
  onClose,
  totalPages,
  onApplyWatermark,
  onApplyPageNumbers,
}: WatermarkModalProps) {
  const [activeTab, setActiveTab] = useState<"watermark" | "pageNumbers">("watermark");

  // Watermark state
  const [wmText, setWmText] = useState("CONFIDENTIAL");
  const [wmFontSize, setWmFontSize] = useState(48);
  const [wmColor, setWmColor] = useState("#be123c"); // Crimson
  const [wmOpacity, setWmOpacity] = useState(0.25);
  const [wmAngle, setWmAngle] = useState(45);
  const [wmPages, setWmPages] = useState<"all" | "first" | "range">("all");
  const [wmRange, setWmRange] = useState("");

  // Page numbers state
  const [pnPosition, setPnPosition] = useState<PageNumberConfig["position"]>("bottom-center");
  const [pnFormat, setPnFormat] = useState<PageNumberConfig["format"]>("page-of-total");
  const [pnFontSize, setPnFontSize] = useState(10);
  const [pnColor, setPnColor] = useState("#475569");
  const [pnStart, setPnStart] = useState(1);

  if (!isOpen) return null;

  const handleSaveWatermark = () => {
    triggerHaptic("success");
    onApplyWatermark({
      enabled: true,
      text: wmText,
      fontSize: wmFontSize,
      color: wmColor,
      opacity: wmOpacity,
      rotationAngle: wmAngle,
      pages: wmPages,
      pageRange: wmRange,
    });
    onClose();
  };

  const handleSavePageNumbers = () => {
    triggerHaptic("success");
    onApplyPageNumbers({
      enabled: true,
      position: pnPosition,
      format: pnFormat,
      fontSize: pnFontSize,
      color: pnColor,
      startNumber: pnStart,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-md w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-sm sm:text-base text-slate-900 dark:text-white">
                Document Overlays
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Apply consistent watermarks or page numbering
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab switch */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 p-1">
          <button
            onClick={() => {
              triggerHaptic("light");
              setActiveTab("watermark");
            }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-2 ${
              activeTab === "watermark"
                ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
                : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            <Type className="w-3.5 h-3.5" />
            <span>Watermark Stamp</span>
          </button>
          <button
            onClick={() => {
              triggerHaptic("light");
              setActiveTab("pageNumbers");
            }}
            className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-2 ${
              activeTab === "pageNumbers"
                ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
                : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            <Hash className="w-3.5 h-3.5" />
            <span>Page Numbering</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 text-xs">
          {activeTab === "watermark" ? (
            <div className="space-y-4">
              <div>
                <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1.5">
                  Watermark Text Preset / Custom
                </label>
                <div className="flex gap-1.5 mb-2 overflow-x-auto pb-1">
                  {["CONFIDENTIAL", "DRAFT", "COPY", "DO NOT SHARE", "FOR REVIEW ONLY"].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setWmText(preset)}
                      className={`px-2 py-1 rounded-lg text-[10px] font-bold border transition-colors ${
                        wmText === preset
                          ? "bg-indigo-600 text-white border-indigo-600"
                          : "border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={wmText}
                  onChange={(e) => setWmText(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-bold text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                    Font Size: {wmFontSize}pt
                  </label>
                  <input
                    type="range"
                    min="20"
                    max="90"
                    value={wmFontSize}
                    onChange={(e) => setWmFontSize(Number(e.target.value))}
                    className="w-full accent-indigo-600 cursor-pointer"
                  />
                </div>
                <div>
                  <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                    Angle: {wmAngle}°
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="90"
                    step="15"
                    value={wmAngle}
                    onChange={(e) => setWmAngle(Number(e.target.value))}
                    className="w-full accent-indigo-600 cursor-pointer"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                    Opacity: {Math.round(wmOpacity * 100)}%
                  </label>
                  <input
                    type="range"
                    min="0.05"
                    max="0.8"
                    step="0.05"
                    value={wmOpacity}
                    onChange={(e) => setWmOpacity(Number(e.target.value))}
                    className="w-full accent-indigo-600 cursor-pointer"
                  />
                </div>
                <div>
                  <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                    Color
                  </label>
                  <div className="flex gap-1.5 items-center mt-1">
                    {["#be123c", "#475569", "#1d4ed8", "#047857", "#b45309"].map((clr) => (
                      <button
                        key={clr}
                        type="button"
                        onClick={() => setWmColor(clr)}
                        className={`w-6 h-6 rounded-full border border-black/20 ${
                          wmColor === clr ? "ring-2 ring-indigo-500 scale-110" : ""
                        }`}
                        style={{ backgroundColor: clr }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Watermark Preview Box */}
              <div className="p-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 relative h-28 flex items-center justify-center overflow-hidden">
                <span
                  style={{
                    color: wmColor,
                    opacity: wmOpacity,
                    fontSize: `${Math.min(wmFontSize * 0.5, 32)}px`,
                    transform: `rotate(-${wmAngle}deg)`,
                  }}
                  className="font-black select-none pointer-events-none uppercase tracking-widest text-center"
                >
                  {wmText || "PREVIEW"}
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1.5">
                  Page Number Position
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: "bottom-left", label: "Bottom Left" },
                    { id: "bottom-center", label: "Bottom Center" },
                    { id: "bottom-right", label: "Bottom Right" },
                    { id: "top-left", label: "Top Left" },
                    { id: "top-center", label: "Top Center" },
                    { id: "top-right", label: "Top Right" },
                  ].map((pos) => (
                    <button
                      key={pos.id}
                      type="button"
                      onClick={() => setPnPosition(pos.id as any)}
                      className={`p-2 rounded-xl border text-center font-bold transition-all ${
                        pnPosition === pos.id
                          ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                          : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                      }`}
                    >
                      {pos.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1.5">
                  Number Format
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: "page-of-total", label: `Page 1 of ${totalPages || 1}` },
                    { id: "page-only", label: "1" },
                    { id: "dash-page", label: "- 1 -" },
                  ].map((fmt) => (
                    <button
                      key={fmt.id}
                      type="button"
                      onClick={() => setPnFormat(fmt.id as any)}
                      className={`p-2 rounded-xl border text-center font-mono font-bold transition-all ${
                        pnFormat === fmt.id
                          ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                          : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                      }`}
                    >
                      {fmt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                    Font Size ({pnFontSize}pt)
                  </label>
                  <input
                    type="range"
                    min="8"
                    max="18"
                    value={pnFontSize}
                    onChange={(e) => setPnFontSize(Number(e.target.value))}
                    className="w-full accent-indigo-600 cursor-pointer"
                  />
                </div>
                <div>
                  <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                    Start At Page #
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={pnStart}
                    onChange={(e) => setPnStart(Math.max(1, Number(e.target.value)))}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-bold"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl"
          >
            Cancel
          </button>
          <button
            onClick={activeTab === "watermark" ? handleSaveWatermark : handleSavePageNumbers}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-md transition-transform active:scale-95 flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Apply to Document</span>
          </button>
        </div>
      </div>
    </div>
  );
}

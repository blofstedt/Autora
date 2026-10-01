import React, { useState } from "react";
import {
  ShieldAlert,
  Search,
  CheckSquare,
  Square,
  X,
  Loader2,
  FileText,
  Mail,
  Lock,
  CreditCard,
  Phone,
  Calendar,
  Code,
  AlertCircle,
  Eye,
  CheckCircle2,
  Sparkles,
  Eraser,
} from "lucide-react";
import { AnnotationItem } from "../types";

export type PatternType =
  | "EMAIL"
  | "SSN"
  | "CREDIT_CARD"
  | "PHONE"
  | "DATE"
  | "TEXT"
  | "REGEX";

export interface FindRedactMatch {
  id: string;
  pageNumber: number;
  text: string;
  snippet: string;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
}

interface FindAndRedactModalProps {
  isOpen: boolean;
  onClose: () => void;
  pdfDocProxy: any;
  numPages: number;
  onApplyRedactions: (
    newRedactions: AnnotationItem[],
    patternLabel: string,
  ) => void;
  onNavigate: (pageNumber: number) => void;
}

export default function FindAndRedactModal({
  isOpen,
  onClose,
  pdfDocProxy,
  numPages,
  onApplyRedactions,
  onNavigate,
}: FindAndRedactModalProps) {
  const [patternType, setPatternType] = useState<PatternType>("EMAIL");
  const [customText, setCustomText] = useState("");
  const [customRegex, setCustomRegex] = useState("");

  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const [matches, setMatches] = useState<FindRedactMatch[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const patternPresets: {
    type: PatternType;
    label: string;
    description: string;
    icon: React.ReactNode;
  }[] = [
    {
      type: "EMAIL",
      label: "Email Addresses",
      description: "Detects all email formats (user@domain.com)",
      icon: <Mail className="w-4 h-4 text-sky-500" />,
    },
    {
      type: "SSN",
      label: "Social Security (SSN)",
      description: "Detects US SSN patterns (XXX-XX-XXXX)",
      icon: <Lock className="w-4 h-4 text-rose-500" />,
    },
    {
      type: "CREDIT_CARD",
      label: "Credit Card Numbers",
      description: "Detects 13 to 19 digit payment numbers",
      icon: <CreditCard className="w-4 h-4 text-amber-500" />,
    },
    {
      type: "PHONE",
      label: "Phone Numbers",
      description: "Detects US & Intl phone formats",
      icon: <Phone className="w-4 h-4 text-emerald-500" />,
    },
    {
      type: "DATE",
      label: "Dates & Birthdays",
      description: "Detects MM/DD/YYYY & YYYY-MM-DD",
      icon: <Calendar className="w-4 h-4 text-purple-500" />,
    },
    {
      type: "TEXT",
      label: "Custom Keyword",
      description: "Search for specific names, words or phrases",
      icon: <FileText className="w-4 h-4 text-indigo-500" />,
    },
    {
      type: "REGEX",
      label: "Custom Regex Pattern",
      description: "Advanced regular expression matching",
      icon: <Code className="w-4 h-4 text-slate-500" />,
    },
  ];

  const handleStartScan = async () => {
    if (!pdfDocProxy) {
      setErrorMessage("No PDF document currently loaded.");
      return;
    }

    setErrorMessage(null);
    setIsScanning(true);
    setHasScanned(false);
    setMatches([]);
    setScanProgress({ current: 0, total: numPages });

    try {
      let regex: RegExp | null = null;
      let label = "";

      if (patternType === "EMAIL") {
        regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
        label = "Email Addresses";
      } else if (patternType === "SSN") {
        regex = /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g;
        label = "SSN";
      } else if (patternType === "CREDIT_CARD") {
        regex = /\b(?:\d[ -]*?){13,19}\b/g;
        label = "Credit Card Numbers";
      } else if (patternType === "PHONE") {
        regex = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
        label = "Phone Numbers";
      } else if (patternType === "DATE") {
        regex = /\b\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4}\b/g;
        label = "Dates";
      } else if (patternType === "TEXT") {
        if (!customText.trim()) {
          setErrorMessage("Please enter a keyword or phrase to search.");
          setIsScanning(false);
          return;
        }
        const escaped = customText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        regex = new RegExp(escaped, "gi");
        label = `Keyword "${customText}"`;
      } else if (patternType === "REGEX") {
        if (!customRegex.trim()) {
          setErrorMessage("Please enter a valid regular expression.");
          setIsScanning(false);
          return;
        }
        try {
          regex = new RegExp(customRegex, "gi");
          label = `Regex /${customRegex}/`;
        } catch (e: any) {
          setErrorMessage(`Invalid Regular Expression: ${e.message}`);
          setIsScanning(false);
          return;
        }
      }

      if (!regex) {
        setIsScanning(false);
        return;
      }

      const foundMatches: FindRedactMatch[] = [];

      for (let pNum = 1; pNum <= numPages; pNum++) {
        setScanProgress({ current: pNum, total: numPages });
        const page = await pdfDocProxy.getPage(pNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const textContent = await page.getTextContent();
        const items = textContent.items;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (!item || !item.str) continue;

          const str = item.str;
          regex.lastIndex = 0;

          let matchExec: RegExpExecArray | null;
          while ((matchExec = regex.exec(str)) !== null) {
            const matchedText = matchExec[0];
            if (!matchedText) {
              regex.lastIndex++;
              continue;
            }

            const matchIdx = matchExec.index;
            const matchLen = matchedText.length;
            const strLen = str.length || 1;

            const itemWidth = item.width || 0;
            const itemHeight =
              Math.abs(item.transform?.[3]) ||
              Math.abs(item.transform?.[0]) ||
              item.height ||
              11;
            const itemX = item.transform?.[4] || 0;
            const itemY = item.transform?.[5] || 0;

            const startFrac = matchIdx / strLen;
            const lenFrac = matchLen / strLen;

            const offsetX = itemWidth * startFrac;
            const matchWidth = itemWidth * lenFrac;

            const pdfX = itemX + offsetX;
            const pdfY = itemY;

            const [vpX, vpY] = viewport.convertToViewportPoint(pdfX, pdfY);

            const boxX = Math.max(0, vpX - 1);
            const boxY = Math.max(0, vpY - itemHeight - 1);
            const boxWidth = Math.min(
              viewport.width - boxX,
              Math.max(matchWidth, 10) + 2,
            );
            const boxHeight = itemHeight + 2;

            const snippetStart = Math.max(0, matchIdx - 20);
            const snippetEnd = Math.min(
              str.length,
              matchIdx + matchLen + 20,
            );
            let snippet = str.substring(snippetStart, snippetEnd).trim();
            if (snippetStart > 0) snippet = "..." + snippet;
            if (snippetEnd < str.length) snippet = snippet + "...";

            foundMatches.push({
              id: `match_${pNum}_${i}_${matchIdx}_${Date.now()}_${Math.random()
                .toString(36)
                .substr(2, 4)}`,
              pageNumber: pNum,
              text: matchedText,
              snippet,
              x: Math.round(boxX * 10) / 10,
              y: Math.round(boxY * 10) / 10,
              width: Math.round(boxWidth * 10) / 10,
              height: Math.round(boxHeight * 10) / 10,
              selected: true,
            });
          }
        }
      }

      setMatches(foundMatches);
      setHasScanned(true);
    } catch (err: any) {
      console.error("Scan error:", err);
      setErrorMessage(`Scan failed: ${err.message || "Unknown error"}`);
    } finally {
      setIsScanning(false);
    }
  };

  const toggleSelectMatch = (id: string) => {
    setMatches((prev) =>
      prev.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m)),
    );
  };

  const toggleSelectAll = (select: boolean) => {
    setMatches((prev) => prev.map((m) => ({ ...m, selected: select })));
  };

  const selectedCount = matches.filter((m) => m.selected).length;

  const handleApplyRedactions = () => {
    const selectedMatches = matches.filter((m) => m.selected);
    if (selectedMatches.length === 0) return;

    const newRedactions: AnnotationItem[] = selectedMatches.map((m) => ({
      id: `ann_redact_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      type: "redact",
      pageNumber: m.pageNumber,
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
    }));

    let label = patternPresets.find((p) => p.type === patternType)?.label || patternType;
    if (patternType === "TEXT") label = `Keyword "${customText}"`;
    if (patternType === "REGEX") label = `Regex /${customRegex}/`;

    onApplyRedactions(newRedactions, label);

    // Navigate to the first match's page
    if (selectedMatches.length > 0) {
      onNavigate(selectedMatches[0].pageNumber);
    }

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden transition-all">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center border border-rose-500/20 shadow-xs">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                Find & Auto-Redact Patterns
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Scan whole document for sensitive data (emails, SSNs) and apply permanent blackout blocks
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Preset Selector Grid */}
          <div>
            <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-2 uppercase tracking-wider">
              1. Select Data Pattern to Scan:
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {patternPresets.map((preset) => (
                <button
                  key={preset.type}
                  onClick={() => {
                    setPatternType(preset.type);
                    setHasScanned(false);
                    setMatches([]);
                  }}
                  className={`flex items-start gap-3 p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                    patternType === preset.type
                      ? "bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800/80 ring-2 ring-rose-500/30"
                      : "bg-slate-50 dark:bg-slate-800/40 border-slate-200/80 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800/80"
                  }`}
                >
                  <div className="p-1.5 rounded-xl bg-white dark:bg-slate-800 shadow-2xs border border-slate-200/50 dark:border-slate-700">
                    {preset.icon}
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block">
                      {preset.label}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5 leading-snug">
                      {preset.description}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Additional input field if custom text or regex */}
          {patternType === "TEXT" && (
            <div className="bg-slate-50 dark:bg-slate-800/50 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-700 space-y-1.5 animate-in fade-in duration-150">
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300">
                Custom Keyword / Term:
              </label>
              <input
                type="text"
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="e.g. Confidential, John Doe, Account #..."
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-rose-500/50"
              />
            </div>
          )}

          {patternType === "REGEX" && (
            <div className="bg-slate-50 dark:bg-slate-800/50 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-700 space-y-1.5 animate-in fade-in duration-150">
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300">
                Regular Expression (RegEx):
              </label>
              <input
                type="text"
                value={customRegex}
                onChange={(e) => setCustomRegex(e.target.value)}
                placeholder="e.g. \b[A-Z]{2}\d{6}\b"
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-rose-500/50"
              />
            </div>
          )}

          {/* Error notice */}
          {errorMessage && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 rounded-2xl flex items-center gap-2 text-xs font-bold text-rose-700 dark:text-rose-300">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Scan trigger button */}
          <div className="flex items-center justify-between gap-3 pt-1 border-t border-slate-100 dark:border-slate-800">
            <button
              onClick={handleStartScan}
              disabled={isScanning || !pdfDocProxy}
              className="flex-1 py-2.5 px-4 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-2xl text-xs shadow-md shadow-rose-600/20 transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isScanning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                  <span>Scanning Page {scanProgress.current} of {scanProgress.total}...</span>
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  <span>Scan Entire Document for {patternPresets.find((p) => p.type === patternType)?.label}</span>
                </>
              )}
            </button>
          </div>

          {/* Scanning Progress Bar */}
          {isScanning && (
            <div className="space-y-1.5 animate-in fade-in duration-150">
              <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-rose-500 h-2 transition-all duration-200 rounded-full"
                  style={{
                    width: `${Math.round(
                      (scanProgress.current / (scanProgress.total || 1)) * 100,
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Results section */}
          {hasScanned && (
            <div className="space-y-3 pt-2 animate-in slide-in-from-bottom-2 duration-200">
              <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/80 p-3 rounded-2xl border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                  <span className="text-xs font-extrabold text-slate-800 dark:text-slate-100">
                    Found {matches.length} {matches.length === 1 ? "occurrence" : "occurrences"}
                  </span>
                </div>

                {matches.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleSelectAll(true)}
                      className="text-[11px] font-bold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                    >
                      Select All
                    </button>
                    <span className="text-slate-300 dark:text-slate-700">•</span>
                    <button
                      onClick={() => toggleSelectAll(false)}
                      className="text-[11px] font-bold text-slate-500 dark:text-slate-400 hover:underline cursor-pointer"
                    >
                      Deselect All
                    </button>
                  </div>
                )}
              </div>

              {matches.length === 0 ? (
                <div className="p-8 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl text-center space-y-2">
                  <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500" />
                  <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    No matching occurrences found!
                  </p>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500">
                    The document appears clear of the selected pattern.
                  </p>
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto space-y-2 pr-1 no-scrollbar">
                  {matches.map((m) => (
                    <div
                      key={m.id}
                      onClick={() => toggleSelectMatch(m.id)}
                      className={`p-3 rounded-2xl border flex items-center justify-between gap-3 transition-all cursor-pointer ${
                        m.selected
                          ? "bg-rose-50/80 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900/60"
                          : "bg-white dark:bg-slate-800/40 border-slate-200/80 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/80"
                      }`}
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelectMatch(m.id);
                          }}
                          className="text-rose-600 dark:text-rose-400 shrink-0 cursor-pointer"
                        >
                          {m.selected ? (
                            <CheckSquare className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300 dark:text-slate-600" />
                          )}
                        </button>

                        <div className="overflow-hidden">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded-md bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300 text-[10px] font-black uppercase">
                              Page {m.pageNumber}
                            </span>
                            <span className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200 truncate">
                              {m.text}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5 font-sans">
                            {m.snippet}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNavigate(m.pageNumber);
                        }}
                        title="Jump to page preview"
                        className="p-1.5 hover:bg-white dark:hover:bg-slate-700 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 rounded-lg transition-colors shrink-0 cursor-pointer"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex items-center justify-between gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
          >
            Cancel
          </button>

          {hasScanned && matches.length > 0 && (
            <button
              onClick={handleApplyRedactions}
              disabled={selectedCount === 0}
              className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-xs rounded-xl shadow-lg shadow-rose-600/25 transition-all cursor-pointer flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Eraser className="w-4 h-4" />
              <span>Apply {selectedCount} Redaction {selectedCount === 1 ? "Block" : "Blocks"}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

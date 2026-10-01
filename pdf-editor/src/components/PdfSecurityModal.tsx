import React, { useState } from "react";
import {
  Shield,
  Lock,
  EyeOff,
  Layers,
  Download,
  Check,
  X,
  FileCheck,
  AlertTriangle,
} from "lucide-react";
import { triggerHaptic } from "../lib/haptics";

interface PdfSecurityModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  onExport: (options: {
    userPassword?: string;
    ownerPassword?: string;
    stripMetadata: boolean;
    flattenLayers: boolean;
    shareDirectly?: boolean;
  }) => Promise<void>;
}

export default function PdfSecurityModal({
  isOpen,
  onClose,
  fileName,
  onExport,
}: PdfSecurityModalProps) {
  const [requirePassword, setRequirePassword] = useState(false);
  const [userPassword, setUserPassword] = useState("");
  const [stripMetadata, setStripMetadata] = useState(true);
  const [flattenLayers, setFlattenLayers] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  if (!isOpen) return null;

  const handleRunExport = async (shareDirectly: boolean = false) => {
    triggerHaptic("medium");
    setIsProcessing(true);
    try {
      await onExport({
        userPassword: requirePassword && userPassword ? userPassword : undefined,
        stripMetadata,
        flattenLayers,
        shareDirectly,
      });
      onClose();
    } catch (err) {
      console.error("Export security failed:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-md w-full shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-slate-900 dark:text-white">
                Export & Document Security
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Configure privacy, metadata scrubbing & encryption
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

        {/* Form Options */}
        <div className="p-5 space-y-4 text-xs">
          {/* 1. Password Protection */}
          <div className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                <Lock className="w-4 h-4 text-indigo-500" />
                <span>Password Encryption</span>
              </div>
              <input
                type="checkbox"
                checked={requirePassword}
                onChange={(e) => {
                  triggerHaptic("light");
                  setRequirePassword(e.target.checked);
                }}
                className="w-4 h-4 accent-indigo-600 rounded cursor-pointer"
              />
            </div>
            {requirePassword && (
              <div className="pt-2 animate-in fade-in slide-in-from-top-1 duration-150">
                <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400 block mb-1">
                  Recipient Unlock Password:
                </label>
                <input
                  type="password"
                  value={userPassword}
                  onChange={(e) => setUserPassword(e.target.value)}
                  placeholder="Enter secure PDF password..."
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-bold text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            )}
          </div>

          {/* 2. Metadata Scrubbing */}
          <div className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 flex items-center justify-between">
            <div className="space-y-0.5 pr-3">
              <div className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                <EyeOff className="w-4 h-4 text-emerald-500" />
                <span>Scrub Privacy Metadata</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Removes original author, machine name, creator software & revision timestamps.
              </p>
            </div>
            <input
              type="checkbox"
              checked={stripMetadata}
              onChange={(e) => {
                triggerHaptic("light");
                setStripMetadata(e.target.checked);
              }}
              className="w-4 h-4 accent-indigo-600 rounded cursor-pointer shrink-0"
            />
          </div>

          {/* 3. Layer Flattening */}
          <div className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 flex items-center justify-between">
            <div className="space-y-0.5 pr-3">
              <div className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                <Layers className="w-4 h-4 text-amber-500" />
                <span>Permanently Flatten Document</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Bakes all signatures, text annotations and stamps into immutable background pixels.
              </p>
            </div>
            <input
              type="checkbox"
              checked={flattenLayers}
              onChange={(e) => {
                triggerHaptic("light");
                setFlattenLayers(e.target.checked);
              }}
              className="w-4 h-4 accent-indigo-600 rounded cursor-pointer shrink-0"
            />
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 flex flex-col sm:flex-row items-center justify-between gap-2">
          <button
            onClick={onClose}
            className="w-full sm:w-auto px-4 py-2.5 text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2 w-full sm:w-auto">

            <button
              disabled={isProcessing}
              onClick={() => handleRunExport(false)}
              className="flex-1 sm:flex-initial px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold text-xs shadow-md flex items-center justify-center gap-1.5 transition-transform active:scale-95 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>{isProcessing ? "Processing..." : "Download PDF"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

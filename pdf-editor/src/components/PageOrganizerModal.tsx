import React, { useState, useEffect } from "react";
import {
  Grid,
  RotateCw,
  RotateCcw,
  Copy,
  Trash2,
  Download,
  ArrowLeft,
  X,
  FilePlus,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
} from "lucide-react";
import { triggerHaptic } from "../lib/haptics";
import { PDFDocument, degrees } from "pdf-lib";

interface PageOrganizerModalProps {
  isOpen: boolean;
  onClose: () => void;
  pdfBytes: Uint8Array | null;
  pdfDocProxy: any;
  numPages: number;
  currentPage: number;
  onUpdatePdfBytes: (newBytes: Uint8Array, newCurrentPage?: number) => void;
  onSelectPage: (pageNumber: number) => void;
}

export default function PageOrganizerModal({
  isOpen,
  onClose,
  pdfBytes,
  pdfDocProxy,
  numPages,
  currentPage,
  onUpdatePdfBytes,
  onSelectPage,
}: PageOrganizerModalProps) {
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [thumbnails, setThumbnails] = useState<{
    [pageNum: number]: { dataUrl: string; width: number; height: number };
  }>({});

  useEffect(() => {
    if (isOpen && numPages > 0) {
      setPageOrder(Array.from({ length: numPages }, (_, i) => i + 1));
      setSelectedPages([currentPage]);
      renderAllThumbnails();
    }
  }, [isOpen, numPages, pdfDocProxy]);

  const renderAllThumbnails = async () => {
    if (!pdfDocProxy) return;
    const thumbs: {
      [pageNum: number]: { dataUrl: string; width: number; height: number };
    } = {};

    for (let i = 1; i <= numPages; i++) {
      try {
        const page = await pdfDocProxy.getPage(i);
        // Render crisp thumbnail matching exact page aspect ratio
        const viewport = page.getViewport({ scale: 0.4 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
          thumbs[i] = {
            dataUrl: canvas.toDataURL("image/jpeg", 0.85),
            width: viewport.width,
            height: viewport.height,
          };
        }
      } catch (err) {
        console.warn(`Failed to render thumbnail for page ${i}:`, err);
      }
    }
    setThumbnails(thumbs);
  };

  if (!isOpen || !pdfBytes) return null;

  const toggleSelectPage = (pageNum: number, e: React.MouseEvent) => {
    e.stopPropagation();
    triggerHaptic("light");
    if (selectedPages.includes(pageNum)) {
      if (selectedPages.length > 1) {
        setSelectedPages(selectedPages.filter((p) => p !== pageNum));
      }
    } else {
      setSelectedPages([...selectedPages, pageNum]);
    }
  };

  // Move page up / down
  const movePage = async (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= pageOrder.length) return;

    triggerHaptic("medium");
    setIsProcessing(true);
    try {
      const newOrder = [...pageOrder];
      const temp = newOrder[index];
      newOrder[index] = newOrder[targetIndex];
      newOrder[targetIndex] = temp;

      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const newDoc = await PDFDocument.create();

      // Copy pages in the new order
      const indicesToCopy = newOrder.map((p) => p - 1);
      const copiedPages = await newDoc.copyPages(pdfDoc, indicesToCopy);
      copiedPages.forEach((p) => newDoc.addPage(p));

      const updatedBytes = await newDoc.save();
      setPageOrder(Array.from({ length: newOrder.length }, (_, i) => i + 1));
      onUpdatePdfBytes(updatedBytes, targetIndex + 1);
    } catch (err) {
      console.error("Reorder failed:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Rotate page
  const rotatePage = async (pageIdx: number, direction: "cw" | "ccw") => {
    triggerHaptic("medium");
    setIsProcessing(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const page = pdfDoc.getPage(pageIdx - 1);
      const currentRotation = page.getRotation().angle || 0;
      const delta = direction === "cw" ? 90 : -90;
      page.setRotation(degrees((currentRotation + delta + 360) % 360));

      const updatedBytes = await pdfDoc.save();
      onUpdatePdfBytes(updatedBytes, pageIdx);
    } catch (err) {
      console.error("Rotate failed:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Duplicate page
  const duplicatePage = async (pageIdx: number) => {
    triggerHaptic("success");
    setIsProcessing(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const [copiedPage] = await pdfDoc.copyPages(pdfDoc, [pageIdx - 1]);
      pdfDoc.insertPage(pageIdx, copiedPage);

      const updatedBytes = await pdfDoc.save();
      onUpdatePdfBytes(updatedBytes, pageIdx + 1);
    } catch (err) {
      console.error("Duplicate failed:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Delete page
  const deletePage = async (pageIdx: number) => {
    if (pageOrder.length <= 1) return;
    triggerHaptic("warning");
    setIsProcessing(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      pdfDoc.removePage(pageIdx - 1);

      const updatedBytes = await pdfDoc.save();
      onUpdatePdfBytes(updatedBytes, Math.max(1, pageIdx - 1));
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Insert blank page
  const insertBlankPage = async (
    pageIdx: number,
    orientation: "portrait" | "landscape" = "portrait"
  ) => {
    triggerHaptic("success");
    setIsProcessing(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const size: [number, number] =
        orientation === "portrait" ? [595.28, 841.89] : [841.89, 595.28]; // A4
      pdfDoc.insertPage(pageIdx, size);

      const updatedBytes = await pdfDoc.save();
      onUpdatePdfBytes(updatedBytes, pageIdx + 1);
    } catch (err) {
      console.error("Insert blank page failed:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Extract selected pages as new standalone PDF
  const extractSelectedPages = async () => {
    if (selectedPages.length === 0) return;
    triggerHaptic("success");
    setIsProcessing(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const extractDoc = await PDFDocument.create();

      const indices = selectedPages.sort((a, b) => a - b).map((p) => p - 1);
      const copied = await extractDoc.copyPages(pdfDoc, indices);
      copied.forEach((p) => extractDoc.addPage(p));

      const extractBytes = await extractDoc.save();
      const blob = new Blob([extractBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Extracted_Pages_${selectedPages.join("_")}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Extract pages failed:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col text-slate-100 animate-in fade-in duration-200">
      {/* Top App Bar Header */}
      <header className="h-16 border-b border-slate-800 bg-slate-900/90 px-4 sm:px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="font-bold text-sm sm:text-base flex items-center gap-2">
              <Grid className="w-4 h-4 text-indigo-400" />
              <span>Page Organizer & Grid Overview</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-mono">
                {pageOrder.length} Pages
              </span>
            </h2>
            <p className="text-xs text-slate-400 hidden sm:block">
              Reorder, rotate, duplicate, delete or extract document pages with 1-click
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedPages.length > 0 && (
            <button
              onClick={extractSelectedPages}
              disabled={isProcessing}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold shadow flex items-center gap-1.5 transition-transform active:scale-95 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Extract ({selectedPages.length})</span>
            </button>
          )}

          <button
            onClick={() => insertBlankPage(pageOrder.length)}
            disabled={isProcessing}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-xl text-xs font-bold border border-slate-700 flex items-center gap-1.5 transition-transform active:scale-95 cursor-pointer"
          >
            <FilePlus className="w-3.5 h-3.5 text-indigo-400" />
            <span>Add Blank Page</span>
          </button>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Grid Canvas Content */}
      <main className="flex-1 overflow-y-auto p-4 sm:p-8">
        <div className="max-w-7xl mx-auto grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6">
          {pageOrder.map((pageNum, idx) => {
            const isSelected = selectedPages.includes(pageNum);
            const isCurrent = pageNum === currentPage;
            const thumbInfo = thumbnails[pageNum];

            return (
              <div
                key={pageNum}
                onClick={() => {
                  onSelectPage(pageNum);
                  onClose();
                }}
                className={`group relative rounded-xl border-2 overflow-hidden bg-white flex flex-col transition-all cursor-pointer shadow-md hover:shadow-2xl hover:scale-[1.02] ${
                  isSelected
                    ? "border-indigo-500 ring-4 ring-indigo-500/40 shadow-indigo-500/20"
                    : isCurrent
                    ? "border-indigo-400 ring-2 ring-indigo-400/30"
                    : "border-slate-700 hover:border-indigo-400"
                }`}
                style={{
                  aspectRatio: thumbInfo
                    ? `${thumbInfo.width} / ${thumbInfo.height}`
                    : "1 / 1.35",
                }}
              >
                {/* Full-Bleed PDF Page Display (Fills 100% of the box, zero dark margins) */}
                {thumbInfo ? (
                  <img
                    src={thumbInfo.dataUrl}
                    alt={`Page ${pageNum}`}
                    className="w-full h-full object-cover bg-white pointer-events-none block"
                  />
                ) : (
                  <div className="w-full h-full min-h-[180px] bg-slate-900 flex flex-col items-center justify-center text-slate-400 text-xs font-mono gap-2 animate-pulse">
                    <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                    <span>Loading Page {pageNum}...</span>
                  </div>
                )}

                {/* Overlaid Floating Header Badges (No wasted space above page) */}
                <div className="absolute top-2 inset-x-2 flex items-center justify-between pointer-events-none z-20">
                  <span className="px-2 py-0.5 rounded-lg bg-slate-900/85 backdrop-blur-md text-white text-[11px] font-bold font-mono shadow-md border border-white/10 pointer-events-auto">
                    Page {pageNum}
                  </span>
                  <button
                    onClick={(e) => toggleSelectPage(pageNum, e)}
                    title={isSelected ? "Deselect page" : "Select page"}
                    className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all pointer-events-auto shadow-md cursor-pointer ${
                      isSelected
                        ? "bg-indigo-600 border-indigo-400 text-white scale-105"
                        : "bg-slate-900/80 border-slate-600 text-white hover:border-indigo-400 hover:bg-indigo-600"
                    }`}
                  >
                    <CheckCircle2
                      className={`w-3.5 h-3.5 ${
                        isSelected ? "text-white opacity-100" : "opacity-0 hover:opacity-100 text-white"
                      }`}
                    />
                  </button>
                </div>

                {/* Active/Current Page Badge */}
                {isCurrent && (
                  <div className="absolute bottom-2 left-2 z-10 pointer-events-none group-hover:opacity-0 transition-opacity">
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-indigo-600 text-white shadow-md">
                      Current
                    </span>
                  </div>
                )}

                {/* Hover Quick Action Bar (Overlaid on bottom) */}
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute inset-x-0 bottom-0 bg-slate-950/90 backdrop-blur-md p-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-around text-slate-200 z-30 shadow-lg border-t border-slate-700/60"
                >
                  <button
                    title="Move Up / Backward"
                    disabled={idx === 0 || isProcessing}
                    onClick={() => movePage(idx, "up")}
                    className="p-1.5 rounded-lg hover:bg-slate-800 hover:text-indigo-400 disabled:opacity-30 transition-colors cursor-pointer"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    title="Move Down / Forward"
                    disabled={idx === pageOrder.length - 1 || isProcessing}
                    onClick={() => movePage(idx, "down")}
                    className="p-1.5 rounded-lg hover:bg-slate-800 hover:text-indigo-400 disabled:opacity-30 transition-colors cursor-pointer"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                  <button
                    title="Rotate 90° Clockwise"
                    disabled={isProcessing}
                    onClick={() => rotatePage(pageNum, "cw")}
                    className="p-1.5 rounded-lg hover:bg-slate-800 hover:text-indigo-400 transition-colors cursor-pointer"
                  >
                    <RotateCw className="w-4 h-4" />
                  </button>
                  <button
                    title="Duplicate Page"
                    disabled={isProcessing}
                    onClick={() => duplicatePage(pageNum)}
                    className="p-1.5 rounded-lg hover:bg-slate-800 hover:text-emerald-400 transition-colors cursor-pointer"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                  <button
                    title="Delete Page"
                    disabled={pageOrder.length <= 1 || isProcessing}
                    onClick={() => deletePage(pageNum)}
                    className="p-1.5 rounded-lg hover:bg-rose-900/60 hover:text-rose-400 disabled:opacity-30 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

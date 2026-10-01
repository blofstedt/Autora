import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
// The legacy build: the modern one uses JavaScript too new for many phones (and for
// the Chromium Autora ships).
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { PDFDocument, rgb, StandardFonts, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFTextField, degrees } from "pdf-lib";
import {
  ShieldAlert,
  Upload,
  Trash2,
  Eye,
  RotateCcw,
  RotateCw,
  MoreVertical,
  Download,
  FileMinus,
  Sparkles,
  FileText,
  ZoomIn,
  ZoomOut,
  AlertCircle,
  Clock,
  Layers,
  ChevronLeft,
  ChevronRight,
  UserCheck,
  Smartphone,
  CheckCircle,
  Menu,
  ChevronDown,
  Moon,
  Sun,
  Undo,
  Redo,
  PenTool,
  Type,
  Edit3,
  Square,
  Circle,
  Minus,
  Palette,
  EyeOff,
  CheckSquare,
  Sidebar,
  HelpCircle,
  Lock,
  Maximize2,
  Loader2,
  X,
  Grid,
  HardDrive,
  CheckCircle2,
  DownloadCloud,
  MessageSquare,
  Share2,
  Image as ImageIcon,
  Highlighter,
  XCircle,
  Shield,
  FileSignature,
  UserCircle,
  Calendar,
  Check,
  XIcon,
} from "lucide-react";

import {
  AnnotationItem,
  SavedSignature,
  ActivityLog,
  PDFPageSize,
  WatermarkConfig,
  PageNumberConfig,
} from "./types";
import SignatureModal from "./components/SignatureModal";
import Toolbar, { ToolMode, StampType, ShapeType } from "./components/Toolbar";
import LayerControl from "./components/LayerControl";
import HistoryControl from "./components/HistoryControl";
import PurgeOverlay from "./components/PurgeOverlay";
import PdfMergeModal from "./components/PdfMergeModal";
import PdfCompressModal from "./components/PdfCompressModal";
import PdfSearch from "./components/PdfSearch";
import FindAndRedactModal from "./components/FindAndRedactModal";
import WatermarkModal from "./components/WatermarkModal";
import PageOrganizerModal from "./components/PageOrganizerModal";
import PdfSecurityModal from "./components/PdfSecurityModal";
import StickyNotePopover from "./components/StickyNotePopover";
import { triggerHaptic } from "./lib/haptics";
import { setupPdfJs, ownWorker, PDFJS_DATA } from "./lib/pdfjs";

// pdf.js's worker and data, served with the editor rather than from a CDN:
// Autora runs on a home server that may have no internet. See ./lib/pdfjs.ts.
setupPdfJs(pdfjsLib);

function parseColorFromDA(da: string | undefined) {
  if (!da) return "#000000";
  const match = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
  if (match) {
    const r = Math.round(parseFloat(match[1]) * 255);
    const g = Math.round(parseFloat(match[2]) * 255);
    const b = Math.round(parseFloat(match[3]) * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  const matchG = da.match(/([\d.]+)\s+g/);
  if (matchG) {
    const v = Math.round(parseFloat(matchG[1]) * 255);
    return `#${v.toString(16).padStart(2, '0')}${v.toString(16).padStart(2, '0')}${v.toString(16).padStart(2, '0')}`;
  }
  return "#000000";
}

async function extractAndCleanAnnotations(bytes: Uint8Array): Promise<{cleanedBytes: Uint8Array, extractedAnnotations: AnnotationItem[]}> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = doc.getPages();
    const newAnnotations: AnnotationItem[] = [];
    const refsToRemove = new Set<string>();
    
    // 1. Extract from AcroForm Text Fields
    let acroForm: any;
    try {
      acroForm = (doc.catalog as any).lookup(PDFName.of("AcroForm"));
    } catch (e) {}
    
    if (acroForm) {
      const form = doc.getForm();
      const fields = form.getFields();
      for (const f of fields) {
        if (f instanceof PDFTextField) {
          const text = (f as any).getText();
          if (text && text.trim().length > 0) {
            let color = "#000000";
            try {
               const da = (f as any).acroField.getDefaultAppearance();
               color = parseColorFromDA(da);
            } catch (e) {}

            const widgets = (f as any).acroField.getWidgets();
            for (const w of widgets) {
              const rect = w.getRectangle();
              const ref = w.P();
              let pageIndex = pages.findIndex(p => p.ref === ref);
              if (pageIndex === -1) pageIndex = 0;
              const pageHeight = pages[pageIndex].getHeight();
              // In PDF, y is from bottom. We want y from top.
              const yFromTop = pageHeight - rect.y - rect.height;
              newAnnotations.push({
                id: Math.random().toString(36).substring(7),
                pageNumber: pageIndex + 1,
                type: "text",
                x: rect.x,
                y: yFromTop,
                text: text,
                fontColor: color,
                width: Math.max(100, rect.width),
                height: Math.max(20, rect.height),
                fontFamily: "Helvetica",
                fontSize: Math.max(10, rect.height * 0.7),
              });
            }
          }
          
          const kids = (f as any).acroField.Kids();
          if (kids) {
            for (let i = 0; i < kids.size(); i++) {
               const r = kids.get(i);
               if (r && (r as any).tag) refsToRemove.add((r as any).tag);
            }
          } else {
             if ((f as any).ref && (f as any).ref.tag) refsToRemove.add((f as any).ref.tag);
          }
          form.removeField(f);
        }
      }
    }

    // 2. Extract from FreeText annotations
    for (let pIdx = 0; pIdx < pages.length; pIdx++) {
      const p = pages[pIdx];
      const pAnnots = p.node.Annots();
      if (pAnnots instanceof PDFArray) {
        for (let i = pAnnots.size() - 1; i >= 0; i--) {
          const aRef = pAnnots.get(i);
          let removeThis = false;
          if (aRef && (aRef as any).tag && refsToRemove.has((aRef as any).tag)) {
             removeThis = true;
          }
          
          const a = pAnnots.lookupMaybe(i, PDFDict);
          if (a) {
             const subtype = a.lookup(PDFName.of('Subtype'));
             if (subtype === PDFName.of('FreeText')) {
                const rectArr = a.lookupMaybe(PDFName.of('Rect'), PDFArray);
                if (rectArr) {
                  const rArr = rectArr.asArray().map(n => (n as any).numberValue || 0);
                  const x = rArr[0];
                  const yBottom = rArr[1];
                  const w = rArr[2] - rArr[0];
                  const h = rArr[3] - rArr[1];
                  const pageHeight = p.getHeight();
                  const yFromTop = pageHeight - yBottom - h;
                  
                  let text = '';
                  const contents = a.lookupMaybe(PDFName.of('Contents'), PDFString) || a.lookupMaybe(PDFName.of('Contents'), PDFHexString);
                  if (contents) {
                    text = contents.decodeText();
                  }
                  
                  let color = "#000000";
                  try {
                     const daStr = a.lookupMaybe(PDFName.of('DA'), PDFString);
                     if (daStr) color = parseColorFromDA(daStr.decodeText());
                  } catch (e) {}

                  if (text && text.trim().length > 0) {
                    newAnnotations.push({
                      id: Math.random().toString(36).substring(7),
                      pageNumber: pIdx + 1,
                      type: "text",
                      x: x,
                      y: yFromTop,
                      text: text,
                      fontColor: color,
                      width: Math.max(100, w),
                      height: Math.max(20, h),
                      fontFamily: "Helvetica",
                      fontSize: Math.max(10, h * 0.7),
                    });
                  }
                }
                removeThis = true;
             }
          }
          if (removeThis) {
             pAnnots.remove(i);
          }
        }
      }
    }

    if (acroForm) {
      acroForm.delete(PDFName.of("XFA"));
    }

    const cleanedBytes = await doc.save();
    return { cleanedBytes, extractedAnnotations: newAnnotations };
  } catch (err) {
    console.warn("Could not parse annotations:", err);
    return { cleanedBytes: bytes, extractedAnnotations: [] };
  }
}

function PageThumbnailCard({
  pageNumber,
  pdfDocProxy,
  isActive,
  onClick,
  onDelete,
  onRotateCw,
  onRotateCcw,
}: {
  key?: React.Key;
  pageNumber: number;
  pdfDocProxy: any;
  isActive: boolean;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onRotateCw: (e: React.MouseEvent) => void;
  onRotateCcw: (e: React.MouseEvent) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
        setMenuPosition(null);
      }
    };
    if (isMenuOpen || menuPosition) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [isMenuOpen, menuPosition]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPosition({ x: e.clientX, y: e.clientY });
    setIsMenuOpen(true);
  };

  const [aspectRatio, setAspectRatio] = useState<number>(1 / 1.3);

  useEffect(() => {
    let isCancelled = false;
    let renderTask: any = null;

    async function renderThumbnail() {
      if (!pdfDocProxy || !canvasRef.current) return;
      try {
        setIsLoading(true);
        const page = await pdfDocProxy.getPage(pageNumber);
        if (isCancelled) return;

        const viewport = page.getViewport({ scale: 0.35 });
        if (viewport.width && viewport.height) {
          setAspectRatio(viewport.width / viewport.height);
        }
        const canvas = canvasRef.current;
        if (!canvas) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        renderTask = page.render({
          canvasContext: ctx,
          viewport: viewport,
        });

        await renderTask.promise;
        if (!isCancelled) setIsLoading(false);
      } catch (err: any) {
        if (err?.name !== "RenderingCancelledException") {
          console.warn("Thumbnail render failed for page", pageNumber, err);
        }
      }
    }

    renderThumbnail();

    return () => {
      isCancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch (_) {}
      }
    };
  }, [pdfDocProxy, pageNumber]);

  return (
    <div
      onClick={onClick}
      onContextMenu={handleContextMenu}
      className={`group relative flex flex-col items-center p-1.5 rounded-xl border transition-all cursor-pointer ${
        isActive
          ? "border-indigo-600 bg-indigo-50/80 dark:bg-indigo-950/50 ring-2 ring-indigo-500/50 shadow-md"
          : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-xs"
      }`}
    >
      <div
        className="relative w-full bg-white rounded-lg overflow-hidden flex items-center justify-center border border-slate-200/80 dark:border-slate-700/80 shadow-xs"
        style={{ aspectRatio: `${aspectRatio}` }}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50 dark:bg-slate-900 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
          </div>
        )}
        <canvas ref={canvasRef} className="w-full h-full object-cover block" />

        {/* Hover Quick Action Buttons */}
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRotateCw(e);
            }}
            title={`Rotate page ${pageNumber} 90° Clockwise`}
            className="p-1 bg-slate-900/80 hover:bg-slate-900 text-white rounded-md shadow-md transition-colors cursor-pointer"
          >
            <RotateCw className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRotateCcw(e);
            }}
            title={`Rotate page ${pageNumber} 90° Counter-Clockwise`}
            className="p-1 bg-slate-900/80 hover:bg-slate-900 text-white rounded-md shadow-md transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(e);
            }}
            title={`Delete page ${pageNumber}`}
            className="p-1 bg-rose-600 hover:bg-rose-700 text-white rounded-md shadow-md transition-colors cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
              setIsMenuOpen(true);
            }}
            title="Page Context Menu"
            className="p-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md shadow-md transition-colors cursor-pointer"
          >
            <MoreVertical className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between w-full px-1">
        <span
          className={`text-[11px] font-bold ${
            isActive
              ? "text-indigo-600 dark:text-indigo-400"
              : "text-slate-600 dark:text-slate-300"
          }`}
        >
          Page {pageNumber}
        </span>
        {isActive && (
          <span className="text-[9px] font-extrabold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 bg-indigo-100 dark:bg-indigo-900/60 px-1.5 py-0.5 rounded-md">
            Active
          </span>
        )}
      </div>

      {/* Context Menu Popup */}
      {isMenuOpen && menuPosition && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            left: Math.min(menuPosition.x, window.innerWidth - 190),
            top: Math.min(menuPosition.y, window.innerHeight - 150),
          }}
          className="z-50 w-48 bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 py-1.5 text-xs text-slate-800 dark:text-slate-200 animate-in fade-in zoom-in-95 duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700/80 mb-1">
            Page {pageNumber} Options
          </div>
          <button
            onClick={(e) => {
              setIsMenuOpen(false);
              setMenuPosition(null);
              onRotateCw(e);
            }}
            className="w-full text-left px-3 py-2 hover:bg-indigo-50 dark:hover:bg-slate-700/80 flex items-center gap-2 font-medium transition-colors cursor-pointer text-slate-700 dark:text-slate-200"
          >
            <RotateCw className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
            <span>Rotate 90° Clockwise</span>
          </button>
          <button
            onClick={(e) => {
              setIsMenuOpen(false);
              setMenuPosition(null);
              onRotateCcw(e);
            }}
            className="w-full text-left px-3 py-2 hover:bg-indigo-50 dark:hover:bg-slate-700/80 flex items-center gap-2 font-medium transition-colors cursor-pointer text-slate-700 dark:text-slate-200"
          >
            <RotateCcw className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
            <span>Rotate 90° Counter-CW</span>
          </button>
          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
          <button
            onClick={(e) => {
              setIsMenuOpen(false);
              setMenuPosition(null);
              onDelete(e);
            }}
            className="w-full text-left px-3 py-2 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 flex items-center gap-2 font-medium transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-500" />
            <span>Delete Page</span>
          </button>
        </div>
      )}
    </div>
  );
}

function MainPdfEditor() {
  // PDF File state
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string>("");
  const [pdfDocProxy, setPdfDocProxy] = useState<any>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [isAutoFitActive, setIsAutoFitActive] = useState<boolean>(true);
  const hasInitialFittedRef = useRef<boolean>(false);
  const [zoomScale, setZoomScale] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const isMobile = window.innerWidth < 768;
      if (isMobile) {
        return Math.max(0.45, Number(((window.innerWidth - 16) / 595).toFixed(2)));
      }
      return Math.max(0.6, Number(((window.innerHeight - 100) / 842).toFixed(2)));
    }
    return 1.2;
  });
  const [deletePageRange, setDeletePageRange] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [originalPageSize, setOriginalPageSize] = useState<PDFPageSize>({
    width: 595,
    height: 842,
  }); // Default A4
  const [canvasDimensions, setCanvasDimensions] = useState({
    width: 595,
    height: 842,
  });

  // Canvas and interaction state
  const [annotations, setAnnotations] = useState<AnnotationItem[]>([]);
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<
    string | null
  >(null);
  const [toolMode, setToolMode] = useState<ToolMode>("select");

  // History state for undo/redo
  const [history, setHistory] = useState<{
    timeline: {
      annotations: AnnotationItem[];
      description: string;
      id: string;
    }[];
    currentIndex: number;
  }>({
    timeline: [{ annotations: [], description: "Document loaded", id: "init" }],
    currentIndex: 0,
  });

  const [isPdfMergeModalOpen, setIsPdfMergeModalOpen] = useState(false);
  const [isPdfCompressModalOpen, setIsPdfCompressModalOpen] = useState(false);
  const [shapeContextMenu, setShapeContextMenu] = useState<{
    annId: string;
    x: number;
    y: number;
  } | null>(null);

  // Page navigation direction & linked gesture tracking
  const pageFoldOverlayRef = useRef<HTMLDivElement | null>(null);
  const prevPageRef = useRef<() => void>(() => {});
  const nextPageRef = useRef<() => void>(() => {});
  const navigateToPageRef = useRef<(p: number) => void>(() => {});
  const pageImageCacheRef = useRef<Map<string, string>>(new Map());
  const neighborCardRef = useRef<HTMLDivElement | null>(null);
  const neighborImgRef = useRef<HTMLImageElement | null>(null);
  const isNavigatingRef = useRef<boolean>(false);
  const inertiaAnimRef = useRef<number | null>(null);

  // Mobile touch gestures (Pinch-to-zoom & Linked Swipe pagination)
  const pinchRef = useRef<{
    initialDist: number;
    initialZoom: number;
    lastRatio: number;
    isPinching: boolean;
    originX: number;
    originY: number;
    initialMidX: number;
    initialMidY: number;
    lastMidX: number;
    lastMidY: number;
  }>({
    initialDist: 0,
    initialZoom: 1.0,
    lastRatio: 1.0,
    isPinching: false,
    originX: 0,
    originY: 0,
    initialMidX: 0,
    initialMidY: 0,
    lastMidX: 0,
    lastMidY: 0,
  });

  const focalPointRef = useRef<{
    focalViewportX: number;
    focalViewportY: number;
    focalOnPageRatioX: number;
    focalOnPageRatioY: number;
    targetZoom: number;
  } | null>(null);

  const touchSwipeRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    currentX: number;
    currentY: number;
    startTime: number;
    isMultiTouch: boolean;
    isSwiping: boolean;
    activeNeighborPage: number | null;
    isPanning: boolean;
    history: Array<{ x: number; y: number; time: number }>;
  }>({
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    currentX: 0,
    currentY: 0,
    startTime: 0,
    isMultiTouch: false,
    isSwiping: false,
    activeNeighborPage: null,
    isPanning: false,
    history: [],
  });

  // Floating Page Indicator Pill state (pops up on page change and fades out)
  const [showPageIndicator, setShowPageIndicator] = useState<boolean>(false);
  const pageIndicatorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const triggerPageIndicator = () => {
    setShowPageIndicator(true);
    if (pageIndicatorTimeoutRef.current) {
      clearTimeout(pageIndicatorTimeoutRef.current);
    }
    pageIndicatorTimeoutRef.current = setTimeout(() => {
      setShowPageIndicator(false);
    }, 1800);
  };

  useEffect(() => {
    if (pdfBytes && numPages > 0) {
      triggerPageIndicator();
    }
  }, [currentPage, pdfBytes, numPages]);

  useEffect(() => {
    return () => {
      if (pageIndicatorTimeoutRef.current) {
        clearTimeout(pageIndicatorTimeoutRef.current);
      }
      if (inertiaAnimRef.current !== null) {
        cancelAnimationFrame(inertiaAnimRef.current);
      }
    };
  }, []);


  useEffect(() => {
    const handleGlobalClick = () => setShapeContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShapeContextMenu(null);
    };
    window.addEventListener("click", handleGlobalClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", handleGlobalClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const resetAnnotations = (initialAnns: AnnotationItem[] = []) => {
    setAnnotations(initialAnns);
    setHistory({
      timeline: [
        {
          annotations: initialAnns,
          description: "Document loaded",
          id: Date.now().toString(),
        },
      ],
      currentIndex: 0,
    });
  };

  const dispatchAnnotationUpdate = (
    updater: AnnotationItem[] | ((prev: AnnotationItem[]) => AnnotationItem[]),
    description: string,
  ) => {
    setAnnotations((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;

      setHistory((currHist) => {
        const newTimeline = currHist.timeline.slice(
          0,
          currHist.currentIndex + 1,
        );
        newTimeline.push({
          annotations: next,
          description,
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        });
        return {
          timeline: newTimeline,
          currentIndex: newTimeline.length - 1,
        };
      });

      return next;
    });
  };

  const undo = () => {
    setHistory((currHist) => {
      if (currHist.currentIndex > 0) {
        const newIndex = currHist.currentIndex - 1;
        setAnnotations(currHist.timeline[newIndex].annotations);
        return { ...currHist, currentIndex: newIndex };
      }
      return currHist;
    });
  };

  const redo = () => {
    setHistory((currHist) => {
      if (currHist.currentIndex < currHist.timeline.length - 1) {
        const newIndex = currHist.currentIndex + 1;
        setAnnotations(currHist.timeline[newIndex].annotations);
        return { ...currHist, currentIndex: newIndex };
      }
      return currHist;
    });
  };

  const jumpToHistory = (index: number) => {
    setHistory((currHist) => {
      if (index >= 0 && index < currHist.timeline.length) {
        setAnnotations(currHist.timeline[index].annotations);
        return { ...currHist, currentIndex: index };
      }
      return currHist;
    });
  };

  // Selected sub-tool attributes
  const [textFontSize, setTextFontSize] = useState<number>(14);
  const [textFontColor, setTextFontColor] = useState<string>("#0e1118");
  const [textFontFamily, setTextFontFamily] = useState<string>("Helvetica");
  const [activeStampType, setActiveStampType] = useState<StampType>("APPROVED");
  const [activeShapeType, setActiveShapeType] = useState<ShapeType>("rectangle");
  const [highlighterColor, setHighlighterColor] = useState<string>("#fde047");
  const [highlighterWidth, setHighlighterWidth] = useState<number>(24);

  // Ink drawing state
  const [isDrawingInk, setIsDrawingInk] = useState<boolean>(false);
  const [currentInkPoints, setCurrentInkPoints] = useState<
    { x: number; y: number }[]
  >([]);
  const [inkColor, setInkColor] = useState<string>("#b22222"); // Crimson red default
  const [inkWidth, setInkWidth] = useState<number>(3);

  // Modals & New Feature States
  const [isWatermarkModalOpen, setIsWatermarkModalOpen] = useState<boolean>(false);
  const [isPageOrganizerOpen, setIsPageOrganizerOpen] = useState<boolean>(false);
  const [isSecurityModalOpen, setIsSecurityModalOpen] = useState<boolean>(false);
  const [watermarkConfig, setWatermarkConfig] = useState<WatermarkConfig | null>(null);
  const [pageNumberConfig, setPageNumberConfig] = useState<PageNumberConfig | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  // Sensitive pattern detection state (for Smart Redaction targeting glow)
  const [sensitiveHighlights, setSensitiveHighlights] = useState<
    Array<{
      id: string;
      type: "EMAIL" | "PHONE" | "SSN" | "CREDIT_CARD";
      label: string;
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>
  >([]);
  const [isScanningSensitive, setIsScanningSensitive] = useState<boolean>(false);

  // Redact drawing state
  const [isDrawingRedact, setIsDrawingRedact] = useState<boolean>(false);
  const [redactStart, setRedactStart] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [redactCurrent, setRedactCurrent] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Signatures list
  const [isSignatureModalOpen, setIsSignatureModalOpen] =
    useState<boolean>(false);
  const [isFindAndRedactOpen, setIsFindAndRedactOpen] =
    useState<boolean>(false);

  // Sandbox privacy elements
  const [isPurging, setIsPurging] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    return typeof window !== "undefined" ? window.innerWidth >= 1024 : true;
  });
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
  const [activeMenu, setActiveMenu] = useState<
    "file" | "edit" | "insert" | "view" | "help" | null
  >(null);
  const [isKeyboardHelpOpen, setIsKeyboardHelpOpen] = useState<boolean>(false);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState<boolean>(false);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);
  const [draggedElementId, setDraggedElementId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeDirection, setResizeDirection] = useState<"br" | null>(null);

  // ---- Autora: the window this editor runs in -------------------------------
  //
  // The file and the objects on it belong to Autora (server/pdfdesk.ts); this
  // page shows them and lets the person change them. Autora sends the file and
  // the objects -- the agent's and the person's -- whenever they change; this
  // page sends back what the person did: objects added, moved, edited or
  // removed (as changes, so it never overwrites something the agent placed a
  // moment ago), and the whole file when an action here rewrote it (pages
  // deleted, turned or reordered, a merge, a redaction applied).
  const bridge = useRef<{
    /** The file as Autora last sent it: a change of pdfBytes to anything else was made here. */
    base: Uint8Array | null;
    baseRev: number;
    /** Each object as Autora last had it, by id, as JSON. */
    synced: Map<string, string>;
  }>({ base: null, baseRev: -1, synced: new Map() });
  const annotationsRef = useRef<AnnotationItem[]>([]);
  annotationsRef.current = annotations;
  /** Autora asks to show one of the agent's changes; and which objects wait for a decision. */
  const [focusRequest, setFocusRequest] = useState<{ id: string | null; page: number; at: number } | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "autora:load" && msg.bytes) {
        const bytes = new Uint8Array(msg.bytes as ArrayBuffer);
        const items: AnnotationItem[] = Array.isArray(msg.items) ? msg.items : [];
        bridge.current.base = bytes;
        bridge.current.baseRev = Number(msg.baseRev) || 0;
        bridge.current.synced = new Map(items.map((i) => [i.id, JSON.stringify(i)]));
        hasInitialFittedRef.current = false;
        setIsAutoFitActive(true);
        setPdfBytes(bytes);
        setPdfFileName(String(msg.name || "document.pdf"));
        setPdfDocProxy(null);
        setCurrentPage((p) => (msg.keepPage ? p : 1));
        resetAnnotations(items);
        setSelectedAnnotationId(null);
      } else if (msg.type === "autora:focus") {
        // The agent's change the person is looking at: go to its page and select it.
        setFocusRequest({ id: typeof msg.id === "string" ? msg.id : null, page: Number(msg.page) || 1, at: Date.now() });
      } else if (msg.type === "autora:pending" && Array.isArray(msg.ids)) {
        setPendingIds(msg.ids.filter((i: unknown): i is string => typeof i === "string" && /^[\w.-]{1,80}$/.test(i)));
      } else if (msg.type === "autora:items" && Array.isArray(msg.items)) {
        // The objects as Autora has them now. What the person changed here and
        // Autora has not heard yet stays as it is on this page.
        const remote: AnnotationItem[] = msg.items;
        const synced = bridge.current.synced;
        const local = new Map(annotationsRef.current.map((i) => [i.id, i]));
        const pending = new Set(
          [...local.values()].filter((i) => synced.get(i.id) !== JSON.stringify(i)).map((i) => i.id),
        );
        const remoteIds = new Set(remote.map((i) => i.id));
        const next = remote.map((i) => (pending.has(i.id) ? local.get(i.id)! : i));
        for (const i of local.values()) if (pending.has(i.id) && !remoteIds.has(i.id) && !synced.has(i.id)) next.push(i);
        bridge.current.synced = new Map(remote.map((i) => [i.id, JSON.stringify(i)]));
        setAnnotations(next);
      }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "autora:ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // What the person did to the objects, told to Autora as changes.
  useEffect(() => {
    // Mid-drag the object is still moving: say where it ends up.
    if (!bridge.current.base || draggedElementId || resizeDirection) return;
    const t = setTimeout(() => {
      const synced = bridge.current.synced;
      const upsert = annotations.filter((i) => synced.get(i.id) !== JSON.stringify(i));
      const ids = new Set(annotations.map((i) => i.id));
      const remove = [...synced.keys()].filter((id) => !ids.has(id));
      if (!upsert.length && !remove.length) return;
      for (const i of upsert) synced.set(i.id, JSON.stringify(i));
      for (const id of remove) synced.delete(id);
      window.parent.postMessage({ type: "autora:ops", upsert, remove }, "*");
    }, 350);
    return () => clearTimeout(t);
  }, [annotations, draggedElementId, resizeDirection]);

  // The file itself changed here: send all of it, with the objects as they now are.
  useEffect(() => {
    if (!pdfBytes || !bridge.current.base || pdfBytes === bridge.current.base) return;
    bridge.current.base = pdfBytes;
    const items = annotationsRef.current;
    bridge.current.synced = new Map(items.map((i) => [i.id, JSON.stringify(i)]));
    const copy = pdfBytes.slice(0);
    window.parent.postMessage(
      { type: "autora:base", bytes: copy.buffer, items, name: pdfFileName },
      "*",
      [copy.buffer],
    );
  }, [pdfBytes]);


  // References
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const xfaLayerRef = useRef<HTMLDivElement>(null);
  const annotationLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const thumbnailRefs = useRef<{ [key: number]: HTMLDivElement | null }>({});
  const viewportScrollerRef = useRef<HTMLDivElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);

  // Lock mobile multi-touch gestures to the PDF viewer container (prevent whole-app / browser window zoom)
  useEffect(() => {
    const scroller = viewportScrollerRef.current;
    if (!scroller) return;

    const preventDefaultMultiTouch = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
      }
    };

    const preventGesture = (e: Event) => {
      e.preventDefault();
    };

    scroller.addEventListener("touchstart", preventDefaultMultiTouch, {
      passive: false,
    });
    scroller.addEventListener("touchmove", preventDefaultMultiTouch, {
      passive: false,
    });
    scroller.addEventListener("gesturestart", preventGesture, {
      passive: false,
    });
    scroller.addEventListener("gesturechange", preventGesture, {
      passive: false,
    });

    return () => {
      scroller.removeEventListener("touchstart", preventDefaultMultiTouch);
      scroller.removeEventListener("touchmove", preventDefaultMultiTouch);
      scroller.removeEventListener("gesturestart", preventGesture);
      scroller.removeEventListener("gesturechange", preventGesture);
    };
  }, []);

  // Auto-scroll sidebar thumbnail list so the active page slides smoothly to the top position
  useEffect(() => {
    if (!isSidebarOpen || !currentPage) return;
    const timer = setTimeout(() => {
      const container = sidebarContainerRef.current;
      const activeCard = thumbnailRefs.current[currentPage];
      if (container && activeCard) {
        // Calculate target scrollTop so active card aligns smoothly at the top
        const targetScrollTop = activeCard.offsetTop - container.offsetTop - 12; // 12px padding offset
        container.scrollTo({
          top: Math.max(0, targetScrollTop),
          behavior: "smooth",
        });
      }
    }, 40);
    return () => clearTimeout(timer);
  }, [currentPage, isSidebarOpen, numPages]);

  // Click outside listener to retract menus when clicking or tapping away
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        activeMenu !== null &&
        menuBarRef.current &&
        !menuBarRef.current.contains(target)
      ) {
        setActiveMenu(null);
      }
      if (
        isMenuOpen &&
        mobileMenuRef.current &&
        !mobileMenuRef.current.contains(target)
      ) {
        setIsMenuOpen(false);
      }
    };

    if (activeMenu !== null || isMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [activeMenu, isMenuOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        redo();
      } else if (
        !isInput &&
        (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp")
      ) {
        e.preventDefault();
        prevPageRef.current();
      } else if (
        !isInput &&
        (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown")
      ) {
        e.preventDefault();
        nextPageRef.current();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [history, numPages]);

  // App initialization log
  useEffect(() => {
    // Logs removed per user request
  }, []);

  // Smart Redaction: Scan visible page text for sensitive patterns (emails, phone numbers, SSNs, credit cards)
  useEffect(() => {
    if (toolMode !== "redact" || !pdfDocProxy || !currentPage) {
      setSensitiveHighlights([]);
      return;
    }

    let isCancelled = false;

    async function scanSensitivePatterns() {
      try {
        setIsScanningSensitive(true);
        const page = await pdfDocProxy.getPage(currentPage);
        const viewport = page.getViewport({ scale: 1.0 });
        const textContent = await page.getTextContent();
        const items = textContent.items;

        const detected: Array<{
          id: string;
          type: "EMAIL" | "PHONE" | "SSN" | "CREDIT_CARD";
          label: string;
          text: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }> = [];

        const patterns: Array<{
          type: "EMAIL" | "PHONE" | "SSN" | "CREDIT_CARD";
          label: string;
          regex: RegExp;
        }> = [
          {
            type: "EMAIL",
            label: "Email Address",
            regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
          },
          {
            type: "PHONE",
            label: "Phone Number",
            regex: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
          },
          {
            type: "SSN",
            label: "SSN",
            regex: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
          },
          {
            type: "CREDIT_CARD",
            label: "Credit Card",
            regex: /\b(?:\d[ -]*?){13,19}\b/g,
          },
        ];

        for (let i = 0; i < items.length; i++) {
          const item: any = items[i];
          if (!item || !item.str) continue;

          const str = item.str;

          for (const p of patterns) {
            p.regex.lastIndex = 0;
            let matchExec: RegExpExecArray | null;

            while ((matchExec = p.regex.exec(str)) !== null) {
              const matchedText = matchExec[0];
              if (!matchedText) {
                p.regex.lastIndex++;
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
                Math.max(matchWidth, 12) + 3
              );
              const boxHeight = Math.min(
                viewport.height - boxY,
                itemHeight + 3
              );

              const key = `${p.type}_${Math.round(boxX)}_${Math.round(boxY)}`;
              if (!detected.some((d) => d.id === key)) {
                detected.push({
                  id: key,
                  type: p.type,
                  label: p.label,
                  text: matchedText,
                  x: Math.round(boxX),
                  y: Math.round(boxY),
                  width: Math.round(boxWidth),
                  height: Math.round(boxHeight),
                });
              }
            }
          }
        }

        if (!isCancelled) {
          setSensitiveHighlights(detected);
        }
      } catch (err) {
        console.warn("Sensitive pattern scan failed:", err);
      } finally {
        if (!isCancelled) {
          setIsScanningSensitive(false);
        }
      }
    }

    scanSensitivePatterns();

    return () => {
      isCancelled = true;
    };
  }, [toolMode, currentPage, pdfDocProxy]);

  // Batch redact all detected sensitive patterns on the current page
  const handleRedactAllDetected = () => {
    if (sensitiveHighlights.length === 0) return;
    const newRedactions: AnnotationItem[] = sensitiveHighlights.map((det) => ({
      id: `ann_redact_${Date.now()}_${Math.random().toString(36).substr(2, 4)}_${det.id}`,
      type: "redact",
      pageNumber: currentPage,
      x: det.x,
      y: det.y,
      width: det.width,
      height: det.height,
    }));

    dispatchAnnotationUpdate(
      (prev) => [...prev, ...newRedactions],
      `Auto-redacted ${sensitiveHighlights.length} sensitive patterns on page ${currentPage}`
    );
    addLog(
      `Auto-redacted ${sensitiveHighlights.length} sensitive patterns on page ${currentPage}.`,
      "security"
    );
  };

  // Helper log generator (No-op)
  const addLog = (
    message: string,
    type: "info" | "success" | "warning" | "security" = "info",
  ) => {
    // no-op
  };

  // Convert Hex color to RGB object
  const hexToRgb = (
    hex: string | undefined,
  ): { r: number; g: number; b: number } | null => {
    if (!hex) return null;
    const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    const fullHex = hex.replace(
      shorthandRegex,
      (_, r, g, b) => r + r + g + g + b + b,
    );
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  };

  // Conversion: base64 data to ArrayBuffer
  const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
    const binaryString = window.atob(base64.split(",")[1]);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  };

  // PDF.js Document Loading (runs only when pdfBytes changes)
  useEffect(() => {
    if (!pdfBytes) {
      setPdfDocProxy(null);
      setNumPages(0);
      return;
    }

    let isCancelled = false;
    let loadingTask: any = null;
    const own = ownWorker(pdfjsLib);

    const loadDocument = async () => {
      try {
        setLoading(true);
        addLog("Parsing document binary array metadata...", "info");
        loadingTask = pdfjsLib.getDocument({
          worker: own.worker as any,
          data: pdfBytes.slice(0),
          enableXfa: true,
          cMapUrl: PDFJS_DATA.cMapUrl,
          cMapPacked: true,
          standardFontDataUrl: PDFJS_DATA.standardFontDataUrl,
          BinaryDataFactory: PDFJS_DATA.BinaryDataFactory as any,
        });

        const docProxy = await loadingTask.promise;
        if (isCancelled) {
          try {
            docProxy.destroy();
          } catch (_) {}
          return;
        }

        setPdfDocProxy(docProxy);
        setNumPages(docProxy.numPages);
        addLog(
          `Document parsed successfully. Total pages: ${docProxy.numPages}`,
          "success",
        );
      } catch (err: any) {
        if (isCancelled) return;
        console.error("PDF Document Load Error:", err);
        addLog(`PDF Loader Error: ${err.message}`, "warning");
        setLoading(false);
        if (
          err.name === "InvalidPDFException" ||
          err.message?.includes("Invalid PDF structure")
        ) {
          setPdfBytes(null);
          setPdfDocProxy(null);
          setPdfFileName("");
          addLog(
            "Invalid PDF file selected. Please choose a valid PDF document.",
            "warning",
          );
        }
      }
    };

    loadDocument();

    return () => {
      isCancelled = true;
      const done = loadingTask ? Promise.resolve(loadingTask.destroy()).catch(() => undefined) : Promise.resolve();
      void done.finally(() => own.close());
    };
  }, [pdfBytes]);

  // Dynamic calculation to ensure the PDF page fills maximum available workspace
  const calculateOptimalFit = useCallback(
    (pageWidth?: number, pageHeight?: number, fitMode: "page" | "width" = "page") => {
      const pWidth = pageWidth || originalPageSize.width || 595;
      const pHeight = pageHeight || originalPageSize.height || 842;
      const container = viewportScrollerRef.current;

      const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

      let availW: number;
      let availH: number;

      if (container && container.clientWidth > 0 && container.clientHeight > 0) {
        availW = container.clientWidth;
        availH = container.clientHeight;
      } else if (typeof window !== "undefined") {
        const sidebarWidth = isSidebarOpen && !isMobile ? 240 : 0;
        availW = window.innerWidth - sidebarWidth;
        availH = window.innerHeight - 60;
      } else {
        availW = 800;
        availH = 700;
      }

      // Minimal edge margins to maximize screen real estate
      const paddingX = isMobile ? 8 : (availW > 1200 ? 40 : 20);
      const paddingY = isMobile ? 72 : 44;

      const usableW = Math.max(120, availW - paddingX);
      const usableH = Math.max(120, availH - paddingY);

      const scaleW = usableW / pWidth;
      const scaleH = usableH / pHeight;

      let targetScale: number;
      if (fitMode === "width" || isMobile) {
        // Mobile screens: fit full width to fill screen horizontally
        targetScale = scaleW;
      } else {
        // Desktop / large screens: fit to page bounds to maximize size without overflowing
        targetScale = Math.min(scaleW, scaleH);
      }

      return Math.max(0.3, Math.min(3.5, Number(targetScale.toFixed(2))));
    },
    [originalPageSize.width, originalPageSize.height, isSidebarOpen]
  );

  // Keep page fitted to available container size when auto-fit is active
  useEffect(() => {
    const scroller = viewportScrollerRef.current;
    if (!scroller) return;

    let resizeTimer: any = null;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (isAutoFitActive && originalPageSize.width > 0 && originalPageSize.height > 0) {
          const newFitScale = calculateOptimalFit(originalPageSize.width, originalPageSize.height);
          if (newFitScale && Math.abs(newFitScale - zoomScale) > 0.02) {
            setZoomScale(newFitScale);
          }
        }
      }, 80);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(scroller);
    window.addEventListener("resize", handleResize);

    return () => {
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [isAutoFitActive, originalPageSize.width, originalPageSize.height, calculateOptimalFit, zoomScale]);

  // PDF.js Page Canvas Rendering (runs when proxy, page, or zoom changes)
  useEffect(() => {
    if (!pdfDocProxy || !pdfBytes) return;

    let isCancelled = false;

    const renderPDFPage = async () => {
      try {
        // Cancel and wait for any previous render task on this canvas before starting a new one
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
            await renderTaskRef.current.promise.catch(() => {});
          } catch (_) {}
          renderTaskRef.current = null;
        }

        if (isCancelled) return;

        const page = await pdfDocProxy.getPage(currentPage);
        if (isCancelled) return;

        // Fetch base scale page sizes
        const originalViewport = page.getViewport({ scale: 1.0 });
        const width_original = originalViewport.width;
        const height_original = originalViewport.height;
        setOriginalPageSize({ width: width_original, height: height_original });

        // Auto-fit page on initial load to immediately fill available space
        if (!hasInitialFittedRef.current) {
          hasInitialFittedRef.current = true;
          const initialScale = calculateOptimalFit(width_original, height_original);
          if (initialScale && Math.abs(initialScale - zoomScale) > 0.02) {
            setZoomScale(initialScale);
            return;
          }
        }

        // Calculate and apply scaled displays using an offscreen canvas to avoid screen flashes
        const viewport = page.getViewport({ scale: zoomScale });
        const targetWidth = Math.floor(viewport.width);
        const targetHeight = Math.floor(viewport.height);

        const offscreenCanvas = document.createElement("canvas");
        offscreenCanvas.width = targetWidth;
        offscreenCanvas.height = targetHeight;
        const offscreenContext = offscreenCanvas.getContext("2d");

        if (offscreenContext) {
          const renderContext = {
            canvasContext: offscreenContext,
            viewport: viewport,
          };

          const renderTask = page.render(renderContext);
          renderTaskRef.current = renderTask;

          try {
            await renderTask.promise;
          } catch (renderErr: any) {
            if (
              renderErr?.name === "RenderingCancelledException" ||
              renderErr?.message?.includes("cancelled") ||
              renderErr?.message?.includes("canceled")
            ) {
              // Task was cleanly cancelled; ignore and exit
              return;
            }
            throw renderErr;
          } finally {
            if (renderTaskRef.current === renderTask) {
              renderTaskRef.current = null;
            }
          }

          if (isCancelled) return;

          // Atomically transfer rendered offscreen buffer to visible canvas with zero screen flash
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const mainContext = canvas.getContext("2d");
            mainContext?.drawImage(offscreenCanvas, 0, 0);

            // Cache rendered canvas to pageImageCacheRef for instantaneous linked gesture previews
            try {
              const dataUrl =
                canvas.toDataURL("image/webp", 0.9) ||
                canvas.toDataURL("image/png");
              pageImageCacheRef.current.set(`${currentPage}_${zoomScale.toFixed(2)}`, dataUrl);
            } catch (_) {}
          }

          setCanvasDimensions({
            width: targetWidth,
            height: targetHeight,
          });

          // XFA rendering
          try {
            const xfaData = await page.getXfa();
            if (xfaData && xfaLayerRef.current && !isCancelled) {
              xfaLayerRef.current.innerHTML = "";
              pdfjsLib.XfaLayer.render({
                viewport: viewport.clone({ dontFlip: true }),
                div: xfaLayerRef.current,
                xfaHtml: xfaData,
                annotationStorage: pdfDocProxy.annotationStorage,
                linkService: null as any,
              });
            } else if (xfaLayerRef.current) {
              xfaLayerRef.current.innerHTML = "";
            }
          } catch (xfaErr) {
            console.warn(
              "XFA layer not available or failed rendering:",
              xfaErr,
            );
          }

          // Standard Annotation rendering (AcroForms)
          try {
            if (annotationLayerRef.current && !isCancelled) {
              annotationLayerRef.current.innerHTML = "";
              const annotationsData = await page.getAnnotations();
              const annotationLayer = new pdfjsLib.AnnotationLayer({
                page,
                viewport: viewport.clone({ dontFlip: true }),
                div: annotationLayerRef.current,
                annotationStorage: pdfDocProxy.annotationStorage,
                linkService: null as any,
                accessibilityManager: null,
                annotationCanvasMap: null,
                annotationEditorUIManager: null,
                structTreeLayer: null,
                commentManager: null,
              });
              await annotationLayer.render({
                viewport: viewport.clone({ dontFlip: true }),
                div: annotationLayerRef.current,
                annotations: annotationsData,
                page: page,
                linkService: null as any,
                annotationStorage: pdfDocProxy.annotationStorage,
                renderForms: true,
              });
            }
          } catch (annErr) {
            console.warn("Annotation layer rendering failed:", annErr);
          }

          if (!isCancelled) {
            if (focalPointRef.current && viewportScrollerRef.current && pageContainerRef.current) {
              const targetFp = { ...focalPointRef.current };
              focalPointRef.current = null;

              if (pageContainerRef.current) {
                pageContainerRef.current.style.transform = "";
                pageContainerRef.current.style.transformOrigin = "center center";
                pageContainerRef.current.style.willChange = "auto";
                pageContainerRef.current.style.transition = "";
              }

              requestAnimationFrame(() => {
                if (!pageContainerRef.current || !viewportScrollerRef.current) return;
                const containerEl = pageContainerRef.current;
                const currentFocalXInContent =
                  (containerEl.offsetLeft || 0) + targetFp.focalOnPageRatioX * targetWidth;
                const currentFocalYInContent =
                  (containerEl.offsetTop || 0) + targetFp.focalOnPageRatioY * targetHeight;

                const desiredScrollLeft = currentFocalXInContent - targetFp.focalViewportX;
                const desiredScrollTop = currentFocalYInContent - targetFp.focalViewportY;

                viewportScrollerRef.current.scrollLeft = Math.max(0, desiredScrollLeft);
                viewportScrollerRef.current.scrollTop = Math.max(0, desiredScrollTop);
              });
            }

            addLog(
              `Rendered page ${currentPage} successfully at zoom ${Math.round(zoomScale * 100)}%`,
              "info",
            );
          }
        }
      } catch (err: any) {
        if (
          err?.name === "RenderingCancelledException" ||
          err?.message?.includes("cancelled") ||
          err?.message?.includes("canceled") ||
          isCancelled
        ) {
          // Normal during zooming/page changes, ignore
          return;
        }
        console.error("PDF Render Error:", err);
        addLog(`PDF Loader Error: ${err.message}`, "warning");
      }
    };

    renderPDFPage();

    return () => {
      isCancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch (_) {}
      }
    };
  }, [pdfDocProxy, currentPage, zoomScale, pdfBytes]);

  // Track dynamic window resizing or zoom adjustment scales
  const scaleMultiplier = canvasDimensions.width / originalPageSize.width;

  // Handle local File Upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result as ArrayBuffer;
      hasInitialFittedRef.current = false;
      setIsAutoFitActive(true);
      setPdfBytes(new Uint8Array(arrayBuffer));
      setPdfFileName(file.name);
      setPdfDocProxy(null); // Force rebuild proxy
      setCurrentPage(1);
      resetAnnotations([]); // Reset edits
      setSelectedAnnotationId(null);
      addLog(`Securely imported raw PDF bytes for: ${file.name}`, "success");
    };
    reader.readAsArrayBuffer(file);
  };

  const loadMergedPdf = (mergedPdfBytes: Uint8Array, fileName: string) => {
    setLoading(true);
    hasInitialFittedRef.current = false;
    setIsAutoFitActive(true);
    setPdfBytes(mergedPdfBytes);
    setPdfFileName(fileName);
    setPdfDocProxy(null);
    setCurrentPage(1);
    resetAnnotations([]);
    setSelectedAnnotationId(null);
    addLog(`Securely imported merged PDF: ${fileName}`, "success");
  };

  const loadPdfFromBytes = async (newBytes: Uint8Array, fileName?: string) => {
    setLoading(true);
    hasInitialFittedRef.current = false;
    setIsAutoFitActive(true);
    setPdfBytes(newBytes);
    if (fileName) setPdfFileName(fileName);
    setPdfDocProxy(null);
    setSelectedAnnotationId(null);
  };

  const triggerImageUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) handleImageUpload(file);
    };
    input.click();
  };

  // Generate dynamic sample agreement so users can play without finding a PDF file!
  const loadSampleAgreement = async () => {
    setLoading(true);
    addLog(
      "Generating interactive ledger mockup using local vector stream...",
      "info",
    );
    try {
      const ledgerBytes = await createSamplePDF();
      hasInitialFittedRef.current = false;
      setIsAutoFitActive(true);
      setPdfBytes(new Uint8Array(ledgerBytes));
      setPdfFileName("Secure_Transaction_Sandbox.pdf");
      setPdfDocProxy(null); // Reset proxy
      setCurrentPage(1);
      resetAnnotations([]); // Reset edit layers
      setSelectedAnnotationId(null);
      addLog("Sample isolation file generated successfully!", "success");
    } catch (err: any) {
      addLog(`Failed to compile sample: ${err.message}`, "warning");
    } finally {
      setLoading(false);
    }
  };

  // Create crisp sample agreements programmatically using pdf-lib (100% Client-Side)!
  const createSamplePDF = async (): Promise<ArrayBuffer> => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]); // Standard A4 points
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const logoColor = rgb(0.06, 0.44, 0.3); // Secure deep forest teal

    // Header banner carbon plate
    page.drawRectangle({
      x: 0,
      y: 775,
      width: 595,
      height: 67,
      color: rgb(0.09, 0.12, 0.15),
    });

    page.drawText("[SECURE] CLIENT ENVIRONMENT PRIVATE SANDBOX", {
      x: 35,
      y: 810,
      size: 13,
      font: boldFont,
      color: rgb(1, 1, 1),
    });

    page.drawText(
      "100% LOCAL COMPILATION RUNTIME • ZERO OUTBOUND TRAFFIC DETECTED",
      {
        x: 35,
        y: 794,
        size: 8,
        font: font,
        color: rgb(0.6, 0.8, 0.7),
      },
    );

    // Content Outline
    page.drawText("MUTUAL NDA, TRANSACTION, & CONSENT FORM", {
      x: 35,
      y: 725,
      size: 16,
      font: boldFont,
      color: rgb(0.12, 0.15, 0.18),
    });

    page.drawText("Transaction ID: TSX-9082-MEMSEC • Generated: June 2, 2026", {
      x: 35,
      y: 705,
      size: 9,
      font: font,
      color: rgb(0.4, 0.5, 0.5),
    });

    page.drawText(
      "The recipient of this document is testing a high-privacy PDF signer environment.",
      {
        x: 35,
        y: 665,
        size: 10.5,
        font: font,
      },
    );
    page.drawText(
      "All textual typing, hand-drawn vector elements, and stamps exist inside RAM buffers.",
      {
        x: 35,
        y: 650,
        size: 10.5,
        font: font,
      },
    );

    // Data table box
    page.drawRectangle({
      x: 35,
      y: 535,
      width: 525,
      height: 90,
      borderColor: rgb(0.8, 0.83, 0.87),
      borderWidth: 1,
    });

    // Table Header
    page.drawRectangle({
      x: 35,
      y: 600,
      width: 525,
      height: 25,
      color: rgb(0.94, 0.96, 0.98),
    });

    page.drawText("ITEM / PROTOCOL", {
      x: 45,
      y: 608,
      size: 9,
      font: boldFont,
      color: rgb(0.2, 0.3, 0.3),
    });
    page.drawText("SECURITY BOUNDARY STATEMENT", {
      x: 220,
      y: 608,
      size: 9,
      font: boldFont,
      color: rgb(0.2, 0.3, 0.3),
    });
    page.drawText("VERDICT", {
      x: 450,
      y: 608,
      size: 9,
      font: boldFont,
      color: rgb(0.2, 0.3, 0.3),
    });

    const rows = [
      {
        item: "Local V8 VM Heap",
        detail: "Ephemerally allocated, zero persistency tags",
        verdict: "SECURED",
      },
      {
        item: "Signature Image",
        detail: "Drawn in SVG vector bounds, zero server logs",
        verdict: "ENCRYPTED",
      },
      {
        item: "Data Disposal",
        detail: "Hard garbage collection triggered on Burn Session",
        verdict: "PENDING",
      },
    ];

    rows.forEach((row, idx) => {
      const yLine = 575 - idx * 22;
      page.drawText(row.item, { x: 45, y: yLine, size: 9, font: font });
      page.drawText(row.detail, { x: 220, y: yLine, size: 9, font: font });
      page.drawText(row.verdict, {
        x: 450,
        y: yLine,
        size: 9,
        font: boldFont,
        color: idx === 2 ? rgb(0.85, 0.5, 0.1) : rgb(0.06, 0.44, 0.3),
      });

      if (idx < 2) {
        page.drawLine({
          start: { x: 35, y: yLine - 5 },
          end: { x: 560, y: yLine - 5 },
          color: rgb(0.9, 0.93, 0.95),
          thickness: 1,
        });
      }
    });

    // Sub-segment Isolation terms
    page.drawText("SECURITY DISCRIMINANT AGREEMENTS", {
      x: 35,
      y: 495,
      size: 11,
      font: boldFont,
      color: logoColor,
    });

    const clauses = [
      "1. No telemetry packets: Clicking buttons or drawing sigs releases no webhook triggers.",
      "2. Memory Isolation: The PDF document is never sent to a background node script processes.",
      "3. Complete purging paradigm: Tab shutdown completely overwrites browser execution.",
      "4. Strict sandboxed canvas rendering prevents any graphic cache leaking.",
    ];

    clauses.forEach((cls, i) => {
      page.drawText(cls, {
        x: 35,
        y: 472 - i * 16,
        size: 9,
        font: font,
        color: rgb(0.3, 0.33, 0.35),
      });
    });

    // Signature placeholders boxes
    page.drawRectangle({
      x: 35,
      y: 160,
      width: 240,
      height: 95,
      borderColor: rgb(0.8, 0.83, 0.87),
      borderWidth: 1,
      color: rgb(0.99, 1.0, 1.0),
    });
    page.drawText("PRIMARY ACCOUNT DIGITAL SIGNATURE", {
      x: 45,
      y: 240,
      size: 8.5,
      font: boldFont,
      color: rgb(0.3, 0.33, 0.35),
    });
    page.drawText("Click and place your handwritten signature here.", {
      x: 45,
      y: 172,
      size: 8,
      font: font,
      color: rgb(0.5, 0.55, 0.6),
    });

    page.drawRectangle({
      x: 320,
      y: 160,
      width: 240,
      height: 95,
      borderColor: rgb(0.8, 0.83, 0.87),
      borderWidth: 1,
      color: rgb(0.99, 1.0, 1.0),
    });
    page.drawText("ADMIN VERIFICATION SEAL AND DATE", {
      x: 330,
      y: 240,
      size: 8.5,
      font: boldFont,
      color: rgb(0.3, 0.33, 0.35),
    });
    page.drawText("Place date stamps or APPROVED emblems here.", {
      x: 330,
      y: 172,
      size: 8,
      font: font,
      color: rgb(0.5, 0.55, 0.6),
    });

    page.drawText("--- Isolated Client-Sandbox Document Registry ---", {
      x: 180,
      y: 100,
      size: 9.5,
      font: font,
      color: rgb(0.6, 0.65, 0.7),
    });

    return await pdfDoc.save();
  };

  // Clear states securely (Self-Destruct Sequence)
  const executeSecurePurge = () => {
    setIsPurging(true);
    addLog("CRITICAL! Initiated self-destruction of memory arrays!", "warning");
  };

  const handlePurgeFinished = () => {
    // Zero-out arrays before resetting references
    if (pdfBytes) {
      pdfBytes.fill(0); // Physically overwrite bytes in RAM with absolute zeroes!
    }

    // Purge React fields
    setPdfBytes(null);
    setPdfFileName("");
    setPdfDocProxy(null);
    resetAnnotations([]);
    setSavedSignatures([]);
    setSelectedAnnotationId(null);
    setIsPurging(false);

    // Trigger window location reset to wipe V8 state heaps
    window.location.reload();
  };

  // Helper to fetch/render and cache high-res page image for neighbor cards
  const getCachedPageImage = useCallback(
    async (pageNum: number, scale: number): Promise<string | null> => {
      if (!pdfDocProxy || pageNum < 1 || pageNum > numPages) return null;
      const cacheKey = `${pageNum}_${scale.toFixed(2)}`;
      if (pageImageCacheRef.current.has(cacheKey)) {
        return pageImageCacheRef.current.get(cacheKey)!;
      }
      try {
        const page = await pdfDocProxy.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const offscreen = document.createElement("canvas");
        offscreen.width = Math.floor(viewport.width);
        offscreen.height = Math.floor(viewport.height);
        const ctx = offscreen.getContext("2d");
        if (!ctx) return null;
        await page.render({ canvasContext: ctx, viewport }).promise;
        const dataUrl =
          offscreen.toDataURL("image/webp", 0.9) ||
          offscreen.toDataURL("image/png");
        pageImageCacheRef.current.set(cacheKey, dataUrl);
        return dataUrl;
      } catch (err: any) {
        if (err?.name !== "RenderingCancelledException") {
          console.warn("Pre-rendering page error:", pageNum, err);
        }
        return null;
      }
    },
    [pdfDocProxy, numPages]
  );

  // Pre-render neighbor pages in the background whenever document or page or zoom changes
  useEffect(() => {
    if (!pdfDocProxy || numPages <= 0) return;
    if (currentPage > 1) {
      getCachedPageImage(currentPage - 1, zoomScale);
    }
    if (currentPage < numPages) {
      getCachedPageImage(currentPage + 1, zoomScale);
    }
  }, [pdfDocProxy, currentPage, zoomScale, numPages, getCachedPageImage]);

  // Programmatic & Gesture Synchronized Linked Page Navigation
  const navigateToPage = useCallback(
    async (targetPage: number) => {
      if (
        targetPage < 1 ||
        targetPage > numPages ||
        targetPage === currentPage ||
        isNavigatingRef.current
      ) {
        return;
      }

      const container = pageContainerRef.current;
      const neighbor = neighborCardRef.current;
      const neighborImg = neighborImgRef.current;
      const cardWidth = canvasDimensions.width || 600;
      const gap = 28;
      const dir = targetPage > currentPage ? 1 : -1; // 1 = forward (slide left), -1 = backward (slide right)

      if (!container || !neighbor || !neighborImg) {
        setCurrentPage(targetPage);
        setSelectedAnnotationId(null);
        return;
      }

      isNavigatingRef.current = true;
      setSelectedAnnotationId(null);

      // Save current page snapshot into cache
      if (canvasRef.current && canvasRef.current.width > 0) {
        try {
          const curData =
            canvasRef.current.toDataURL("image/webp", 0.9) ||
            canvasRef.current.toDataURL("image/png");
          pageImageCacheRef.current.set(`${currentPage}_${zoomScale.toFixed(2)}`, curData);
        } catch (_) {}
      }

      let targetImgUrl = await getCachedPageImage(targetPage, zoomScale);
      if (!targetImgUrl && canvasRef.current) {
        targetImgUrl = canvasRef.current.toDataURL("image/png");
      }

      if (neighborImg && targetImgUrl) {
        neighborImg.src = targetImgUrl;
      }

      const neighborStartX = dir > 0 ? cardWidth + gap : -(cardWidth + gap);
      const containerEndX = dir > 0 ? -(cardWidth + gap) : cardWidth + gap;

      neighbor.style.display = "block";
      neighbor.style.transition = "none";
      neighbor.style.transform = `translate3d(${neighborStartX}px, 0, 0)`;

      container.style.transition = "none";
      container.style.transform = "translate3d(0, 0, 0)";

      const duration = 280;
      const ease = "cubic-bezier(0.16, 1, 0.3, 1)";

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          container.style.transition = `transform ${duration}ms ${ease}`;
          container.style.transform = `translate3d(${containerEndX}px, 0, 0)`;

          neighbor.style.transition = `transform ${duration}ms ${ease}`;
          neighbor.style.transform = "translate3d(0, 0, 0)";

          setTimeout(() => {
            setCurrentPage(targetPage);
            container.style.transition = "none";
            container.style.transform = "translate3d(0, 0, 0)";
            neighbor.style.display = "none";
            neighbor.style.transition = "none";
            neighbor.style.transform = "";
            isNavigatingRef.current = false;
          }, duration + 20);
        });
      });
    },
    [currentPage, numPages, canvasDimensions.width, zoomScale, getCachedPageImage]
  );

  // The agent's changes waiting for a decision are outlined on the page.
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = pendingIds
      .map((id) => `#draggable-${CSS.escape(id)}{outline:2px dashed #f59e0b;outline-offset:2px}`)
      .join("\n");
    document.head.appendChild(el);
    return () => el.remove();
  }, [pendingIds]);

  useEffect(() => {
    if (!focusRequest || numPages === 0) return;
    void navigateToPage(Math.min(Math.max(1, focusRequest.page), numPages));
    setSelectedAnnotationId(focusRequest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  const prevPage = useCallback(() => {
    if (currentPage > 1) {
      navigateToPage(currentPage - 1);
    }
  }, [currentPage, navigateToPage]);

  const nextPage = useCallback(() => {
    if (currentPage < numPages) {
      navigateToPage(currentPage + 1);
    }
  }, [currentPage, numPages, navigateToPage]);

  // Keep navigation refs synchronized
  navigateToPageRef.current = navigateToPage;
  prevPageRef.current = prevPage;
  nextPageRef.current = nextPage;

  // Viewport Touch Event Handlers for Mobile Pinch-to-Zoom and Linked Left/Right Swipe Page Navigation
  const handleViewportTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    // Cancel any active pan/pinch inertia animation frame immediately so the user can grab the page
    if (inertiaAnimRef.current !== null) {
      cancelAnimationFrame(inertiaAnimRef.current);
      inertiaAnimRef.current = null;
    }

    if (isNavigatingRef.current) return;

    if (e.touches.length >= 2) {
      touchSwipeRef.current.isMultiTouch = true;
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

      let originX = 0;
      let originY = 0;
      if (pageContainerRef.current) {
        const cRect = pageContainerRef.current.getBoundingClientRect();
        originX = midX - cRect.left;
        originY = midY - cRect.top;
        pageContainerRef.current.style.transformOrigin = `${originX}px ${originY}px`;
        pageContainerRef.current.style.transition = "none";
        pageContainerRef.current.style.willChange = "transform";
      }

      pinchRef.current = {
        initialDist: Math.max(10, dist),
        initialZoom: zoomScale,
        lastRatio: 1.0,
        isPinching: true,
        originX,
        originY,
        initialMidX: midX,
        initialMidY: midY,
        lastMidX: midX,
        lastMidY: midY,
      };
    } else if (e.touches.length === 1) {
      pinchRef.current.isPinching = false;
      const now = Date.now();
      touchSwipeRef.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        lastX: e.touches[0].clientX,
        lastY: e.touches[0].clientY,
        currentX: e.touches[0].clientX,
        currentY: e.touches[0].clientY,
        startTime: now,
        isMultiTouch: false,
        isSwiping: false,
        activeNeighborPage: null,
        isPanning: false,
        history: [{ x: e.touches[0].clientX, y: e.touches[0].clientY, time: now }],
      };
    }
  };

  const handleViewportTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (
      e.touches.length >= 2 &&
      pinchRef.current.isPinching &&
      pinchRef.current.initialDist > 0
    ) {
      touchSwipeRef.current.isMultiTouch = true;
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const ratio = dist / pinchRef.current.initialDist;

      pinchRef.current.lastRatio = ratio;
      pinchRef.current.lastMidX = midX;
      pinchRef.current.lastMidY = midY;

      const minRatio = 0.3 / Math.max(0.01, pinchRef.current.initialZoom);
      const maxRatio = 3.5 / Math.max(0.01, pinchRef.current.initialZoom);
      const visualRatio = Math.min(maxRatio, Math.max(minRatio, ratio));

      const deltaX = midX - pinchRef.current.initialMidX;
      const deltaY = midY - pinchRef.current.initialMidY;

      if (pageContainerRef.current) {
        pageContainerRef.current.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0px) scale(${visualRatio})`;
      }
    } else if (e.touches.length === 1 && !pinchRef.current.isPinching && !isNavigatingRef.current) {
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const now = Date.now();
      const dx = currentX - touchSwipeRef.current.lastX;
      const dy = currentY - touchSwipeRef.current.lastY;

      touchSwipeRef.current.currentX = currentX;
      touchSwipeRef.current.currentY = currentY;
      touchSwipeRef.current.lastX = currentX;
      touchSwipeRef.current.lastY = currentY;

      // Track recent touch positions for inertia velocity calculation (last 120ms window)
      const updatedHistory = touchSwipeRef.current.history
        .filter((p) => now - p.time <= 120)
        .concat({ x: currentX, y: currentY, time: now });
      touchSwipeRef.current.history = updatedHistory;

      if (
        !touchSwipeRef.current.isMultiTouch &&
        !draggedElementId &&
        !isDrawingInk &&
        !isDrawingRedact &&
        toolMode !== "draw" &&
        toolMode !== "highlighter" &&
        toolMode !== "redact"
      ) {
        const isZoomed = zoomScale > 1.08;
        const scroller = viewportScrollerRef.current;
        const isOverflowing =
          scroller &&
          isZoomed &&
          (scroller.scrollWidth > scroller.clientWidth + 20 ||
            scroller.scrollHeight > scroller.clientHeight + 20);

        if (isOverflowing && scroller) {
          // Dragging finger moves/pans the PDF page around when zoomed in
          scroller.scrollLeft -= dx;
          scroller.scrollTop -= dy;
          touchSwipeRef.current.isPanning = true;
        } else if (!touchSwipeRef.current.isPanning) {
          const totalDx = currentX - touchSwipeRef.current.startX;
          const totalDy = currentY - touchSwipeRef.current.startY;

          // Detect start of horizontal page swipe gesture
          if (!touchSwipeRef.current.isSwiping) {
            if (Math.abs(totalDx) > 8 && Math.abs(totalDx) > Math.abs(totalDy)) {
              touchSwipeRef.current.isSwiping = true;
              const target =
                totalDx < 0
                  ? currentPage < numPages
                    ? currentPage + 1
                    : null
                  : currentPage > 1
                  ? currentPage - 1
                  : null;
              touchSwipeRef.current.activeNeighborPage = target;

              if (target !== null && neighborCardRef.current && neighborImgRef.current) {
                const cardWidth = canvasDimensions.width || 600;
                const gap = 28;
                const neighborBaseX = totalDx < 0 ? cardWidth + gap : -(cardWidth + gap);
                neighborCardRef.current.style.display = "block";
                neighborCardRef.current.style.transition = "none";
                neighborCardRef.current.style.transform = `translate3d(${neighborBaseX + totalDx}px, 0, 0)`;

                // Fetch pre-rendered image for neighbor page
                const cached = pageImageCacheRef.current.get(`${target}_${zoomScale.toFixed(2)}`);
                if (cached) {
                  neighborImgRef.current.src = cached;
                } else {
                  getCachedPageImage(target, zoomScale).then((imgUrl) => {
                    if (imgUrl && neighborImgRef.current) {
                      neighborImgRef.current.src = imgUrl;
                    }
                  });
                }
              }
            }
          }

          // Realtime interactive linked swipe transformation
          if (touchSwipeRef.current.isSwiping) {
            const cardWidth = canvasDimensions.width || 600;
            const gap = 28;
            const target = touchSwipeRef.current.activeNeighborPage;
            // Apply rubber-band damping resistance if at outer page boundaries
            const effectiveDx = target !== null ? totalDx : totalDx * 0.22;

            if (pageContainerRef.current) {
              pageContainerRef.current.style.transition = "none";
              pageContainerRef.current.style.transform = `translate3d(${effectiveDx}px, 0, 0)`;
            }

            if (target !== null && neighborCardRef.current) {
              const neighborBaseX = totalDx < 0 ? cardWidth + gap : -(cardWidth + gap);
              neighborCardRef.current.style.transition = "none";
              neighborCardRef.current.style.transform = `translate3d(${neighborBaseX + effectiveDx}px, 0, 0)`;
            }
          }
        }
      }
    }
  };

  const handleViewportTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (pinchRef.current.isPinching) {
      if (e.touches.length < 2) {
        const finalRatio = pinchRef.current.lastRatio;
        const targetZoom = Math.min(
          3.5,
          Math.max(
            0.3,
            Number((pinchRef.current.initialZoom * finalRatio).toFixed(2)),
          ),
        );
        const isZoomChanged = Math.abs(targetZoom - zoomScale) >= 0.02;

        const scroller = viewportScrollerRef.current;
        const container = pageContainerRef.current;

        if (scroller && container) {
          const sRect = scroller.getBoundingClientRect();
          const cRect = container.getBoundingClientRect();
          const focalViewportX = pinchRef.current.lastMidX - sRect.left;
          const focalViewportY = pinchRef.current.lastMidY - sRect.top;
          const focalOnPageRatioX = Math.max(
            0,
            Math.min(1, (pinchRef.current.lastMidX - cRect.left) / (cRect.width || 1)),
          );
          const focalOnPageRatioY = Math.max(
            0,
            Math.min(1, (pinchRef.current.lastMidY - cRect.top) / (cRect.height || 1)),
          );

          focalPointRef.current = {
            focalViewportX,
            focalViewportY,
            focalOnPageRatioX,
            focalOnPageRatioY,
            targetZoom,
          };
        }

        const deltaX = pinchRef.current.lastMidX - pinchRef.current.initialMidX;
        const deltaY = pinchRef.current.lastMidY - pinchRef.current.initialMidY;

        pinchRef.current.isPinching = false;
        pinchRef.current.initialDist = 0;
        pinchRef.current.lastRatio = 1.0;

        if (!isZoomChanged) {
          if (pageContainerRef.current) {
            pageContainerRef.current.style.transition = "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)";
            pageContainerRef.current.style.transform = "";
            setTimeout(() => {
              if (pageContainerRef.current) {
                pageContainerRef.current.style.transition = "";
                pageContainerRef.current.style.willChange = "auto";
              }
            }, 230);
          }
        } else {
          setIsAutoFitActive(false);
          setZoomScale(targetZoom);
        }

        // Apply smooth coasting settling to viewport if fingers were translating during pinch release
        if (scroller && (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8)) {
          let coastX = deltaX * 0.12;
          let coastY = deltaY * 0.12;
          const stepPinchInertia = () => {
            if (!viewportScrollerRef.current) return;
            viewportScrollerRef.current.scrollLeft -= coastX;
            viewportScrollerRef.current.scrollTop -= coastY;
            coastX *= 0.88;
            coastY *= 0.88;
            if (Math.hypot(coastX, coastY) > 0.35) {
              inertiaAnimRef.current = requestAnimationFrame(stepPinchInertia);
            } else {
              inertiaAnimRef.current = null;
            }
          };
          inertiaAnimRef.current = requestAnimationFrame(stepPinchInertia);
        }
      }
    } else if (
      touchSwipeRef.current.isPanning &&
      !touchSwipeRef.current.isMultiTouch &&
      !draggedElementId
    ) {
      // User finished panning: calculate velocity and apply exponential decay inertia
      const now = Date.now();
      const recentHistory = touchSwipeRef.current.history.filter((p) => now - p.time <= 100);
      if (recentHistory.length >= 2) {
        const oldest = recentHistory[0];
        const newest = recentHistory[recentHistory.length - 1];
        const dt = Math.max(10, newest.time - oldest.time);
        let vx = ((newest.x - oldest.x) / dt) * 16;
        let vy = ((newest.y - oldest.y) / dt) * 16;

        // Clamp maximum fling velocity to prevent disorientation
        const maxV = 36;
        const speed = Math.hypot(vx, vy);
        if (speed > maxV) {
          vx = (vx / speed) * maxV;
          vy = (vy / speed) * maxV;
        }

        // If flick velocity exceeds minimum threshold, coast smoothly to a halt
        if (speed > 1.0) {
          const decay = 0.94; // Smooth exponential friction
          const stepPanInertia = () => {
            const scroller = viewportScrollerRef.current;
            if (!scroller) return;

            scroller.scrollLeft -= vx;
            scroller.scrollTop -= vy;

            vx *= decay;
            vy *= decay;

            if (Math.hypot(vx, vy) > 0.35) {
              inertiaAnimRef.current = requestAnimationFrame(stepPanInertia);
            } else {
              inertiaAnimRef.current = null;
            }
          };
          inertiaAnimRef.current = requestAnimationFrame(stepPanInertia);
        }
      }
      touchSwipeRef.current.isPanning = false;
      touchSwipeRef.current.history = [];
    } else if (touchSwipeRef.current.isSwiping) {
      // Complete linked swipe transition
      let endX = touchSwipeRef.current.lastX;
      if (e.changedTouches && e.changedTouches.length > 0) {
        endX = e.changedTouches[0].clientX;
      }

      const totalDx = endX - touchSwipeRef.current.startX;
      const dt = Math.max(1, Date.now() - touchSwipeRef.current.startTime);
      const vx = totalDx / dt;
      const cardWidth = canvasDimensions.width || 600;
      const gap = 28;
      const targetPage = touchSwipeRef.current.activeNeighborPage;

      touchSwipeRef.current.isSwiping = false;

      const shouldCommit =
        targetPage !== null &&
        (Math.abs(totalDx) > Math.min(90, cardWidth * 0.18) || (Math.abs(totalDx) > 25 && Math.abs(vx) > 0.3));

      const duration = 260;
      const ease = "cubic-bezier(0.16, 1, 0.3, 1)";
      const container = pageContainerRef.current;
      const neighbor = neighborCardRef.current;

      if (shouldCommit && container && neighbor) {
        isNavigatingRef.current = true;
        const containerEndX = totalDx < 0 ? -(cardWidth + gap) : cardWidth + gap;

        container.style.transition = `transform ${duration}ms ${ease}`;
        container.style.transform = `translate3d(${containerEndX}px, 0, 0)`;

        neighbor.style.transition = `transform ${duration}ms ${ease}`;
        neighbor.style.transform = "translate3d(0, 0, 0)";

        setTimeout(() => {
          setCurrentPage(targetPage);
          container.style.transition = "none";
          container.style.transform = "translate3d(0, 0, 0)";
          neighbor.style.display = "none";
          neighbor.style.transition = "none";
          neighbor.style.transform = "";
          isNavigatingRef.current = false;
          triggerHaptic("medium");
        }, duration + 20);
      } else {
        // Snap back to resting position
        if (container) {
          container.style.transition = `transform 200ms ${ease}`;
          container.style.transform = "translate3d(0, 0, 0)";
        }
        if (neighbor && targetPage !== null) {
          const neighborBaseX = totalDx < 0 ? cardWidth + gap : -(cardWidth + gap);
          neighbor.style.transition = `transform 200ms ${ease}`;
          neighbor.style.transform = `translate3d(${neighborBaseX}px, 0, 0)`;
        }
        setTimeout(() => {
          if (container) {
            container.style.transition = "";
            container.style.transform = "";
          }
          if (neighbor) {
            neighbor.style.display = "none";
            neighbor.style.transition = "";
            neighbor.style.transform = "";
          }
        }, 220);
      }
    }
  };

  const handleZoomIn = () => {
    setIsAutoFitActive(false);
    setZoomScale((z) => Math.min(3.5, Number((z + 0.15).toFixed(2))));
  };

  const handleZoomOut = () => {
    setIsAutoFitActive(false);
    setZoomScale((z) => Math.max(0.3, Number((z - 0.15).toFixed(2))));
  };

  const handleZoomFit = () => {
    setIsAutoFitActive(true);
    const optimal = calculateOptimalFit(originalPageSize.width, originalPageSize.height);
    setZoomScale(optimal);
    addLog(`Fitted page to maximize available space (${Math.round(optimal * 100)}%)`, "info");
    triggerHaptic("light");
  };

  // Canvas clicking listener (for adding text/stamps/shapes/notes)
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (toolMode === "select" || toolMode === "draw" || toolMode === "highlighter" || toolMode === "redact") return;
    if (!overlayRef.current) return;

    const rect = overlayRef.current.getBoundingClientRect();
    const clickX_px = e.clientX - rect.left;
    const clickY_px = e.clientY - rect.top;

    // Convert pixel click coordinates back to original PDF points units
    const pdfX = clickX_px / scaleMultiplier;
    const pdfY = clickY_px / scaleMultiplier;

    if (toolMode === "text") {
      const newTextAnn: AnnotationItem = {
        id: `ann_text_${Date.now()}`,
        type: "text",
        pageNumber: currentPage,
        x: pdfX - 10,
        y: pdfY - 14,
        width: 150,
        height: 24,
        text: "Type text here",
        fontSize: textFontSize,
        fontColor: textFontColor,
        fontFamily: textFontFamily,
        userResized: false,
      };

      dispatchAnnotationUpdate(
        (prev) => [...prev, newTextAnn],
        "Added text layer",
      );
      setSelectedAnnotationId(newTextAnn.id);
      addLog("Placed editable text block layer on page.", "info");
    } else if (toolMode === "note") {
      const newNoteAnn: AnnotationItem = {
        id: `ann_note_${Date.now()}`,
        type: "note",
        pageNumber: currentPage,
        x: pdfX - 16,
        y: pdfY - 16,
        width: 32,
        height: 32,
        noteComment: "Add review comment here...",
        noteAuthor: "Reviewer",
        noteColor: "#fef08a",
        noteDate: new Date().toLocaleDateString(),
      };
      dispatchAnnotationUpdate(
        (prev) => [...prev, newNoteAnn],
        "Added sticky comment note",
      );
      setSelectedAnnotationId(newNoteAnn.id);
      setActiveNoteId(newNoteAnn.id);
      setToolMode("select");
      addLog("Placed sticky comment note on page.", "info");
    } else if (toolMode === "shape") {
      const isLineOrArrow = activeShapeType === "line" || activeShapeType === "arrow";
      const shapeWidth = isLineOrArrow ? 140 : 100;
      const shapeHeight = isLineOrArrow ? 24 : 50;

      const newShapeAnn: AnnotationItem = {
        id: `ann_shape_${Date.now()}`,
        type: "shape",
        pageNumber: currentPage,
        x: pdfX - shapeWidth / 2,
        y: pdfY - shapeHeight / 2,
        width: shapeWidth,
        height: shapeHeight,
        shapeType: activeShapeType,
        shapeFillColor: isLineOrArrow ? "transparent" : "#ffffff",
        hasFill: !isLineOrArrow,
        shapeStrokeColor: "#000000",
        shapeStrokeWidth: 2,
        hasStroke: true,
      };
      dispatchAnnotationUpdate(
        (prev) => [...prev, newShapeAnn],
        `Added ${activeShapeType} layer`,
      );
      setSelectedAnnotationId(newShapeAnn.id);
      setToolMode("select");
      addLog(`Placed ${activeShapeType} on page.`, "info");
    } else if (toolMode === "stamp") {
      const stampWidth = 48;
      const stampHeight = 48;

      const newStampAnn: AnnotationItem = {
        id: `ann_stamp_${Date.now()}`,
        type: "stamp",
        pageNumber: currentPage,
        x: pdfX - stampWidth / 2,
        y: pdfY - stampHeight / 2,
        width: stampWidth,
        height: stampHeight,
        stampType: activeStampType,
      };

      dispatchAnnotationUpdate(
        (prev) => [...prev, newStampAnn],
        "Placed stamp layer",
      );
      setSelectedAnnotationId(newStampAnn.id);
      setToolMode("select");
      addLog(`Stamp [${activeStampType}] dropped onto target page.`, "info");
    }
  };

  // Image upload insertion
  const handleImageUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const maxDim = 160;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w *= ratio;
          h *= ratio;
        }
        const pdf_centerX = originalPageSize.width / 2 - w / 2;
        const pdf_centerY = originalPageSize.height / 2 - h / 2;

        const imgAnn: AnnotationItem = {
          id: `ann_img_${Date.now()}`,
          type: "image",
          pageNumber: currentPage,
          x: Math.max(20, pdf_centerX),
          y: Math.max(20, pdf_centerY),
          width: Math.round(w),
          height: Math.round(h),
          imageDataUrl: dataUrl,
          signatureDataUrl: dataUrl,
        };

        dispatchAnnotationUpdate(
          (prev) => [...prev, imgAnn],
          `Inserted image "${file.name}"`,
        );
        setSelectedAnnotationId(imgAnn.id);
        setToolMode("select");
        addLog(`Inserted image seal/logo: ${file.name}`, "success");
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  // Placement of saved signatures on page
  const placeSavedSignature = (sig: SavedSignature) => {
    // Drop signature near center of active viewport bounds
    const pdf_centerX = originalPageSize.width / 2 - 80;
    const pdf_centerY = originalPageSize.height / 2 - 40;

    const signatureAnn: AnnotationItem = {
      id: `ann_sig_${Date.now()}`,
      type: "signature",
      pageNumber: currentPage,
      x: pdf_centerX,
      y: pdf_centerY,
      width: 160,
      height: 60,
      signatureDataUrl: sig.dataUrl,
    };

    dispatchAnnotationUpdate(
      (prev) => [...prev, signatureAnn],
      "Added signature seal",
    );
    setSelectedAnnotationId(signatureAnn.id);
    setToolMode("select");
    addLog("Placed digital signature seal onto active document.", "success");
  };

  // Drawing event handlers in draw mode and highlighter mode
  const handleInkStart = (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    if (toolMode !== "draw" && toolMode !== "highlighter") return;
    if (!overlayRef.current) return;

    const rect = overlayRef.current.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ("touches" in e) {
      if (e.touches && e.touches.length > 1) {
        // Multi-touch: allow pinch zoom to take precedence
        return;
      }
      if (e.touches && e.touches.length === 1) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        return;
      }
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const startX_px = clientX - rect.left;
    const startY_px = clientY - rect.top;

    // Convert to PDF resolution points
    const pdfX = startX_px / scaleMultiplier;
    const pdfY = startY_px / scaleMultiplier;

    setIsDrawingInk(true);
    setCurrentInkPoints([{ x: pdfX, y: pdfY }]);
  };

  const handleInkMove = (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    if (!isDrawingInk || (toolMode !== "draw" && toolMode !== "highlighter") || !overlayRef.current) return;

    const rect = overlayRef.current.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ("touches" in e) {
      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        return;
      }
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const curX_px = clientX - rect.left;
    const curY_px = clientY - rect.top;

    const pdfX = curX_px / scaleMultiplier;
    const pdfY = curY_px / scaleMultiplier;

    setCurrentInkPoints((prev) => [...prev, { x: pdfX, y: pdfY }]);
  };

  const handleInkEnd = () => {
    if (!isDrawingInk) return;
    setIsDrawingInk(false);

    if (currentInkPoints.length < 2) {
      setCurrentInkPoints([]);
      return;
    }

    const isHighlighter = toolMode === "highlighter";

    // Capture min and max boundingbox
    const xs = currentInkPoints.map((p) => p.x);
    const ys = currentInkPoints.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    // Save as normalized relative drawing item
    const drawAnn: AnnotationItem = {
      id: `ann_${isHighlighter ? "hl" : "draw"}_${Date.now()}`,
      type: "drawing",
      pageNumber: currentPage,
      x: minX,
      y: minY,
      width: Math.max(10, maxX - minX),
      height: Math.max(10, maxY - minY),
      drawingPoints: currentInkPoints,
      drawingColor: isHighlighter ? highlighterColor : inkColor,
      drawingWidth: isHighlighter ? highlighterWidth : inkWidth,
      isHighlighter,
    };

    dispatchAnnotationUpdate(
      (prev) => [...prev, drawAnn],
      isHighlighter ? "Added highlighter stroke" : "Added drawing layer",
    );
    addLog(isHighlighter ? "Saved highlighter markup layer." : "Saved hand-drawn stroke as vector layer.", "info");
    setCurrentInkPoints([]);
  };

  const handleRedactStart = (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    if (toolMode !== "redact" || !overlayRef.current) return;

    const rect = overlayRef.current.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ("touches" in e) {
      if (e.touches && e.touches.length > 1) {
        // Multi-touch: allow pinch zoom to take precedence
        return;
      }
      if (e.touches && e.touches.length === 1) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else return;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const startX_px = clientX - rect.left;
    const startY_px = clientY - rect.top;

    const pdfX = startX_px / scaleMultiplier;
    const pdfY = startY_px / scaleMultiplier;

    setIsDrawingRedact(true);
    setRedactStart({ x: pdfX, y: pdfY });
    setRedactCurrent({ x: pdfX, y: pdfY });
  };

  const handleRedactMove = (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    if (!isDrawingRedact || toolMode !== "redact" || !overlayRef.current)
      return;

    const rect = overlayRef.current.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ("touches" in e) {
      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else return;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const curX_px = clientX - rect.left;
    const curY_px = clientY - rect.top;

    const pdfX = curX_px / scaleMultiplier;
    const pdfY = curY_px / scaleMultiplier;

    setRedactCurrent({ x: pdfX, y: pdfY });
  };

  const handleRedactEnd = async () => {
    if (!isDrawingRedact || !redactStart || !redactCurrent) return;
    setIsDrawingRedact(false);

    const minX = Math.min(redactStart.x, redactCurrent.x);
    const maxX = Math.max(redactStart.x, redactCurrent.x);
    const minY = Math.min(redactStart.y, redactCurrent.y);
    const maxY = Math.max(redactStart.y, redactCurrent.y);

    let width = maxX - minX;
    let height = maxY - minY;

    let finalX = minX;
    let finalY = minY;

    if (width <= 5 || height <= 5) {
      // Smart redact: find text under cursor
      if (pdfDocProxy) {
        try {
          const page = await pdfDocProxy.getPage(currentPage);
          const textContent = await page.getTextContent();
          const viewport = page.getViewport({ scale: 1.0 });

          interface TextRect {
            left: number;
            right: number;
            top: number;
            bottom: number;
            baselineY: number;
            str: string;
          }

          const textRects: TextRect[] = [];
          for (const item of textContent.items) {
            if ("str" in item && item.str.trim() !== "") {
              const tx = item.transform[4];
              const ty = item.transform[5];
              const baselineY = viewport.height - ty;
              const itemTop = baselineY - item.height;
              const itemBottom = baselineY + item.height * 0.2;
              const itemLeft = tx;
              const itemRight = tx + item.width;
              textRects.push({
                left: itemLeft,
                right: itemRight,
                top: itemTop,
                bottom: itemBottom,
                baselineY,
                str: item.str,
              });
            }
          }

          textRects.sort((a, b) => {
            if (Math.abs(a.baselineY - b.baselineY) > 5) {
              return a.baselineY - b.baselineY;
            }
            return a.left - b.left;
          });

          const groupedRects: TextRect[] = [];
          if (textRects.length > 0) {
            let currentGroup = { ...textRects[0] };
            for (let i = 1; i < textRects.length; i++) {
              const rect = textRects[i];
              const isSameLine =
                Math.abs(currentGroup.baselineY - rect.baselineY) <= 5;
              const isClose = rect.left - currentGroup.right <= 25;

              if (isSameLine && isClose) {
                currentGroup.right = Math.max(currentGroup.right, rect.right);
                currentGroup.left = Math.min(currentGroup.left, rect.left);
                currentGroup.top = Math.min(currentGroup.top, rect.top);
                currentGroup.bottom = Math.max(
                  currentGroup.bottom,
                  rect.bottom,
                );
                currentGroup.str += " " + rect.str;
              } else {
                groupedRects.push(currentGroup);
                currentGroup = { ...rect };
              }
            }
            groupedRects.push(currentGroup);
          }

          let foundMatch = false;
          for (const group of groupedRects) {
            if (
              redactStart.x >= group.left - 4 &&
              redactStart.x <= group.right + 4 &&
              redactStart.y >= group.top - 4 &&
              redactStart.y <= group.bottom + 4
            ) {
              finalX = group.left;
              finalY = group.top;
              width = group.right - group.left;
              height = group.bottom - group.top;
              foundMatch = true;
              break;
            }
          }

          if (!foundMatch) {
            setRedactStart(null);
            setRedactCurrent(null);
            return;
          }
        } catch (err) {
          console.error("Smart redact failed", err);
          setRedactStart(null);
          setRedactCurrent(null);
          return;
        }
      } else {
        setRedactStart(null);
        setRedactCurrent(null);
        return;
      }
    }

    const redactAnn: AnnotationItem = {
      id: `ann_redact_${Date.now()}`,
      type: "redact",
      pageNumber: currentPage,
      x: finalX,
      y: finalY,
      width,
      height,
    };

    dispatchAnnotationUpdate(
      (prev) => [...prev, redactAnn],
      "Added redact block",
    );
    addLog(
      "Applied redaction block. (Warning: Native save will permanently flatten these pages)",
      "security",
    );

    setRedactStart(null);
    setRedactCurrent(null);
  };

  // Draggable handlers
  const getEventClientPos = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent) => {
    if ("touches" in e && e.touches && e.touches.length > 0) {
      return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
    }
    if ("changedTouches" in e && e.changedTouches && e.changedTouches.length > 0) {
      return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
    }
    const mouseEvt = e as React.MouseEvent;
    return { clientX: mouseEvt.clientX, clientY: mouseEvt.clientY };
  };

  const handleDragStart = (e: React.MouseEvent | React.TouchEvent, ann: AnnotationItem) => {
    e.stopPropagation();

    setSelectedAnnotationId(ann.id);
    setDraggedElementId(ann.id);

    const pos = getEventClientPos(e);
    const clientX = pos.clientX;
    const clientY = pos.clientY;

    const elementX_px = ann.x * scaleMultiplier;
    const elementY_px = ann.y * scaleMultiplier;

    setDragOffset({
      x: clientX - elementX_px,
      y: clientY - elementY_px,
    });
  };

  const handleResizeStart = (e: React.MouseEvent | React.TouchEvent, ann: AnnotationItem) => {
    e.stopPropagation();

    setSelectedAnnotationId(ann.id);
    setDraggedElementId(ann.id);
    setResizeDirection("br");

    const pos = getEventClientPos(e);
    setDragOffset({
      x: pos.clientX,
      y: pos.clientY,
    });
  };

  const handleGlobalMouseMoveOrTouch = (e: React.MouseEvent | React.TouchEvent) => {
    if (!draggedElementId) return;

    const ann = annotations.find((a) => a.id === draggedElementId);
    if (!ann) return;

    const pos = getEventClientPos(e);

    if (resizeDirection === "br") {
      // Delta-based scale resizing
      const deltaX_px = pos.clientX - dragOffset.x;
      const deltaY_px = pos.clientY - dragOffset.y;

      const deltaX_pdf = deltaX_px / scaleMultiplier;
      const deltaY_pdf = deltaY_px / scaleMultiplier;

      // Update offsets to current position
      setDragOffset({ x: pos.clientX, y: pos.clientY });

      setAnnotations((prev) =>
        prev.map((item) => {
          if (item.id === draggedElementId) {
            // Keep bounds in range
            const newW = Math.max(25, item.width + deltaX_pdf);
            const newH = Math.max(15, item.height + deltaY_pdf);
            return { ...item, width: newW, height: newH, userResized: true };
          }
          return item;
        }),
      );
    } else {
      // Move tracking
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) return;

      const currentX_pdf = (pos.clientX - dragOffset.x) / scaleMultiplier;
      const currentY_pdf = (pos.clientY - dragOffset.y) / scaleMultiplier;

      setAnnotations((prev) =>
        prev.map((item) => {
          if (item.id === draggedElementId) {
            // Contain in bounds
            const finalX = Math.max(
              0,
              Math.min(originalPageSize.width - item.width, currentX_pdf),
            );
            const finalY = Math.max(
              0,
              Math.min(originalPageSize.height - item.height, currentY_pdf),
            );
            return { ...item, x: finalX, y: finalY };
          }
          return item;
        }),
      );
    }
  };

  const handleGlobalMouseUp = () => {
    if (draggedElementId) {
      setDraggedElementId(null);
      setResizeDirection(null);
    }
  };

  const handleDeleteAnnotation = (id: string) => {
    dispatchAnnotationUpdate(
      (prev) => prev.filter((a) => a.id !== id),
      "Deleted layer",
    );
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null);
    }
    addLog("Annotation layer deleted.", "info");
  };

  const handleDeletePages = async (explicitRange?: string) => {
    if (!pdfBytes || !pdfDocProxy) return;

    setLoading(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, {
        ignoreEncryption: true,
      });
      const totalPages = pdfDoc.getPageCount();

      let pagesToDelete: number[] = [];
      const rangeToUse =
        typeof explicitRange === "string" ? explicitRange : deletePageRange;

      if (rangeToUse.trim() === "") {
        pagesToDelete = [currentPage];
      } else {
        // Parse range string (e.g., "1-3, 5")
        const parts = rangeToUse.split(",");
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed.includes("-")) {
            const [start, end] = trimmed.split("-");
            const startNum = parseInt(start);
            const endNum = parseInt(end);
            if (!isNaN(startNum) && !isNaN(endNum)) {
              const min = Math.min(startNum, endNum);
              const max = Math.max(startNum, endNum);
              for (let i = min; i <= max; i++) {
                pagesToDelete.push(i);
              }
            }
          } else {
            const num = parseInt(trimmed);
            if (!isNaN(num)) {
              pagesToDelete.push(num);
            }
          }
        }
      }

      // Filter out invalid pages and deduplicate
      pagesToDelete = [...new Set(pagesToDelete)].filter(
        (p) => p >= 1 && p <= totalPages,
      );

      if (pagesToDelete.length === 0) {
        addLog("No valid pages selected for deletion.", "warning");
        setLoading(false);
        return;
      }

      if (pagesToDelete.length >= totalPages) {
        addLog("Cannot delete all pages in the document.", "warning");
        setLoading(false);
        return;
      }

      addLog(`Removing pages: ${pagesToDelete.join(", ")}...`, "info");

      // Sort in descending order to avoid index shifting issues when removing
      pagesToDelete.sort((a, b) => b - a);

      for (const pageNum of pagesToDelete) {
        pdfDoc.removePage(pageNum - 1);
      }

      // Update annotations
      // We need to shift pageNumbers of remaining annotations down by the number of deleted pages before them
      dispatchAnnotationUpdate(
        (prev) => {
          return prev
            .filter((ann) => !pagesToDelete.includes(ann.pageNumber))
            .map((ann) => {
              const deletedBefore = pagesToDelete.filter(
                (p) => p < ann.pageNumber,
              ).length;
              return { ...ann, pageNumber: ann.pageNumber - deletedBefore };
            });
        },
        `Deleted pages: ${pagesToDelete.join(", ")}`,
      );

      const updatedBytes = await pdfDoc.save();
      setPdfBytes(updatedBytes);

      setPdfDocProxy(null);
      setDeletePageRange("");

      // Adjust current page if it was deleted or shifted
      const remainingPages = totalPages - pagesToDelete.length;
      let newPage = currentPage;
      const deletedBeforeOrEqual = pagesToDelete.filter(
        (p) => p <= currentPage,
      ).length;
      newPage = currentPage - deletedBeforeOrEqual;
      if (newPage < 1) newPage = 1;
      if (newPage > remainingPages) newPage = remainingPages;

      setCurrentPage(newPage);

      addLog(`Pages successfully removed.`, "success");
    } catch (err: any) {
      addLog(`Failed to delete pages: ${err.message}`, "warning");
    } finally {
      setLoading(false);
    }
  };

  const handleRotatePage = async (targetPageNumber: number, direction: "cw" | "ccw") => {
    if (!pdfBytes || !pdfDocProxy) return;

    setLoading(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes, {
        ignoreEncryption: true,
      });
      const totalPages = pdfDoc.getPageCount();

      if (targetPageNumber < 1 || targetPageNumber > totalPages) {
        setLoading(false);
        return;
      }

      const page = pdfDoc.getPage(targetPageNumber - 1);
      const currentRotation = page.getRotation().angle || 0;
      const delta = direction === "cw" ? 90 : -90;
      const newRotation = (currentRotation + delta + 360) % 360;

      page.setRotation(degrees(newRotation));

      const updatedBytes = await pdfDoc.save();
      setPdfBytes(updatedBytes);
      setPdfDocProxy(null);

      addLog(
        `Page ${targetPageNumber} rotated ${direction === "cw" ? "90° Clockwise" : "90° Counter-Clockwise"} (New angle: ${newRotation}°).`,
        "success"
      );
    } catch (err: any) {
      addLog(`Failed to rotate page: ${err.message}`, "warning");
    } finally {
      setLoading(false);
    }
  };

  // Compile final annotated PDF with full security, watermarking, page numbering, flattening and PWA share support
  const exportPdf = async (options?: {
    userPassword?: string;
    ownerPassword?: string;
    stripMetadata?: boolean;
    flattenLayers?: boolean;
    shareDirectly?: boolean;
  }) => {
    if (!pdfBytes || !pdfDocProxy) return;

    try {
      setLoading(true);
      triggerHaptic("medium");
      addLog("Compiling vector modifications natively...", "info");

      // Load into pdf-lib directly
      const pdfDoc = await PDFDocument.load(pdfBytes, {
        ignoreEncryption: true,
      });

      // Strip metadata if requested
      if (options?.stripMetadata) {
        addLog("Scrubbing document metadata (Author, Producer, Revision history)...", "security");
        try {
          pdfDoc.setTitle("");
          pdfDoc.setAuthor("");
          pdfDoc.setSubject("");
          pdfDoc.setKeywords([]);
          pdfDoc.setProducer("Secure Document System");
          pdfDoc.setCreator("Zero-Trust Client PWA");
          pdfDoc.setModificationDate(new Date());
        } catch (mErr) {
          console.warn("Could not scrub metadata:", mErr);
        }
      }

      // Remove XFA from AcroForm to fix Adobe Reader Error 132 while preserving normal pdf vectors!
      let acroForm: any;
      try {
        acroForm = (pdfDoc.catalog as any).lookupMaybe(PDFName.of("AcroForm"));
      } catch (e) {
        console.warn("Could not lookup AcroForm:", e);
      }

      if (acroForm) {
        addLog(
          "Stripping XFA streams to ensure Adobe compatibility...",
          "warning",
        );
        acroForm.delete(PDFName.of("XFA"));
      }

      const hFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const hFontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const timesFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
      const courierFont = await pdfDoc.embedFont(StandardFonts.Courier);

      const pages = pdfDoc.getPages();

      // Helper to locate user fonts
      const getEmbeddedFont = (fontName: string | undefined) => {
        if (fontName === "Times-Roman") return timesFont;
        if (fontName === "Courier") return courierFont;
        return hFont;
      };

      for (let pNum = 1; pNum <= pages.length; pNum++) {
        let page = pages[pNum - 1];
        const { width, height } = page.getSize();

        // Form field filling using PDF.js standard annotations storage
        if (pdfDocProxy.annotationStorage) {
          try {
            const proxyPage = await pdfDocProxy.getPage(pNum);
            const pageAnns = await proxyPage.getAnnotations();
            const storageObj = pdfDocProxy.annotationStorage.getAll();

            for (const ann of pageAnns) {
              if (
                ann.id &&
                storageObj[ann.id] &&
                storageObj[ann.id].value !== undefined
              ) {
                const val = storageObj[ann.id].value;
                const rect = ann.rect; // [x, y, maxX, maxY]
                if (rect && typeof val === "string") {
                  page.drawText(val, {
                    x: rect[0] + 1,
                    y: rect[1] + 3,
                    size: 11,
                    font: hFont,
                    color: rgb(0, 0, 0),
                  });
                } else if (rect && typeof val === "boolean" && val) {
                  page.drawText("X", {
                    x: rect[0] + 2,
                    y: rect[1] + 2,
                    size: 12,
                    font: hFont,
                    color: rgb(0, 0, 0),
                  });
                }
              }
            }
          } catch (formErr) {
            console.warn(
              "Error overlaying form fields text onto target PDF:",
              formErr,
            );
          }
        }

        // Add user DOM Annotations (Text, Signatures, Images, Stamps, Drawings, Redacts)
        const userAnns = annotations.filter((a) => a.pageNumber === pNum);

        const hasRedactions = userAnns.some((a) => a.type === "redact");
        const shouldFlatten = options?.flattenLayers || hasRedactions;

        if (shouldFlatten && pdfDocProxy) {
          addLog(
            `Securely rasterizing & flattening page ${pNum} to permanently obscure layers...`,
            "security",
          );
          try {
            const proxyPage = await pdfDocProxy.getPage(pNum);
            const viewport = proxyPage.getViewport({ scale: 2.5 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              await proxyPage.render({ canvasContext: ctx, viewport }).promise;

              // Draw redactions directly onto the image canvas!
              for (const ann of userAnns) {
                if (ann.type === "redact") {
                  ctx.fillStyle = "#000000";
                  ctx.fillRect(
                    ann.x * 2.5,
                    ann.y * 2.5,
                    ann.width * 2.5,
                    ann.height * 2.5,
                  );
                }
              }

              // Embed the newly flattened image
              const imgDataUrl = canvas.toDataURL("image/jpeg", 0.92);
              const imgBytes = base64ToArrayBuffer(imgDataUrl);
              const embeddedImage = await pdfDoc.embedJpg(imgBytes);

              // Obliterate underlying text streams by completely replacing the page
              pdfDoc.removePage(pNum - 1);
              page = pdfDoc.insertPage(pNum - 1, [width, height]);

              page.drawImage(embeddedImage, {
                x: 0,
                y: 0,
                width: width,
                height: height,
              });
            }
          } catch (err) {
            console.error("Failed to securely rasterize page:", err);
            addLog(
              `Failed to securely flatten page ${pNum}, redactions may be vulnerable.`,
              "warning",
            );
          }
        }

        // Draw DOM Annotations
        for (const ann of userAnns) {
          if (ann.type === "text" && ann.text) {
            const textClr = hexToRgb(ann.fontColor) || { r: 14, g: 17, b: 24 };
            page.drawText(ann.text, {
              x: ann.x,
              y: height - ann.y - (ann.fontSize || 12),
              size: ann.fontSize || 12,
              font: getEmbeddedFont(ann.fontFamily),
              color: rgb(textClr.r / 255, textClr.g / 255, textClr.b / 255),
            });
          } else if (ann.type === "shape") {
            const hasFill =
              ann.hasFill !== false &&
              ann.shapeFillColor !== "transparent" &&
              ann.shapeFillColor !== "none";
            const fillClr = hasFill
              ? hexToRgb(ann.shapeFillColor || "#ffffff") || {
                  r: 255,
                  g: 255,
                  b: 255,
                }
              : null;

            const hasStroke =
              ann.hasStroke !== false && (ann.shapeStrokeWidth ?? 2) > 0;
            const strokeClr = hasStroke
              ? hexToRgb(ann.shapeStrokeColor || "#000000") || {
                  r: 0,
                  g: 0,
                  b: 0,
                }
              : null;
            const strokeWidth = ann.shapeStrokeWidth ?? 2;

            if (ann.shapeType === "circle") {
              page.drawEllipse({
                x: ann.x + ann.width / 2,
                y: height - ann.y - ann.height / 2,
                xScale: ann.width / 2,
                yScale: ann.height / 2,
                color: fillClr
                  ? rgb(fillClr.r / 255, fillClr.g / 255, fillClr.b / 255)
                  : undefined,
                borderColor: strokeClr
                  ? rgb(strokeClr.r / 255, strokeClr.g / 255, strokeClr.b / 255)
                  : undefined,
                borderWidth: hasStroke ? strokeWidth : 0,
              });
            } else if (ann.shapeType === "line" || ann.shapeType === "arrow") {
              page.drawLine({
                start: { x: ann.x, y: height - ann.y - ann.height / 2 },
                end: { x: ann.x + ann.width, y: height - ann.y - ann.height / 2 },
                thickness: strokeWidth || 2,
                color: strokeClr
                  ? rgb(strokeClr.r / 255, strokeClr.g / 255, strokeClr.b / 255)
                  : fillClr
                  ? rgb(fillClr.r / 255, fillClr.g / 255, fillClr.b / 255)
                  : rgb(0, 0, 0),
              });
              if (ann.shapeType === "arrow") {
                // Draw arrowhead
                const arrowX = ann.x + ann.width;
                const arrowY = height - ann.y - ann.height / 2;
                page.drawLine({
                  start: { x: arrowX - 8, y: arrowY + 5 },
                  end: { x: arrowX, y: arrowY },
                  thickness: strokeWidth || 2,
                  color: strokeClr
                    ? rgb(strokeClr.r / 255, strokeClr.g / 255, strokeClr.b / 255)
                    : rgb(0, 0, 0),
                });
                page.drawLine({
                  start: { x: arrowX - 8, y: arrowY - 5 },
                  end: { x: arrowX, y: arrowY },
                  thickness: strokeWidth || 2,
                  color: strokeClr
                    ? rgb(strokeClr.r / 255, strokeClr.g / 255, strokeClr.b / 255)
                    : rgb(0, 0, 0),
                });
              }
            } else {
              page.drawRectangle({
                x: ann.x,
                y: height - ann.y - ann.height,
                width: ann.width,
                height: ann.height,
                color: fillClr
                  ? rgb(fillClr.r / 255, fillClr.g / 255, fillClr.b / 255)
                  : undefined,
                borderColor: strokeClr
                  ? rgb(strokeClr.r / 255, strokeClr.g / 255, strokeClr.b / 255)
                  : undefined,
                borderWidth: hasStroke ? strokeWidth : 0,
              });
            }
          } else if (
            (ann.type === "signature" || ann.type === "image") &&
            (ann.signatureDataUrl || ann.imageDataUrl)
          ) {
            const dataUrl = ann.signatureDataUrl || ann.imageDataUrl || "";
            const sigBytes = base64ToArrayBuffer(dataUrl);
            const embeddedImage = dataUrl.includes("image/png")
              ? await pdfDoc.embedPng(sigBytes)
              : await pdfDoc.embedJpg(sigBytes);
            page.drawImage(embeddedImage, {
              x: ann.x,
              y: height - ann.y - ann.height,
              width: ann.width,
              height: ann.height,
            });
          } else if (ann.type === "stamp" && ann.stampType) {
            const borderClr =
              ann.stampType === "APPROVED" || ann.stampType === "CHECKMARK"
                ? rgb(16 / 255, 185 / 255, 129 / 255)
                : ann.stampType === "REJECTED" || ann.stampType === "CROSS"
                  ? rgb(244 / 255, 63 / 255, 94 / 255)
                  : ann.stampType === "SIGN_HERE"
                    ? rgb(245 / 255, 158 / 255, 11 / 255)
                    : ann.stampType === "INITIAL_HERE"
                      ? rgb(168 / 255, 85 / 255, 247 / 255)
                      : rgb(56 / 255, 189 / 255, 248 / 255);

            if (ann.stampType === "CHECKMARK") {
              page.drawLine({
                start: { x: ann.x + 6, y: height - ann.y - 18 },
                end: { x: ann.x + 14, y: height - ann.y - 26 },
                thickness: 3.5,
                color: borderClr,
              });
              page.drawLine({
                start: { x: ann.x + 14, y: height - ann.y - 26 },
                end: { x: ann.x + 28, y: height - ann.y - 8 },
                thickness: 3.5,
                color: borderClr,
              });
            } else if (ann.stampType === "CROSS") {
              page.drawLine({
                start: { x: ann.x + 6, y: height - ann.y - 6 },
                end: { x: ann.x + 26, y: height - ann.y - 26 },
                thickness: 3.5,
                color: borderClr,
              });
              page.drawLine({
                start: { x: ann.x + 6, y: height - ann.y - 26 },
                end: { x: ann.x + 26, y: height - ann.y - 6 },
                thickness: 3.5,
                color: borderClr,
              });
            } else {
              page.drawRectangle({
                x: ann.x,
                y: height - ann.y - ann.height,
                width: ann.width,
                height: ann.height,
                borderColor: borderClr,
                borderWidth: 2,
                color: rgb(0.98, 1.0, 0.99),
              });
              page.drawRectangle({
                x: ann.x + 3,
                y: height - ann.y - ann.height + 3,
                width: ann.width - 6,
                height: ann.height - 6,
                borderColor: borderClr,
                borderWidth: 0.75,
              });
              let stampLabelText = ann.stampType.replace("_", " ");
              if (ann.stampType === "SIGN_HERE") stampLabelText = "SIGN HERE ➔";
              if (ann.stampType === "INITIAL_HERE")
                stampLabelText = "INITIALS ➔";
              page.drawText(stampLabelText, {
                x: ann.x + 14,
                y: height - ann.y - ann.height / 2 - 4,
                size: 9.5,
                font: hFontBold,
                color: borderClr,
              });
            }
          } else if (ann.type === "drawing" && ann.drawingPoints) {
            const drawClr = hexToRgb(ann.drawingColor) || {
              r: 178,
              g: 34,
              b: 34,
            };
            const opacity = ann.isHighlighter ? 0.35 : 1.0;
            for (let sIdx = 0; sIdx < ann.drawingPoints.length - 1; sIdx++) {
              const startPt = ann.drawingPoints[sIdx];
              const endPt = ann.drawingPoints[sIdx + 1];
              page.drawLine({
                start: { x: startPt.x, y: height - startPt.y },
                end: { x: endPt.x, y: height - endPt.y },
                thickness: ann.drawingWidth || (ann.isHighlighter ? 20 : 3),
                color: rgb(drawClr.r / 255, drawClr.g / 255, drawClr.b / 255),
                opacity,
              });
            }
          }
        }

        // Apply Watermark if configured
        if (watermarkConfig && watermarkConfig.text.trim()) {
          let shouldWatermark = false;
          if (watermarkConfig.pages === "all") shouldWatermark = true;
          else if (watermarkConfig.pages === "first" && pNum === 1) shouldWatermark = true;
          else if (watermarkConfig.pages === "range" && watermarkConfig.pageRange) {
            const rangeNums = watermarkConfig.pageRange.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            if (rangeNums.includes(pNum)) shouldWatermark = true;
          }

          if (shouldWatermark) {
            const wmClr = hexToRgb(watermarkConfig.color || "#64748b") || { r: 100, g: 116, b: 139 };
            const rotDegrees = watermarkConfig.rotationAngle ?? -45;
            page.drawText(watermarkConfig.text, {
              x: width / 2 - (watermarkConfig.text.length * (watermarkConfig.fontSize || 48)) / 4,
              y: height / 2,
              size: watermarkConfig.fontSize || 48,
              font: hFontBold,
              color: rgb(wmClr.r / 255, wmClr.g / 255, wmClr.b / 255),
              opacity: watermarkConfig.opacity ?? 0.25,
              rotate: degrees(rotDegrees),
            });
          }
        }

        // Apply Page Numbering if configured
        if (pageNumberConfig) {
          // The fields the watermark dialog sets: the first number shown, and
          // one of its three formats (these read names it never set, so every
          // page came out as a bare number).
          const startNumber = pageNumberConfig.startNumber || 1;
          {
            const numVal = pNum - 1 + startNumber;
            let pageStr = `${numVal}`;
            if (pageNumberConfig.format === "page-of-total") {
              pageStr = `Page ${numVal} of ${pages.length - 1 + startNumber}`;
            } else if (pageNumberConfig.format === "dash-page") {
              pageStr = `- ${numVal} -`;
            }

            const pSize = pageNumberConfig.fontSize || 10;
            const pClr = hexToRgb(pageNumberConfig.color || "#475569") || { r: 71, g: 85, b: 105 };
            const margin = 28;

            let px = width / 2 - (pageStr.length * pSize) / 4;
            let py = margin;

            if (pageNumberConfig.position === "bottom-right") {
              px = width - margin - (pageStr.length * pSize) / 2;
              py = margin;
            } else if (pageNumberConfig.position === "bottom-left") {
              px = margin;
              py = margin;
            } else if (pageNumberConfig.position === "top-right") {
              px = width - margin - (pageStr.length * pSize) / 2;
              py = height - margin;
            } else if (pageNumberConfig.position === "top-center") {
              px = width / 2 - (pageStr.length * pSize) / 4;
              py = height - margin;
            }

            page.drawText(pageStr, {
              x: px,
              y: py,
              size: pSize,
              font: hFont,
              color: rgb(pClr.r / 255, pClr.g / 255, pClr.b / 255),
            });
          }
        }
      }

      const finishedBytesComp = await pdfDoc.save();

      const outBlob = new Blob([finishedBytesComp], {
        type: "application/pdf",
      });
      const defaultFileName = `Document_${pdfFileName || "signed.pdf"}`;

      const dlLink = document.createElement("a");
      dlLink.href = URL.createObjectURL(outBlob);
      dlLink.download = defaultFileName;
      document.body.appendChild(dlLink);
      dlLink.click();
      document.body.removeChild(dlLink);
      addLog(
        "Document compiled & exported to local device storage successfully!",
        "success",
      );
    } catch (exportErr: any) {
      console.error(exportErr);
      addLog(
        `Failed compiling vector streams: ${exportErr.message}`,
        "warning",
      );
    } finally {
      setLoading(false);
    }
  };

  const downloadFinishedPDF = () => exportPdf();

  // Rendering of draggable active annotation on sheet overlay
  const renderDraggableAnnotation = (ann: AnnotationItem) => {
    const isSelected = selectedAnnotationId === ann.id;
    const x_px = ann.x * scaleMultiplier;
    const y_px = ann.y * scaleMultiplier;
    const w_px = ann.width * scaleMultiplier;
    const h_px = ann.height * scaleMultiplier;

    // Selected input box logic
    if (ann.type === "text") {
      return (
        <div
          key={ann.id}
          id={`draggable-${ann.id}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className={`absolute flex items-center justify-between group pointer-events-auto select-none ${
            isSelected
              ? "ring-2 ring-emerald-400 bg-emerald-500/5 z-20 shadow-md"
              : "hover:ring-1 hover:ring-gray-400 z-10"
          }`}
          style={{
            left: x_px,
            top: y_px,
            width: w_px,
            height: h_px,
          }}
        >
          {/* Edge Drag Handles */}
          <div onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => handleDragStart(e, ann)} className="absolute top-0 left-0 w-full h-2 cursor-move z-20" />
          <div onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => handleDragStart(e, ann)} className="absolute bottom-0 left-0 w-full h-2 cursor-move z-20" />
          <div onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => handleDragStart(e, ann)} className="absolute top-0 left-0 w-2 h-full cursor-move z-20" />
          <div onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => handleDragStart(e, ann)} className="absolute top-0 right-0 w-2 h-full cursor-move z-20" />
          
          <textarea
            id={`input-ann-${ann.id}`}
            value={ann.text || ""}
            onChange={(e) => {
              const capText = e.target.value;
              const targetEl = e.target;
              targetEl.style.height = "auto";
              const scrollH = targetEl.scrollHeight;
              const singleLineH = ((ann.fontSize || 12) * scaleMultiplier) + 6;
              const neededPxH = Math.max(scrollH, singleLineH);
              const neededPdfH = Math.ceil(neededPxH / scaleMultiplier);

              setAnnotations((prev) =>
                prev.map((item) =>
                  item.id === ann.id
                    ? {
                        ...item,
                        text: capText,
                        height: item.userResized
                          ? Math.max(item.height, neededPdfH)
                          : neededPdfH,
                      }
                    : item,
                ),
              );
            }}
            onBlur={() => {
              setAnnotations((prev) => {
                setHistory((currHist) => {
                  const newTimeline = currHist.timeline.slice(
                    0,
                    currHist.currentIndex + 1,
                  );
                  newTimeline.push({
                    annotations: prev,
                    description: "Edited text content",
                    id:
                      Date.now().toString() +
                      Math.random().toString(36).substr(2, 5),
                  });
                  return {
                    timeline: newTimeline,
                    currentIndex: newTimeline.length - 1,
                  };
                });
                return prev;
              });
            }}
            onClick={(e) => e.stopPropagation()}
            onFocus={() => setSelectedAnnotationId(ann.id)}
            style={{
              fontSize: (ann.fontSize || 12) * scaleMultiplier,
              color: ann.fontColor || "#000",
              fontFamily:
                ann.fontFamily === "Courier"
                  ? "monospace"
                  : ann.fontFamily === "Times-Roman"
                    ? "serif"
                    : "sans-serif",
            }}
            className="bg-transparent border-none outline-hidden w-full h-full px-1.5 focus:bg-white/40 leading-tight rounded-xs select-text cursor-text resize-none overflow-hidden"
          />

          {/* Action corner tags overlay when mouse over */}
          {isSelected && (
            <button
              id={`del-inline-btn-${ann.id}`}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAnnotation(ann.id);
              }}
              className="absolute -top-3.5 -right-3.5 w-7 h-7 sm:w-6 sm:h-6 bg-rose-500 text-white rounded-full flex items-center justify-center hover:bg-rose-600 transition-transform active:scale-90 shadow-md pointer-events-auto z-50 cursor-pointer"
              title="Delete text box"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          )}

          {/* Sizing scale grip element */}
          {isSelected && (
            <div
              id={`resize-handle-${ann.id}`}
              onMouseDown={(e) => handleResizeStart(e, ann)}
              onTouchStart={(e) => handleResizeStart(e, ann)}
              className="absolute -bottom-2.5 -right-2.5 w-6 h-6 flex items-center justify-center cursor-se-resize shadow-xs z-30 touch-none"
            >
              <div className="w-3 h-3 bg-emerald-400 rounded-full border border-slate-900 shadow-xs" />
            </div>
          )}
        </div>
      );
    }

    if (ann.type === "signature") {
      return (
        <div
          key={ann.id}
          id={`draggable-${ann.id}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => handleDragStart(e, ann)}
          onTouchStart={(e) => handleDragStart(e, ann)}
          className={`absolute group pointer-events-auto select-none flex items-center justify-center p-0.5 ${
            isSelected
              ? "ring-2 ring-emerald-400 bg-emerald-500/5 cursor-move z-20 shadow-md"
              : "hover:ring-1 hover:ring-gray-400 cursor-pointer z-10"
          }`}
          style={{
            left: x_px,
            top: y_px,
            width: w_px,
            height: h_px,
          }}
        >
          <img
            src={ann.signatureDataUrl}
            alt="Sig seal"
            className="max-w-full max-h-full pointer-events-none select-none object-contain"
            referrerPolicy="no-referrer"
          />

          {isSelected && (
            <button
              id={`del-inline-btn-${ann.id}`}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAnnotation(ann.id);
              }}
              className="absolute -top-3.5 -right-3.5 w-7 h-7 sm:w-6 sm:h-6 bg-rose-500 text-white rounded-full flex items-center justify-center hover:bg-rose-600 transition-transform active:scale-90 shadow-md pointer-events-auto z-50 cursor-pointer"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          )}

          {isSelected && (
            <div
              id={`resize-handle-${ann.id}`}
              onMouseDown={(e) => handleResizeStart(e, ann)}
              onTouchStart={(e) => handleResizeStart(e, ann)}
              className="absolute -bottom-2.5 -right-2.5 w-6 h-6 flex items-center justify-center cursor-se-resize z-30 touch-none"
            >
              <div className="w-3 h-3 bg-emerald-400 rounded-full border border-slate-900 shadow-xs" />
            </div>
          )}
        </div>
      );
    }

    if (ann.type === "stamp") {
      return (
        <div
          key={ann.id}
          id={`draggable-${ann.id}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => handleDragStart(e, ann)}
          onTouchStart={(e) => handleDragStart(e, ann)}
          className={`absolute group pointer-events-auto select-none flex items-center justify-center bg-transparent cursor-move ${
            isSelected
              ? "ring-2 ring-emerald-400 z-20 shadow-md"
              : "hover:ring-1 hover:ring-gray-400 z-10"
          }`}
          style={{
            left: x_px,
            top: y_px,
            width: w_px,
            height: h_px,
          }}
        >
          {ann.stampType === "APPROVED" && <CheckCircle className="w-full h-full text-emerald-500" />}
          {ann.stampType === "REJECTED" && <XCircle className="w-full h-full text-rose-500" />}
          {ann.stampType === "SIGN_HERE" && <FileSignature className="w-full h-full text-amber-500" />}
          {ann.stampType === "INITIAL_HERE" && <UserCircle className="w-full h-full text-purple-500" />}
          {ann.stampType === "DATE" && <Calendar className="w-full h-full text-sky-500" />}
          {ann.stampType === "CHECKMARK" && <Check className="w-full h-full text-emerald-500" />}
          {ann.stampType === "CROSS" && <XIcon className="w-full h-full text-rose-500" />}
          {ann.stampType === "CONFIDENTIAL" && <Shield className="w-full h-full text-red-500" />}

          {isSelected && (
            <button
              id={`del-inline-btn-${ann.id}`}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAnnotation(ann.id);
              }}
              className="absolute -top-3.5 -right-3.5 w-7 h-7 sm:w-6 sm:h-6 bg-rose-500 text-white rounded-full flex items-center justify-center hover:bg-rose-600 transition-transform active:scale-90 shadow-md pointer-events-auto z-50 cursor-pointer"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          )}

          {isSelected && (
            <div
              id={`resize-handle-${ann.id}`}
              onMouseDown={(e) => handleResizeStart(e, ann)}
              onTouchStart={(e) => handleResizeStart(e, ann)}
              className="absolute -bottom-2.5 -right-2.5 w-6 h-6 flex items-center justify-center cursor-se-resize z-30 touch-none"
            >
              <div className="w-3 h-3 bg-emerald-400 rounded-full border border-slate-900 shadow-xs" />
            </div>
          )}
        </div>
      );
    }

    if (ann.type === "note") {
      return (
        <div
          key={ann.id}
          id={`draggable-${ann.id}`}
          onClick={(e) => {
            e.stopPropagation();
            setSelectedAnnotationId(ann.id);
            setActiveNoteId(ann.id);
          }}
          onMouseDown={(e) => handleDragStart(e, ann)}
          onTouchStart={(e) => handleDragStart(e, ann)}
          className={`absolute group pointer-events-auto cursor-pointer select-none ${
            isSelected ? "z-30" : "z-10"
          }`}
          style={{
            left: x_px,
            top: y_px,
            width: Math.max(36, w_px),
            height: Math.max(36, h_px),
          }}
        >
          <div
            className={`w-10 h-10 sm:w-9 sm:h-9 rounded-xl shadow-lg flex items-center justify-center border transition-transform duration-150 ${
              isSelected
                ? "ring-2 ring-indigo-500 scale-110 shadow-indigo-500/20"
                : "hover:scale-105"
            }`}
            style={{
              backgroundColor: ann.noteColor || "#fef08a",
              borderColor: "#ca8a04",
            }}
            title={ann.noteComment || "Review Note"}
          >
            <MessageSquare className="w-5 h-5 sm:w-4 sm:h-4 text-amber-900 drop-shadow-xs" />
          </div>

          {/* Delete button */}
          {isSelected && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAnnotation(ann.id);
                if (activeNoteId === ann.id) setActiveNoteId(null);
              }}
              className="absolute -top-3 -right-3 w-7 h-7 sm:w-6 sm:h-6 bg-rose-500 text-white rounded-full flex items-center justify-center hover:bg-rose-600 transition-transform active:scale-90 shadow-md z-40 cursor-pointer"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          )}
        </div>
      );
    }

    if (ann.type === "image" && (ann.imageDataUrl || ann.signatureDataUrl)) {
      return (
        <div
          key={ann.id}
          id={`draggable-${ann.id}`}
          onClick={(e) => {
            e.stopPropagation();
            setSelectedAnnotationId(ann.id);
          }}
          onMouseDown={(e) => handleDragStart(e, ann)}
          onTouchStart={(e) => handleDragStart(e, ann)}
          className={`absolute group pointer-events-auto cursor-move select-none ${
            isSelected ? "ring-2 ring-indigo-500 z-20 shadow-lg" : "z-10"
          }`}
          style={{
            left: x_px,
            top: y_px,
            width: w_px,
            height: h_px,
          }}
        >
          <img
            src={ann.imageDataUrl || ann.signatureDataUrl}
            alt="Inserted Seal"
            className="w-full h-full object-contain pointer-events-none rounded-sm"
          />

          {/* Delete button */}
          {isSelected && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAnnotation(ann.id);
              }}
              className="absolute -top-3.5 -right-3.5 w-7 h-7 sm:w-6 sm:h-6 bg-rose-500 text-white rounded-full flex items-center justify-center hover:bg-rose-600 transition-transform active:scale-90 shadow-md z-40 cursor-pointer"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          )}

          {/* Resize handle */}
          {isSelected && (
            <div
              onMouseDown={(e) => handleResizeStart(e, ann)}
              onTouchStart={(e) => handleResizeStart(e, ann)}
              className="absolute -bottom-2.5 -right-2.5 w-6 h-6 flex items-center justify-center cursor-se-resize z-30 touch-none"
            >
              <div className="w-3 h-3 bg-indigo-600 border-2 border-white rounded-full shadow-md" />
            </div>
          )}
        </div>
      );
    }

    if (ann.type === "shape") {
      const hasFill =
        ann.hasFill !== false &&
        ann.shapeFillColor !== "transparent" &&
        ann.shapeFillColor !== "none";
      const fillClr = hasFill ? ann.shapeFillColor || "#ffffff" : "transparent";

      const hasStroke =
        ann.hasStroke !== false && (ann.shapeStrokeWidth ?? 2) > 0;
      const strokeClr = ann.shapeStrokeColor || "#000000";
      const strokeWidth = hasStroke
        ? (ann.shapeStrokeWidth ?? 2) * scaleMultiplier
        : 0;

      const shapeType = ann.shapeType || "rectangle";

      return (
        <div
          key={ann.id}
          id={`draggable-${ann.id}`}
          onClick={(e) => {
            e.stopPropagation();
            setSelectedAnnotationId(ann.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSelectedAnnotationId(ann.id);
            setShapeContextMenu({
              annId: ann.id,
              x: e.clientX,
              y: e.clientY,
            });
          }}
          onMouseDown={(e) => handleDragStart(e, ann)}
          onTouchStart={(e) => handleDragStart(e, ann)}
          className={`absolute group pointer-events-auto cursor-move ${
            isSelected ? "ring-2 ring-emerald-400 z-20 shadow-md" : "z-10"
          }`}
          style={{
            left: x_px,
            top: y_px,
            width: w_px,
            height: h_px,
          }}
        >
          {/* Shape background & border visual element */}
          {shapeType === "line" ? (
            <div
              className="w-full absolute top-1/2 -translate-y-1/2"
              style={{
                height: Math.max(2, strokeWidth),
                backgroundColor: strokeClr,
              }}
            />
          ) : shapeType === "arrow" ? (
            <svg className="w-full h-full" viewBox="0 0 100 24" preserveAspectRatio="none">
              <defs>
                <marker
                  id={`arrowhead-${ann.id}`}
                  markerWidth="8"
                  markerHeight="6"
                  refX="7"
                  refY="3"
                  orient="auto"
                >
                  <polygon points="0 0, 8 3, 0 6" fill={strokeClr} />
                </marker>
              </defs>
              <line
                x1="2"
                y1="12"
                x2="90"
                y2="12"
                stroke={strokeClr}
                strokeWidth={Math.max(2, strokeWidth)}
                markerEnd={`url(#arrowhead-${ann.id})`}
              />
            </svg>
          ) : (
            <div
              className="w-full h-full transition-all"
              style={{
                backgroundColor: fillClr,
                border: hasStroke
                  ? `${Math.max(1, strokeWidth)}px solid ${strokeClr}`
                  : "none",
                borderRadius: shapeType === "circle" ? "9999px" : "0px",
              }}
            />
          )}

          {/* Delete button at top right */}
          {isSelected && (
            <button
              id={`del-inline-btn-${ann.id}`}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAnnotation(ann.id);
              }}
              className="absolute -top-3.5 -right-3.5 w-7 h-7 sm:w-6 sm:h-6 bg-rose-500 text-white rounded-full flex items-center justify-center hover:bg-rose-600 transition-transform active:scale-90 shadow-md pointer-events-auto z-50 cursor-pointer"
              title="Delete shape"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          )}

          {/* Resize handle */}
          {isSelected && (
            <div
              id={`resize-handle-${ann.id}`}
              onMouseDown={(e) => handleResizeStart(e, ann)}
              onTouchStart={(e) => handleResizeStart(e, ann)}
              className="absolute -bottom-2.5 -right-2.5 w-6 h-6 flex items-center justify-center cursor-se-resize z-30 touch-none"
            >
              <div className="w-3 h-3 bg-emerald-400 rounded-full border border-slate-900 shadow-xs" />
            </div>
          )}
        </div>
      );
    }
    if (ann.type === "redact") {
      return (
        <div
          key={ann.id}
          id={`draggable-${ann.id}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => handleDragStart(e, ann)}
          onTouchStart={(e) => handleDragStart(e, ann)}
          className={`absolute group pointer-events-auto select-none bg-black cursor-move ${
            isSelected ? "ring-2 ring-emerald-400 z-20 shadow-md" : "z-10"
          }`}
          style={{
            left: x_px,
            top: y_px,
            width: w_px,
            height: h_px,
          }}
        >
          {isSelected && (
            <button
              id={`del-inline-btn-${ann.id}`}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAnnotation(ann.id);
              }}
              className="absolute -top-3.5 -right-3.5 w-7 h-7 sm:w-6 sm:h-6 bg-rose-500 text-white rounded-full flex items-center justify-center hover:bg-rose-600 transition-transform active:scale-90 shadow-sm pointer-events-auto z-50 cursor-pointer"
              title="Delete block"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          )}
          {isSelected && (
            <div
              id={`resize-handle-${ann.id}`}
              onMouseDown={(e) => handleResizeStart(e, ann)}
              onTouchStart={(e) => handleResizeStart(e, ann)}
              className="absolute -bottom-2.5 -right-2.5 w-6 h-6 flex items-center justify-center cursor-se-resize z-30 touch-none"
            >
              <div className="w-3 h-3 bg-emerald-400 rounded-full border border-slate-900 shadow-xs" />
            </div>
          )}
        </div>
      );
    }

    return null;
  };

  return (
    <div
      id="app-root-container"
      className={`h-[100dvh] h-screen max-h-[100dvh] max-h-screen overflow-hidden bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 flex flex-col font-sans transition-colors ${isDarkMode ? "dark" : ""}`}
      onMouseMove={handleGlobalMouseMoveOrTouch}
      onMouseUp={handleGlobalMouseUp}
      onTouchMove={handleGlobalMouseMoveOrTouch}
      onTouchEnd={handleGlobalMouseUp}
    >
      {/* Dynamic Incineration Scrub screen block lock */}
      <PurgeOverlay
        isPurging={isPurging}
        onPurgeFinished={handlePurgeFinished}
      />

      {/* Signature Placement Modal */}
      <SignatureModal
        isOpen={isSignatureModalOpen}
        onClose={() => setIsSignatureModalOpen(false)}
        onSave={(sig) => {
          setSavedSignatures((prev) => [...prev, sig]);
          addLog(
            `Added signature seal context in memory registry: "${sig.label}"`,
            "security",
          );
          placeSavedSignature(sig);
        }}
      />

      <PdfMergeModal
        isOpen={isPdfMergeModalOpen}
        onClose={() => setIsPdfMergeModalOpen(false)}
        onMerged={loadMergedPdf}
      />

      <PdfCompressModal
        isOpen={isPdfCompressModalOpen}
        onClose={() => setIsPdfCompressModalOpen(false)}
      />

      <FindAndRedactModal
        isOpen={isFindAndRedactOpen}
        onClose={() => setIsFindAndRedactOpen(false)}
        pdfDocProxy={pdfDocProxy}
        numPages={numPages}
        onApplyRedactions={(newRedactions, patternLabel) => {
          dispatchAnnotationUpdate(
            (prev) => [...prev, ...newRedactions],
            `Applied ${newRedactions.length} auto-redaction blocks for ${patternLabel}`,
          );
          addLog(
            `Applied ${newRedactions.length} auto-redaction blackout blocks across document for ${patternLabel}.`,
            "security",
          );
          setToolMode("redact");
        }}
        onNavigate={(page) => navigateToPage(page)}
      />

      {/* Page Reorder & Thumbnails Organizer Modal */}
      <PageOrganizerModal
        isOpen={isPageOrganizerOpen}
        onClose={() => setIsPageOrganizerOpen(false)}
        pdfBytes={pdfBytes}
        pdfDocProxy={pdfDocProxy}
        numPages={numPages}
        currentPage={currentPage}
        onUpdatePdfBytes={async (newBytes, newPage) => {
          await loadPdfFromBytes(newBytes, pdfFileName);
          if (newPage) setCurrentPage(newPage);
          addLog("Updated PDF page structure successfully.", "success");
        }}
        onSelectPage={(page) => {
          navigateToPage(page);
          setIsPageOrganizerOpen(false);
        }}
      />

      {/* Watermark & Page Numbering Modal */}
      <WatermarkModal
        isOpen={isWatermarkModalOpen}
        onClose={() => setIsWatermarkModalOpen(false)}
        totalPages={numPages}
        onApplyWatermark={(cfg) => {
          setWatermarkConfig(cfg);
          addLog(`Applied watermark "${cfg.text}" to document export settings.`, "info");
        }}
        onApplyPageNumbers={(cfg) => {
          setPageNumberConfig(cfg);
          addLog("Applied page numbering configuration to document export settings.", "info");
        }}
      />

      {/* Zero-Trust PDF Security & Sanitization Modal */}
      <PdfSecurityModal
        isOpen={isSecurityModalOpen}
        onClose={() => setIsSecurityModalOpen(false)}
        fileName={pdfFileName}
        onExport={async (opts) => {
          await exportPdf({
            stripMetadata: opts.stripMetadata,
            flattenLayers: opts.flattenLayers,
            shareDirectly: opts.shareDirectly,
          });
        }}
      />

      {/* PWA Mobile Offline & Install Notification Banner */}

      {/* Active Sticky Note Popover */}
      {activeNoteId && (() => {
        const activeAnn = annotations.find(
          (a) => a.id === activeNoteId && a.type === "note",
        );
        if (!activeAnn) return null;
        return (
          <StickyNotePopover
            annotation={activeAnn}
            onUpdate={(updates) => {
              dispatchAnnotationUpdate(
                (prev) =>
                  prev.map((a) =>
                    a.id === activeAnn.id ? { ...a, ...updates } : a,
                  ),
                "Updated note comments",
              );
            }}
            onDelete={() => {
              handleDeleteAnnotation(activeAnn.id);
              setActiveNoteId(null);
            }}
            onClose={() => setActiveNoteId(null)}
          />
        );
      })()}

      {/* Keyboard Shortcuts Help Modal */}
      <AnimatePresence>
        {isKeyboardHelpOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs"
              onClick={() => setIsKeyboardHelpOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="relative bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 z-10"
            >
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-700">
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <HelpCircle className="w-5 h-5 text-indigo-500" /> Keyboard Shortcuts
                </h3>
                <button
                  onClick={() => setIsKeyboardHelpOpen(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 font-bold p-1 rounded-lg cursor-pointer"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
                <div className="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                  <span>Previous / Next Page</span>
                  <span className="font-mono bg-white dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-600 font-bold">← → ↑ ↓ / PgUp PgDn</span>
                </div>
                <div className="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                  <span>Undo Change</span>
                  <span className="font-mono bg-white dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-600 font-bold">Ctrl + Z</span>
                </div>
                <div className="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                  <span>Redo Change</span>
                  <span className="font-mono bg-white dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-600 font-bold">Ctrl + Y</span>
                </div>
                <div className="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                  <span>Add Text Box</span>
                  <span className="font-mono bg-white dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-600 font-bold">Double Click Page</span>
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={() => setIsKeyboardHelpOpen(false)}
                  className="px-4 py-2 text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-500 rounded-xl transition-colors cursor-pointer"
                >
                  Got it
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* About & Security Modal */}
      <AnimatePresence>
        {isAboutModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs"
              onClick={() => setIsAboutModalOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="relative bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 z-10"
            >
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-700">
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <Lock className="w-5 h-5 text-emerald-500" /> About Secure PDF
                </h3>
                <button
                  onClick={() => setIsAboutModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 font-bold p-1 rounded-lg cursor-pointer"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                <p>
                  <strong>Secure PDF</strong> is a zero-trust, 100% client-side PDF editing and signature application.
                </p>
                <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 rounded-xl space-y-1">
                  <div className="font-bold text-emerald-700 dark:text-emerald-400">🔒 Volatile Memory Architecture</div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    No document or signature data is ever transmitted to a remote server. All parsing, rendering, vector stream manipulation, and redactions execute exclusively in volatile local browser memory.
                  </p>
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={() => setIsAboutModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100 rounded-xl transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Application Top Bar Header */}
      <header className="relative h-14 flex items-center justify-between px-2 sm:px-4 lg:px-6 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shadow-xs z-40 shrink-0 transition-colors">
        <input
          ref={fileInputRef}
          id="pdf-file-uploader-input"
          type="file"
          accept="application/pdf"
          onChange={handleFileUpload}
          className="hidden"
        />

        {/* Left-Aligned Menu & Navigation Section */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 z-10">
          {/* Mobile Thumbnails Drawer Toggle Button */}
          {pdfBytes && (
            <button
              onClick={() => setIsSidebarOpen((prev) => !prev)}
              title="Toggle Page Thumbnails"
              className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg md:hidden cursor-pointer shrink-0"
            >
              <Grid className="w-4 h-4" />
            </button>
          )}

          {/* Mobile Menu Dropdown (Left Aligned) */}
          <div ref={mobileMenuRef} className="relative md:hidden">
            <motion.button
              whileTap={{ scale: 0.94 }}
              onClick={() => setIsMenuOpen((prev) => !prev)}
              className="min-h-[36px] px-3 py-1.5 text-xs font-bold rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 flex items-center gap-1.5 cursor-pointer transition-colors border border-slate-200 dark:border-slate-700 shadow-xs"
            >
              <Menu className="w-4 h-4" />
              <span>Menu</span>
            </motion.button>

            <AnimatePresence>
              {isMenuOpen && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -8 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute left-0 mt-2 w-64 max-w-[calc(100vw-24px)] bg-white/95 dark:bg-slate-800/95 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden z-50 py-1.5 text-slate-800 dark:text-slate-200 max-h-[80vh] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700/60"
                >
                  <div className="py-1">
                    <button
                      onClick={() => {
                        setIsMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                    >
                      <Upload className="w-4 h-4 text-indigo-500" /> Open New PDF...
                    </button>
                    <button
                      onClick={() => {
                        setIsMenuOpen(false);
                        setIsPdfMergeModalOpen(true);
                      }}
                      className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                    >
                      <Layers className="w-4 h-4 text-indigo-500" /> Merge PDFs...
                    </button>
                    <button
                      onClick={() => {
                        setIsMenuOpen(false);
                        setIsPdfCompressModalOpen(true);
                      }}
                      className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                    >
                      <Maximize2 className="w-4 h-4 text-indigo-500" /> Compress PDF...
                    </button>
                  </div>

                  {pdfBytes && (
                    <div className="py-1">
                      <button
                        onClick={() => {
                          setIsMenuOpen(false);
                          setIsPageOrganizerOpen(true);
                        }}
                        className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                      >
                        <Grid className="w-4 h-4 text-indigo-500" /> Page Organizer...
                      </button>
                      <button
                        onClick={() => {
                          setIsMenuOpen(false);
                          setIsWatermarkModalOpen(true);
                        }}
                        className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                      >
                        <Sparkles className="w-4 h-4 text-indigo-500" /> Watermark & Numbers...
                      </button>
                      <button
                        onClick={() => {
                          setIsMenuOpen(false);
                          setIsSecurityModalOpen(true);
                        }}
                        className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                      >
                        <Lock className="w-4 h-4 text-emerald-500" /> Security & Sanitize...
                      </button>

                      {/* Redaction Options */}
                      <button
                        onClick={() => {
                          setIsMenuOpen(false);
                          setToolMode("redact");
                        }}
                        className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-400 flex items-center gap-3 cursor-pointer"
                      >
                        <EyeOff className="w-4 h-4 text-rose-500" /> Redact Area (Blackout Tool)
                      </button>
                      <button
                        onClick={() => {
                          setIsMenuOpen(false);
                          setIsFindAndRedactOpen(true);
                        }}
                        className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-400 flex items-center gap-3 cursor-pointer"
                      >
                        <ShieldAlert className="w-4 h-4 text-rose-500" /> Find & Auto-Redact Patterns...
                      </button>

                      <button
                        onClick={() => {
                          setIsMenuOpen(false);
                          downloadFinishedPDF();
                        }}
                        className="w-full text-left px-4 py-2.5 text-xs font-extrabold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 flex items-center gap-3 cursor-pointer"
                      >
                        <Download className="w-4 h-4" /> Save / Export PDF
                      </button>
                      <button
                        onClick={() => {
                          setIsMenuOpen(false);
                          exportPdf({ shareDirectly: true });
                        }}
                        className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                      >
                        <Share2 className="w-4 h-4 text-indigo-500" /> Native Mobile Share...
                      </button>
                    </div>
                  )}

                  <div className="py-1">
                    <button
                      onClick={() => {
                        setIsMenuOpen(false);
                        setIsDarkMode(!isDarkMode);
                      }}
                      className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                    >
                      {isDarkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
                      {isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
                    </button>
                    <button
                      onClick={() => {
                        setIsMenuOpen(false);
                        setIsAboutModalOpen(true);
                      }}
                      className="w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-3 cursor-pointer"
                    >
                      <Lock className="w-4 h-4 text-emerald-500" /> Security & Privacy Info
                    </button>
                    {pdfBytes && (
                      <button
                        onClick={() => {
                          setIsMenuOpen(false);
                          executeSecurePurge();
                        }}
                        className="w-full text-left px-4 py-2.5 text-xs font-extrabold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 flex items-center gap-3 cursor-pointer"
                      >
                        <ShieldAlert className="w-4 h-4" /> Purge Memory & Close
                      </button>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Adobe Style Top Menu Bar (Desktop - Left Aligned) */}
          <div ref={menuBarRef} className="relative hidden md:flex items-center gap-0.5">
            {(["file", "edit", "insert", "view", "help"] as const).map((menuName) => {
              const isDisabled = !pdfBytes && ["edit", "insert", "view"].includes(menuName);
              const isOpen = activeMenu === menuName && !isDisabled;
              const label = menuName.charAt(0).toUpperCase() + menuName.slice(1);
              return (
                <div key={menuName} className="relative">
                  <button
                    disabled={isDisabled}
                    onClick={() => {
                      if (isDisabled) return;
                      setActiveMenu(isOpen ? null : menuName);
                    }}
                    onMouseEnter={() => {
                      if (isDisabled) return;
                      if (activeMenu !== null && activeMenu !== menuName) {
                        setActiveMenu(menuName);
                      }
                    }}
                    title={isDisabled ? `Open or upload a PDF to enable ${label} menu` : undefined}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors select-none ${
                      isDisabled
                        ? "opacity-40 cursor-not-allowed pointer-events-none text-slate-400 dark:text-slate-500"
                        : isOpen
                        ? "bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white cursor-pointer"
                        : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/60 cursor-pointer"
                    }`}
                  >
                    {label}
                  </button>

                  <AnimatePresence>
                    {isOpen && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.96, y: -4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: -4 }}
                        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                        className="absolute left-0 mt-1 w-60 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden z-50 py-1 text-slate-800 dark:text-slate-200"
                      >
                      {menuName === "file" && (
                        <>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              fileInputRef.current?.click();
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Upload className="w-3.5 h-3.5 text-indigo-500" /> Open PDF...</span>
                            <kbd className="text-[10px] text-slate-400 font-mono">Ctrl+O</kbd>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsPdfMergeModalOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Layers className="w-3.5 h-3.5 text-indigo-500" /> Merge PDFs...</span>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsPdfCompressModalOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Maximize2 className="w-3.5 h-3.5 text-indigo-500" /> Compress PDF...</span>
                          </button>
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              setIsPageOrganizerOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer disabled:opacity-40"
                          >
                            <span className="flex items-center gap-2"><Grid className="w-3.5 h-3.5 text-indigo-500" /> Page Organizer & Reorder...</span>
                          </button>
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              setIsWatermarkModalOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer disabled:opacity-40"
                          >
                            <span className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-indigo-500" /> Watermark & Page Numbers...</span>
                          </button>
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              setIsSecurityModalOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer disabled:opacity-40"
                          >
                            <span className="flex items-center gap-2"><Lock className="w-3.5 h-3.5 text-emerald-500" /> Security & Sanitization...</span>
                          </button>
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              setIsFindAndRedactOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer disabled:opacity-40 text-rose-600 dark:text-rose-400 font-semibold"
                          >
                            <span className="flex items-center gap-2"><ShieldAlert className="w-3.5 h-3.5 text-rose-500" /> Find & Auto-Redact...</span>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              downloadFinishedPDF();
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              pdfBytes
                                ? "hover:bg-indigo-50 dark:hover:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 cursor-pointer font-bold"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><Download className="w-3.5 h-3.5" /> Save / Export PDF</span>
                            <kbd className="text-[10px] font-mono opacity-60">Ctrl+S</kbd>
                          </button>
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              exportPdf({ shareDirectly: true });
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              pdfBytes
                                ? "hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer text-slate-700 dark:text-slate-200"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><Share2 className="w-3.5 h-3.5 text-indigo-500" /> Native Mobile Share...</span>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            disabled={!pdfBytes && savedSignatures.length === 0}
                            onClick={() => {
                              setActiveMenu(null);
                              executeSecurePurge();
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              pdfBytes || savedSignatures.length > 0
                                ? "text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 cursor-pointer font-bold"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><ShieldAlert className="w-3.5 h-3.5" /> Purge & Exit</span>
                          </button>
                        </>
                      )}

                      {menuName === "edit" && (
                        <>
                          <button
                            disabled={history.currentIndex <= 0}
                            onClick={() => {
                              setActiveMenu(null);
                              undo();
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              history.currentIndex > 0
                                ? "hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><Undo className="w-3.5 h-3.5 text-indigo-500" /> Undo</span>
                            <kbd className="text-[10px] text-slate-400 font-mono">Ctrl+Z</kbd>
                          </button>
                          <button
                            disabled={history.currentIndex >= history.timeline.length - 1}
                            onClick={() => {
                              setActiveMenu(null);
                              redo();
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              history.currentIndex < history.timeline.length - 1
                                ? "hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><Redo className="w-3.5 h-3.5 text-indigo-500" /> Redo</span>
                            <kbd className="text-[10px] text-slate-400 font-mono">Ctrl+Y</kbd>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsSignatureModalOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><PenTool className="w-3.5 h-3.5 text-indigo-500" /> Manage Signatures...</span>
                          </button>
                          <button
                            disabled={annotations.length === 0}
                            onClick={() => {
                              setActiveMenu(null);
                              resetAnnotations([]);
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              annotations.length > 0
                                ? "hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><RotateCcw className="w-3.5 h-3.5 text-indigo-500" /> Clear All Annotations</span>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              setToolMode("redact");
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              pdfBytes
                                ? "hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-400 cursor-pointer"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><EyeOff className="w-3.5 h-3.5 text-rose-500" /> Redact Area (Blackout Tool)</span>
                          </button>
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              setIsFindAndRedactOpen(true);
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              pdfBytes
                                ? "hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-400 cursor-pointer font-bold"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><ShieldAlert className="w-3.5 h-3.5 text-rose-500" /> Find & Auto-Redact Patterns...</span>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              handleRotatePage(currentPage, "cw");
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              pdfBytes
                                ? "hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><RotateCw className="w-3.5 h-3.5 text-indigo-500" /> Rotate Page Clockwise</span>
                          </button>
                          <button
                            disabled={!pdfBytes}
                            onClick={() => {
                              setActiveMenu(null);
                              handleRotatePage(currentPage, "ccw");
                            }}
                            className={`w-full text-left px-3.5 py-2 text-xs font-medium flex items-center justify-between transition-colors ${
                              pdfBytes
                                ? "hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                                : "opacity-40 cursor-not-allowed"
                            }`}
                          >
                            <span className="flex items-center gap-2"><RotateCcw className="w-3.5 h-3.5 text-indigo-500" /> Rotate Page Counter-CW</span>
                          </button>
                        </>
                      )}

                      {menuName === "insert" && (
                        <>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setToolMode("text");
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Type className="w-3.5 h-3.5 text-indigo-500" /> Text Box</span>
                            <kbd className="text-[10px] text-slate-400 font-mono">Double Click</kbd>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setToolMode("draw");
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Edit3 className="w-3.5 h-3.5 text-indigo-500" /> Freehand Pen</span>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setToolMode("highlighter");
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Highlighter className="w-3.5 h-3.5 text-amber-500" /> Text Highlighter</span>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setToolMode("note");
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><MessageSquare className="w-3.5 h-3.5 text-amber-500" /> Sticky Comment Note</span>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setToolMode("shape");
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Square className="w-3.5 h-3.5 text-indigo-500" /> Shapes & Lines</span>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              triggerImageUpload();
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><ImageIcon className="w-3.5 h-3.5 text-indigo-500" /> Insert Image / Logo...</span>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setToolMode("redact");
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer text-rose-600 dark:text-rose-400"
                          >
                            <span className="flex items-center gap-2"><EyeOff className="w-3.5 h-3.5 text-rose-500" /> Permanent Redaction</span>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsFindAndRedactOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer text-rose-600 dark:text-rose-400 font-bold"
                          >
                            <span className="flex items-center gap-2"><ShieldAlert className="w-3.5 h-3.5 text-rose-500" /> Find & Auto-Redact Patterns...</span>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsSignatureModalOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><CheckSquare className="w-3.5 h-3.5 text-indigo-500" /> Signature Seal...</span>
                          </button>
                        </>
                      )}

                      {menuName === "view" && (
                        <>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsSidebarOpen(!isSidebarOpen);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Sidebar className="w-3.5 h-3.5 text-indigo-500" /> {isSidebarOpen ? "Hide Side Panel" : "Show Side Panel"}</span>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              handleZoomIn();
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><ZoomIn className="w-3.5 h-3.5 text-indigo-500" /> Zoom In</span>
                            <kbd className="text-[10px] text-slate-400 font-mono">+15%</kbd>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              handleZoomOut();
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><ZoomOut className="w-3.5 h-3.5 text-indigo-500" /> Zoom Out</span>
                            <kbd className="text-[10px] text-slate-400 font-mono">-15%</kbd>
                          </button>
                          <div className="border-t border-slate-100 dark:border-slate-700/80 my-1" />
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsDarkMode(!isDarkMode);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2">
                              {isDarkMode ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-indigo-500" />}
                              {isDarkMode ? "Light Mode" : "Dark Mode"}
                            </span>
                          </button>
                        </>
                      )}

                      {menuName === "help" && (
                        <>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsKeyboardHelpOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><HelpCircle className="w-3.5 h-3.5 text-indigo-500" /> Keyboard Shortcuts</span>
                          </button>
                          <button
                            onClick={() => {
                              setActiveMenu(null);
                              setIsAboutModalOpen(true);
                            }}
                            className="w-full text-left px-3.5 py-2 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-between transition-colors cursor-pointer"
                          >
                            <span className="flex items-center gap-2"><Lock className="w-3.5 h-3.5 text-emerald-500" /> Security & About</span>
                          </button>
                        </>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
          </div>
        </div>

        {/* Horizontally Centered Brand Logo & Title */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 sm:gap-2 shrink-0 select-none pointer-events-none sm:pointer-events-auto">
          <div className="bg-indigo-600 p-1.5 rounded-lg text-white shadow-xs">
            <Lock className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </div>
          <h1 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 tracking-tight leading-none whitespace-nowrap">
            Secure PDF
          </h1>
        </div>

        {/* Right-Aligned Top Bar Tools */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 z-10">
          <PdfSearch
            pdfDocProxy={pdfDocProxy}
            onNavigate={(page) => navigateToPage(page)}
            onOpenFindAndRedactModal={() => setIsFindAndRedactOpen(true)}
          />
        </div>
      </header>


      {/* Main Workspace Layout */}
      <main className="flex-1 min-h-0 w-full relative overflow-hidden flex">
        {/* Left Side Column Panel (Page Thumbnails - Adobe Acrobat style) */}
        {pdfBytes && isSidebarOpen && (
          <>
            {/* Mobile Drawer Backdrop */}
            <div
              className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs z-40 md:hidden"
              onClick={() => setIsSidebarOpen(false)}
            />
            <aside
              id="sidebar-left-thumbnails"
              className="fixed inset-y-0 left-0 z-50 w-64 md:static md:w-56 lg:w-64 bg-slate-50 dark:bg-slate-800/90 border-r border-slate-200 dark:border-slate-700 flex flex-col flex-shrink-0 h-full shadow-2xl md:shadow-xs transition-transform duration-200"
            >
            {/* Sidebar Header */}
            <div className="p-3.5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
              <div className="flex items-center gap-2">
                <Grid className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <h2 className="text-xs font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wider">
                  Page Thumbnails
                </h2>
                {numPages > 0 && (
                  <span className="text-[10px] font-bold bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded-full border border-indigo-100 dark:border-indigo-800/50">
                    {numPages}
                  </span>
                )}
              </div>
              <button
                onClick={() => setIsSidebarOpen(false)}
                title="Hide Side Panel"
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Thumbnails Container */}
            <div
              ref={sidebarContainerRef}
              className="flex-1 overflow-y-auto p-3 space-y-3 scroll-smooth"
            >
              {pdfDocProxy && numPages > 0 && (
                Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                  <motion.div
                    key={pageNum}
                    ref={(el) => { thumbnailRefs.current[pageNum] = el; }}
                    layout
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      type: "spring",
                      stiffness: 350,
                      damping: 28,
                    }}
                    className="relative"
                  >
                    <PageThumbnailCard
                      pageNumber={pageNum}
                      pdfDocProxy={pdfDocProxy}
                      isActive={currentPage === pageNum}
                      onClick={() => navigateToPage(pageNum)}
                      onDelete={(e) => {
                        e.stopPropagation();
                        handleDeletePages(pageNum.toString());
                      }}
                      onRotateCw={(e) => {
                        e.stopPropagation();
                        handleRotatePage(pageNum, "cw");
                      }}
                      onRotateCcw={(e) => {
                        e.stopPropagation();
                        handleRotatePage(pageNum, "ccw");
                      }}
                    />
                  </motion.div>
                ))
              )}
            </div>
          </aside>
        </>
        )}

        {/* Center Canvas Main Board & Tool Controls (Main Panel spacing) */}
        <section
          id="workspace-center-track"
          className="flex-1 min-h-0 w-full relative h-full flex flex-col overflow-hidden"
        >
          {/* Overlay Floating Controls */}
          {pdfBytes && (
            <>
              {/* Toolbar responsive positioning */}
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 md:top-1/2 md:-translate-y-1/2 md:bottom-auto md:left-auto md:translate-x-0 md:right-4 z-30 pointer-events-none max-w-[98vw] md:max-w-none">
                <Toolbar
                  activeMode={toolMode}
                  setMode={(mode) => {
                    setToolMode(mode);
                    setSelectedAnnotationId(null);
                  }}
                  textFontSize={textFontSize}
                  setTextFontSize={setTextFontSize}
                  textFontColor={textFontColor}
                  setTextFontColor={setTextFontColor}
                  textFontFamily={textFontFamily}
                  setTextFontFamily={setTextFontFamily}
                  activeStampType={activeStampType}
                  setActiveStampType={setActiveStampType}
                  activeShapeType={activeShapeType}
                  setActiveShapeType={setActiveShapeType}
                  highlighterColor={highlighterColor}
                  setHighlighterColor={setHighlighterColor}
                  highlighterWidth={highlighterWidth}
                  setHighlighterWidth={setHighlighterWidth}
                  inkColor={inkColor}
                  setInkColor={setInkColor}
                  inkWidth={inkWidth}
                  setInkWidth={setInkWidth}
                  onOpenSignatureModal={() => setIsSignatureModalOpen(true)}
                  onOpenFindAndRedactModal={() => setIsFindAndRedactOpen(true)}
                  onOpenWatermarkModal={() => setIsWatermarkModalOpen(true)}
                  onOpenPageOrganizer={() => setIsPageOrganizerOpen(true)}
                  onOpenSecurityModal={() => setIsSecurityModalOpen(true)}
                  onImageUpload={handleImageUpload}
                  savedSignaturesCount={savedSignatures.length}
                  onDeletePage={() => {
                    handleDeletePages(currentPage.toString());
                  }}
                />
              </div>

              {/* Desktop Unified Pagination & Zoom Bar (Middle-Bottom) */}
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 hidden md:flex items-center bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-slate-200/90 dark:border-slate-700/90 rounded-full shadow-xl px-2 py-1 pointer-events-auto transition-colors gap-1">
                <button
                  onClick={prevPage}
                  disabled={currentPage <= 1}
                  title="Previous Page"
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full text-slate-700 dark:text-slate-300 disabled:opacity-30 transition-colors cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300 px-2 min-w-[65px] text-center font-mono select-none">
                  {currentPage} / {numPages || "?"}
                </span>
                <button
                  onClick={nextPage}
                  disabled={currentPage >= numPages}
                  title="Next Page"
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full text-slate-700 dark:text-slate-300 disabled:opacity-30 transition-colors cursor-pointer"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>

                <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 shrink-0" />

                <button
                  onClick={handleZoomOut}
                  title="Zoom Out"
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button
                  onClick={handleZoomFit}
                  title="Fit to Screen"
                  className="text-xs font-mono font-bold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/40 px-2 py-0.5 rounded-md select-none min-w-[48px] text-center cursor-pointer transition-colors"
                >
                  {Math.round(zoomScale * 100)}%
                </button>
                <button
                  onClick={handleZoomIn}
                  title="Zoom In"
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
              </div>
            </>
          )}

          {/* Redaction Mode Top Helper Toast */}
          <AnimatePresence>
            {toolMode === "redact" && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-rose-200 dark:border-rose-800/80 rounded-2xl shadow-xl px-3.5 py-2 flex items-center gap-3 text-xs pointer-events-auto max-w-[94vw]"
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-rose-500 animate-ping shrink-0" />
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Redaction Mode
                  </span>
                </div>
                <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 shrink-0" />
                {isScanningSensitive ? (
                  <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5 text-[11px]">
                    <Loader2 className="w-3 h-3 text-rose-500 animate-spin" /> Scanning for sensitive patterns...
                  </span>
                ) : sensitiveHighlights.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <span className="text-rose-600 dark:text-rose-400 font-semibold text-[11px]">
                      {sensitiveHighlights.length} sensitive pattern{sensitiveHighlights.length > 1 ? "s" : ""} glowing
                    </span>
                    <button
                      onClick={handleRedactAllDetected}
                      className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg font-bold text-[10px] transition-colors cursor-pointer"
                    >
                      Redact All ({sensitiveHighlights.length})
                    </button>
                  </div>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400 text-[11px]">
                    Click glowing targets or draw a box to blackout sensitive info
                  </span>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Floating Page Change Indicator Pill (pops up on page change and fades out) */}
          <AnimatePresence>
            {showPageIndicator && pdfBytes && numPages > 0 && (
              <motion.div
                key={`page-pill-${currentPage}`}
                initial={{ opacity: 0, y: 20, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.95 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="fixed bottom-24 md:bottom-20 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-2 bg-slate-900/90 dark:bg-slate-800/95 backdrop-blur-md text-white px-4 py-2 rounded-full shadow-2xl border border-slate-700/60 dark:border-slate-600/80 text-xs font-mono font-bold tracking-wide select-none"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>
                  Page {currentPage} of {numPages}
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Core Interactive Sandbox Viewport Rendering Layer */}
          <div
            id="pdf-viewport-scroller"
            ref={viewportScrollerRef}
            onTouchStart={handleViewportTouchStart}
            onTouchMove={handleViewportTouchMove}
            onTouchEnd={handleViewportTouchEnd}
            onTouchCancel={handleViewportTouchEnd}
            className="flex-1 min-h-0 w-full relative overflow-auto bg-slate-100 dark:bg-slate-950 transition-colors overscroll-contain select-none flex flex-col no-scrollbar"
          >
            {pdfBytes ? (
              <div className="min-h-full min-w-full flex-1 flex items-center-safe justify-center-safe p-1 sm:p-2 md:p-3 pb-20 md:pb-12">
                <div className="flex items-center justify-center min-w-fit min-h-fit [perspective:1400px] relative shrink-0">
                  {/* Linked Gesture Neighbor Page Card */}
                  <div
                    ref={neighborCardRef}
                    id="neighbor-page-card-node"
                    className="pointer-events-none absolute inset-0 m-auto select-none shadow-2xl bg-white dark:bg-[#e2e8f0] border border-slate-300 dark:border-slate-600 rounded-xs will-change-transform z-20 overflow-hidden hidden"
                    style={{
                      width: canvasDimensions.width || 600,
                      height: canvasDimensions.height || 800,
                    }}
                  >
                    <img
                      ref={neighborImgRef}
                      alt="Neighbor page"
                      className="w-full h-full object-contain pointer-events-none select-none block"
                    />
                  </div>

                  <div
                    id="pdf-render-frame-container"
                    ref={pageContainerRef}
                onMouseDown={() => {
                  if (toolMode === "select" && selectedAnnotationId) {
                    setSelectedAnnotationId(null);
                  }
                }}
                onDoubleClick={(e) => {
                  if (toolMode === "text" || toolMode === "draw") return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickX_px = e.clientX - rect.left;
                  const clickY_px = e.clientY - rect.top;
                  const pdfX = clickX_px / scaleMultiplier;
                  const pdfY = clickY_px / scaleMultiplier;
                  const newTextAnn: AnnotationItem = {
                    id: `ann_text_${Date.now()}`,
                    type: "text",
                    pageNumber: currentPage,
                    x: pdfX - 10,
                    y: pdfY - 14,
                    width: 150,
                    height: 24,
                    text: "Type text here",
                    fontSize: textFontSize,
                    fontColor: textFontColor,
                    fontFamily: textFontFamily,
                    userResized: false,
                  };
                  dispatchAnnotationUpdate(
                    (prev) => [...prev, newTextAnn],
                    "Added text layer via double click",
                  );
                  setSelectedAnnotationId(newTextAnn.id);
                  setToolMode("select");
                  addLog("Placed editable text block layer on page.", "info");
                }}
                className="relative shadow-2xl bg-white dark:bg-[#e2e8f0] border border-slate-300 dark:border-slate-600 rounded-xs select-none scale-100 transition-colors origin-center dark:brightness-90 will-change-transform"
                style={{
                  width: canvasDimensions.width,
                  height: canvasDimensions.height,
                }}
              >
                {/* Dynamic 3D Page Fold Crease & Lighting Sheen Overlay */}
                <div
                  ref={pageFoldOverlayRef}
                  id="page-fold-lighting-overlay"
                  className="pointer-events-none absolute inset-0 z-40 rounded-xs opacity-0 transition-opacity"
                  aria-hidden="true"
                />

                <canvas
                  id="pdf-canvas-frame-node"
                  ref={canvasRef}
                  className="absolute inset-0 select-none pointer-events-none"
                />

                <div
                  ref={xfaLayerRef}
                  className="xfaLayer absolute inset-0 select-none"
                />

                <div
                  ref={annotationLayerRef}
                  className="annotationLayer absolute inset-0"
                />

                {/* Annotation Overlay Wrapper */}
                <div
                  id="annotation-interactive-overlay"
                  ref={overlayRef}
                  onClick={handleOverlayClick}
                  onMouseDown={(e) => {
                    handleInkStart(e);
                    handleRedactStart(e);
                  }}
                  onMouseMove={(e) => {
                    handleInkMove(e);
                    handleRedactMove(e);
                  }}
                  onMouseUp={(e) => {
                    handleInkEnd();
                    handleRedactEnd();
                  }}
                  onMouseLeave={(e) => {
                    handleInkEnd();
                    handleRedactEnd();
                  }}
                  onTouchStart={(e) => {
                    if (toolMode === "draw" || toolMode === "highlighter" || toolMode === "redact") {
                      handleInkStart(e);
                      handleRedactStart(e);
                    }
                  }}
                  onTouchMove={(e) => {
                    if (toolMode === "draw" || toolMode === "highlighter" || toolMode === "redact") {
                      handleInkMove(e);
                      handleRedactMove(e);
                    }
                  }}
                  onTouchEnd={() => {
                    if (toolMode === "draw" || toolMode === "highlighter" || toolMode === "redact") {
                      handleInkEnd();
                      handleRedactEnd();
                    }
                  }}
                  onTouchCancel={() => {
                    if (toolMode === "draw" || toolMode === "highlighter" || toolMode === "redact") {
                      handleInkEnd();
                      handleRedactEnd();
                    }
                  }}
                  className={`absolute inset-0 select-none ${
                    toolMode === "select"
                      ? "pointer-events-none"
                      : "pointer-events-auto"
                  } ${
                    toolMode === "draw" || toolMode === "redact"
                      ? "cursor-crosshair touch-none"
                      : "cursor-default"
                  }`}
                >
                  {/* Sensitive pattern glow highlights for smart targeting */}
                  {toolMode === "redact" &&
                    sensitiveHighlights.map((det) => {
                      const alreadyRedacted = annotations.some(
                        (ann) =>
                          ann.type === "redact" &&
                          ann.pageNumber === currentPage &&
                          Math.abs(ann.x - det.x) < 8 &&
                          Math.abs(ann.y - det.y) < 8
                      );
                      if (alreadyRedacted) return null;

                      return (
                        <div
                          key={det.id}
                          id={`glow-redact-${det.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            const newRedactAnn: AnnotationItem = {
                              id: `ann_redact_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
                              type: "redact",
                              pageNumber: currentPage,
                              x: det.x,
                              y: det.y,
                              width: det.width,
                              height: det.height,
                            };
                            dispatchAnnotationUpdate(
                              (prev) => [...prev, newRedactAnn],
                              `Redacted ${det.label}`
                            );
                            addLog(
                              `Redacted suspected sensitive ${det.label} "${det.text}"`,
                              "security"
                            );
                            triggerHaptic("medium");
                          }}
                          style={{
                            left: det.x * scaleMultiplier,
                            top: det.y * scaleMultiplier,
                            width: det.width * scaleMultiplier,
                            height: det.height * scaleMultiplier,
                          }}
                          className="absolute z-20 cursor-pointer pointer-events-auto rounded-[3px] border-2 border-rose-500 bg-rose-500/25 shadow-[0_0_14px_rgba(244,63,94,0.85)] hover:bg-rose-500/50 hover:shadow-[0_0_22px_rgba(244,63,94,1)] hover:scale-[1.02] transition-all animate-pulse flex items-center justify-center group"
                          title={`Suspected ${det.label}: "${det.text}". Click to redact immediately.`}
                        >
                          <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute -top-6 left-1/2 -translate-x-1/2 bg-slate-900/95 text-rose-300 text-[10px] font-bold px-2 py-0.5 rounded-md shadow-lg border border-rose-500/40 whitespace-nowrap pointer-events-none z-30 flex items-center gap-1">
                            <ShieldAlert className="w-2.5 h-2.5 text-rose-400" />
                            Click to Redact {det.label}
                          </span>
                        </div>
                      );
                    })}

                  {/* Visual SVG Ink Segment tracker renderer for freehand */}
                  <svg
                    className="absolute inset-0 pointer-events-none select-none z-20 w-full h-full"
                    width="100%"
                    height="100%"
                  >
                    {/* Render currently drawing stroke */}
                    {isDrawingInk && currentInkPoints.length > 1 && (
                      <path
                        d={currentInkPoints
                          .map(
                            (p, idx) =>
                              `${idx === 0 ? "M" : "L"} ${p.x * scaleMultiplier} ${p.y * scaleMultiplier}`,
                          )
                          .join(" ")}
                        fill="none"
                        stroke={toolMode === "highlighter" ? highlighterColor : inkColor}
                        strokeWidth={
                          (toolMode === "highlighter" ? highlighterWidth : inkWidth) *
                          scaleMultiplier
                        }
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={toolMode === "highlighter" ? 0.45 : 1}
                      />
                    )}

                    {/* Render currently drawing redact rect */}
                    {isDrawingRedact && redactStart && redactCurrent && (
                      <rect
                        x={
                          Math.min(redactStart.x, redactCurrent.x) *
                          scaleMultiplier
                        }
                        y={
                          Math.min(redactStart.y, redactCurrent.y) *
                          scaleMultiplier
                        }
                        width={
                          Math.abs(redactStart.x - redactCurrent.x) *
                          scaleMultiplier
                        }
                        height={
                          Math.abs(redactStart.y - redactCurrent.y) *
                          scaleMultiplier
                        }
                        fill="#000000"
                        className="opacity-75"
                      />
                    )}

                    {/* Render saved drawing stroke layers on current page */}
                    {annotations
                      .filter(
                        (ann) =>
                          ann.type === "drawing" &&
                          ann.pageNumber === currentPage,
                      )
                      .map((ann) => {
                        if (
                          !ann.drawingPoints ||
                          ann.drawingPoints.length === 0
                        )
                          return null;
                        const pathD = ann.drawingPoints
                          .map(
                            (p, idx) =>
                              `${idx === 0 ? "M" : "L"} ${p.x * scaleMultiplier} ${p.y * scaleMultiplier}`,
                          )
                          .join(" ");
                        const isSel = selectedAnnotationId === ann.id;
                        return (
                          <g
                            key={ann.id}
                            onClick={(e) => {
                              if (toolMode === "select") {
                                e.stopPropagation();
                                setSelectedAnnotationId(ann.id);
                              }
                            }}
                            className="pointer-events-auto cursor-pointer"
                          >
                            <path
                              d={pathD}
                              fill="none"
                              stroke={ann.drawingColor || "#000"}
                              strokeWidth={
                                (ann.drawingWidth || 3) * scaleMultiplier
                              }
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              opacity={ann.isHighlighter ? 0.45 : 1}
                              className={
                                isSel
                                  ? "stroke-indigo-500 drop-shadow-md"
                                  : "hover:stroke-slate-400"
                              }
                            />
                            {isSel && (
                              <foreignObject
                                x={ann.x * scaleMultiplier - 10}
                                y={ann.y * scaleMultiplier - 30}
                                width={60}
                                height={24}
                              >
                                <button
                                  id={`del-draw-${ann.id}`}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    handleDeleteAnnotation(ann.id);
                                  }}
                                  className="text-[9px] bg-rose-600 hover:bg-rose-500 text-white rounded p-0.5 px-1.5 leading-none shadow-xs font-bold"
                                >
                                  Wipe
                                </button>
                              </foreignObject>
                            )}
                          </g>
                        );
                      })}
                  </svg>

                  {/* Render draggable signature and text boxes */}
                  {annotations
                    .filter(
                      (ann) =>
                        ann.type !== "drawing" &&
                        ann.pageNumber === currentPage,
                    )
                    .map((ann) => renderDraggableAnnotation(ann))}
                </div>
              </div>
            </div>
          </div>
          ) : (
              <div className="min-h-full min-w-full flex-1 flex items-center justify-center p-8">
                <div
                  id="unloaded-blank-prompt"
                  className="flex flex-col items-center justify-center text-center max-w-sm"
                >
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    title="Click to select PDF file"
                    className="w-20 h-20 bg-indigo-50 dark:bg-indigo-900/40 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 border-2 border-indigo-200 dark:border-indigo-700/60 text-indigo-600 dark:text-indigo-400 rounded-3xl flex items-center justify-center mb-5 shadow-lg hover:scale-105 active:scale-95 transition-all cursor-pointer group"
                  >
                    <Upload className="w-10 h-10 animate-pulse group-hover:animate-none" />
                  </button>
                  <h3 className="font-sans font-bold text-lg text-slate-800 dark:text-slate-200 mb-2">
                    No Private Document Active
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-5">
                    Upload a standard PDF locally from your device to begin editing and signing securely.
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl shadow-md transition-all hover:scale-105 cursor-pointer inline-flex items-center gap-2"
                  >
                    <Upload className="w-4 h-4" /> Open PDF...
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right Action & Elements Setting Control (Activates only when element is selected) */}
          {selectedAnnotationId && (
            <div
              id="selection-adjuster-panel"
              className="absolute bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-30 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-indigo-200 dark:border-indigo-700/80 rounded-2xl p-2.5 sm:p-3 flex items-center justify-between gap-3 shadow-2xl transition-colors max-w-[92vw] pointer-events-auto"
            >
              <div className="flex items-center space-x-2 sm:space-x-3">
                <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <div>
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wide">
                    Element Selected
                  </div>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono font-bold">
                    ID: {selectedAnnotationId.slice(0, 14)}...
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  id="deselect-annotation-btn"
                  onClick={() => setSelectedAnnotationId(null)}
                  className="text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100 px-2.5 py-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg transition-colors cursor-pointer border border-slate-200 dark:border-slate-600 text-[11px]"
                >
                  Dismiss
                </button>
                <button
                  id="delete-selected-annotation-btn"
                  onClick={() => handleDeleteAnnotation(selectedAnnotationId)}
                  className="text-xs font-bold bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800/50 hover:bg-rose-100 dark:hover:bg-rose-900/50 p-1 px-2.5 rounded-lg transition-all flex items-center cursor-pointer text-[11px]"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  Delete
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Footer - Hidden on mobile devices to prevent taking up screen space */}
      <footer className="hidden md:block bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 py-2.5 text-center transition-colors shrink-0">
        <div className="max-w-7xl mx-auto px-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            🔒{" "}
            <strong className="text-slate-700 dark:text-slate-300">
              Secure Environment:
            </strong>{" "}
            All processing is performed locally on your device.
          </p>
        </div>
      </footer>

      {/* Shape Customization Context Menu */}
      <AnimatePresence>
        {shapeContextMenu && (() => {
        const activeShape = annotations.find(
          (a) => a.id === shapeContextMenu.annId,
        );
        if (!activeShape || activeShape.type !== "shape") return null;

        const shapeType = activeShape.shapeType || "rectangle";
        const hasFill =
          activeShape.hasFill !== false &&
          activeShape.shapeFillColor !== "transparent" &&
          activeShape.shapeFillColor !== "none";
        const fillColor = activeShape.shapeFillColor || "#ffffff";

        const hasStroke =
          activeShape.hasStroke !== false &&
          (activeShape.shapeStrokeWidth ?? 2) > 0;
        const strokeColor = activeShape.shapeStrokeColor || "#000000";
        const strokeWidth = activeShape.shapeStrokeWidth ?? 2;

        const updateShape = (updates: Partial<AnnotationItem>) => {
          dispatchAnnotationUpdate(
            (prev) =>
              prev.map((item) =>
                item.id === activeShape.id ? { ...item, ...updates } : item,
              ),
            "Updated shape properties",
          );
        };

        const menuWidth = 260;
        const menuHeight = 340;
        const posX = Math.min(
          Math.max(10, shapeContextMenu.x),
          window.innerWidth - menuWidth - 10,
        );
        const posY = Math.min(
          Math.max(10, shapeContextMenu.y),
          window.innerHeight - menuHeight - 10,
        );

        const fillPresets = [
          { name: "White", hex: "#ffffff" },
          { name: "Yellow", hex: "#fef08a" },
          { name: "Blue", hex: "#bfdbfe" },
          { name: "Green", hex: "#bbf7d0" },
          { name: "Red", hex: "#fecaca" },
          { name: "Gray", hex: "#e2e8f0" },
          { name: "Black", hex: "#000000" },
        ];

        const strokePresets = [
          { name: "Black", hex: "#000000" },
          { name: "Red", hex: "#ef4444" },
          { name: "Blue", hex: "#3b82f6" },
          { name: "Green", hex: "#22c55e" },
          { name: "Amber", hex: "#f59e0b" },
          { name: "Gray", hex: "#64748b" },
          { name: "White", hex: "#ffffff" },
        ];

        return (
          <motion.div
            key="shape-context-menu-popover"
            initial={{ opacity: 0, scale: 0.95, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 6 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            className="fixed z-50 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl p-4 w-64 text-slate-800 dark:text-slate-100"
            style={{ left: posX, top: posY }}
          >
            {/* Title Header */}
            <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-100 dark:border-slate-700">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5" /> Shape Options
              </span>
              <button
                onClick={() => setShapeContextMenu(null)}
                className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 rounded-md cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* 1. Shape Type Selection */}
            <div className="mb-3 space-y-1">
              <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                Shape Type
              </label>
              <div className="grid grid-cols-3 gap-1 bg-slate-100 dark:bg-slate-900 p-1 rounded-xl">
                <button
                  onClick={() => updateShape({ shapeType: "rectangle" })}
                  className={`flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    shapeType === "rectangle"
                      ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
                      : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  <Square className="w-3.5 h-3.5" /> Rect
                </button>
                <button
                  onClick={() => updateShape({ shapeType: "circle" })}
                  className={`flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    shapeType === "circle"
                      ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
                      : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  <Circle className="w-3.5 h-3.5" /> Circle
                </button>
                <button
                  onClick={() => updateShape({ shapeType: "line" })}
                  className={`flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    shapeType === "line"
                      ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-xs"
                      : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  <Minus className="w-3.5 h-3.5" /> Line
                </button>
              </div>
            </div>

            {/* 2. Fill Control */}
            {shapeType !== "line" && (
              <div className="mb-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                    Fill Color
                  </span>
                  <button
                    onClick={() => updateShape({ hasFill: !hasFill })}
                    className={`text-[10px] font-extrabold px-2 py-0.5 rounded-md cursor-pointer transition-colors ${
                      hasFill
                        ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300"
                        : "bg-slate-100 text-slate-400 dark:bg-slate-700 dark:text-slate-400"
                    }`}
                  >
                    {hasFill ? "ENABLED" : "NO FILL"}
                  </button>
                </div>

                {hasFill && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    {fillPresets.map((preset) => (
                      <button
                        key={preset.hex}
                        onClick={() =>
                          updateShape({
                            shapeFillColor: preset.hex,
                            hasFill: true,
                          })
                        }
                        className={`w-5 h-5 rounded-full border border-slate-300 dark:border-slate-600 cursor-pointer transition-transform ${
                          fillColor.toLowerCase() === preset.hex.toLowerCase()
                            ? "ring-2 ring-indigo-500 scale-110"
                            : "hover:scale-105"
                        }`}
                        style={{ backgroundColor: preset.hex }}
                        title={preset.name}
                      />
                    ))}
                    <input
                      type="color"
                      value={fillColor.startsWith("#") ? fillColor : "#ffffff"}
                      onChange={(e) =>
                        updateShape({
                          shapeFillColor: e.target.value,
                          hasFill: true,
                        })
                      }
                      className="w-5 h-5 rounded-full border-0 p-0 bg-transparent cursor-pointer"
                      title="Custom color"
                    />
                  </div>
                )}
              </div>
            )}

            {/* 3. Stroke Control */}
            <div className="mb-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  Stroke Outline
                </span>
                <button
                  onClick={() => updateShape({ hasStroke: !hasStroke })}
                  className={`text-[10px] font-extrabold px-2 py-0.5 rounded-md cursor-pointer transition-colors ${
                    hasStroke
                      ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300"
                      : "bg-slate-100 text-slate-400 dark:bg-slate-700 dark:text-slate-400"
                  }`}
                >
                  {hasStroke ? "ENABLED" : "NO STROKE"}
                </button>
              </div>

              {hasStroke && (
                <div className="space-y-2 pt-0.5">
                  {/* Stroke Width Selector */}
                  <div className="flex items-center justify-between gap-1">
                    {[1, 2, 4, 6].map((w) => (
                      <button
                        key={w}
                        onClick={() =>
                          updateShape({ shapeStrokeWidth: w, hasStroke: true })
                        }
                        className={`flex-1 py-1 text-[10px] font-bold rounded-md border transition-all cursor-pointer ${
                          strokeWidth === w
                            ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300"
                            : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700"
                        }`}
                      >
                        {w}px
                      </button>
                    ))}
                  </div>

                  {/* Stroke Color presets */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {strokePresets.map((preset) => (
                      <button
                        key={preset.hex}
                        onClick={() =>
                          updateShape({
                            shapeStrokeColor: preset.hex,
                            hasStroke: true,
                          })
                        }
                        className={`w-5 h-5 rounded-full border border-slate-300 dark:border-slate-600 cursor-pointer transition-transform ${
                          strokeColor.toLowerCase() === preset.hex.toLowerCase()
                            ? "ring-2 ring-indigo-500 scale-110"
                            : "hover:scale-105"
                        }`}
                        style={{ backgroundColor: preset.hex }}
                        title={preset.name}
                      />
                    ))}
                    <input
                      type="color"
                      value={
                        strokeColor.startsWith("#") ? strokeColor : "#000000"
                      }
                      onChange={(e) =>
                        updateShape({
                          shapeStrokeColor: e.target.value,
                          hasStroke: true,
                        })
                      }
                      className="w-5 h-5 rounded-full border-0 p-0 bg-transparent cursor-pointer"
                      title="Custom stroke color"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 4. Delete Action */}
            <div className="pt-2 border-t border-slate-100 dark:border-slate-700">
              <button
                onClick={() => {
                  handleDeleteAnnotation(activeShape.id);
                  setShapeContextMenu(null);
                }}
                className="w-full py-1.5 bg-rose-50 hover:bg-rose-100 dark:bg-rose-900/30 dark:hover:bg-rose-900/50 text-rose-600 dark:text-rose-400 rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete Shape
              </button>
            </div>
          </motion.div>
        );
      })()}
      </AnimatePresence>
    </div>
  );
}

export default MainPdfEditor;

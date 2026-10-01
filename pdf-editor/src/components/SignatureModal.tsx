import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Pen,
  Type,
  Upload,
  Eraser,
  Smartphone,
  Check,
  X,
  Sparkles,
  QrCode,
  Trash2,
  Undo,
  RotateCcw,
  Palette,
} from "lucide-react";
import { SavedSignature } from "../types";
import { triggerHaptic } from "../lib/haptics";

interface SignatureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (sig: SavedSignature) => void;
  savedSignatures?: SavedSignature[];
  onDeleteSavedSignature?: (id: string) => void;
}

export default function SignatureModal({
  isOpen,
  onClose,
  onSave,
  savedSignatures = [],
  onDeleteSavedSignature,
}: SignatureModalProps) {
  const [activeTab, setActiveTab] = useState<
    "draw" | "type" | "upload" | "saved"
  >("draw");
  const [typedText, setTypedText] = useState("");
  const [selectedFont, setSelectedFont] = useState("'Great Vibes', cursive");
  const [penColor, setPenColor] = useState("#0d1117");
  const [lineWidth, setLineWidth] = useState(3.5);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [removeBgThreshold, setRemoveBgThreshold] = useState(200);

  // Canvas refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastXRef = useRef(0);
  const lastYRef = useRef(0);
  const strokeHistoryRef = useRef<ImageData[]>([]);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const signatureFonts = [
    { name: "Great Vibes", family: "'Great Vibes', cursive", sample: "Great Vibes" },
    { name: "Dancing Script", family: "'Dancing Script', cursive", sample: "Dancing Script" },
    { name: "Caveat", family: "'Caveat', cursive", sample: "Caveat" },
    { name: "Sacramento", family: "'Sacramento', cursive", sample: "Sacramento" },
    { name: "Pacifico", family: "'Pacifico', cursive", sample: "Pacifico" },
    { name: "Satisfy", family: "'Satisfy', cursive", sample: "Satisfy" },
  ];

  const inkColors = [
    { name: "Black", hex: "#0d1117" },
    { name: "Navy Blue", hex: "#1d4ed8" },
    { name: "Crimson", hex: "#be123c" },
    { name: "Emerald", hex: "#047857" },
  ];

  // Start over each time it is opened.
  useEffect(() => {
    if (!isOpen) {
      setActiveTab("draw");
      setUploadedImage(null);
    }
  }, [isOpen]);

  // Setup canvas
  useEffect(() => {
    if (activeTab === "draw" && canvasRef.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = penColor;
        ctx.lineWidth = lineWidth;
      }
    }
  }, [activeTab, penColor, lineWidth]);

  if (!isOpen) return null;

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Save state for undo
    strokeHistoryRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));

    isDrawingRef.current = true;
    const rect = canvas.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;

    const x = ((clientX - rect.left) / rect.width) * canvas.width;
    const y = ((clientY - rect.top) / rect.height) * canvas.height;

    lastXRef.current = x;
    lastYRef.current = y;

    ctx.beginPath();
    ctx.arc(x, y, lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = penColor;
    ctx.fill();
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;

    const x = ((clientX - rect.left) / rect.width) * canvas.width;
    const y = ((clientY - rect.top) / rect.height) * canvas.height;

    ctx.beginPath();
    ctx.moveTo(lastXRef.current, lastYRef.current);
    ctx.lineTo(x, y);
    ctx.strokeStyle = penColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    lastXRef.current = x;
    lastYRef.current = y;
  };

  const stopDrawing = () => {
    isDrawingRef.current = false;
  };

  const clearCanvas = () => {
    triggerHaptic("light");
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokeHistoryRef.current = [];
  };

  const undoLastStroke = () => {
    triggerHaptic("light");
    const canvas = canvasRef.current;
    if (!canvas || strokeHistoryRef.current.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const prev = strokeHistoryRef.current.pop();
    if (prev) {
      ctx.putImageData(prev, 0, 0);
    }
  };

  // Handle uploaded image background knockout
  const processUploadedImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imgData.data;

          // Transparent background knockout
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const brightness = (r + g + b) / 3;

            // If bright (white/gray paper), make transparent
            if (brightness > removeBgThreshold) {
              data[i + 3] = 0;
            } else {
              // Darken pen ink
              data[i] = Math.min(r, 20);
              data[i + 1] = Math.min(g, 20);
              data[i + 2] = Math.min(b, 20);
            }
          }

          ctx.putImageData(imgData, 0, 0);
          setUploadedImage(canvas.toDataURL("image/png"));
        }
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  // Generate image from Typed text
  const generateTypedSignature = (): string => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `64px ${selectedFont}`;
    ctx.fillStyle = penColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(typedText || "Signature", canvas.width / 2, canvas.height / 2);

    return canvas.toDataURL("image/png");
  };

  const handleCompleteSave = () => {
    triggerHaptic("success");
    let dataUrl = "";
    let label = "Handwritten Signature";

    if (activeTab === "draw") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      dataUrl = canvas.toDataURL("image/png");
      label = `Drawn Signature (${new Date().toLocaleTimeString()})`;
    } else if (activeTab === "type") {
      if (!typedText.trim()) return;
      dataUrl = generateTypedSignature();
      label = `Typed: ${typedText}`;
    } else if (activeTab === "upload") {
      if (!uploadedImage) return;
      dataUrl = uploadedImage;
      label = "Uploaded Signature";
    }

    if (dataUrl) {
      const newSig: SavedSignature = {
        id: `sig_${Date.now()}`,
        dataUrl,
        label,
        createdAt: new Date().toLocaleTimeString(),
      };
      onSave(newSig);
      onClose();
    }
  };


  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            key="sig-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/75 backdrop-blur-md"
          />
          <motion.div
            key="sig-modal"
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl max-w-lg w-full shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
          >
            {/* Header */}
            <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-cyan-50 dark:bg-cyan-950 text-cyan-600 dark:text-cyan-400">
                  <Pen className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-bold text-sm sm:text-base text-slate-900 dark:text-white">
                    Create Digital Signature
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    100% vector-sharp, legal client-side digital signatures
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

        {/* Tab Selection */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 p-1.5 gap-1 overflow-x-auto no-scrollbar">
          {[
            { id: "draw", label: "Draw", icon: <Pen className="w-4 h-4" /> },
            { id: "type", label: "Type", icon: <Type className="w-4 h-4" /> },
            { id: "upload", label: "Upload", icon: <Upload className="w-4 h-4" /> },
            ...(savedSignatures.length > 0
              ? [{ id: "saved", label: `Saved (${savedSignatures.length})`, icon: <Sparkles className="w-4 h-4" /> }]
              : []),
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                triggerHaptic("light");
                setActiveTab(tab.id as any);
              }}
              className={`flex-1 min-h-[44px] py-2.5 px-2 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 shrink-0 cursor-pointer ${
                activeTab === tab.id
                  ? "bg-white dark:bg-slate-800 text-cyan-600 dark:text-cyan-400 shadow-sm"
                  : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-1 text-xs">
          {/* 1. DRAW TAB */}
          {activeTab === "draw" && (
            <div className="space-y-3">
              {/* Canvas controls */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-400 uppercase">Ink:</span>
                  {inkColors.map((clr) => (
                    <button
                      key={clr.hex}
                      onClick={() => setPenColor(clr.hex)}
                      className={`w-7 h-7 rounded-full border border-black/20 cursor-pointer transition-transform ${
                        penColor === clr.hex ? "ring-2 ring-cyan-500 scale-110 shadow-xs" : ""
                      }`}
                      style={{ backgroundColor: clr.hex }}
                    />
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={undoLastStroke}
                    className="min-h-[36px] px-2.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl flex items-center gap-1.5 font-bold text-xs cursor-pointer border border-slate-200 dark:border-slate-700"
                  >
                    <Undo className="w-4 h-4" />
                    <span>Undo</span>
                  </button>
                  <button
                    onClick={clearCanvas}
                    className="min-h-[36px] px-2.5 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl flex items-center gap-1.5 font-bold text-xs cursor-pointer border border-rose-200/80 dark:border-rose-900/50"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Clear</span>
                  </button>
                </div>
              </div>

              {/* Drawing Board */}
              <div className="relative rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 h-48 overflow-hidden touch-none">
                <canvas
                  ref={canvasRef}
                  width={500}
                  height={200}
                  onMouseDown={startDrawing}
                  onMouseMove={draw}
                  onMouseUp={stopDrawing}
                  onMouseLeave={stopDrawing}
                  onTouchStart={startDrawing}
                  onTouchMove={draw}
                  onTouchEnd={stopDrawing}
                  className="w-full h-full cursor-crosshair"
                />
                <div className="absolute bottom-2 right-3 text-[10px] font-mono text-slate-400 select-none pointer-events-none">
                  Sign on line above
                </div>
              </div>
            </div>
          )}

          {/* 2. TYPE TAB */}
          {activeTab === "type" && (
            <div className="space-y-4">
              <div>
                <label className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                  Type Your Name
                </label>
                <input
                  type="text"
                  value={typedText}
                  onChange={(e) => setTypedText(e.target.value)}
                  placeholder="e.g. Johnathan Doe"
                  className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-bold text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              {/* Ink color */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-slate-500">Color:</span>
                {inkColors.map((clr) => (
                  <button
                    key={clr.hex}
                    onClick={() => setPenColor(clr.hex)}
                    className={`w-6 h-6 rounded-full border border-black/20 ${
                      penColor === clr.hex ? "ring-2 ring-cyan-500 scale-110" : ""
                    }`}
                    style={{ backgroundColor: clr.hex }}
                  />
                ))}
              </div>

              {/* Font Choice List */}
              <div className="space-y-2">
                <label className="font-bold text-slate-700 dark:text-slate-300 block">
                  Select Calligraphy Style
                </label>
                <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                  {signatureFonts.map((f) => (
                    <button
                      key={f.name}
                      onClick={() => {
                        triggerHaptic("light");
                        setSelectedFont(f.family);
                      }}
                      className={`p-3 rounded-2xl border text-center transition-all ${
                        selectedFont === f.family
                          ? "bg-cyan-50 dark:bg-cyan-950/60 border-cyan-500 text-cyan-700 dark:text-cyan-300 shadow-xs"
                          : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 text-slate-700 dark:text-slate-300 hover:bg-slate-100"
                      }`}
                    >
                      <div
                        style={{ fontFamily: f.family, color: penColor }}
                        className="text-xl sm:text-2xl py-1 truncate dark:!text-white"
                      >
                        {typedText || f.sample}
                      </div>
                      <div className="text-[10px] text-slate-400 dark:text-slate-300">{f.name}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 3. UPLOAD TAB */}
          {activeTab === "upload" && (
            <div className="space-y-3">
              <input
                ref={uploadInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    processUploadedImage(e.target.files[0]);
                  }
                }}
                className="hidden"
              />

              {!uploadedImage ? (
                <div
                  onClick={() => uploadInputRef.current?.click()}
                  className="p-8 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-cyan-500 transition-colors"
                >
                  <Upload className="w-8 h-8 text-cyan-500" />
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Upload Photo of Signature
                  </span>
                  <span className="text-[11px] text-slate-400 text-center">
                    JPG, PNG or photo of signed paper. Background will be automatically made transparent!
                  </span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 flex items-center justify-center h-36">
                    <img
                      src={uploadedImage}
                      alt="Uploaded Signature"
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => uploadInputRef.current?.click()}
                      className="text-cyan-600 font-bold hover:underline"
                    >
                      Choose Different Photo
                    </button>
                    <button
                      onClick={() => setUploadedImage(null)}
                      className="text-rose-600 font-bold hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 5. SAVED TAB */}
          {activeTab === "saved" && (
            <div className="space-y-2">
              <label className="font-bold text-slate-700 dark:text-slate-300 block">
                Saved Signatures Library
              </label>
              <div className="space-y-2 max-h-52 overflow-y-auto">
                {savedSignatures.map((sig) => (
                  <div
                    key={sig.id}
                    className="p-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 flex items-center justify-between gap-3 hover:border-cyan-500 transition-colors"
                  >
                    <div
                      onClick={() => {
                        triggerHaptic("success");
                        onSave(sig);
                        onClose();
                      }}
                      className="flex-1 flex items-center gap-3 cursor-pointer"
                    >
                      <div className="h-10 w-24 bg-white rounded-lg p-1 border border-slate-200 flex items-center justify-center">
                        <img
                          src={sig.dataUrl}
                          alt="Signature"
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                      <div className="text-left">
                        <div className="font-bold text-slate-800 dark:text-slate-200 truncate max-w-[150px]">
                          {sig.label}
                        </div>
                        <div className="text-[10px] text-slate-400">{sig.createdAt}</div>
                      </div>
                    </div>

                    {onDeleteSavedSignature && (
                      <button
                        onClick={() => {
                          triggerHaptic("warning");
                          onDeleteSavedSignature(sig.id);
                        }}
                        className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 flex items-center justify-end gap-2.5">
          <button
            onClick={onClose}
            className="min-h-[44px] px-4 py-2 text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
          >
            Cancel
          </button>
          {activeTab !== "saved" && (
            <button
              onClick={handleCompleteSave}
              className="min-h-[44px] px-5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-extrabold rounded-xl shadow-md transition-transform active:scale-95 flex items-center gap-2 cursor-pointer"
            >
              <Check className="w-4.5 h-4.5" />
              <span>Use Signature</span>
            </button>
          )}
        </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

import React, { useState, useEffect, useRef } from "react";
import { X, Upload, File as FileIcon, Download, Settings2 } from "lucide-react";
// The legacy build: the modern one uses JavaScript too new for many phones (and for
// the Chromium Autora ships).
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { setupPdfJs, PDFJS_DATA } from "../lib/pdfjs";
import { PDFDocument } from "pdf-lib";

setupPdfJs(pdfjsLib);

interface PdfCompressModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function PdfCompressModal({ isOpen, onClose }: PdfCompressModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [quality, setQuality] = useState(50);
  const [pdfDocProxy, setPdfDocProxy] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [estimatedSizeMb, setEstimatedSizeMb] = useState<number | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setFile(null);
      setPdfDocProxy(null);
      setPreviewDataUrl(null);
      setEstimatedSizeMb(null);
      setQuality(50);
      setIsCompressing(false);
      canvasRef.current = null;
    }
  }, [isOpen]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setIsLoadingFile(true);

    try {
      const arrayBuffer = await selected.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ 
        data: arrayBuffer,
        cMapUrl: PDFJS_DATA.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: PDFJS_DATA.standardFontDataUrl,
      });
      const doc = await loadingTask.promise;
      setPdfDocProxy(doc);

      // Render first page to our hidden canvas
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext("2d")!;
      
      // Fill white background
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport } as any).promise;
      canvasRef.current = canvas;
      
      updatePreview(canvas, 50, doc.numPages);
    } catch (err) {
      console.error("Error loading PDF for compression:", err);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const updatePreview = (canvas: HTMLCanvasElement, q: number, numPages: number) => {
    const dataUrl = canvas.toDataURL("image/jpeg", q / 100);
    setPreviewDataUrl(dataUrl);
    
    // Estimate size
    // Data URL is base64, so it's ~33% larger than binary.
    const base64Length = dataUrl.length - 'data:image/jpeg;base64,'.length;
    const binaryBytes = (base64Length * 3) / 4;
    
    // Estimate total size: 1 page size * total pages * small overhead factor
    const totalBytesEstimate = binaryBytes * numPages * 1.05; 
    setEstimatedSizeMb(totalBytesEstimate / (1024 * 1024));
  };

  const handleQualityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = parseInt(e.target.value);
    setQuality(q);
    if (canvasRef.current && pdfDocProxy) {
      updatePreview(canvasRef.current, q, pdfDocProxy.numPages);
    }
  };

  const handleCompress = async () => {
    if (!pdfDocProxy || !file) return;
    setIsCompressing(true);
    
    try {
      const newPdf = await PDFDocument.create();
      
      for (let i = 1; i <= pdfDocProxy.numPages; i++) {
        const page = await pdfDocProxy.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d")!;
        
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        await page.render({ canvasContext: context, viewport } as any).promise;
        
        const dataUrl = canvas.toDataURL("image/jpeg", quality / 100);
        const base64Data = dataUrl.split(',')[1];
        
        // Convert base64 to Uint8Array
        const binaryString = window.atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let j = 0; j < len; j++) {
            bytes[j] = binaryString.charCodeAt(j);
        }

        const jpgImage = await newPdf.embedJpg(bytes);
        
        const newPage = newPdf.addPage([viewport.width, viewport.height]);
        newPage.drawImage(jpgImage, {
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height,
        });
      }
      
      const pdfBytes = await newPdf.save();
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = file.name.replace(".pdf", `_compressed_${quality}.pdf`);
      link.click();
      
      onClose();
    } catch (err) {
      console.error("Compression error:", err);
      alert("Failed to compress PDF. See console for details.");
    } finally {
      setIsCompressing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col max-h-[90vh] overflow-hidden border border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between p-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-indigo-500" />
            <h2 className="font-bold text-slate-800 dark:text-slate-100">
              Compress PDF
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 flex flex-col md:flex-row gap-6">
          {/* Controls Panel */}
          <div className="w-full md:w-1/3 flex flex-col gap-6">
            {!file ? (
              <div className="relative border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-8 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex flex-col items-center justify-center text-center cursor-pointer group">
                <input
                  type="file"
                  accept=".pdf"
                  onChange={handleFileSelect}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <div className="w-12 h-12 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <Upload className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                </div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">
                  Select a PDF
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Click or drag and drop to upload
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-100 dark:border-slate-800">
                  <FileIcon className="w-8 h-8 text-indigo-500" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                      {file.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      Original: {(file.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  </div>
                </div>

                <div className="space-y-4 pt-4">
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                        Compression Level
                      </label>
                      <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-2 py-1 rounded-md">
                        {quality}% Quality
                      </span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      step="5"
                      value={quality}
                      onChange={handleQualityChange}
                      className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer dark:bg-slate-700"
                    />
                    <div className="flex justify-between text-xs text-slate-500 mt-1">
                      <span>Max Compression</span>
                      <span>High Quality</span>
                    </div>
                  </div>
                  
                  {estimatedSizeMb !== null && (
                    <div className="bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-100 dark:border-indigo-900/30">
                      <p className="text-xs text-indigo-600 dark:text-indigo-400 mb-1 font-medium uppercase tracking-wider">
                        Estimated Output Size
                      </p>
                      <p className="text-2xl font-bold text-indigo-700 dark:text-indigo-300">
                        ~{estimatedSizeMb.toFixed(2)} <span className="text-base font-medium">MB</span>
                      </p>
                      {estimatedSizeMb > (file.size / (1024 * 1024)) && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 font-medium">
                          Note: Target size may be larger than original if original was heavily optimized.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <button
                  onClick={handleCompress}
                  disabled={isCompressing || !pdfDocProxy}
                  className="w-full mt-4 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white py-3 px-4 rounded-xl font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isCompressing ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      Compressing...
                    </>
                  ) : (
                    <>
                      <Download className="w-5 h-5" />
                      Compress & Download
                    </>
                  )}
                </button>
                <button
                  onClick={() => setFile(null)}
                  disabled={isCompressing}
                  className="w-full mt-2 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                >
                  Choose different file
                </button>
              </div>
            )}
          </div>

          {/* Preview Panel */}
          <div className="w-full md:w-2/3 bg-slate-50 dark:bg-slate-800/30 rounded-xl border border-slate-100 dark:border-slate-800 flex flex-col p-4">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4 flex items-center gap-2">
              Quality Preview <span className="text-xs font-normal text-slate-500">(Page 1)</span>
            </h3>
            
            <div className="flex-1 w-full bg-slate-200 dark:bg-slate-900 rounded-lg overflow-auto border border-slate-300 dark:border-slate-700 flex items-center justify-center">
              {isLoadingFile ? (
                <div className="flex flex-col items-center gap-3 text-slate-500">
                  <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-sm font-medium">Generating preview...</p>
                </div>
              ) : previewDataUrl ? (
                <img 
                  src={previewDataUrl} 
                  alt="Preview" 
                  className="max-w-full h-auto object-contain shadow-lg"
                />
              ) : (
                <p className="text-slate-500 text-sm">Upload a PDF to see preview</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

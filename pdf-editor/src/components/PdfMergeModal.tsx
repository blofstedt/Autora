import React from "react";
import { useState, useRef } from "react";
import {
  X,
  FileUp,
  GripVertical,
  File,
  ArrowRight,
  Trash2,
} from "lucide-react";
import { PDFDocument } from "pdf-lib";

interface PdfMergeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMerged: (mergedPdfBytes: Uint8Array, fileName: string) => void;
}

interface MergeFile {
  id: string;
  file: File;
  name: string;
  size: number;
}

export default function PdfMergeModal({
  isOpen,
  onClose,
  onMerged,
}: PdfMergeModalProps) {
  const [files, setFiles] = useState<MergeFile[]>([]);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files).map((f: File) => ({
        id: Math.random().toString(36).substring(7),
        file: f,
        name: f.name,
        size: f.size,
      }));
      setFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const removeFile = (id: string) => {
    setFiles(files.filter((f) => f.id !== id));
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newFiles = [...files];
    const temp = newFiles[index];
    newFiles[index] = newFiles[index - 1];
    newFiles[index - 1] = temp;
    setFiles(newFiles);
  };

  const moveDown = (index: number) => {
    if (index === files.length - 1) return;
    const newFiles = [...files];
    const temp = newFiles[index];
    newFiles[index] = newFiles[index + 1];
    newFiles[index + 1] = temp;
    setFiles(newFiles);
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = "move";
    // Firefox requires some data to be set for drag to work
    e.dataTransfer.setData("text/plain", index.toString());
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (draggedIndex === null || draggedIndex === index) return;
    setDragOverIndex(index);
  };

  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newFiles = [...files];
    const draggedFile = newFiles[draggedIndex];
    newFiles.splice(draggedIndex, 1);
    newFiles.splice(index, 0, draggedFile);

    setFiles(newFiles);
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleMerge = async () => {
    if (files.length < 2) {
      setError("Please select at least 2 PDF files to merge.");
      return;
    }

    setIsMerging(true);
    setError(null);

    try {
      const mergedPdf = await PDFDocument.create();

      for (const fileObj of files) {
        const arrayBuffer = await fileObj.file.arrayBuffer();
        const pdf = await PDFDocument.load(arrayBuffer, {
          ignoreEncryption: true,
        });
        const copiedPages = await mergedPdf.copyPages(
          pdf,
          pdf.getPageIndices(),
        );
        copiedPages.forEach((page) => {
          mergedPdf.addPage(page);
        });
      }

      const mergedPdfFile = await mergedPdf.save();
      onMerged(mergedPdfFile, `Merged_${files.length}_Files.pdf`);
      setFiles([]);
      onClose();
    } catch (err: any) {
      console.error(err);
      setError(`Failed to merge PDFs: ${err.message}`);
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs transition-colors">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between shrink-0">
          <h3 className="font-sans font-bold text-lg text-slate-800 dark:text-slate-100 flex items-center">
            <FileUp className="w-5 h-5 mr-2 text-indigo-600 dark:text-indigo-400" />
            Merge PDFs
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
          {error && (
            <div className="mb-4 p-3 bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 rounded-lg text-sm border border-red-200 dark:border-red-800/50">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-xl p-8 bg-slate-50 dark:bg-slate-900/50">
              <input
                type="file"
                multiple
                accept="application/pdf"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileSelect}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold transition-colors cursor-pointer text-sm shadow-md flex items-center"
              >
                <FileUp className="w-4 h-4 mr-2" />
                Select PDF Files
              </button>
              <p className="text-xs text-slate-500 mt-3">
                Select multiple files to merge them together.
              </p>
            </div>

            {files.length > 0 && (
              <div className="space-y-2 mt-4">
                <h4 className="text-sm font-bold text-slate-700 dark:text-slate-300">
                  Selected Files (Drag/Arrows to reorder)
                </h4>
                <div className="space-y-2">
                  {files.map((file, index) => (
                    <div
                      key={file.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDrop={(e) => handleDrop(e, index)}
                      onDragEnd={handleDragEnd}
                      className={`flex items-center justify-between p-3 rounded-lg border shadow-sm transition-colors cursor-move ${
                        draggedIndex === index
                          ? "bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-800 opacity-50"
                          : dragOverIndex === index
                            ? "bg-slate-100 dark:bg-slate-600 border-indigo-400 dark:border-indigo-400"
                            : "bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600"
                      }`}
                    >
                      <div className="flex items-center space-x-3 truncate pointer-events-none">
                        <GripVertical className="w-4 h-4 text-slate-400 shrink-0" />
                        <File className="w-4 h-4 text-indigo-500 shrink-0" />
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                          {file.name}
                        </span>
                        <span className="text-xs text-slate-400">
                          ({(file.size / 1024 / 1024).toFixed(2)} MB)
                        </span>
                      </div>
                      <div className="flex items-center space-x-2 shrink-0">
                        <div className="flex flex-col border-r border-slate-200 dark:border-slate-600 pr-2">
                          <button
                            onClick={() => moveUp(index)}
                            disabled={index === 0}
                            className="text-slate-400 hover:text-indigo-600 disabled:opacity-30 cursor-pointer p-0.5"
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => moveDown(index)}
                            disabled={index === files.length - 1}
                            className="text-slate-400 hover:text-indigo-600 disabled:opacity-30 cursor-pointer p-0.5"
                          >
                            ▼
                          </button>
                        </div>
                        <button
                          onClick={() => removeFile(file.id)}
                          className="text-slate-400 hover:text-red-500 cursor-pointer p-1"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg mr-2 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleMerge}
            disabled={files.length < 2 || isMerging}
            className="px-6 py-2 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors cursor-pointer flex items-center shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isMerging ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
            ) : (
              <ArrowRight className="w-4 h-4 mr-2" />
            )}
            Merge & Load
          </button>
        </div>
      </div>
    </div>
  );
}

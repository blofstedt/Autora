import { Trash2, Type, PenLine, Award, Move, BadgeAlert } from 'lucide-react';
import { AnnotationItem } from '../types';

interface LayerControlProps {
  annotations: AnnotationItem[];
  currentPage: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function LayerControl({
  annotations,
  currentPage,
  selectedId,
  onSelect,
  onDelete,
}: LayerControlProps) {
  // Filter for elements placed only on the current visible page
  const pageLayers = annotations.filter((ann) => ann.pageNumber === currentPage);

  const getLayerName = (ann: AnnotationItem) => {
    switch (ann.type) {
      case 'text':
        return ann.text ? (ann.text.length > 20 ? `Text: "${ann.text.slice(0, 18)}..."` : `Text: "${ann.text}"`) : 'Empty Text Node';
      case 'stamp':
        return `Stamp: [${ann.stampType}]`;
      case 'signature':
        return 'Signature Seal';
      case 'drawing':
        return 'Freehand Drawing Path';
      default:
        return 'Layer Node';
    }
  };

  const getLayerIcon = (type: string) => {
    switch (type) {
      case 'text':
        return <Type className="w-3.5 h-3.5 text-blue-600 font-bold" />;
      case 'drawing':
        return <PenLine className="w-3.5 h-3.5 text-indigo-600 font-bold" />;
      case 'stamp':
        return <Award className="w-3.5 h-3.5 text-amber-600 font-bold" />;
      default:
        return <Move className="w-3.5 h-3.5 text-emerald-600 font-bold" />;
    }
  };

  return (
    <div id="layer-control-sidebar" className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 flex flex-col space-y-3 shadow-xs transition-colors">
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 pb-2">
        <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Active Layers (Page {currentPage})</h4>
        <span className="text-[10px] font-bold bg-indigo-50 dark:bg-indigo-900/30 p-0.5 px-2 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-800/50 rounded-full">
          {pageLayers.length} total
        </span>
      </div>

      {pageLayers.length === 0 ? (
        <div id="no-layers-state" className="flex flex-col items-center justify-center py-6 text-center text-slate-400 dark:text-slate-500 space-y-1">
          <BadgeAlert className="w-5 h-5 text-slate-300 dark:text-slate-600" />
          <p className="text-xs font-bold text-slate-500 dark:text-slate-400">No annotations on this page</p>
          <p className="text-[10px] text-slate-400 dark:text-slate-500 font-semibold uppercase tracking-wider leading-normal">
            Toggle Tools to annotate
          </p>
        </div>
      ) : (
        <div id="layers-list" className="max-h-56 overflow-y-auto space-y-1.5 pr-1 divide-y divide-slate-100 dark:divide-slate-700">
          {pageLayers.map((ann) => (
            <div
              key={ann.id}
              id={`layer-row-${ann.id}`}
              onClick={() => onSelect(ann.id)}
              className={`group flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all ${
                selectedId === ann.id
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800/50 text-indigo-700 dark:text-indigo-400 font-bold shadow-xs'
                  : 'border border-slate-100/40 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300'
              }`}
            >
              <div className="flex items-center space-x-2 overflow-hidden mr-2">
                <span className="shrink-0">{getLayerIcon(ann.type)}</span>
                <span className="text-xs font-sans font-bold truncate select-none leading-none">
                  {getLayerName(ann)}
                </span>
              </div>

              <button
                id={`delete-layer-${ann.id}-btn`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(ann.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 hover:border hover:border-rose-100 dark:hover:border-rose-800/50 rounded transition-all cursor-pointer"
                title="Delete layer element"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

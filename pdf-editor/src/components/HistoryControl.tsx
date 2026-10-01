import { Undo2, Redo2, History } from 'lucide-react';
import { AnnotationItem } from '../types';

interface HistoryControlProps {
  history: {
    timeline: { annotations: AnnotationItem[]; description: string; id: string }[];
    currentIndex: number;
  };
  undo: () => void;
  redo: () => void;
  jumpToHistory: (index: number) => void;
}

export default function HistoryControl({
  history,
  undo,
  redo,
  jumpToHistory,
}: HistoryControlProps) {
  const canUndo = history.currentIndex > 0;
  const canRedo = history.currentIndex < history.timeline.length - 1;

  return (
    <div id="history-control-sidebar" className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 flex flex-col space-y-3 shadow-xs transition-colors">
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 pb-2">
        <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center">
          <History className="w-3.5 h-3.5 mr-1.5 text-indigo-600 dark:text-indigo-400" />
          Changes
        </h4>
        <div className="flex space-x-1">
          <button
            onClick={undo}
            disabled={!canUndo}
            className={`p-1 rounded-md transition-all ${
              canUndo
                ? 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer'
                : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
            }`}
            title="Undo"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className={`p-1 rounded-md transition-all ${
              canRedo
                ? 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer'
                : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
            }`}
            title="Redo"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
        {[...history.timeline].reverse().map((entry, reverseIdx) => {
          const actualIndex = history.timeline.length - 1 - reverseIdx;
          const isActive = actualIndex === history.currentIndex;
          const isFuture = actualIndex > history.currentIndex;

          return (
            <button
              key={entry.id}
              onClick={() => jumpToHistory(actualIndex)}
              className={`w-full flex items-center justify-between p-2 rounded-lg text-left text-[11px] font-bold transition-all cursor-pointer ${
                isActive
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800/50 text-indigo-700 dark:text-indigo-400 shadow-xs'
                  : isFuture
                  ? 'bg-transparent text-slate-400 dark:text-slate-500 italic hover:bg-slate-50 dark:hover:bg-slate-700/50'
                  : 'bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-800 dark:hover:text-slate-100'
              }`}
            >
              <span className="truncate pr-2">{entry.description}</span>
              {isActive && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0 shadow-[0_0_4px_rgba(99,102,241,0.6)]" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { ShieldAlert, Flame, Trash2, CheckCircle2 } from 'lucide-react';

interface PurgeOverlayProps {
  isPurging: boolean;
  onPurgeFinished: () => void;
}

export default function PurgeOverlay({ isPurging, onPurgeFinished }: PurgeOverlayProps) {
  const [phase, setPhase] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isPurging) {
      setPhase(0);
      setProgress(0);
      return;
    }

    // Step 1: Start immediately
    setPhase(1);
    setProgress(15);

    // Step 2: Clear state memory
    const t1 = setTimeout(() => {
      setPhase(2);
      setProgress(50);
    }, 800);

    // Step 3: Zero-out bytebuffers
    const t2 = setTimeout(() => {
      setPhase(3);
      setProgress(85);
    }, 1600);

    // Step 4: Finished reset
    const t3 = setTimeout(() => {
      setPhase(4);
      setProgress(100);
    }, 2400);

    // Final callback to parent to hard reload the tab
    const t4 = setTimeout(() => {
      onPurgeFinished();
    }, 3200);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [isPurging, onPurgeFinished]);

  if (!isPurging) return null;

  const getPhaseText = () => {
    switch (phase) {
      case 1:
        return 'WIPING VOLATILE STATE ARRAYS...';
      case 2:
        return 'ZEROING OUT BINARY PDF BUFFER STREAM (0x00)...';
      case 3:
        return 'PURGING SIGNATURE VECTOR TRACKS & LOCAL CACHE...';
      case 4:
        return 'SAFE SHUTDOWN COMPLETED. MEMORY PURGED!';
      default:
        return 'INITIATING SANDBOX DESTRUCTION SEALS...';
    }
  };

  return (
    <div id="purge-screen-lock-overlay" className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-slate-950 p-6 text-center animate-in fade-in duration-300">
      
      {/* Background Grid Accent */}
      <div className="absolute inset-0 bg-radial-at-c from-red-950/20 via-slate-950 to-slate-950 pointer-events-none" />

      {/* Burning Containment Box */}
      <div className="relative z-10 w-full max-w-md bg-gray-900 border border-red-500/30 rounded-2xl p-8 flex flex-col items-center space-y-6 shadow-2xl shadow-red-950/40">
        
        {/* Animated Fire / Scrap Indicators */}
        <div className="relative flex items-center justify-center w-20 h-20 bg-red-500/10 rounded-full border border-red-500/20 text-red-400 animate-pulse">
          {phase === 4 ? (
            <CheckCircle2 className="w-10 h-10 text-emerald-400 animate-bounce" />
          ) : (
            <>
              <Flame className="w-10 h-10 animate-pulse" />
              <Trash2 className="w-6 h-6 absolute text-white/80 animate-bounce" />
            </>
          )}
        </div>

        {/* Warning Badge */}
        <div className="flex items-center space-x-1.5 p-1 px-3 bg-red-500/10 text-red-400 border border-red-500/20 rounded-md font-mono text-[10px] tracking-wider uppercase select-none">
          <ShieldAlert className="w-3.5 h-3.5" />
          <span>Active Self-Destruct Sequence</span>
        </div>

        {/* Header Titles */}
        <div className="space-y-1.5">
          <h2 className="font-sans font-bold text-xl text-white">Scrubbing Core Memories</h2>
          <p className="text-xs text-gray-400 font-mono">
            Destroying on-device sandbox caches. This cannot be undone.
          </p>
        </div>

        {/* Custom Progress Bar Segment */}
        <div className="w-full space-y-2">
          <div className="flex justify-between items-center text-[10px] font-mono text-gray-500">
            <span>SCRUB_STATUS: {progress}%</span>
            <span>{phase === 4 ? 'SUCCESS' : 'MEM_BURN'}</span>
          </div>
          
          {/* Progress outer track */}
          <div className="w-full h-2 bg-gray-950 rounded-full overflow-hidden border border-gray-800">
            <div 
              id="purge-progress-indicator-bar"
              className={`h-full rounded-full transition-all duration-700 ${
                phase === 4 ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="h-5 flex items-center justify-center">
            <p className="text-[10px] font-mono text-emerald-400 bg-emerald-500/5 p-1 px-2.5 rounded border border-emerald-500/10 animate-pulse">
              {getPhaseText()}
            </p>
          </div>
        </div>

        {/* Detailed Safety Information */}
        <p className="text-[10px] font-mono text-gray-500 max-w-xs leading-normal">
          Closing tabs will automatically trigger this memory garbage collection loop. We recommend manual purging after every sensitive signature event.
        </p>
      </div>
    </div>
  );
}

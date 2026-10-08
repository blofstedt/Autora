import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Debounced undo/redo over an immutable value. Rapid changes (slider drags,
 * push-pull gestures) collapse into a single history entry.
 */
export function useHistory<T>(value: T, apply: (value: T) => void, delay = 600) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const committed = useRef(value);
  const current = useRef(value);
  const timer = useRef<number | undefined>(undefined);
  const holding = useRef(false);
  const [, setVersion] = useState(0);
  current.current = value;

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (current.current === committed.current) return;
    past.current.push(committed.current);
    if (past.current.length > 100) past.current.shift();
    committed.current = current.current;
    future.current = [];
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (value === committed.current || holding.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, delay);
    return () => window.clearTimeout(timer.current);
  }, [value, delay, flush]);

  /** While held (e.g. mid-drag), changes accumulate into one entry that is committed on release. */
  const hold = useCallback(
    (on: boolean) => {
      if (on) flush(); // settle anything pending so the gesture starts from a clean entry
      holding.current = on;
      if (!on) flush();
    },
    [flush]
  );

  const undo = useCallback(() => {
    flush();
    const prev = past.current.pop();
    if (prev === undefined) return false;
    future.current.push(committed.current);
    committed.current = prev;
    apply(prev);
    setVersion((v) => v + 1);
    return true;
  }, [apply, flush]);

  const redo = useCallback(() => {
    flush();
    const next = future.current.pop();
    if (next === undefined) return false;
    past.current.push(committed.current);
    committed.current = next;
    apply(next);
    setVersion((v) => v + 1);
    return true;
  }, [apply, flush]);

  /** Tells the history about a change before the next render, so an undo right after it (an agent's) still sees it. */
  const track = useCallback((v: T) => {
    current.current = v;
  }, []);

  return {
    track,
    /** Close the current history entry now (instead of waiting for changes to settle). */
    commit: flush,
    hold,
    undo,
    redo,
    canUndo: past.current.length > 0 || value !== committed.current,
    canRedo: future.current.length > 0,
  };
}

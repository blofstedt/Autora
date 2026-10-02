import { useCallback, useRef } from "react";

/**
 * The seam between two panes, to drag. A pointer takes hold of it (so the drag
 * carries on over a frame, which would otherwise swallow it), the arrow keys move
 * it, and a double click puts it back.
 */
export function ResizeHandle(props: {
  label: string;
  /** The width of the pane it sizes, in pixels. */
  value: number;
  min: number;
  max: number;
  onChange: (px: number) => void;
  onReset: () => void;
  /** Which side of the seam the sized pane is on: dragging right grows it if "left". */
  from?: "left" | "right";
  className?: string;
}) {
  const { label, value, min, max, onChange, onReset, from = "left", className = "" } = props;
  const start = useRef<{ x: number; width: number } | null>(null);

  const move = useCallback((e: React.PointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    onChange(start.current.width + (from === "left" ? dx : -dx));
  }, [from, onChange]);

  const end = useCallback((e: React.PointerEvent) => {
    start.current = null;
    document.body.classList.remove("is-resizing");
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already let go */ }
  }, []);

  return (
    <div
      className={`pane-handle ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title={`${label} (drag, or double-click to reset)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // The pane's width as it is on screen (it may not have been set yet: a default is a range, not a number).
        const pane = (from === "left" ? e.currentTarget.previousElementSibling : e.currentTarget.nextElementSibling) as HTMLElement | null;
        start.current = { x: e.clientX, width: pane ? pane.getBoundingClientRect().width : value };
        document.body.classList.add("is-resizing");
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const pane = (from === "left" ? e.currentTarget.previousElementSibling : e.currentTarget.nextElementSibling) as HTMLElement | null;
        const value = pane ? Math.round(pane.getBoundingClientRect().width) : props.value;
        const step = e.shiftKey ? 64 : 16;
        const grow = from === "left" ? "ArrowRight" : "ArrowLeft";
        const shrink = from === "left" ? "ArrowLeft" : "ArrowRight";
        if (e.key === grow) { onChange(value + step); e.preventDefault(); }
        else if (e.key === shrink) { onChange(value - step); e.preventDefault(); }
        else if (e.key === "Home") { onReset(); e.preventDefault(); }
      }}
    />
  );
}

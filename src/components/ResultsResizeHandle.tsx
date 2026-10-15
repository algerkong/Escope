import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  height: number | null;
  minHeight: number;
  maxHeight: number;
  active: boolean;
  onResize: (height: number) => void;
  onReset: () => void;
}

/**
 * Vertical drag handle for resizing the height of the query results panel.
 * Sits horizontally between the query editor and results panel.
 * Dragging upward increases results panel height, dragging downward decreases it.
 */
export function ResultsResizeHandle({ label, height, minHeight, maxHeight, active, onResize, onReset }: Props) {
  const drag = useRef<{ id: number; startY: number; startHeight: number; parentHeight: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!active) drag.current = null;
    return () => { drag.current = null; };
  }, [active]);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={label}
      aria-valuemin={Math.round(minHeight)}
      aria-valuemax={Math.round(maxHeight)}
      aria-valuenow={height ? Math.round(height) : undefined}
      tabIndex={active ? 0 : -1}
      hidden={!active}
      className="results-resize-handle"
      data-dragging={active && dragging}
      onPointerDown={(event) => {
        if (!active || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        const parent = event.currentTarget.parentElement;
        const parentHeight = parent?.clientHeight ?? 600;
        const currentHeight = height ?? (parent?.querySelector('.results-section')?.clientHeight ?? 300);
        drag.current = {
          id: event.pointerId,
          startY: event.clientY,
          startHeight: currentHeight,
          parentHeight,
        };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!active || !current || event.pointerId !== current.id) return;
        const delta = current.startY - event.clientY;
        const liveParent = current.parentHeight > minHeight + 160 ? current.parentHeight - 160 : maxHeight;
        const boundMax = Math.max(minHeight, Math.min(maxHeight, liveParent));
        const next = Math.min(boundMax, Math.max(minHeight, Math.round(current.startHeight + delta)));
        onResize(next);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={() => { if (active) onReset(); }}
      onKeyDown={(event) => {
        if (!active || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const step = event.shiftKey ? 48 : 16;
        const parent = event.currentTarget.parentElement;
        const base = height ?? (parent?.querySelector('.results-section')?.clientHeight ?? minHeight);
        const parentHeight = parent?.clientHeight ?? 0;
        const liveParent = parentHeight > minHeight + 160 ? parentHeight - 160 : maxHeight;
        const boundMax = Math.max(minHeight, Math.min(maxHeight, liveParent));
        const next = event.key === 'Home' ? minHeight
          : event.key === 'End' ? boundMax
          : event.key === 'ArrowUp' ? Math.min(boundMax, base + step)
          : event.key === 'ArrowDown' ? Math.max(minHeight, base - step)
          : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(next);
      }}
    />
  );
}

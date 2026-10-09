import { useEffect, useRef, useState } from 'react';
import { clampPanelWidth } from '../domain/workspace-panels';

interface Props {
  label: string;
  controls: string;
  side: 'resources' | 'ai';
  width: number;
  min: number;
  max: number;
  active: boolean;
  onResize: (width: number) => void;
  onReset: () => void;
}

export function PanelResizeHandle({ label, controls, side, width, min, max, active, onResize, onReset }: Props) {
  const drag = useRef<{ id: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = side === 'resources' ? 1 : -1;

  useEffect(() => {
    if (!active) drag.current = null;
    return () => { drag.current = null; };
  }, [active]);

  return <div role="separator" aria-orientation="vertical" aria-label={label} title={label}
    aria-controls={controls} aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)}
    aria-valuenow={Math.round(width)} tabIndex={active ? 0 : -1} hidden={!active}
    className={`workspace-resize workspace-resize-${side}`} data-dragging={active && dragging}
    onPointerDown={(event) => {
      if (!active || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      drag.current = { id: event.pointerId, startX: event.clientX, startWidth: width };
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      const current = drag.current;
      if (!active || !current || event.pointerId !== current.id) return;
      onResize(clampPanelWidth(current.startWidth + (event.clientX - current.startX) * direction, min, max));
    }}
    onPointerUp={(event) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; setDragging(false); }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
    onDoubleClick={() => { if (active) onReset(); }}
    onKeyDown={(event) => {
      if (!active || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const step = event.shiftKey ? 48 : 16;
      const next = event.key === 'Home' ? min : event.key === 'End' ? max
        : event.key === 'ArrowRight' ? width + step * direction
          : event.key === 'ArrowLeft' ? width - step * direction : null;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      onResize(clampPanelWidth(next, min, max));
    }}>
    <span aria-hidden="true" />
  </div>;
}

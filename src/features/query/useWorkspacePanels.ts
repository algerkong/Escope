import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { PANEL_DEFAULTS, PANEL_LIMITS, clampPanelWidth, resolveWorkspacePanels, type PanelWidths } from '../../domain/workspace-panels';

export function useWorkspacePanels(aiOpen: boolean, active: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const [preferred, setPreferred] = useState<PanelWidths>(PANEL_DEFAULTS);

  useEffect(() => {
    if (!active) return;
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setContainerWidth(width);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [active]);

  const resize = useCallback((side: keyof PanelWidths, width: number) => {
    const limits = PANEL_LIMITS[side];
    setPreferred((current) => ({ ...current, [side]: clampPanelWidth(width, limits.min, limits.max) }));
  }, []);
  const layout = resolveWorkspacePanels(containerWidth, preferred, aiOpen);
  return {
    containerRef,
    layout,
    resize,
    style: {
      '--resources-width': `${layout.resources.width}px`,
      '--ai-width': `${layout.ai.width}px`,
    } as CSSProperties,
  };
}

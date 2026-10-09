export const PANEL_GUTTER = 6;
export const MAIN_MIN_WIDTH = 420;
export const PANEL_DEFAULTS = { resources: 216, ai: 360 } as const;
export const PANEL_LIMITS = { resources: { min: 160, max: 340 }, ai: { min: 280, max: 640 } } as const;

export interface PanelWidths {
  resources: number;
  ai: number;
}

export function clampPanelWidth(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)));
}

/** Preserve the query area when panels are inline; a narrow window uses the existing AI overlay. */
export function resolveWorkspacePanels(containerWidth: number, preferred: PanelWidths, aiOpen: boolean) {
  const width = Math.max(0, containerWidth);
  const resourcesVisible = width > 760;
  const aiInline = width >= 1200;
  const resourcesMax = Math.max(PANEL_LIMITS.resources.min, Math.min(
    PANEL_LIMITS.resources.max,
    width - MAIN_MIN_WIDTH - PANEL_GUTTER - (aiInline && aiOpen ? PANEL_LIMITS.ai.min + PANEL_GUTTER : 0),
  ));
  const resources = clampPanelWidth(preferred.resources, PANEL_LIMITS.resources.min, resourcesMax);
  const aiMax = Math.max(0, Math.min(PANEL_LIMITS.ai.max,
    aiInline ? width - resources - MAIN_MIN_WIDTH - PANEL_GUTTER * 2 : width - 20));
  const aiMin = Math.min(PANEL_LIMITS.ai.min, aiMax);
  const ai = clampPanelWidth(preferred.ai, aiMin, aiMax);
  const currentResourcesMax = aiInline && aiOpen
    ? Math.min(resourcesMax, width - ai - MAIN_MIN_WIDTH - PANEL_GUTTER * 2) : resourcesMax;
  return {
    resources: { width: resources, min: PANEL_LIMITS.resources.min, max: currentResourcesMax, visible: resourcesVisible },
    ai: { width: ai, min: aiMin, max: aiMax, visible: aiOpen, inline: aiInline },
  };
}

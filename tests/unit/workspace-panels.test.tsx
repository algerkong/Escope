import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelResizeHandle } from '../../src/components/PanelResizeHandle';
import {
  MAIN_MIN_WIDTH, PANEL_DEFAULTS, PANEL_GUTTER, PANEL_LIMITS, clampPanelWidth, resolveWorkspacePanels,
} from '../../src/domain/workspace-panels';
import { useWorkspacePanels } from '../../src/features/query/useWorkspacePanels';

describe('workspace panel constraints', () => {
  it('keeps the center usable at every desktop width and both resize extremes', () => {
    for (const viewport of [1200, 1280, 1440, 1920]) {
      for (const resources of [160, 216, 340, 999]) {
        for (const ai of [280, 360, 640, 999]) {
          const layout = resolveWorkspacePanels(viewport, { resources, ai }, true);
          expect(layout.resources.width).toBeGreaterThanOrEqual(PANEL_LIMITS.resources.min);
          expect(layout.resources.width).toBeLessThanOrEqual(layout.resources.max);
          expect(layout.ai.width).toBeGreaterThanOrEqual(layout.ai.min);
          expect(layout.ai.width).toBeLessThanOrEqual(layout.ai.max);
          expect(viewport - layout.resources.width - layout.ai.width - PANEL_GUTTER * 2)
            .toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
        }
      }
    }
  });

  it('constrains the narrow overlay without allocating its width in the grid', () => {
    for (const viewport of [240, 320, 760, 900, 1199]) {
      const layout = resolveWorkspacePanels(viewport, { resources: 999, ai: 999 }, true);
      expect(layout.ai.inline).toBe(false);
      expect(layout.ai.width).toBeLessThanOrEqual(viewport - 20);
      expect(layout.ai.width).toBeLessThanOrEqual(PANEL_LIMITS.ai.max);
      expect(layout.resources.visible).toBe(viewport > 760);
    }
    expect(resolveWorkspacePanels(1200, PANEL_DEFAULTS, false).ai.visible).toBe(false);
  });

  it('clamps invalid and out-of-range preferences without modifying the stored preference', () => {
    expect(clampPanelWidth(Number.NaN, 160, 340)).toBe(160);
    expect(clampPanelWidth(-5, 160, 340)).toBe(160);
    expect(clampPanelWidth(999, 160, 340)).toBe(340);
    const preferred = { resources: 340, ai: 640 };
    expect(resolveWorkspacePanels(1200, preferred, true).ai.width).toBeLessThan(640);
    expect(resolveWorkspacePanels(1920, preferred, true).ai.width).toBe(640);
    expect(preferred).toEqual({ resources: 340, ai: 640 });
  });
});

function Handle({ side = 'resources', active = true }: { side?: 'resources' | 'ai'; active?: boolean }) {
  const [width, setWidth] = useState<number>(PANEL_DEFAULTS[side]);
  return <PanelResizeHandle label="Resize panel" controls="test-panel" side={side}
    width={width} {...PANEL_LIMITS[side]} active={active} onResize={setWidth}
    onReset={() => setWidth(PANEL_DEFAULTS[side])} />;
}

describe('workspace resize interaction', () => {
  beforeEach(() => {
    class Pointer extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options);
        this.pointerId = options.pointerId ?? 1;
      }
    }
    vi.stubGlobal('PointerEvent', Pointer);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function capture(element: HTMLElement) {
    Object.defineProperties(element, {
      setPointerCapture: { value: vi.fn(), configurable: true },
      releasePointerCapture: { value: vi.fn(), configurable: true },
      hasPointerCapture: { value: () => true, configurable: true },
    });
  }

  it('supports keyboard resizing, min/max and double-click reset without leaving the handle', () => {
    render(<Handle />);
    const separator = screen.getByRole('separator', { name: 'Resize panel' });
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute('aria-valuenow', '216');
    separator.focus();
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '232');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '340');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '340');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuenow', '160');
    fireEvent.doubleClick(separator);
    expect(separator).toHaveAttribute('aria-valuenow', '216');
    expect(separator).toHaveFocus();
  });

  it('widens the left panel when dragging right and ignores foreign and cancelled pointers', () => {
    render(<Handle />);
    const separator = screen.getByRole('separator');
    capture(separator);
    fireEvent.pointerDown(separator, { pointerId: 1, button: 0, clientX: 216 });
    fireEvent.pointerMove(separator, { pointerId: 2, clientX: 400 });
    expect(separator).toHaveAttribute('aria-valuenow', '216');
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 300 });
    expect(separator).toHaveAttribute('aria-valuenow', '300');
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 800 });
    expect(separator).toHaveAttribute('aria-valuenow', '340');
    fireEvent.pointerCancel(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 170 });
    expect(separator).toHaveAttribute('aria-valuenow', '340');
  });

  it('reverses the direction for the right panel and releases capture after dragging', () => {
    render(<Handle side="ai" />);
    const separator = screen.getByRole('separator');
    capture(separator);
    fireEvent.pointerDown(separator, { pointerId: 5, button: 0, clientX: 900 });
    fireEvent.pointerMove(separator, { pointerId: 5, clientX: 780 });
    expect(separator).toHaveAttribute('aria-valuenow', '480');
    fireEvent.pointerUp(separator, { pointerId: 5 });
    expect(separator.releasePointerCapture).toHaveBeenCalledWith(5);
    fireEvent.pointerMove(separator, { pointerId: 5, clientX: 600 });
    expect(separator).toHaveAttribute('aria-valuenow', '480');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '464');
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
    expect(separator).toHaveAttribute('aria-valuenow', '512');
  });

  it('ignores IME, right clicks and hidden resize handles', () => {
    const view = render(<Handle />);
    const separator = screen.getByRole('separator');
    capture(separator);
    fireEvent.keyDown(separator, { key: 'ArrowRight', keyCode: 229 });
    fireEvent.pointerDown(separator, { pointerId: 1, button: 2, clientX: 216 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 300 });
    expect(separator).toHaveAttribute('aria-valuenow', '216');
    expect(separator.setPointerCapture).not.toHaveBeenCalled();
    view.rerender(<Handle active={false} />);
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('hidden');
    expect(separator).toHaveAttribute('tabindex', '-1');
    expect(separator).toHaveAttribute('aria-valuenow', '216');
  });

  it('retains preferences through hide/show and clamps them after container resizing', () => {
    let width = 1920;
    let measure: (() => void) | undefined;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width } as DOMRect));
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { measure = callback; }
      observe() {}
      disconnect = disconnect;
    });
    function Harness({ active }: { active: boolean }) {
      const { containerRef, layout, resize, style } = useWorkspacePanels(true, active);
      return <div ref={containerRef} style={style}>
        <output data-testid="ai-width">{layout.ai.width}</output>
        <button onClick={() => resize('ai', 640)}>Widen</button>
      </div>;
    }
    const view = render(<Harness active />);
    fireEvent.click(screen.getByRole('button', { name: 'Widen' }));
    expect(screen.getByTestId('ai-width')).toHaveTextContent('640');
    act(() => { width = 1200; measure?.(); });
    expect(Number(screen.getByTestId('ai-width').textContent)).toBeLessThan(640);
    view.rerender(<Harness active={false} />);
    expect(disconnect).toHaveBeenCalled();
    width = 1920;
    view.rerender(<Harness active />);
    expect(screen.getByTestId('ai-width')).toHaveTextContent('640');
  });
});

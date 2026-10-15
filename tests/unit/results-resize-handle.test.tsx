import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsResizeHandle } from '../../src/components/ResultsResizeHandle';

describe('ResultsResizeHandle', () => {
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function capture(element: HTMLElement) {
    Object.defineProperties(element, {
      setPointerCapture: { value: vi.fn(), configurable: true },
      releasePointerCapture: { value: vi.fn(), configurable: true },
      hasPointerCapture: { value: () => true, configurable: true },
    });
  }
  it('renders with separator semantics, correct bounds and aria attributes', () => {
    render(
      <ResultsResizeHandle
        label="Resize results panel"
        height={320}
        minHeight={160}
        maxHeight={800}
        active={true}
        onResize={() => {}}
        onReset={() => {}}
      />,
    );

    const handle = screen.getByRole('separator', { name: 'Resize results panel' });
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    expect(handle).toHaveAttribute('aria-valuemin', '160');
    expect(handle).toHaveAttribute('aria-valuemax', '800');
    expect(handle).toHaveAttribute('aria-valuenow', '320');
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).not.toHaveAttribute('hidden');
  });

  it('hides and disables keyboard focus when inactive', () => {
    render(
      <ResultsResizeHandle
        label="Resize results panel"
        height={320}
        minHeight={160}
        maxHeight={800}
        active={false}
        onResize={() => {}}
        onReset={() => {}}
      />,
    );

    const handle = screen.getByLabelText('Resize results panel');
    expect(handle).toHaveAttribute('hidden');
    expect(handle).toHaveAttribute('tabindex', '-1');
  });

  it('handles keyboard navigation with bounds and step sizes', () => {
    const onResize = vi.fn();
    render(
      <ResultsResizeHandle
        label="Resize results panel"
        height={300}
        minHeight={150}
        maxHeight={600}
        active={true}
        onResize={onResize}
        onReset={() => {}}
      />,
    );

    const handle = screen.getByRole('separator', { name: 'Resize results panel' });

    // ArrowUp -> +16
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onResize).toHaveBeenCalledWith(316);

    // Shift + ArrowUp -> +48
    fireEvent.keyDown(handle, { key: 'ArrowUp', shiftKey: true });
    expect(onResize).toHaveBeenCalledWith(348);

    // ArrowDown -> -16
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(onResize).toHaveBeenCalledWith(284);

    // Shift + ArrowDown -> -48
    fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true });
    expect(onResize).toHaveBeenCalledWith(252);

    // Home -> minHeight
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onResize).toHaveBeenCalledWith(150);

    // End -> maxHeight
    fireEvent.keyDown(handle, { key: 'End' });
    expect(onResize).toHaveBeenCalledWith(600);
  });

  it('calls onReset on double-click when active', () => {
    const onReset = vi.fn();
    render(
      <ResultsResizeHandle
        label="Resize results panel"
        height={300}
        minHeight={150}
        maxHeight={600}
        active={true}
        onResize={() => {}}
        onReset={onReset}
      />,
    );

    const handle = screen.getByRole('separator', { name: 'Resize results panel' });
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('updates height via pointer drag with clamping to min/max', () => {
    const onResize = vi.fn();
    render(
      <ResultsResizeHandle
        label="Resize results panel"
        height={300}
        minHeight={150}
        maxHeight={600}
        active={true}
        onResize={onResize}
        onReset={() => {}}
      />,
    );

    const handle = screen.getByRole('separator', { name: 'Resize results panel' });
    capture(handle);

    // Pointer down at clientY = 500
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 500 });
    expect(handle).toHaveAttribute('data-dragging', 'true');

    // Drag up by 50px (clientY = 450) -> startY (500) - clientY (450) = +50 -> 350
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 450 });
    expect(onResize).toHaveBeenCalledWith(350);

    // Drag way down (clientY = 800) -> startY (500) - clientY (800) = -300 -> 300 - 300 = 0 -> clamped to minHeight 150
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 800 });
    expect(onResize).toHaveBeenCalledWith(150);

    // Pointer up
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle).toHaveAttribute('data-dragging', 'false');
  });
});

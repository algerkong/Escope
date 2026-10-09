import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { useTableRowSelection } from '../../src/components/useTableRowSelection';

const IDS = ['a', 'b', 'c', 'd', 'e'];

function Harness({ ids = IDS, visible = ids, scope = 'first', active = true, name = 'rows', onAction, selectOnCommit = false }: {
  ids?: readonly string[]; visible?: readonly string[]; scope?: string; active?: boolean; name?: string; onAction?: () => void; selectOnCommit?: boolean;
}) {
  const selection = useTableRowSelection({ rowIds: ids, visibleRowIds: visible, scope, active });
  useLayoutEffect(() => {
    if (!selectOnCommit) return;
    const rows = selection.bodyRef.current?.rows;
    rows?.[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
    rows?.[1]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, [scope, selectOnCommit, selection.bodyRef]);
  return <>
    <div data-testid={`scroll-${name}`} style={{ overflowY: 'auto' }}>
      <table aria-label={name}><thead><tr><th>Value</th></tr></thead>
        <tbody ref={selection.bodyRef} {...selection.bodyProps}>
          {visible.map((id) => <tr key={id} {...selection.rowProps(id)}>
            <td><span>{id}</span></td><td><button onClick={onAction}>Action {id}</button></td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <button onClick={selection.clear}>Clear {name}</button>
    <output aria-label={`selected-${name}`}>{selection.selectedCount}</output>
  </>;
}

const row = (id: string, name = 'rows') => within(screen.getByRole('table', { name })).getByText(id).closest('tr')!;
const selected = (name = 'rows') => [...screen.getByRole('table', { name }).querySelectorAll<HTMLElement>('tr[aria-selected="true"]')]
  .map((item) => item.dataset.selectionId);
const drag = (from: HTMLElement, to: HTMLElement) => {
  fireEvent.mouseDown(from, { button: 0, buttons: 1 });
  fireEvent.mouseMove(to, { buttons: 1 });
  fireEvent.mouseUp(document);
};

afterEach(() => { document.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); });

describe('table row selection', () => {
  it('does not erase a new-scope gesture when passive effects finish after the commit', () => {
    const view = render(<Harness selectOnCommit />);
    expect(selected()).toEqual(['a', 'b']);
    view.rerender(<Harness scope="replacement" selectOnCommit />);
    expect(selected()).toEqual(['a', 'b']);
  });

  it('keeps one clicked row selected after the pointer leaves and replaces it on the next click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(row('b'));
    fireEvent.mouseLeave(row('b'));
    expect(selected()).toEqual(['b']);
    expect(row('b')).toHaveFocus();
    await user.click(row('d'));
    expect(selected()).toEqual(['d']);
    expect(screen.getByLabelText('selected-rows')).toHaveTextContent('1');
    await user.click(screen.getByRole('button', { name: 'Clear rows' }));
    expect(selected()).toEqual([]);
  });

  it('selects inclusive drag ranges in either direction and shrinks them when reversing', () => {
    render(<Harness />);
    fireEvent.mouseDown(row('b'), { button: 0, buttons: 1 });
    fireEvent.mouseMove(row('e'), { buttons: 1 });
    expect(selected()).toEqual(['b', 'c', 'd', 'e']);
    expect(row('b').parentElement).toHaveAttribute('data-row-dragging', 'true');
    fireEvent.mouseMove(row('c'), { buttons: 1 });
    expect(selected()).toEqual(['b', 'c']);
    fireEvent.mouseMove(row('a'), { buttons: 1 });
    expect(selected()).toEqual(['a', 'b']);
    fireEvent.mouseUp(document);
    fireEvent.click(row('a'), { detail: 1 });
    expect(selected()).toEqual(['a', 'b']);
    expect(row('a').parentElement).not.toHaveAttribute('data-row-dragging');
    drag(row('e'), row('c'));
    expect(selected()).toEqual(['c', 'd', 'e']);
  });

  it.each(['ctrlKey', 'metaKey'] as const)('supports %s toggles and additive or subtractive drag ranges', (modifier) => {
    render(<Harness />);
    fireEvent.click(row('a'));
    fireEvent.click(row('e'), { [modifier]: true });
    expect(selected()).toEqual(['a', 'e']);
    fireEvent.mouseDown(row('c'), { button: 0, buttons: 1, [modifier]: true });
    fireEvent.mouseMove(row('d'), { buttons: 1, [modifier]: true });
    fireEvent.mouseUp(document);
    expect(selected()).toEqual(['a', 'c', 'd', 'e']);
    fireEvent.mouseDown(row('c'), { button: 0, buttons: 1, [modifier]: true });
    fireEvent.mouseMove(row('e'), { buttons: 1, [modifier]: true });
    fireEvent.mouseUp(document);
    expect(selected()).toEqual(['a']);
  });

  it('uses the current display order for Shift ranges and preserves IDs across filtering and paging', () => {
    const view = render(<Harness />);
    fireEvent.click(row('d'));
    view.rerender(<Harness ids={['e', 'd', 'c', 'b', 'a']} visible={['c', 'b', 'a']} />);
    expect(selected()).toEqual([]);
    fireEvent.click(row('a'), { shiftKey: true });
    expect(selected()).toEqual(['c', 'b', 'a']);
    expect(screen.getByLabelText('selected-rows')).toHaveTextContent('4');
    view.rerender(<Harness ids={['e', 'd', 'c', 'b', 'a']} visible={['e', 'd']} />);
    expect(selected()).toEqual(['d']);
    view.rerender(<Harness />);
    expect(selected()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not select for right clicks, text-selection modifiers, headers or row actions', async () => {
    const action = vi.fn();
    const user = userEvent.setup();
    render(<Harness onAction={action} />);
    fireEvent.mouseDown(row('b'), { button: 2, buttons: 2 });
    fireEvent.mouseMove(row('d'), { buttons: 2 });
    fireEvent.mouseDown(row('c'), { button: 0, buttons: 1, altKey: true });
    fireEvent.click(row('c'), { altKey: true });
    await user.click(screen.getByText('Value'));
    await user.click(screen.getByRole('button', { name: 'Action a' }));
    expect(selected()).toEqual([]);
    expect(action).toHaveBeenCalledTimes(1);
    drag(row('b'), row('d'));
    await user.click(screen.getByRole('button', { name: 'Action a' }));
    expect(action).toHaveBeenCalledTimes(2);
    expect(selected()).toEqual(['b', 'c', 'd']);
  });

  it('keeps native same-row text selection and suppresses it only after crossing rows', () => {
    render(<Harness />);
    const text = within(row('a')).getByText('a');
    fireEvent.mouseDown(text, { button: 0, buttons: 1 });
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    fireEvent.mouseMove(text, { buttons: 1 });
    expect(document.getSelection()!.toString()).toBe('a');
    expect(row('a').parentElement).not.toHaveAttribute('data-row-dragging');
    fireEvent.mouseMove(row('b'), { buttons: 1 });
    expect(document.getSelection()!.toString()).toBe('');
    expect(selected()).toEqual(['a', 'b']);
    fireEvent.mouseUp(document);
  });

  it.each(['mouseup', 'blur', 'released-buttons'] as const)('stops extending when a gesture ends via %s', (ending) => {
    render(<Harness />);
    fireEvent.mouseDown(row('b'), { button: 0, buttons: 1 });
    fireEvent.mouseMove(row('c'), { buttons: 1 });
    if (ending === 'mouseup') fireEvent.mouseUp(document.body);
    else if (ending === 'blur') fireEvent(window, new Event('blur'));
    else fireEvent.mouseMove(document.body, { buttons: 0 });
    fireEvent.mouseMove(row('e'), { buttons: 1 });
    expect(selected()).toEqual(['b', 'c']);
    expect(row('c').parentElement).not.toHaveAttribute('data-row-dragging');
  });

  it('isolates tables and cancels pending gestures on hide, scope change and unmount', () => {
    const removed = vi.spyOn(document, 'removeEventListener');
    const view = render(<><Harness /><Harness name="second" /></>);
    fireEvent.mouseDown(row('b'), { button: 0, buttons: 1 });
    fireEvent.mouseMove(row('d', 'second'), { buttons: 1 });
    expect(selected()).toEqual(['b']);
    expect(selected('second')).toEqual([]);
    view.rerender(<Harness active={false} />);
    fireEvent.mouseMove(row('e'), { buttons: 1 });
    expect(selected()).toEqual(['b']);
    fireEvent.click(row('e'));
    expect(selected()).toEqual(['b']);
    view.rerender(<Harness scope="next" />);
    expect(selected()).toEqual([]);
    fireEvent.mouseDown(row('a'), { button: 0, buttons: 1 });
    view.unmount();
    expect(removed).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('mouseup', expect.any(Function));
  });

  it('supports keyboard ranges, toggles, select-all and clearing without hijacking row buttons or Ctrl+Enter', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    row('a').focus();
    fireEvent.keyDown(row('a'), { key: 'ArrowDown', shiftKey: true });
    expect(row('b')).toHaveFocus();
    expect(selected()).toEqual(['a', 'b']);
    fireEvent.keyDown(row('b'), { key: 'End', shiftKey: true });
    expect(selected()).toEqual(IDS);
    fireEvent.keyDown(row('e'), { key: 'Home', ctrlKey: true });
    expect(row('a')).toHaveFocus();
    expect(selected()).toEqual(IDS);
    fireEvent.keyDown(row('a'), { key: 'Escape' });
    expect(selected()).toEqual([]);
    fireEvent.keyDown(row('a'), { key: ' ' });
    expect(selected()).toEqual(['a']);
    fireEvent.keyDown(row('a'), { key: ' ', isComposing: true });
    expect(selected()).toEqual(['a']);
    expect(fireEvent.keyDown(row('a'), { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(selected()).toEqual(['a']);
    fireEvent.keyDown(row('a'), { key: 'a', ctrlKey: true });
    expect(selected()).toEqual(IDS);
    await user.click(screen.getByRole('button', { name: 'Action c' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Action c' }), { key: 'ArrowUp' });
    expect(selected()).toEqual(IDS);
    fireEvent.keyDown(row('a'), { key: 'Escape' });
    expect(fireEvent.keyDown(row('a'), { key: 'Escape' })).toBe(true);
  });

  it('auto-scrolls the current table near its edge and cancels the animation on mouseup', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    render(<Harness />);
    const container = screen.getByTestId('scroll-rows');
    Object.defineProperties(container, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 200, top: 0, bottom: 100 } as DOMRect);
    for (const [index, id] of IDS.entries()) {
      vi.spyOn(row(id), 'getBoundingClientRect').mockImplementation(() => ({
        top: index * 30 - container.scrollTop, bottom: (index + 1) * 30 - container.scrollTop,
      } as DOMRect));
    }
    fireEvent.mouseDown(row('a'), { button: 0, buttons: 1, clientX: 50, clientY: 15 });
    fireEvent.mouseMove(row('c'), { buttons: 1, clientX: 50, clientY: 95 });
    act(() => frames[0]!(0));
    expect(container.scrollTop).toBe(12);
    expect(selected()).toEqual(['a', 'b', 'c', 'd']);
    fireEvent.mouseUp(document);
    expect(cancel).toHaveBeenCalled();
    act(() => frames.at(-1)!(1));
    expect(container.scrollTop).toBe(12);
  });
});

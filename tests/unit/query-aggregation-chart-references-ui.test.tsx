import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAggregationPage } from '../../src/domain/query-aggregations';
import { AggregationChart } from '../../src/features/query/charts/AggregationChart';
import { i18n } from '../../src/locales';
import { enQueryAggregationCharts as en, zhQueryAggregationCharts as zh } from '../../src/locales/query-aggregation-charts';

const fetchSpy = vi.fn();
const invokeSpy = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeSpy(...args) }));

function chartEntry(type = 'terms', values = ['10', '20'], metric = 'total') {
  const group = type === 'terms' ? { terms: { field: 'kind' } } : { date_histogram: { field: 'at', fixed_interval: '1h' } };
  const dsl = JSON.stringify({ aggs: { grouped: {
    ...group, aggs: { [metric]: { sum: { field: 'amount' } }, mean: { avg: { field: 'duration' } } },
  } } });
  const result = readAggregationPage(dsl, `{"aggregations":{"grouped":{"buckets":[${values.map((raw, index) =>
    `{"key":${index * 3600000},"doc_count":${index + 1},${JSON.stringify(metric)}:{"value":${raw}},"mean":{"value":${(index + 1) * 1000}}}`
  ).join(',')}]}}}`);
  if (!result.ok || !result.entries[0]) throw new Error('valid fixture');
  return result.entries[0];
}

async function panel(type = 'terms', values = ['10', '20'], metric = 'total') {
  const onMeasureChange = vi.fn();
  const view = render(<I18nextProvider i18n={i18n}>
    <AggregationChart entry={chartEntry(type, values, metric)}
      scope={{ target: 'orders-*', page: 1, bounds: null, limited: false }} onMeasureChange={onMeasureChange} />
  </I18nextProvider>);
  await screen.findByRole('img');
  fireEvent.change(screen.getByRole('combobox', { name: en.measure }), { target: { value: metric } });
  onMeasureChange.mockClear();
  return { ...view, onMeasureChange };
}

function dual() {
  fireEvent.click(screen.getByRole('switch', { name: en.dualToggle }));
  fireEvent.change(screen.getByRole('combobox', { name: en.measureRight }), { target: { value: 'mean' } });
}

function editValue(axis: string, raw: string) {
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByRole('combobox', { name: en.referenceAxis }), { target: { value: axis } });
  fireEvent.change(dialog.getByRole('textbox', { name: en.referenceValue }), { target: { value: raw } });
}
function apply() { fireEvent.click(screen.getByRole('button', { name: en.referenceApply })); }
function add(axis: string, raw: string) {
  fireEvent.click(screen.getByRole('button', { name: en.referenceAdd }));
  editValue(axis, raw);
  apply();
}
const refs = (root: HTMLElement) => [...root.querySelectorAll('.qac-svg .qac-reference-line')];
const originalPlot = (root: HTMLElement) =>
  [...root.querySelectorAll('.qac-bar, .qac-line, .qac-marker, .qac-axis')].map((node) => node.outerHTML);
const reference = (id: number) => screen.getByRole('listitem', { name: `Reference ${id}` });

beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(invokeSpy).not.toHaveBeenCalled();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('session reference line UI', () => {
  it.each(['terms', 'date_histogram'])('adds independent %s left and right references without changing any data geometry', async (type) => {
    const view = await panel(type);
    dual();
    const before = originalPlot(view.container);
    const svg = view.container.querySelector('.qac-svg')!;
    const frame = ['width', 'height', 'viewBox'].map((name) => svg.getAttribute(name));
    add('left', '5.00');
    add('right', '1500e0');
    expect(refs(view.container).map((node) => [node.getAttribute('data-axis'), Number(node.getAttribute('y1'))]))
      .toEqual([['left', 138], ['right', 46]]);
    expect(reference(1)).toHaveTextContent('Left axis: total (sum)');
    expect(reference(2)).toHaveTextContent('Right axis: mean (avg)');
    expect(reference(1).querySelector('code')?.textContent).toBe('5.00');
    expect(refs(view.container)[1]?.querySelector('title')).toHaveTextContent('right axis, mean (avg) = 1500e0');
    expect(originalPlot(view.container)).toEqual(before);
    expect(['width', 'height', 'viewBox'].map((name) => svg.getAttribute(name))).toEqual(frame);
    expect(view.onMeasureChange).not.toHaveBeenCalled();
  });

  it('requires an explicit axis, has no right option without a second measure, and retains invalid input for correction', async () => {
    const view = await panel();
    fireEvent.click(screen.getByRole('button', { name: en.referenceAdd }));
    const axis = screen.getByRole('combobox', { name: en.referenceAxis });
    expect(axis).toHaveValue('');
    expect(within(axis).queryByRole('option', { name: /Right axis/ })).toBeNull();
    apply();
    expect(screen.getByRole('alert')).toHaveTextContent(en.referenceError_axisRequired);
    expect(axis).toHaveFocus();
    editValue('left', 'Infinity');
    apply();
    expect(screen.getByRole('textbox', { name: en.referenceValue })).toHaveValue('Infinity');
    expect(screen.getByRole('alert')).toHaveTextContent(en.referenceError_invalidToken);
    expect(screen.getByRole('textbox', { name: en.referenceValue })).toHaveFocus();
    expect(refs(view.container)).toHaveLength(0);
    editValue('left', '1e1');
    apply();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(reference(1).querySelector('code')?.textContent).toBe('1e1');
    expect(view.onMeasureChange).not.toHaveBeenCalled();
  });

  it('edits only after apply, cancels without changing a line, and restores focus after deletion', async () => {
    const view = await panel();
    const user = userEvent.setup();
    dual();
    add('left', '10.000');
    const first = refs(view.container)[0]?.outerHTML;
    await user.click(screen.getByRole('button', { name: 'Edit reference line 1' }));
    expect(screen.getByRole('textbox', { name: en.referenceValue })).toHaveValue('10.000');
    editValue('right', '500.0');
    expect(refs(view.container)[0]?.outerHTML).toBe(first);
    await user.click(screen.getByRole('button', { name: en.referenceCancel }));
    expect(refs(view.container)[0]?.outerHTML).toBe(first);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit reference line 1' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Edit reference line 1' }));
    editValue('right', '500.0');
    apply();
    expect(refs(view.container)[0]).toHaveAttribute('data-axis', 'right');
    expect(refs(view.container)[0]).toHaveAttribute('y1', '138');
    expect(reference(1).querySelector('code')?.textContent).toBe('500.0');
    fireEvent.click(screen.getByRole('button', { name: 'Delete reference line 1' }));
    expect(refs(view.container)).toHaveLength(0);
    expect(screen.queryByRole('listitem', { name: 'Reference 1' })).toBeNull();
    expect(screen.getByRole('heading', { name: en.references })).toHaveFocus();
  });

  it('counts outside references toward the four-line limit, permits edits and reuses only the deleted identifier', async () => {
    const view = await panel();
    const user = userEvent.setup();
    dual();
    for (const [axis, raw] of [['left', '-100'], ['right', '10000'], ['left', '5'], ['right', '500']]) {
      await user.click(screen.getByRole('button', { name: en.referenceAdd }));
      editValue(axis!, raw!);
      apply();
    }
    expect(screen.getByRole('button', { name: en.referenceAdd })).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: en.referenceAdd })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: en.referenceAdd }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.container.querySelectorAll('.qac-reference-row')).toHaveLength(4);
    expect(refs(view.container)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Edit reference line 2' }));
    editValue('left', '10');
    apply();
    expect(refs(view.container)).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Delete reference line 2' }));
    add('right', '1000');
    expect([...view.container.querySelectorAll('.qac-reference-row')].map((node) => node.getAttribute('aria-label')))
      .toEqual(['Reference 1', 'Reference 3', 'Reference 4', 'Reference 2']);
  });

  it.each([
    ['1e400', en.referenceError_outOfRange],
    ['1e-400', en.referenceError_outOfRange],
    ['1.', en.referenceError_invalidToken],
    [`1.${'0'.repeat(4095)}`, en.referenceError_invalidToken],
  ])('rejects invalid numeric input without changing a previous line (%#)', async (raw, message) => {
    const view = await panel();
    add('left', '5.00');
    const before = originalPlot(view.container);
    const lines = refs(view.container).map((node) => node.outerHTML);
    fireEvent.click(screen.getByRole('button', { name: 'Edit reference line 1' }));
    editValue('left', raw);
    apply();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('textbox', { name: en.referenceValue })).toHaveValue(raw);
    expect(refs(view.container).map((node) => node.outerHTML)).toEqual(lines);
    expect(originalPlot(view.container)).toEqual(before);
  });

  it('refuses an unsafe doc_count threshold and a finite reference that overflows the span', async () => {
    const view = await panel('date_histogram', ['-1e308', '-1e307']);
    fireEvent.change(screen.getByRole('combobox', { name: en.measure }), { target: { value: 'doc_count' } });
    add('left', '9007199254740993');
    expect(screen.getByRole('alert')).toHaveTextContent(en.referenceError_unsafeCount);
    fireEvent.click(screen.getByRole('button', { name: en.referenceCancel }));
    fireEvent.change(screen.getByRole('combobox', { name: en.measure }), { target: { value: 'total' } });
    add('left', '1e308');
    expect(screen.getByRole('alert')).toHaveTextContent(en.referenceError_spanOutOfRange);
    expect(refs(view.container)).toHaveLength(0);
    expect(view.container.querySelector('.qac-svg')?.outerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('retains precision loss and out-of-domain literals separately without clamping them to the data edge', async () => {
    const view = await panel();
    const before = originalPlot(view.container);
    add('left', '0.10000000000000000001');
    expect(reference(1)).toHaveTextContent(en.referenceImprecise.replace('{{value}}', '0.1'));
    expect(refs(view.container)[0]).toHaveAttribute('data-precise', 'false');
    add('left', '20.000000000000000001');
    expect(reference(2)).toHaveTextContent(en.reference_above);
    expect(reference(2)).toHaveTextContent(en.referenceImprecise.replace('{{value}}', '20'));
    add('left', '-1');
    expect(reference(3)).toHaveTextContent(en.reference_below);
    expect(refs(view.container)).toHaveLength(1);
    expect(originalPlot(view.container)).toEqual(before);
  });

  it('keeps coincident references in distinct legend rows, with matching non-color-only strokes and no overlaid text', async () => {
    const view = await panel();
    dual();
    add('left', '10');
    add('right', '1000');
    expect(refs(view.container).map((node) => node.getAttribute('y1'))).toEqual(['92', '92']);
    expect(reference(1)).toHaveTextContent(en.referenceCoincident.replace('{{ids}}', '2'));
    expect(reference(2)).toHaveTextContent(en.referenceCoincident.replace('{{ids}}', '1'));
    expect(refs(view.container).map((node) => node.getAttribute('data-reference'))).toEqual(['1', '2']);
    expect([...view.container.querySelectorAll('.qac-reference-swatch line')].map((node) => node.getAttribute('data-reference')))
      .toEqual(['1', '2']);
    expect(view.container.querySelector('.qac-reference-layer text')).toBeNull();
  });

  it('retains full long labels and 4096-character values outside the plot, and treats labels as plain text', async () => {
    const metric = `<img src=x>${'long-metric'.repeat(80)}`;
    const view = await panel('terms', ['10', '20'], metric);
    const raw = `1.${'0'.repeat(4094)}`;
    add('left', raw);
    expect(reference(1)).toHaveTextContent(metric);
    expect(reference(1).querySelector('code')?.textContent).toBe(raw);
    expect(reference(1).querySelector('code')).toHaveAttribute('tabindex', '0');
    expect(view.container.querySelector('img, script, iframe, foreignObject')).toBeNull();
    expect(refs(view.container)[0]?.querySelector('title')?.textContent).toContain(raw);
  });

  it('uses the same raw value and geometry after a language change and translates controls and errors', async () => {
    const view = await panel('date_histogram');
    dual();
    add('right', '5.00e2');
    const y = refs(view.container)[0]?.getAttribute('y1');
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('heading', { name: zh.references })).toBeVisible();
    expect(view.container.querySelector('.qac-reference-raw')?.textContent).toBe('5.00e2');
    expect(refs(view.container)[0]?.getAttribute('y1')).toBe(y);
    fireEvent.click(screen.getByRole('button', { name: zh.referenceAdd }));
    fireEvent.click(screen.getByRole('button', { name: zh.referenceApply }));
    expect(screen.getByRole('alert')).toHaveTextContent(zh.referenceError_axisRequired);
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('supports keyboard editing and Escape cancellation without interpreting IME or modified Enter as apply', async () => {
    const view = await panel();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: en.referenceAdd }));
    await user.selectOptions(screen.getByRole('combobox', { name: en.referenceAxis }), 'left');
    const input = screen.getByRole('textbox', { name: en.referenceValue });
    await user.click(input);
    await user.type(input, '5.00');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(refs(view.container)).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeVisible();
    await user.keyboard('{Enter}');
    expect(reference(1).querySelector('code')?.textContent).toBe('5.00');
    await user.click(screen.getByRole('button', { name: 'Edit reference line 1' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(refs(view.container)).toHaveLength(1);
    expect(view.onMeasureChange).not.toHaveBeenCalled();
  });
});

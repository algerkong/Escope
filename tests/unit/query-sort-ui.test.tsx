import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuery, type QueryDocument, type QueryDocumentPatch } from '../../src/domain/query';
import { MAX_QUERY_SORT_FIELDS } from '../../src/domain/query-sort';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { QuerySortDialog } from '../../src/features/query/QuerySortDialog';
import type { Loadable } from '../../src/features/query/useQueryResources';
import { i18n } from '../../src/locales';
import { enQuerySort, zhQuerySort } from '../../src/locales/query-sort';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events',
  dsl: '{"query":{"term":{"original":9007199254740993}},"sort":["n","date"]}' };
const parsed = parseFieldCaps('{"fields":{"n":{"long":{"aggregatable":true}},"date":{"date":{"aggregatable":true}}}}');
if (!parsed.ok) throw new Error('fixture');
const ready: Loadable<FieldCatalog> = { status: 'ready', data: parsed.value };
function fixture(overrides: Partial<Parameters<typeof QuerySortDialog>[0]> = {}) {
  const props = { source, current: source, endpoint: 'https://fixture.test', fields: ready,
    targetCurrent: true, canInspect: true, onInspect: vi.fn(),
    onCommit: vi.fn<(source: QueryDocument, patch: QueryDocumentPatch) => boolean>(() => true), onClose: vi.fn(), ...overrides };
  const mount = (next = props) => <I18nextProvider i18n={i18n}><QuerySortDialog {...next} /></I18nextProvider>;
  const view = render(mount());
  return { ...view, props, rerenderWith: (patch: Partial<typeof props>) => view.rerender(mount({ ...props, ...patch })) };
}
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview sorted DSL' }));
const apply = () => screen.getByRole('button', { name: 'Apply sort to draft' });
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const final = () => (screen.getByLabelText('Final sorted DSL') as HTMLTextAreaElement).value;

describe('server sort review dialog', () => {
  it('requires changes and a complete preview, reorders rows and commits exactly what was reviewed', async () => {
    const f = fixture();
    expect(f.props.onInspect).not.toHaveBeenCalled();
    expect(apply()).toBeDisabled();
    preview();
    expect(apply()).toBeDisabled();
    expect(screen.getByText(enQuerySort.unchanged)).toBeVisible();
    change('Sort order 1', 'desc');
    change('Missing values 1', '_first');
    change('Unmapped targets 1', 'long');
    fireEvent.click(screen.getByRole('button', { name: 'Move sort 2 up' }));
    expect(screen.getByLabelText('Sort field 1')).toHaveValue('date');
    expect(screen.getByLabelText('Sort field 2')).toHaveValue('n');
    expect(screen.getByLabelText('Sort order 2')).toHaveValue('desc');
    expect(screen.getByLabelText('Unmapped targets 2')).toHaveValue('long');
    expect(apply()).toBeDisabled();
    preview();
    const text = final();
    expect(text).toContain('"original": 9007199254740993');
    expect(text.indexOf('"date":')).toBeLessThan(text.indexOf('"n":'));
    expect(text).toContain('"missing": "_first"');
    expect(text).toContain('"unmapped_type": "long"');
    expect(f.props.onCommit).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByLabelText('最终排序 DSL')).toHaveValue(text);
    expect(f.props.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用排序到草稿' }));
    expect(f.props.onCommit).toHaveBeenCalledExactlyOnceWith(source, { dsl: text });
    expect(f.props.onClose).toHaveBeenCalledOnce();
  });

  it('distinguishes missing values from unmapped targets, and defaults _score to descending', () => {
    fixture();
    change('Sort field 1', '_score');
    expect(screen.getByLabelText('Sort order 1')).toHaveValue('desc');
    expect(screen.getByLabelText('Missing values 1')).toBeDisabled();
    expect(screen.getByLabelText('Unmapped targets 1')).toBeDisabled();
    expect(screen.getByLabelText('Missing values 2')).toHaveAttribute('title', enQuerySort.missingBoundary);
    expect(screen.getByLabelText('Unmapped targets 2')).toHaveAttribute('title', enQuerySort.unmappedBoundary);
    preview();
    expect(final()).not.toContain('missing');
    expect(final()).not.toContain('unmapped_type');
    expect(screen.getByText('Multi-value: minimum')).toHaveAttribute('title', enQuerySort.modeBoundary);
  });

  it('invalidates a preview for field, direction, policy, order, add and remove changes', () => {
    fixture();
    change('Sort order 1', 'desc');
    preview();
    expect(apply()).toBeEnabled();
    for (const update of [
      () => change('Sort order 1', 'asc'),
      () => change('Missing values 1', '_last'),
      () => change('Unmapped targets 1', 'long'),
      () => fireEvent.click(screen.getByRole('button', { name: 'Move sort 1 down' })),
      () => fireEvent.click(screen.getByRole('button', { name: 'Add sort field' })),
    ]) {
      update();
      expect(apply()).toBeDisabled();
      expect(screen.queryByLabelText('Final sorted DSL')).not.toBeInTheDocument();
      preview();
    }
    expect(screen.getByRole('alert')).toHaveTextContent(enQuerySort.invalidField);
    fireEvent.click(screen.getByRole('button', { name: 'Remove sort 3' }));
    preview();
    expect(apply()).toBeEnabled();
    change('Sort field 1', 'n');
    expect(apply()).toBeDisabled();
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQuerySort.duplicateField);
  });

  it('checks evidence only on an explicit action and invalidates it during refresh or failure', () => {
    const f = fixture({ fields: { status: 'idle' } });
    change('Sort order 1', 'desc');
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQuerySort.fieldUnchecked);
    expect(f.props.onInspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check sort field capabilities' }));
    expect(f.props.onInspect).toHaveBeenCalledOnce();
    f.rerenderWith({ fields: ready });
    preview();
    expect(apply()).toBeEnabled();
    f.rerenderWith({ fields: { ...ready, refreshing: true } });
    expect(apply()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview sorted DSL' })).toBeDisabled();
    expect(screen.queryByLabelText('Final sorted DSL')).not.toBeInTheDocument();
    f.rerenderWith({ fields: { ...ready, refreshError: 'forbidden' } });
    expect(screen.getByText(enQuerySort.inspectionFailed)).toBeVisible();
    preview();
    expect(apply()).toBeDisabled();
    f.rerenderWith({ fields: { ...ready } });
    expect(apply()).toBeDisabled();
    preview();
    expect(apply()).toBeEnabled();
  });

  it.each(['revision', 'dsl', 'index', 'connection', 'parameters', 'closed', 'target'] as const)(
    'refuses changed %s after review', (kind) => {
      const f = fixture();
      change('Sort order 1', 'desc');
      preview();
      const current = kind === 'closed' ? undefined : { ...source,
        ...(kind === 'revision' ? { revision: 1 } : {}), ...(kind === 'dsl' ? { dsl: '{}' } : {}),
        ...(kind === 'index' ? { index: 'other' } : {}), ...(kind === 'connection' ? { connectionId: 'other' } : {}),
        ...(kind === 'parameters' ? { parameters: { version: 1, template: '{}', definitions: [] } } : {}) };
      f.rerenderWith({ current, targetCurrent: kind !== 'target' });
      expect(apply()).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(enQuerySort.draftChanged);
      fireEvent.click(apply());
      expect(f.props.onCommit).not.toHaveBeenCalled();
    });

  it('keeps the dialog open and disables further apply after a rejected final compare-and-swap', () => {
    const onCommit = vi.fn(() => false);
    const f = fixture({ onCommit });
    change('Sort order 1', 'desc');
    preview();
    fireEvent.click(apply());
    expect(onCommit).toHaveBeenCalledOnce();
    expect(f.props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(enQuerySort.draftChanged);
    expect(apply()).toBeDisabled();
  });

  it('preserves complex hand-written sort without exposing a destructive replacement', () => {
    const complex = { ...source, dsl: '{"sort":[{"n":{"order":"asc","mode":"avg","missing":9007199254740993}}]}' };
    const f = fixture({ source: complex, current: complex });
    expect(screen.getByRole('alert')).toHaveTextContent(enQuerySort.unsupportedSort);
    expect(screen.queryByRole('button', { name: 'Remove all sort fields' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add sort field' })).not.toBeInTheDocument();
    expect(apply()).toBeDisabled();
    fireEvent.click(screen.getByText('Current DSL'));
    expect(screen.getByText(complex.dsl)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(f.props.onCommit).not.toHaveBeenCalled();
    expect(f.props.onClose).toHaveBeenCalledOnce();
  });

  it('shows runtime declaration evidence without using a catalog and never changes the script', () => {
    const runtime = { ...source, dsl: '{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(42L);"}}},"sort":["n"]}' };
    fixture({ source: runtime, current: runtime, fields: { status: 'idle' } });
    expect(screen.getByText('long (DSL runtime declaration)')).toHaveAttribute('title', enQuerySort.runtimeBoundary);
    change('Sort order 1', 'desc');
    preview();
    expect(final()).toContain('"source": "emit(42L);"');
    expect(apply()).toBeEnabled();
  });

  it('supports explicit removal, bounds row count, and never commits on cancel', () => {
    const f = fixture();
    for (let index = 2; index < MAX_QUERY_SORT_FIELDS; index += 1) fireEvent.click(screen.getByRole('button', { name: 'Add sort field' }));
    expect(within(screen.getByRole('list', { name: 'Sort priority' })).getAllByRole('listitem')).toHaveLength(MAX_QUERY_SORT_FIELDS);
    expect(screen.getByRole('button', { name: 'Add sort field' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove all sort fields' }));
    expect(apply()).toBeDisabled();
    preview();
    expect(final()).not.toContain('"sort"');
    expect(final()).toContain('9007199254740993');
    expect(apply()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(f.props.onCommit).not.toHaveBeenCalled();
  });

  it('keeps bilingual labels, bounded responsive rows and inherited focus tokens', () => {
    expect(Object.keys(enQuerySort).sort()).toEqual(Object.keys(zhQuerySort).sort());
    const css = readFileSync('src/styles/query-sort.css', 'utf8');
    expect(css).toContain('var(--muted)');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain('minmax(0, 1fr)');
    expect(css).toContain('max-height: 300px');
    expect(css).toContain('@media (max-width: 520px)');
    expect(css).not.toMatch(/background:\s*#|gradient|letter-spacing:\s*-/);
    fixture();
    expect(screen.getByRole('button', { name: 'Move sort 2 up' })).toHaveAttribute('title');
    expect(screen.getByRole('button', { name: 'Move sort 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move sort 2 down' })).toBeDisabled();
  });
});

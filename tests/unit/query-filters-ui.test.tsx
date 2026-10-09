import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createQuery, createSnapshot, type QueryDocument, type QueryDocumentPatch } from '../../src/domain/query';
import { type CellFilterSelection, type QueryFilterDraft } from '../../src/domain/query-filters';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { QueryFiltersDialog } from '../../src/features/query/QueryFiltersDialog';
import type { Loadable } from '../../src/features/query/useQueryResources';
import { i18n } from '../../src/locales';
import { enQueryFilters, zhQueryFilters } from '../../src/locales/query-filters';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events-*', dsl: '{"query":{"term":{"original":9007199254740993}}}' };
const snapshot = createSnapshot(source, 'request', new Date('2026-10-10T00:00:00.000Z'));
const fieldResult = parseFieldCaps('{"fields":{"n":{"long":{"searchable":true}},"message":{"text":{"searchable":true}},"status":{"keyword":{"searchable":true}}}}');
if (!fieldResult.ok) throw new Error('fixture');
const ready: Loadable<FieldCatalog> = { status: 'ready', data: fieldResult.value };
const selected: CellFilterSelection = { field: 'n', value: { kind: 'number', text: '9007199254740993' }, origin: 'source' };

interface HarnessProps {
  current?: QueryDocument;
  fields?: Loadable<FieldCatalog>;
  selection?: CellFilterSelection;
  targetCurrent?: boolean;
  newQuery?: boolean;
  onCommit: (source: QueryDocument, patch: QueryDocumentPatch) => boolean;
  onInspect: () => void;
  onClose: () => void;
  onDiscard: () => void;
}
function Harness({ current, fields = ready, selection = selected, targetCurrent = true, newQuery = false, ...callbacks }: HarnessProps) {
  const [draft, setDraft] = useState<QueryFilterDraft>({ source, snapshot, endpoint: 'https://fixture.test', filters: [] });
  return <I18nextProvider i18n={i18n}><QueryFiltersDialog draft={draft} current={current} fields={fields}
    initialSelection={selection} targetCurrent={targetCurrent} canInspect newQuery={newQuery}
    onFiltersChange={(filters) => setDraft((state) => ({ ...state, filters }))} {...callbacks} /></I18nextProvider>;
}
function fixture(overrides: Partial<HarnessProps> = {}) {
  const onCommit = vi.fn(() => true);
  const onInspect = vi.fn();
  const onClose = vi.fn();
  const onDiscard = vi.fn();
  const props = { current: source, onCommit, onInspect, onClose, onDiscard, ...overrides };
  const view = render(<Harness {...props} />);
  return { ...view, props, onCommit, onInspect, onClose, onDiscard };
}
const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add to pending filters' }));
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview filtered DSL' }));
const apply = () => screen.getByRole('button', { name: 'Apply filters to draft' });

describe('cell filter review', () => {
  it('requires staging and explicit preview, preserves exact originals, and keeps language changes inert', async () => {
    const f = fixture();
    expect(screen.getByLabelText('Original JSON value')).toHaveValue('9007199254740993');
    expect(apply()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview filtered DSL' })).toBeDisabled();
    add();
    expect(screen.getByRole('list', { name: '1 pending filters' })).toHaveTextContent('9007199254740993');
    expect(apply()).toBeDisabled();
    preview();
    const final = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    expect(final).toContain('"original": 9007199254740993');
    expect(final).toContain('"n": 9007199254740993');
    expect(f.onCommit).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByLabelText('最终筛选 DSL')).toHaveValue(final);
    expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用筛选到草稿' }));
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith(source, { dsl: final });
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.onInspect).not.toHaveBeenCalled();
  });

  it('selects one original array token and makes analyzed text and exclusion semantics explicit', () => {
    const f = fixture({ selection: { field: 'message', value: { kind: 'array', text: '["first","second \\"quoted\\" phrase"]' }, origin: 'fields' } });
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'exclude' } });
    expect(screen.getByRole('option', { name: 'Exclude phrase' })).toBeInTheDocument();
    expect(screen.getByText(enQueryFilters.phraseBoundary)).toBeVisible();
    expect(screen.getByText(enQueryFilters.excludeBoundary)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Array element'), { target: { value: '1' } });
    expect(screen.getByLabelText('Original JSON value')).toHaveValue('"second \\"quoted\\" phrase"');
    add();
    preview();
    const text = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    expect(text).toContain('"match_phrase"');
    expect(text).toContain('"message": "second \\"quoted\\" phrase"');
    expect(text).not.toContain('keyword');
    expect(text).not.toContain('"first"');
    fireEvent.click(apply());
    expect(f.onCommit).toHaveBeenCalledOnce();
  });

  it('never translates a null cell into missing automatically', () => {
    fixture({ selection: { field: 'status', value: { kind: 'null', text: 'null' }, origin: 'source' } });
    expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeDisabled();
    expect(screen.getByText(enQueryFilters.noScalarValue)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'missing' } });
    expect(screen.getByText(enQueryFilters.presenceBoundary)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeEnabled();
    add();
    preview();
    expect((screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value).toContain('"exists"');
    expect((screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value).toContain('"must_not"');
  });

  it('loads evidence only on request and refuses unknown or failed evidence without a guessed type', () => {
    const f = fixture({ fields: { status: 'idle' } });
    expect(screen.getByText(enQueryFilters.fieldUnchecked)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeDisabled();
    expect(f.onInspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check field capabilities' }));
    expect(f.onInspect).toHaveBeenCalledOnce();
    f.rerender(<Harness {...f.props} fields={{ status: 'ready', data: ready.data, refreshError: 'forbidden' }} />);
    expect(screen.getByText('Field check failed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeDisabled();
    f.rerender(<Harness {...f.props} fields={ready} />);
    expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeEnabled();
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it.each(['revision', 'dsl', 'index', 'connection', 'closed', 'target'] as const)('refuses changed %s after preview', (change) => {
    const f = fixture();
    add();
    preview();
    const current = change === 'closed' ? undefined : { ...source, ...(change === 'revision' ? { revision: source.revision + 1 } : {}),
      ...(change === 'dsl' ? { dsl: '{}' } : {}), ...(change === 'index' ? { index: 'other' } : {}),
      ...(change === 'connection' ? { connectionId: 'other' } : {}) };
    f.rerender(<Harness {...f.props} current={current} targetCurrent={change !== 'target'} />);
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.draftChanged);
    expect(apply()).toBeDisabled();
    fireEvent.click(apply());
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('invalidates preview when evidence refreshes, even when the same catalog is returned', () => {
    const f = fixture();
    add();
    preview();
    expect(apply()).toBeEnabled();
    f.rerender(<Harness {...f.props} fields={{ ...ready, refreshing: true }} />);
    expect(apply()).toBeDisabled();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    f.rerender(<Harness {...f.props} fields={{ ...ready }} />);
    expect(apply()).toBeDisabled();
    preview();
    expect(apply()).toBeEnabled();
  });

  it('removes or discards pending filters without committing and invalidates prior review', () => {
    const f = fixture();
    add();
    preview();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter for n' }));
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    expect(apply()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard pending filters' }));
    expect(f.onDiscard).toHaveBeenCalledOnce();
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('keeps a rejected final compare-and-swap open instead of claiming success', () => {
    const f = fixture();
    f.onCommit.mockReturnValue(false);
    add();
    preview();
    fireEvent.click(apply());
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.draftChanged);
    expect(apply()).toBeDisabled();
    expect(f.onClose).not.toHaveBeenCalled();
    fireEvent.click(apply());
    expect(f.onCommit).toHaveBeenCalledOnce();
  });

  it('labels locked-index output as a new query and leaves creation to the explicit final action', () => {
    const f = fixture({ newQuery: true });
    expect(screen.getByText('New query')).toBeVisible();
    add();
    preview();
    expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open filtered query' }));
    expect(f.onCommit).toHaveBeenCalledOnce();
  });

  it('keeps bilingual keys and bounded token-based layout with keyboard-visible cell controls', () => {
    expect(Object.keys(enQueryFilters).sort()).toEqual(Object.keys(zhQueryFilters).sort());
    const style = readFileSync('src/styles/query-filters.css', 'utf8');
    const grid = readFileSync('src/styles/result-grid.css', 'utf8');
    expect(style).toContain('var(--muted)');
    expect(style).toContain('overflow-wrap: anywhere');
    expect(style).toContain('min-width: 0');
    expect(style).not.toMatch(/background:\s*#|gradient|letter-spacing:\s*-/);
    expect(grid).toContain('.rg-filter-cell:focus-within');
    expect(grid).toContain('flex: 0 0 22px');
    expect(grid).toContain('@media (hover: none)');
    fixture();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Check field capabilities' })).toHaveAttribute('title');
  });
});

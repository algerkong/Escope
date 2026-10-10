import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createQuery, createSnapshot, updateWorkspaceDocument, type QueryDocument, type QueryDocumentPatch } from '../../src/domain/query';
import { MAX_FILTER_GROUPS, MAX_QUERY_FILTERS, type CellFilterSelection, type QueryFilter, type QueryFilterComposition, type QueryFilterDraft } from '../../src/domain/query-filters';
import { bindAppliedQueryFilters, previewQueryFilterDraft } from '../../src/domain/query-filter-session';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { QueryFiltersDialog } from '../../src/features/query/QueryFiltersDialog';
import type { Loadable, MappingState } from '../../src/features/query/useQueryResources';
import { i18n } from '../../src/locales';
import { enQueryFilters, zhQueryFilters } from '../../src/locales/query-filters';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events-*', dsl: '{"query":{"term":{"original":9007199254740993}}}' };
const snapshot = createSnapshot(source, 'request', new Date('2026-10-10T00:00:00.000Z'));
const fieldResult = parseFieldCaps('{"fields":{"n":{"long":{"searchable":true}},"message":{"text":{"searchable":true}},"status":{"keyword":{"searchable":true}}}}');
if (!fieldResult.ok) throw new Error('fixture');
const ready = { status: 'ready', data: fieldResult.value } satisfies Loadable<FieldCatalog>;
const selected: CellFilterSelection = { field: 'n', value: { kind: 'number', text: '9007199254740993' }, origin: 'source' };
const idleMapping: Loadable<MappingState> = { status: 'idle' };

interface HarnessProps {
  current?: QueryDocument;
  fields?: Loadable<FieldCatalog>;
  mapping?: Loadable<MappingState>;
  selection?: CellFilterSelection | null;
  initialDraft?: QueryFilterDraft;
  targetCurrent?: boolean;
  newQuery?: boolean;
  onCommit: (source: QueryDocument, patch: QueryDocumentPatch) => boolean;
  onInspect: () => void;
  onClose: () => void;
  onDiscard: () => void;
}
function Harness({ current, fields = ready, mapping = idleMapping, selection = selected, initialDraft, targetCurrent = true, newQuery = false, ...callbacks }: HarnessProps) {
  const [draft, setDraft] = useState<QueryFilterDraft>(initialDraft ?? { source, snapshot, endpoint: 'https://fixture.test', filters: [] });
  return <I18nextProvider i18n={i18n}><QueryFiltersDialog draft={draft} current={current} fields={fields} mapping={mapping} onInspectNested={callbacks.onInspect}
    initialSelection={selection ?? undefined} targetCurrent={targetCurrent} canInspect newQuery={newQuery}
    onFiltersChange={(filters, composition) => setDraft((state) => ({ ...state, filters, composition }))} {...callbacks} /></I18nextProvider>;
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
const join = (label: string, mode: 'all' | 'any') =>
  fireEvent.click(within(screen.getByRole('radiogroup', { name: label })).getByRole('radio', { name: enQueryFilters[mode] }));
const groupDraft = (composition?: QueryFilterComposition): QueryFilterDraft => ({
  source, snapshot, endpoint: 'https://fixture.test', composition,
  filters: [
    { id: 'n', field: 'n', fieldType: 'long', evidence: 'mapped', operation: 'include', value: '9007199254740993', origin: 'source' },
    { id: 'status', field: 'status', fieldType: 'keyword', evidence: 'mapped', operation: 'exclude', value: '"blocked"', origin: 'source' },
    { id: 'message', field: 'message', fieldType: 'text', evidence: 'mapped', operation: 'include', value: '"some words"', origin: 'source' },
  ],
});

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
    expect(style).toContain('input:focus-visible');
    expect(style).toContain('@media (forced-colors: active)');
    expect(style).toContain('.qfilter-group-modes { max-height: 160px; overflow: auto; }');
    expect(style).not.toMatch(/background:\s*#|gradient|letter-spacing:\s*-/);
    expect(grid).toContain('.rg-filter-cell:focus-within');
    expect(grid).toContain('flex: 0 0 22px');
    expect(grid).toContain('@media (hover: none)');
    fixture();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Check field capabilities' })).toHaveAttribute('title');
  });
});

describe('filter group review controls', () => {
  it('reviews group and root AND/OR changes, keeps exclusions local, and preserves the review across languages', async () => {
    const f = fixture({ selection: null, initialDraft: groupDraft() });
    preview();
    expect(apply()).toBeEnabled();
    join('Group 1 operator', 'any');
    expect(apply()).toBeDisabled();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    expect(screen.getByText('minimum_should_match: 1')).toHaveAttribute('title', enQueryFilters.orBoundary);
    const groupSelect = screen.getByLabelText('Group for status');
    groupSelect.focus();
    fireEvent.change(groupSelect, { target: { value: 'new' } });
    expect(groupSelect).toHaveFocus();
    expect(screen.getByRole('radiogroup', { name: 'Group 2 operator' })).toBeVisible();
    join('Between groups', 'any');
    preview();
    const final = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    const bool = JSON.parse(final).query.bool;
    expect(bool.should).toBeUndefined();
    expect(bool.must_not).toBeUndefined();
    expect(bool.filter[0].bool.minimum_should_match).toBe(1);
    expect(bool.filter[0].bool.should[0].bool.minimum_should_match).toBe(1);
    expect(bool.filter[0].bool.should[1].bool.must_not).toEqual([{ term: { status: 'blocked' } }]);
    expect(final).toContain('9007199254740993');
    expect(screen.getByText('Filter context')).toHaveAttribute('title', enQueryFilters.scoringBoundary);
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(within(screen.getByRole('radiogroup', { name: '组间关系' })).getByRole('radio', { name: '任一 (OR)' })).toBeChecked();
    expect(screen.getByLabelText('最终筛选 DSL')).toHaveValue(final);
    expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用筛选到草稿' }));
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith(source, { dsl: final });
    expect(f.onInspect).not.toHaveBeenCalled();
  });

  it('can add a new cell to a new group and remove or merge groups without dropping other conditions', () => {
    const f = fixture({ initialDraft: groupDraft(), selection: { field: 'status', value: { kind: 'string', text: 'ready' }, origin: 'source' } });
    fireEvent.change(screen.getByLabelText('Add to group'), { target: { value: 'new' } });
    add();
    expect(screen.getByRole('list', { name: '4 pending filters' })).toBeVisible();
    join('Between groups', 'any');
    preview();
    expect(JSON.parse((screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value).query.bool.filter[0].bool.should).toHaveLength(2);
    const assignments = screen.getAllByLabelText('Group for status');
    const firstGroup = (screen.getByLabelText('Group for n') as HTMLSelectElement).value;
    fireEvent.change(assignments[1]!, { target: { value: firstGroup } });
    expect(screen.queryByRole('radiogroup', { name: 'Group 2 operator' })).not.toBeInTheDocument();
    expect(apply()).toBeDisabled();
    preview();
    expect((screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value).toContain('"ready"');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter for message' }));
    expect(screen.getByRole('list', { name: '3 pending filters' })).toBeVisible();
    expect(apply()).toBeDisabled();
    expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard pending filters' }));
    expect(f.onDiscard).toHaveBeenCalledOnce();
  });

  it('invalidates an already reviewed composition when only its identity changes upstream', () => {
    const draft = groupDraft({ mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: ['n', 'status', 'message'] }] });
    const props = { draft, current: source, fields: ready, mapping: idleMapping, targetCurrent: true, canInspect: true, newQuery: false,
      onInspect: vi.fn(), onInspectNested: vi.fn(), onFiltersChange: vi.fn(), onCommit: vi.fn(() => true), onDiscard: vi.fn(), onClose: vi.fn() };
    const renderDialog = (next: QueryFilterDraft) => <I18nextProvider i18n={i18n}><QueryFiltersDialog {...props} draft={next} /></I18nextProvider>;
    const f = render(renderDialog(draft));
    preview();
    expect(apply()).toBeEnabled();
    f.rerender(renderDialog({ ...draft, composition: structuredClone(draft.composition) }));
    expect(apply()).toBeDisabled();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('requires fresh field evidence and refuses malformed groups instead of silently dropping a leaf', () => {
    const draft = groupDraft({ mode: 'any', groups: [{ id: 'g', mode: 'any', filterIds: ['n', 'status'] }] });
    const f = fixture({ selection: null, initialDraft: draft });
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.invalidComposition);
    expect(apply()).toBeDisabled();
    f.rerender(<Harness {...f.props} fields={{ status: 'error', code: 'forbidden' }} />);
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.fieldUnchecked);
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('exposes native keyboard radio behavior without applying or requesting data', async () => {
    const f = fixture({ selection: null, initialDraft: groupDraft() });
    const control = screen.getByRole('radiogroup', { name: 'Group 1 operator' });
    within(control).getByRole('radio', { name: 'All (AND)' }).focus();
    await userEvent.setup().keyboard('{ArrowRight}');
    const any = within(control).getByRole('radio', { name: 'Any (OR)' });
    expect(any).toBeChecked();
    expect(any).toHaveFocus();
    expect(apply()).toBeDisabled();
    expect(f.onCommit).not.toHaveBeenCalled();
    expect(f.onInspect).not.toHaveBeenCalled();
  });

  it.each([MAX_FILTER_GROUPS, MAX_QUERY_FILTERS])('enforces group and filter limits for a %i-leaf draft', (count) => {
    const filters: QueryFilter[] = Array.from({ length: count }, (_, index) => ({ ...groupDraft().filters[0]!, id: `n-${index}`, value: String(index) }));
    const initialDraft: QueryFilterDraft = { ...groupDraft(), filters, composition: { mode: 'all',
      groups: Array.from({ length: MAX_FILTER_GROUPS }, (_, index) => ({ id: `g-${index}`, mode: 'all',
        filterIds: filters.filter((_, position) => position % MAX_FILTER_GROUPS === index).map((filter) => filter.id) })) } };
    fixture({ initialDraft });
    const groupSelect = screen.getByLabelText('Add to group');
    expect(within(groupSelect).getByRole('option', { name: 'New group' })).toBeDisabled();
    if (count === MAX_QUERY_FILTERS) {
      expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeDisabled();
      expect(screen.getByText(enQueryFilters.tooMany)).toBeVisible();
    } else {
      expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeEnabled();
      fireEvent.change(groupSelect, { target: { value: 'new' } });
      expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeDisabled();
      expect(screen.getByText(enQueryFilters.tooManyGroups)).toBeVisible();
    }
  });
});

describe('session filter enablement controls', () => {
  const toggle = (field: string) => screen.getByRole('switch', { name: `Filter enabled for ${field}` });
  const final = () => (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;

  it('toggles with the native keyboard while retaining values, membership and group operators', async () => {
    const f = fixture({ selection: null, initialDraft: groupDraft() });
    join('Group 1 operator', 'any');
    const assignment = (screen.getByLabelText('Group for n') as HTMLSelectElement).value;
    preview();
    const original = final();
    toggle('n').focus();
    await userEvent.setup().keyboard(' ');
    expect(toggle('n')).not.toBeChecked();
    expect(toggle('n')).toHaveFocus();
    expect(toggle('n')).toHaveAttribute('title', enQueryFilters.enable);
    expect(toggle('n')).toHaveAccessibleDescription('Include value 9007199254740993');
    expect(screen.getByLabelText('Group for n')).toHaveValue(assignment);
    expect(within(screen.getByRole('radiogroup', { name: 'Group 1 operator' })).getByRole('radio', { name: 'Any (OR)' })).toBeChecked();
    const item = toggle('n').closest('li')!;
    expect(item).toHaveAttribute('data-filter-disabled', 'true');
    expect(item).toHaveTextContent('Disabled');
    expect(item).toHaveTextContent('9007199254740993');
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    expect(apply()).toBeDisabled();
    preview();
    expect(final()).not.toContain('"n":');
    expect(final()).toContain('"original": 9007199254740993');
    expect(apply()).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(toggle('n'));
    expect(toggle('n')).toBeChecked();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    preview();
    expect(final()).toBe(original);
    expect(apply()).toBeEnabled();
    expect(f.onCommit).not.toHaveBeenCalled();
    expect(f.onInspect).not.toHaveBeenCalled();
  });

  it('retains fully inactive groups and previews the exact original body without permitting a no-op commit', () => {
    const draft = groupDraft({ mode: 'any', groups: [
      { id: 'first', mode: 'any', filterIds: ['n', 'message'] },
      { id: 'second', mode: 'all', filterIds: ['status'] },
    ] });
    const f = fixture({ selection: null, initialDraft: draft });
    for (const field of ['n', 'status', 'message']) fireEvent.click(toggle(field));
    expect(screen.getByRole('list', { name: '3 pending filters' })).toBeVisible();
    expect(screen.getByText('Group 1: 0 / 2 enabled')).toHaveAttribute('title', enQueryFilters.inactiveGroupBoundary);
    expect(screen.getByText('Group 2: 0 / 1 enabled')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('0 / 3 enabled');
    expect(screen.getByRole('status')).toHaveTextContent(enQueryFilters.allDisabled);
    preview();
    expect(final()).toBe(source.dsl);
    expect(apply()).toBeDisabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(apply());
    expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.click(toggle('n'));
    expect(screen.getByLabelText('Group for n')).toHaveValue('first');
    expect(screen.getByLabelText('Group for status')).toHaveValue('second');
    preview();
    const branches = JSON.parse(final()).query.bool.filter[0].bool;
    expect(branches.minimum_should_match).toBe(1);
    expect(branches.should).toHaveLength(1);
    expect(branches.should[0].bool.minimum_should_match).toBe(1);
    expect(branches.should[0].bool.should).toHaveLength(1);
    expect(final()).toContain('"n": 9007199254740993');
    expect(final()).not.toContain('blocked');
    expect(f.onInspect).not.toHaveBeenCalled();
  });

  it('keeps disabled definitions through mixed application without asking to discard them, and renews review after edits', async () => {
    const f = fixture({ selection: null, initialDraft: groupDraft() });
    fireEvent.click(toggle('message'));
    preview();
    expect(apply()).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(f.onCommit).not.toHaveBeenCalled();
    join('Group 1 operator', 'any');
    expect(apply()).toBeDisabled();
    preview();
    expect(apply()).toBeEnabled();
    f.rerender(<Harness {...f.props} fields={{ ...ready }} />);
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    expect(apply()).toBeDisabled();
    preview();
    expect(apply()).toBeEnabled();
    const reviewed = final();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('switch', { name: 'message 筛选启用状态' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('最终筛选 DSL')).toHaveValue(reviewed);
    expect(f.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '应用筛选到草稿' }));
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith(source, { dsl: reviewed });
    expect(f.onClose).toHaveBeenCalledOnce();
  });

  it.each(['source', 'snapshot', 'endpoint'] as const)('does not reuse a preview after the session %s changes', (change) => {
    const draft = { ...groupDraft(), filters: groupDraft().filters.map((filter) => ({ ...filter, enabled: filter.id !== 'message' })) };
    const props = { current: source, fields: ready, mapping: idleMapping, targetCurrent: true, canInspect: true, newQuery: false,
      onInspect: vi.fn(), onInspectNested: vi.fn(), onFiltersChange: vi.fn(), onCommit: vi.fn(() => true), onDiscard: vi.fn(), onClose: vi.fn() };
    const renderDialog = (next: QueryFilterDraft) => <I18nextProvider i18n={i18n}><QueryFiltersDialog {...props} current={next.source} draft={next} /></I18nextProvider>;
    const view = render(renderDialog(draft));
    preview();
    expect(apply()).toBeEnabled();
    const next: QueryFilterDraft = { ...draft,
      ...(change === 'source' ? { source: { ...source, revision: source.revision + 1, dsl: '{"size":25}' } }
        : change === 'snapshot' ? { snapshot: { ...snapshot, requestId: 'new-request' } }
          : { endpoint: 'https://other.test' }) };
    view.rerender(renderDialog(next));
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    expect(apply()).toBeDisabled();
    expect(toggle('message')).not.toBeChecked();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('requires current evidence again when re-enabling a disabled condition', () => {
    const initialDraft = { ...groupDraft(), filters: groupDraft().filters.map((filter) => ({ ...filter, enabled: filter.id === 'status' })) };
    const onlyStatus: Loadable<FieldCatalog> = { ...ready, data: { ...ready.data, fields: ready.data.fields.filter((field) => field.name === 'status') } };
    const f = fixture({ selection: null, initialDraft, fields: onlyStatus });
    preview();
    expect(screen.getByLabelText('Final filtered DSL')).toBeVisible();
    fireEvent.click(toggle('n'));
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.fieldMissing);
    expect(apply()).toBeDisabled();
    expect(toggle('n')).toBeChecked();
    f.rerender(<Harness {...f.props} fields={ready} />);
    preview();
    expect(screen.getByLabelText('Final filtered DSL')).toBeVisible();
    expect(apply()).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('does not bypass target guards or duplicate and group quotas using disabled definitions', () => {
    const initialDraft = { ...groupDraft(), filters: groupDraft().filters.map((filter) => ({ ...filter, enabled: false })) };
    const f = fixture({ initialDraft });
    expect(screen.getByText(enQueryFilters.duplicate)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeDisabled();
    preview();
    f.rerender(<Harness {...f.props} targetCurrent={false} />);
    expect(toggle('n')).toBeDisabled();
    expect(apply()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.draftChanged);
    expect(f.onCommit).not.toHaveBeenCalled();
  });
});

describe('applied session filter review', () => {
  function boundFixture() {
    const first = groupDraft();
    const result = previewQueryFilterDraft(first, ready.data);
    if (!result.ok) throw new Error(result.code);
    const applied = updateWorkspaceDocument({ activeConnectionId: source.connectionId, activeTabId: source.id,
      tabs: [{ kind: 'query', document: source }], lastTabByConnection: {} }, source.id, result.patch).tabs[0]!.document;
    const binding = bindAppliedQueryFilters(first, applied, ready.data);
    if (!binding) throw new Error('binding');
    const draft: QueryFilterDraft = { source: applied, snapshot, endpoint: binding.endpoint,
      binding, filters: structuredClone(binding.filters), composition: structuredClone(binding.composition) };
    return { binding, ...fixture({ current: applied, initialDraft: draft, selection: null }) };
  }

  it('requires an actual edit and fresh preview, then reviews all-disabled as exact baseline restoration', () => {
    const f = boundFixture();
    preview();
    expect(apply()).toBeDisabled();
    expect(screen.getByText('Baseline DSL')).toBeInTheDocument();
    expect(screen.getByText('Applied in this session')).toHaveAttribute('title', enQueryFilters.sessionOnly);
    for (const field of ['n', 'status', 'message']) fireEvent.click(screen.getByRole('switch', { name: `Filter enabled for ${field}` }));
    expect(screen.getByText(enQueryFilters.boundDisabled)).toBeVisible();
    expect(apply()).toBeDisabled();
    preview();
    expect(screen.getByLabelText('Final filtered DSL')).toHaveValue(source.dsl);
    expect(apply()).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(apply());
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith(f.binding.applied, { dsl: source.dsl });
  });

  it('reviews last-definition removal, keeping cancellation distinct from changing the DSL', () => {
    const f = boundFixture();
    for (const field of ['n', 'status', 'message']) fireEvent.click(screen.getByRole('button', { name: `Remove filter for ${field}` }));
    expect(screen.getByText(enQueryFilters.boundRemoved)).toBeVisible();
    expect(apply()).toBeDisabled();
    preview();
    expect(screen.getByLabelText('Final filtered DSL')).toHaveValue(source.dsl);
    expect(apply()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard pending filters' }));
    expect(f.onDiscard).toHaveBeenCalledOnce();
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('blocks overwritten or cloned bindings even for removal and all-disabled previews', () => {
    const f = boundFixture();
    for (const field of ['n', 'status', 'message']) fireEvent.click(screen.getByRole('switch', { name: `Filter enabled for ${field}` }));
    preview();
    expect(apply()).toBeEnabled();
    f.rerender(<Harness {...f.props} current={{ ...f.binding.applied, dsl: '{}', revision: f.binding.applied.revision + 1 }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.filterBindingChanged);
    expect(apply()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove filter for n' })).toBeDisabled();
    expect(f.onCommit).not.toHaveBeenCalled();
  });

  it('does not apply a toggle cycle that returns to the already bound definitions', () => {
    const f = boundFixture();
    const toggle = screen.getByRole('switch', { name: 'Filter enabled for n' });
    fireEvent.click(toggle);
    preview();
    expect(apply()).toBeEnabled();
    fireEvent.click(toggle);
    preview();
    expect(apply()).toBeDisabled();
    expect(screen.getByLabelText('Final filtered DSL')).toHaveValue(f.binding.applied.dsl);
    expect(f.onCommit).not.toHaveBeenCalled();
  });
});

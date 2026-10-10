import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import type { QueryFilter, QueryFilterComposition, QueryFilterDraft } from '../../src/domain/query-filters';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { QueryFiltersDialog } from '../../src/features/query/QueryFiltersDialog';
import type { Loadable, MappingState } from '../../src/features/query/useQueryResources';
import { i18n } from '../../src/locales';
import { enQueryFilters } from '../../src/locales/query-filters';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events-*',
  dsl: '{"query":{"term":{"original":9007199254740993}},"sort":[{"n":"desc"}]}' };
const snapshot = createSnapshot(source, 'request', new Date('2026-10-10T00:00:00.000Z'));
const rawMapping = JSON.stringify({ events: { mappings: { properties: {
  comments: { type: 'nested', properties: { author: { type: 'keyword' }, n: { type: 'long' }, active: { type: 'boolean' }, text: { type: 'text' } } },
  tags: { type: 'nested', properties: { name: { type: 'keyword' } } }, status: { type: 'keyword' },
} } } });
const mapping: Loadable<MappingState> = { status: 'ready', data: { raw: rawMapping, fields: [] } };
const parsed = parseFieldCaps(JSON.stringify({ indices: ['events'], fields: {
  'comments.author': { keyword: { searchable: true } }, 'comments.n': { long: { searchable: true } },
  'comments.active': { boolean: { searchable: true } }, 'comments.text': { text: { searchable: true } },
  'tags.name': { keyword: { searchable: true } }, status: { keyword: { searchable: true } },
} }));
if (!parsed.ok) throw new Error('fixture');
const fields: Loadable<FieldCatalog> = { status: 'ready', data: parsed.value };
const draft: QueryFilterDraft = { source, snapshot, endpoint: 'https://fixture.test', filters: [] };
const pending = (name: string, value: string, id = name): QueryFilter =>
  ({ id, field: name, fieldType: 'keyword', evidence: 'mapped', operation: 'include', value, nestedPath: name.split('.')[0]!, origin: 'input' });
const flat: QueryFilter = { id: 'flat', field: 'status', fieldType: 'keyword', evidence: 'mapped', operation: 'include', value: '"ready"', origin: 'source' };
const initial = (filters: readonly QueryFilter[], composition: QueryFilterComposition): QueryFilterDraft => ({ ...draft, filters, composition });

type DialogProps = React.ComponentProps<typeof QueryFiltersDialog>;
function Harness({ draft: initialDraft, ...props }: DialogProps) {
  const [state, setState] = useState(initialDraft);
  return <I18nextProvider i18n={i18n}><QueryFiltersDialog {...props} draft={state}
    onFiltersChange={(filters, composition) => {
      setState((current) => ({ ...current, filters, composition }));
      props.onFiltersChange(filters, composition);
    }} /></I18nextProvider>;
}
function fixture(overrides: Partial<DialogProps> = {}) {
  const props: DialogProps = { draft, current: source, fields, mapping, initialNested: true,
    targetCurrent: true, canInspect: true, newQuery: false, onInspect: vi.fn(), onInspectNested: vi.fn(),
    onCommit: vi.fn(() => true), onFiltersChange: vi.fn(), onDiscard: vi.fn(), onClose: vi.fn(), ...overrides };
  const view = render(<Harness {...props} />);
  return { ...view, props };
}
const path = (value = 'comments') => fireEvent.change(screen.getByLabelText('Nested path'), { target: { value } });
const field = (value = 'comments.author') => fireEvent.change(screen.getByLabelText('Nested field'), { target: { value } });
const value = (text: string) => fireEvent.change(screen.getByLabelText('Entered value'), { target: { value: text } });
const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add nested condition' }));
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview filtered DSL' }));
const apply = () => screen.getByRole('button', { name: 'Apply filters to draft' });
const final = () => (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
const join = (label: string, mode: 'all' | 'any') =>
  fireEvent.click(within(screen.getByRole('radiogroup', { name: label })).getByRole('radio', { name: enQueryFilters[mode] }));

describe('explicit nested filter editor', () => {
  it('reads Mapping only on request, stages exact input values, and requires a complete preview before applying', () => {
    const f = fixture({ fields: { status: 'idle' }, mapping: { status: 'idle' } });
    expect(screen.getByText(enQueryFilters.mappingUnchecked)).toBeVisible();
    expect(screen.getByLabelText('Nested path')).toBeDisabled();
    expect(f.props.onInspectNested).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check Mapping and field capabilities' }));
    expect(f.props.onInspectNested).toHaveBeenCalledOnce();
    f.rerender(<Harness {...f.props} fields={fields} mapping={mapping} />);
    path();
    field('comments.n');
    value('9007199254740993');
    add();
    expect(screen.getByRole('list', { name: '1 pending filters' })).toHaveTextContent('9007199254740993');
    expect(screen.getByLabelText('Nested field')).toHaveValue('');
    expect(apply()).toBeDisabled();
    expect(f.props.onCommit).not.toHaveBeenCalled();
    preview();
    expect(final()).toContain('"comments.n": 9007199254740993');
    expect(final()).toContain('"original": 9007199254740993');
    expect(final()).toContain('"score_mode": "none"');
    expect(final()).toContain('"ignore_unmapped": false');
    expect(JSON.parse(final()).sort).toEqual([{ n: 'desc' }]);
    const reviewed = final();
    fireEvent.click(apply());
    expect(f.props.onCommit).toHaveBeenCalledExactlyOnceWith(source, { dsl: reviewed });
    expect(f.props.onClose).toHaveBeenCalledOnce();
    expect(f.props.onInspect).not.toHaveBeenCalled();
  });

  it('keeps successive conditions in one explicit object group and makes inner and parent negation separate', async () => {
    const f = fixture();
    path();
    field();
    value('alice');
    add();
    field('comments.n');
    value('2');
    fireEvent.change(screen.getByLabelText('Condition within object'), { target: { value: 'exclude' } });
    expect(screen.getByText(enQueryFilters.nestedInnerBoundary)).toBeVisible();
    add();
    expect(screen.queryByRole('radiogroup', { name: 'Group 2 operator' })).not.toBeInTheDocument();
    preview();
    const nested = JSON.parse(final()).query.bool.filter[0].nested;
    expect(nested.query.bool).toEqual({ filter: [{ term: { 'comments.author': 'alice' } }], must_not: [{ term: { 'comments.n': 2 } }] });
    const match = screen.getByLabelText('Group 1 parent match');
    expect(match).toHaveAttribute('title', enQueryFilters.nestedSameObject);
    fireEvent.change(match, { target: { value: 'exclude' } });
    expect(match).toHaveAttribute('title', enQueryFilters.nestedOuterBoundary);
    expect(apply()).toBeDisabled();
    preview();
    expect(JSON.parse(final()).query.bool.must_not[0].nested.query.bool.must_not).toEqual([{ term: { 'comments.n': 2 } }]);
    join('Group 1 operator', 'any');
    expect(apply()).toBeDisabled();
    preview();
    expect(JSON.parse(final()).query.bool.must_not[0].nested.query.bool.minimum_should_match).toBe(1);
    const reviewed = final();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByLabelText('组 1 父文档匹配')).toHaveValue('exclude');
    expect(screen.getByLabelText('最终筛选 DSL')).toHaveValue(reviewed);
    expect(f.props.onCommit).not.toHaveBeenCalled();
    expect(f.props.onInspectNested).not.toHaveBeenCalled();
  });

  it('does not move nested conditions into flat or different-path groups, and permits identical leaves in independent groups', () => {
    const comment = pending('comments.author', '"alice"');
    const tag = pending('tags.name', '"live"');
    const f = fixture({ draft: initial([flat, comment, tag], { mode: 'all', groups: [
      { id: 'flat', mode: 'all', filterIds: [flat.id] },
      { id: 'comments', mode: 'all', filterIds: [comment.id], nested: { path: 'comments', match: 'include' } },
      { id: 'tags', mode: 'all', filterIds: [tag.id], nested: { path: 'tags', match: 'include' } },
    ] }) });
    const select = screen.getByLabelText('Group for comments.author');
    expect(within(select).getByRole('option', { name: 'Group 1' })).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'Group 3 (tags)' })).toBeDisabled();
    fireEvent.change(select, { target: { value: 'flat' } });
    expect(f.props.onFiltersChange).not.toHaveBeenCalled();
    path();
    field();
    value('alice');
    fireEvent.change(screen.getByLabelText('Nested group'), { target: { value: 'comments' } });
    expect(screen.getByRole('button', { name: 'Add nested condition' })).toBeDisabled();
    expect(screen.getByText(enQueryFilters.duplicate)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Nested group'), { target: { value: 'new' } });
    add();
    expect(screen.getByRole('list', { name: '4 pending filters' })).toBeVisible();
    preview();
    expect(JSON.parse(final()).query.bool.filter).toHaveLength(4);
    const repeated = screen.getAllByLabelText('Group for comments.author')[1]!;
    expect(within(repeated).getByRole('option', { name: 'Group 2 (comments)' })).toBeDisabled();
    fireEvent.change(repeated, { target: { value: 'comments' } });
    expect(apply()).toBeEnabled();
    expect(f.props.onFiltersChange).toHaveBeenCalledOnce();
  });

  it.each(['loading', 'refreshing', 'failed', 'changed', 'indices', 'identity'] as const)('invalidates review after %s evidence without dropping pending conditions', (change) => {
    const f = fixture();
    path(); field(); value('alice'); add(); preview();
    expect(apply()).toBeEnabled();
    const nextMapping: Loadable<MappingState> = change === 'loading' ? { status: 'loading' }
      : change === 'refreshing' ? { ...mapping, refreshing: true }
        : change === 'failed' ? { ...mapping, refreshError: 'forbidden' }
          : change === 'changed' ? { status: 'ready', data: { ...mapping.data, raw: rawMapping.replace('"type":"nested"', '"type":"object"') } }
            : { ...mapping };
    const nextFields: Loadable<FieldCatalog> = change === 'indices' ? { ...fields, data: { ...fields.data, indices: ['other'] } } : fields;
    f.rerender(<Harness {...f.props} mapping={nextMapping} fields={nextFields} />);
    expect(apply()).toBeDisabled();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: '1 pending filters' })).toHaveTextContent('alice');
    if (change === 'failed' || change === 'changed' || change === 'indices') {
      preview();
      expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters[change === 'failed' ? 'mappingUnchecked'
        : change === 'changed' ? 'nestedPathConflict' : 'mappingTargetChanged']);
    }
    f.rerender(<Harness {...f.props} mapping={{ ...mapping }} />);
    expect(apply()).toBeDisabled();
    preview();
    expect(apply()).toBeEnabled();
    expect(f.props.onCommit).not.toHaveBeenCalled();
  });

  it('keeps typed booleans, phrases and explicit existence separate from missing source values', () => {
    fixture();
    path();
    field('comments.active');
    expect(screen.getByRole('combobox', { name: 'Entered value' })).toBeVisible();
    value('false'); add();
    field('comments.text'); value('some "quoted" words'); add();
    field('comments.author');
    fireEvent.change(screen.getByLabelText('Condition within object'), { target: { value: 'missing' } });
    expect(screen.queryByLabelText('Entered value')).not.toBeInTheDocument();
    expect(screen.getByText(enQueryFilters.presenceBoundary)).toBeVisible();
    add(); preview();
    const nested = JSON.parse(final()).query.bool.filter[0].nested.query.bool;
    expect(nested.filter).toEqual([{ term: { 'comments.active': false } }, { match_phrase: { 'comments.text': 'some "quoted" words' } }]);
    expect(nested.must_not).toEqual([{ exists: { field: 'comments.author' } }]);
  });

  it('disables unsupported Mapping selections, rechecks runtime scope and never guesses a path', () => {
    const f = fixture({ mapping: { status: 'ready', data: { raw: '{"events":{"mappings":{"properties":{"comments.author":{"type":"keyword"}}}}}', fields: [] } } });
    expect(screen.getByText(enQueryFilters.nestedPathsEmpty)).toBeVisible();
    expect(screen.getByLabelText('Nested path')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add nested condition' })).toBeDisabled();
    f.rerender(<Harness {...f.props} mapping={mapping} fields={{ ...fields, data: { ...fields.data, indices: [] } }} />);
    path(); field();
    expect(screen.getByText(enQueryFilters.mappingTargetChanged)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add nested condition' })).toBeDisabled();
    expect(f.props.onFiltersChange).not.toHaveBeenCalled();
  });

  it('invalidates a preview when an unstaged input changes and rejects a changed source at final application', () => {
    const f = fixture();
    path(); field(); value('alice'); add(); preview();
    field('comments.n'); value('2');
    expect(apply()).toBeDisabled();
    preview();
    expect(apply()).toBeEnabled();
    f.rerender(<Harness {...f.props} current={{ ...source, dsl: '{}' }} />);
    fireEvent.click(apply());
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.draftChanged);
    expect(f.props.onCommit).not.toHaveBeenCalled();
  });

  it('retains native select focus and reviews parent exclusion only after explicit selection', async () => {
    const f = fixture();
    path(); field(); value('alice'); add(); preview();
    const select = screen.getByLabelText('Group 1 parent match');
    select.focus();
    await userEvent.setup().selectOptions(select, 'exclude');
    expect(select).toHaveFocus();
    expect(select).toHaveValue('exclude');
    expect(apply()).toBeDisabled();
    expect(f.props.onCommit).not.toHaveBeenCalled();
    expect(f.props.onInspectNested).not.toHaveBeenCalled();
  });

  it('omits a disabled parent-exclusion group without losing its scope or moving it into an OR branch', () => {
    const comment = pending('comments.author', '"alice"');
    const f = fixture({ initialNested: false, draft: initial([comment, flat], { mode: 'any', groups: [
      { id: 'comments', mode: 'any', filterIds: [comment.id], nested: { path: 'comments', match: 'exclude' } },
      { id: 'flat', mode: 'all', filterIds: [flat.id] },
    ] }) });
    preview();
    const original = final();
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for comments.author' }));
    expect(apply()).toBeDisabled();
    expect(screen.getByText('Group 1: 0 / 1 enabled')).toBeVisible();
    expect(screen.getByLabelText('Group for comments.author')).toHaveValue('comments');
    expect(screen.getByLabelText('Group 1 parent match')).toHaveValue('exclude');
    preview();
    expect(final()).not.toContain('"nested"');
    expect(final()).not.toContain('"must_not"');
    const branches = JSON.parse(final()).query.bool.filter[0].bool;
    expect(branches.minimum_should_match).toBe(1);
    expect(branches.should).toEqual([{ bool: { filter: [{ term: { status: 'ready' } }] } }]);
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for comments.author' }));
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    preview();
    expect(final()).toBe(original);
    expect(f.props.onCommit).not.toHaveBeenCalled();
    expect(f.props.onInspectNested).not.toHaveBeenCalled();
  });

  it('can review an inactive nested group without Mapping but cannot re-enable it using failed evidence', () => {
    const comment = { ...pending('comments.author', '"alice"'), enabled: false };
    const f = fixture({ initialNested: false, mapping: { status: 'error', code: 'forbidden' },
      draft: initial([comment, flat], { mode: 'all', groups: [
        { id: 'comments', mode: 'any', filterIds: [comment.id], nested: { path: 'comments', match: 'exclude' } },
        { id: 'flat', mode: 'all', filterIds: [flat.id] },
      ] }) });
    preview();
    expect(final()).not.toContain('"nested"');
    expect(screen.getByText('Mapping check failed')).toBeVisible();
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for comments.author' }));
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.mappingUnchecked);
    expect(apply()).toBeDisabled();
    expect(screen.getByLabelText('Group 1 parent match')).toHaveValue('exclude');
    f.rerender(<Harness {...f.props} mapping={mapping} />);
    preview();
    expect(final()).toContain('"nested"');
    expect(f.props.onCommit).not.toHaveBeenCalled();
  });
});

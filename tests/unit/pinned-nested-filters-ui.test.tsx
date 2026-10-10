import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/pinned-filters-v2.json';
import { draftFromPinnedFilters, parsePinnedFilterLibrary } from '../../src/domain/pinned-filters';
import { createQuery } from '../../src/domain/query';
import { parseFieldCaps } from '../../src/domain/resource';
import { QueryFiltersDialog } from '../../src/features/query/QueryFiltersDialog';
import { i18n } from '../../src/locales';
import { enPinnedFilters } from '../../src/locales/pinned-filters';
import { enQueryFilters } from '../../src/locales/query-filters';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const definition = parsePinnedFilterLibrary(fixture)!.entries[0]!;
const source = { ...createQuery(definition.connectionId), index: definition.index, dsl: '{"query":{"match_all":{}},"size":25}' };
const draft = draftFromPinnedFilters(definition, source, 'https://fixture.test')!;
const parsed = parseFieldCaps('{"indices":["events"],"fields":{"status":{"keyword":{"searchable":true}},"comments.author":{"keyword":{"searchable":true}},"comments.n":{"long":{"searchable":true}}}}');
if (!parsed.ok) throw new Error('fixture');
const fields = { status: 'ready' as const, data: parsed.value };
const mapping = { status: 'ready' as const, data: {
  raw: '{"events":{"mappings":{"properties":{"comments":{"type":"nested","properties":{"author":{"type":"keyword"},"n":{"type":"long"}}}}}}}',
  fields: [],
} };
type Props = React.ComponentProps<typeof QueryFiltersDialog>;
function Harness({ draft: initial, ...props }: Props) {
  const [draft, setDraft] = useState(initial);
  return <I18nextProvider i18n={i18n}><QueryFiltersDialog {...props} draft={draft} onFiltersChange={(filters, composition) => {
    setDraft((draft) => ({ ...draft, filters, composition }));
    props.onFiltersChange(filters, composition);
  }} /></I18nextProvider>;
}
function mount(overrides: Partial<Props> = {}) {
  const props: Props = { draft, current: source, fields, mapping, targetCurrent: true, canInspect: true, newQuery: false,
    onInspect: vi.fn(), onInspectNested: vi.fn(), onFiltersChange: vi.fn(), onCommit: vi.fn(() => true),
    onDiscard: vi.fn(), onClose: vi.fn(), ...overrides };
  return { ...render(<Harness {...props} />), props };
}
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview filtered DSL' }));
const apply = () => screen.getByRole('button', { name: 'Apply filters to draft' });
const final = () => (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;

describe('loaded nested definition review', () => {
  it('does not accept earlier in-flight completions as an explicit post-load evidence check', () => {
    const f = mount({ fields: { status: 'loading' }, mapping: { status: 'loading' } });
    f.rerender(<Harness {...f.props} fields={fields} mapping={mapping} />);
    preview();
    expect(apply()).toBeDisabled();
    expect(f.props.onInspectNested).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check Mapping and field capabilities' }));
    f.rerender(<Harness {...f.props} fields={{ ...fields }} mapping={{ ...mapping }} />);
    preview();
    expect(apply()).toBeEnabled();
    expect(f.props.onCommit).not.toHaveBeenCalled();
  });

  it('requires post-load Mapping and field-caps checks even when prior cached evidence is ready', () => {
    const f = mount();
    expect(screen.getAllByText(enPinnedFilters.literal)).toHaveLength(6);
    expect(screen.getByLabelText('Group 2 parent match')).toHaveValue('include');
    expect(screen.getByLabelText('Group 3 parent match')).toHaveValue('exclude');
    expect(screen.getByRole('button', { name: 'Nested conditions' })).toBeDisabled();
    expect(f.props.onInspectNested).not.toHaveBeenCalled();
    preview();
    expect(apply()).toBeDisabled();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check Mapping and field capabilities' }));
    expect(f.props.onInspectNested).toHaveBeenCalledOnce();
    f.rerender(<Harness {...f.props} fields={{ ...fields }} />);
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.mappingUnchecked);
    f.rerender(<Harness {...f.props} fields={{ ...fields }} mapping={{ ...mapping, refreshing: true }} />);
    expect(screen.getByRole('button', { name: 'Preview filtered DSL' })).toBeDisabled();
    f.rerender(<Harness {...f.props} fields={{ ...fields }} mapping={{ ...mapping }} />);
    preview();
    const reviewed = final();
    expect(reviewed).toContain('"comments.n": 9007199254740993');
    expect(reviewed).not.toContain('"tags"');
    expect(apply()).toBeEnabled();
    expect(f.props.onCommit).not.toHaveBeenCalled();
    fireEvent.click(apply());
    expect(f.props.onCommit).toHaveBeenCalledExactlyOnceWith(source, { dsl: reviewed });
  });

  it('invalidates a review on refresh, failed or drifted Mapping without changing literals or auto-applying', async () => {
    const f = mount({ fields: { status: 'idle' }, mapping: { status: 'idle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check Mapping and field capabilities' }));
    f.rerender(<Harness {...f.props} fields={fields} mapping={mapping} />);
    preview();
    expect(apply()).toBeEnabled();
    f.rerender(<Harness {...f.props} fields={fields} mapping={{ ...mapping, refreshError: 'forbidden' }} />);
    expect(apply()).toBeDisabled();
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.mappingUnchecked);
    f.rerender(<Harness {...f.props} fields={{ ...fields, data: { ...fields.data, indices: ['other'] } }} mapping={mapping} />);
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.mappingTargetChanged);
    expect(screen.getByRole('list', { name: '6 pending filters' })).toHaveTextContent('a\\u006cice');
    f.rerender(<Harness {...f.props} fields={fields} mapping={mapping} />);
    preview();
    const reviewed = final();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByLabelText('最终筛选 DSL')).toHaveValue(reviewed);
    expect(screen.getByLabelText('组 3 父文档匹配')).toHaveValue('exclude');
    expect(f.props.onCommit).not.toHaveBeenCalled();
    expect(f.props.onInspectNested).toHaveBeenCalledOnce();
  });

  it('retains disabled scopes with no evidence and requires rechecking before enabling a saved nested literal', () => {
    const disabled = { ...draft, filters: draft.filters.map((filter) => ({ ...filter, enabled: false })) };
    const f = mount({ draft: disabled, fields: { status: 'idle' }, mapping: { status: 'error', code: 'forbidden' } });
    preview();
    expect(final()).toBe(source.dsl);
    expect(apply()).toBeDisabled();
    const toggle = screen.getAllByRole('switch', { name: 'Filter enabled for comments.author' })[0]!;
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.mappingUnchecked);
    fireEvent.click(screen.getByRole('button', { name: 'Check Mapping and field capabilities' }));
    f.rerender(<Harness {...f.props} fields={fields} mapping={mapping} />);
    preview();
    expect(final()).toContain('"nested"');
    expect(final()).not.toContain('"tags"');
    expect(screen.getByLabelText('Group 3 parent match')).toHaveValue('exclude');
    expect(f.props.onCommit).not.toHaveBeenCalled();
  });
});

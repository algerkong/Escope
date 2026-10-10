import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/pinned-filters-v3.json';
import { draftFromPinnedFilters, parsePinnedFilterLibrary } from '../../src/domain/pinned-filters';
import { createQuery } from '../../src/domain/query';
import type { QueryFilterDraft } from '../../src/domain/query-filters';
import { PinFiltersDialog } from '../../src/features/query/PinnedFiltersDialog';
import { QueryFiltersDialog } from '../../src/features/query/QueryFiltersDialog';
import type { PinnedFiltersController } from '../../src/features/query/usePinnedFilters';
import { i18n } from '../../src/locales';
import { enPinnedFilters, zhPinnedFilters } from '../../src/locales/pinned-filters';
import { enQueryFilters } from '../../src/locales/query-filters';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const definition = parsePinnedFilterLibrary(fixture)!.entries[0]!;
const source = { ...createQuery(definition.connectionId), index: definition.index,
  dsl: JSON.stringify({ runtime_mappings: Object.fromEntries(definition.filters.map((f) => [f.field, f.runtimeMapping])), query: { match_all: {} } }) };
const draft = draftFromPinnedFilters(definition, source, 'https://fixture.test')!;
const wrap = (view: React.ReactNode) => <I18nextProvider i18n={i18n}>{view}</I18nextProvider>;
function controller(): PinnedFiltersController {
  return { status: 'ready', entries: [], error: null, saving: false, reload: vi.fn(),
    save: vi.fn(async () => true), remove: vi.fn(async () => true) };
}
const saveButton = () => screen.getByRole('button', { name: enPinnedFilters.save });
const literalConsent = () => fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent }));
const scriptConsent = () => fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.scriptConsent }));

describe('explicit local script storage consent', () => {
  it('shows full source text including disabled scripts and requires both confirmations before saving', async () => {
    const library = controller();
    const close = vi.fn();
    const disabled = { ...draft, filters: draft.filters.map((filter) => ({ ...filter, enabled: false })) };
    render(wrap(<PinFiltersDialog draft={disabled} currentTarget library={library} kind="desktop" onClose={close} />));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Full script set' } });
    expect(screen.getByLabelText('Script source: n')).toHaveValue('emit(9007199254740995L);');
    expect(screen.getByLabelText('Script source: ratio')).toHaveValue('double n = 1.23e-8;\n\temit(n);');
    const payload = JSON.parse((screen.getByLabelText(enPinnedFilters.definition) as HTMLTextAreaElement).value);
    expect(payload.filters.every((f: { enabled: boolean }) => !f.enabled)).toBe(true);
    expect(payload.filters[0].runtimeMapping).toEqual(definition.filters[0]!.runtimeMapping);
    literalConsent();
    expect(saveButton()).toBeDisabled();
    scriptConsent();
    expect(saveButton()).toBeEnabled();
    scriptConsent();
    expect(saveButton()).toBeDisabled();
    scriptConsent();
    fireEvent.click(saveButton());
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(library.save).toHaveBeenCalledExactlyOnceWith(payload);
    expect(payload).not.toHaveProperty('snapshot');
    expect(payload).not.toHaveProperty('endpoint');
  });

  it('invalidates both consents when the name or captured draft changes, even if the payload is equal', () => {
    const library = controller();
    const props = { draft, currentTarget: true, library, kind: 'desktop' as const, onClose: vi.fn() };
    const view = render(wrap(<PinFiltersDialog {...props} />));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Set' } });
    literalConsent();
    scriptConsent();
    expect(saveButton()).toBeEnabled();
    view.rerender(wrap(<PinFiltersDialog {...props} draft={{ ...draft, source: { ...source, revision: 1 } }} />));
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: enPinnedFilters.scriptConsent })).not.toBeChecked();
    literalConsent();
    scriptConsent();
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Renamed' } });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: enPinnedFilters.scriptConsent })).not.toBeChecked();
    expect(library.save).not.toHaveBeenCalled();
  });

  it('requires no script consent for same-name source declarations and keeps the bilingual review unchanged', async () => {
    const library = controller();
    const noScript = { ...draft, filters: [draft.filters[1]!],
      composition: { mode: 'all' as const, groups: [{ id: 'g', mode: 'all' as const, filterIds: ['label'] }] } };
    render(wrap(<PinFiltersDialog draft={noScript} currentTarget library={library} kind="session" onClose={vi.fn()} />));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Source' } });
    expect(screen.queryByRole('checkbox', { name: enPinnedFilters.scriptConsent })).not.toBeInTheDocument();
    literalConsent();
    expect(saveButton()).toBeEnabled();
    const raw = (screen.getByLabelText(enPinnedFilters.definition) as HTMLTextAreaElement).value;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByLabelText(zhPinnedFilters.definition)).toHaveValue(raw);
    expect(screen.getByRole('button', { name: zhPinnedFilters.save })).toBeEnabled();
    expect(library.save).not.toHaveBeenCalled();
  });

  it('blocks missing or changed declarations without substituting scripts, and preserves failure input', () => {
    const library = controller();
    const changed = { ...draft, source: { ...source, dsl: '{}' } };
    const view = render(wrap(<PinFiltersDialog draft={changed} currentTarget library={library} kind="desktop" onClose={vi.fn()} />));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Set' } });
    expect(screen.getByRole('status')).toHaveTextContent(enPinnedFilters.runtimeChanged);
    expect(saveButton()).toBeDisabled();
    expect(screen.queryByLabelText(enPinnedFilters.definition)).not.toBeInTheDocument();
    view.rerender(wrap(<PinFiltersDialog draft={draft} currentTarget library={{ ...library, error: 'invalidResponse' }} kind="desktop" onClose={vi.fn()} />));
    expect(screen.getByLabelText(enPinnedFilters.name)).toHaveValue('Set');
    literalConsent();
    scriptConsent();
    expect(saveButton()).toBeDisabled();
    expect(library.save).not.toHaveBeenCalled();
  });
});

type Props = React.ComponentProps<typeof QueryFiltersDialog>;
function Harness({ draft: initial, ...props }: Props) {
  const [draft, setDraft] = useState<QueryFilterDraft>(initial);
  return wrap(<QueryFiltersDialog {...props} draft={draft} onFiltersChange={(filters, composition) => {
    setDraft((draft) => ({ ...draft, filters, composition }));
    props.onFiltersChange(filters, composition);
  }} />);
}
function review(overrides: Partial<Props> = {}) {
  const props: Props = { draft, current: source, fields: { status: 'idle' }, mapping: { status: 'idle' },
    targetCurrent: true, canInspect: true, newQuery: false, onInspect: vi.fn(), onInspectNested: vi.fn(),
    onFiltersChange: vi.fn(), onCommit: vi.fn(() => true), onDiscard: vi.fn(), onClose: vi.fn(), ...overrides };
  return { ...render(<Harness {...props} />), props };
}
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview filtered DSL' }));
const apply = () => screen.getByRole('button', { name: 'Apply filters to draft' });

describe('loaded runtime literal review', () => {
  it('labels saved values and declarations honestly and previews without querying or injecting fields', () => {
    const view = review();
    expect(screen.getAllByText(enPinnedFilters.literal)).toHaveLength(7);
    expect(screen.getAllByText(enPinnedFilters.runtime)).toHaveLength(7);
    expect(screen.queryByText(enQueryFilters.runtime)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Runtime declaration: n'));
    expect(screen.getByText('Runtime declaration: n').parentElement).toHaveTextContent('emit(9007199254740995L);');
    expect(apply()).toBeDisabled();
    preview();
    const dsl = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    expect(JSON.parse(dsl).runtime_mappings).toEqual(JSON.parse(source.dsl).runtime_mappings);
    expect(JSON.parse(dsl).fields).toBeUndefined();
    expect(view.props.onInspect).not.toHaveBeenCalled();
    expect(view.props.onInspectNested).not.toHaveBeenCalled();
    expect(view.props.onCommit).not.toHaveBeenCalled();
    fireEvent.click(apply());
    expect(view.props.onCommit).toHaveBeenCalledExactlyOnceWith(source, { dsl });
  });

  it('keeps disabled definitions and focus, then rejects re-enabling a missing runtime declaration', async () => {
    const current = { ...source, dsl: '{}' };
    const disabled = { ...draft, source: current, filters: draft.filters.map((filter) => ({ ...filter, enabled: false })) };
    const view = review({ draft: disabled, current });
    preview();
    expect(screen.getByLabelText('Final filtered DSL')).toHaveValue('{}');
    expect(apply()).toBeDisabled();
    const toggle = screen.getByRole('switch', { name: 'Filter enabled for n' });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.runtimeChanged);
    expect(apply()).toBeDisabled();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getAllByText(zhPinnedFilters.runtime)).toHaveLength(7);
    expect(view.props.onCommit).not.toHaveBeenCalled();
  });

  it('cannot apply an earlier preview after current source or field evidence changes', () => {
    const view = review();
    preview();
    expect(apply()).toBeEnabled();
    view.rerender(<Harness {...view.props} current={{ ...source, revision: 1 }} />);
    expect(apply()).toBeDisabled();
    view.rerender(<Harness {...view.props} fields={{ status: 'error', code: 'forbidden' }} />);
    expect(apply()).toBeDisabled();
    preview();
    expect(apply()).toBeEnabled();
    expect(view.props.onCommit).not.toHaveBeenCalled();
  });
});

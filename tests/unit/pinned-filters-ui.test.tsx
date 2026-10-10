import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/pinned-filters-v1.json';
import nestedFixture from '../fixtures/pinned-filters-v2.json';
import { createQuery } from '../../src/domain/query';
import { draftFromPinnedFilters, parsePinnedFilterLibrary } from '../../src/domain/pinned-filters';
import { PinFiltersDialog, PinnedFiltersDialog } from '../../src/features/query/PinnedFiltersDialog';
import type { PinnedFiltersController } from '../../src/features/query/usePinnedFilters';
import { i18n } from '../../src/locales';
import { enPinnedFilters, zhPinnedFilters } from '../../src/locales/pinned-filters';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const definition = parsePinnedFilterLibrary(fixture)!.entries[0]!;
const source = { ...createQuery(definition.connectionId), index: definition.index };
const draft = draftFromPinnedFilters(definition, source, 'https://fixture.test')!;
const profiles = [{ id: definition.connectionId, displayName: 'Fixture', endpoint: draft.endpoint,
  environment: 'development' as const, sortOrder: 0, auth: 'none' as const }];
function controller(): PinnedFiltersController {
  return { status: 'ready', entries: [definition], error: null, saving: false,
    reload: vi.fn(), save: vi.fn(async () => true), remove: vi.fn(async () => true) };
}
const wrap = (view: React.ReactNode) => <I18nextProvider i18n={i18n}>{view}</I18nextProvider>;

describe('pinned filter review dialogs', () => {
  it('requires reviewing the complete local payload and resets consent when the name changes', async () => {
    const library = controller();
    const close = vi.fn();
    render(wrap(<PinFiltersDialog draft={draft} currentTarget library={library} kind="desktop" onClose={close} />));
    expect(screen.getByRole('button', { name: enPinnedFilters.save })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Saved set' } });
    const payload = JSON.parse((screen.getByLabelText(enPinnedFilters.definition) as HTMLTextAreaElement).value);
    expect(payload).toMatchObject({ connectionId: definition.connectionId, filters: definition.filters, composition: definition.composition });
    expect(payload).not.toHaveProperty('endpoint');
    expect(payload).not.toHaveProperty('snapshot');
    expect(payload.filters[2].enabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent }));
    expect(screen.getByRole('button', { name: enPinnedFilters.save })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Final set' } });
    expect(screen.getByRole('button', { name: enPinnedFilters.save })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.save }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(library.save).toHaveBeenCalledOnce();
    expect(vi.mocked(library.save).mock.calls[0]![0]).toMatchObject({ name: 'Final set', filters: definition.filters });
  });

  it('keeps all disabled definitions but refuses disabled runtime or malformed nested entries', () => {
    const library = controller();
    const changed = { ...draft, filters: draft.filters.map((filter, index) => index === 2
      ? { ...filter, evidence: 'runtime' as const, origin: 'fields' as const } : filter) };
    const view = render(wrap(<PinFiltersDialog draft={changed} currentTarget library={library} kind="session" onClose={vi.fn()} />));
    expect(screen.getByRole('status')).toHaveTextContent(enPinnedFilters.unsupported);
    expect(screen.getByText(enPinnedFilters.session)).toBeVisible();
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Invalid' } });
    expect(screen.getByRole('button', { name: enPinnedFilters.save })).toBeDisabled();
    const nested = { ...draft, filters: draft.filters.map((filter, index) => index === 2 ? { ...filter, nestedPath: 'comments' } : filter) };
    view.rerender(wrap(<PinFiltersDialog draft={nested} currentTarget library={library} kind="session" onClose={vi.fn()} />));
    expect(screen.getByRole('status')).toHaveTextContent(enPinnedFilters.invalid);
    expect(library.save).not.toHaveBeenCalled();
  });

  it('invalidates review on source changes and reports failed storage without losing input', async () => {
    const library = controller();
    const close = vi.fn();
    const view = render(wrap(<PinFiltersDialog draft={draft} currentTarget library={library} kind="desktop" onClose={close} />));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Set' } });
    fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent }));
    view.rerender(wrap(<PinFiltersDialog draft={draft} currentTarget={false} library={library} kind="desktop" onClose={close} />));
    expect(screen.getByRole('alert')).toHaveTextContent(enPinnedFilters.changed);
    expect(screen.getByRole('button', { name: enPinnedFilters.save })).toBeDisabled();
    view.rerender(wrap(<PinFiltersDialog draft={draft} currentTarget library={{ ...library, error: 'invalidResponse' }} kind="desktop" onClose={close} />));
    expect(screen.getByRole('alert')).toHaveTextContent(enPinnedFilters.invalidStorage);
    expect(screen.getByLabelText(enPinnedFilters.name)).toHaveValue('Set');
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.reload }));
    expect(library.reload).toHaveBeenCalledOnce();
    expect(library.save).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('heading', { name: zhPinnedFilters.pin })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(zhPinnedFilters.invalidStorage);
    expect(library.save).not.toHaveBeenCalled();
  });

  it('loads only matching stable IDs and targets and does not infer same names or request execution', () => {
    const library = controller();
    const onLoad = vi.fn(() => true);
    const props = { library, kind: 'desktop' as const, profiles, source, endpoint: draft.endpoint, canLoad: true, onLoad, onClose: vi.fn() };
    const view = render(wrap(<PinnedFiltersDialog {...props} />));
    const load = () => screen.getByRole('button', { name: 'Load Orders for review' });
    expect(load()).toBeEnabled();
    view.rerender(wrap(<PinnedFiltersDialog {...props} source={{ ...source, index: 'orders-1' }} />));
    expect(load()).toBeDisabled();
    view.rerender(wrap(<PinnedFiltersDialog {...props} source={{ ...source, connectionId: 'another' }}
      profiles={[...profiles, { ...profiles[0]!, id: 'another' }]} />));
    expect(load()).toBeDisabled();
    view.rerender(wrap(<PinnedFiltersDialog {...props} profiles={[]} />));
    expect(load()).toBeDisabled();
    view.rerender(wrap(<PinnedFiltersDialog {...props} canLoad={false} />));
    expect(load()).toBeDisabled();
    expect(onLoad).not.toHaveBeenCalled();
    view.rerender(wrap(<PinnedFiltersDialog {...props} />));
    fireEvent.click(load());
    expect(onLoad).toHaveBeenCalledExactlyOnceWith(definition);
  });

  it('filters the bounded list and confirms deletion of a complete detached copy', async () => {
    const library = controller();
    render(wrap(<PinnedFiltersDialog library={library} kind="desktop" profiles={[]} source={null} endpoint={null}
      canLoad={false} onLoad={vi.fn()} onClose={vi.fn()} />));
    fireEvent.change(screen.getByRole('searchbox', { name: enPinnedFilters.filter }), { target: { value: 'absent' } });
    expect(screen.getByText(enPinnedFilters.noMatches)).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox', { name: enPinnedFilters.filter }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Orders' }));
    expect(library.remove).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: enPinnedFilters.deleteTitle });
    expect(dialog).toHaveTextContent('Loaded session copies and applied DSL remain unchanged.');
    expect(JSON.parse((screen.getByLabelText(enPinnedFilters.definition) as HTMLTextAreaElement).value)).toEqual(definition);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(library.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Orders' }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.delete }));
    await waitFor(() => expect(library.remove).toHaveBeenCalledExactlyOnceWith(definition));
    expect(vi.mocked(library.remove).mock.calls[0]![0]).not.toBe(definition);
  });

  it('does not acknowledge failed save/delete operations as success', async () => {
    const library = controller();
    vi.mocked(library.save).mockResolvedValue(false);
    const close = vi.fn();
    render(wrap(<PinFiltersDialog draft={draft} currentTarget library={library} kind="desktop" onClose={close} />));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Set' } });
    fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.save }));
    await waitFor(() => expect(library.save).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText(enPinnedFilters.name)).toHaveValue('Set');
  });

  it('keeps every added label and error translated', () => {
    expect(Object.keys(zhPinnedFilters).sort()).toEqual(Object.keys(enPinnedFilters).sort());
    expect(Object.values(zhPinnedFilters).every((value) => value.trim().length > 0)).toBe(true);
  });

  it('reviews and saves every nested path, parent exclusion and disabled literal without flattening the set', async () => {
    const nested = parsePinnedFilterLibrary(nestedFixture)!.entries[0]!;
    const pending = draftFromPinnedFilters(nested, { ...source, index: nested.index }, draft.endpoint)!;
    const library = controller();
    const close = vi.fn();
    render(wrap(<PinFiltersDialog draft={pending} currentTarget library={library} kind="desktop" onClose={close} />));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Nested copy' } });
    const payload = JSON.parse((screen.getByLabelText(enPinnedFilters.definition) as HTMLTextAreaElement).value);
    expect(payload).toMatchObject({ filters: nested.filters, composition: nested.composition });
    expect(payload).not.toHaveProperty('snapshot');
    expect(screen.getByRole('button', { name: enPinnedFilters.save })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.save }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(library.save).toHaveBeenCalledExactlyOnceWith(payload);
  });
});

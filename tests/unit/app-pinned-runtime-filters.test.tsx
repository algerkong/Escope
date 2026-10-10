import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import runtimeFixture from '../fixtures/pinned-filters-v3.json';
import { parsePinnedFilterLibrary } from '../../src/domain/pinned-filters';
import { DATA_PREVIEW_DSL } from '../../src/domain/query-pagination';
import { enPinnedFilters } from '../../src/locales/pinned-filters';
import { enQueryFilters } from '../../src/locales/query-filters';
import { add, apply, fixture, preview } from './query-filter-workspace-fixture';

const close = () => fireEvent.click(screen.getByText('Close', { selector: 'button' }));
async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const entry = parsePinnedFilterLibrary(runtimeFixture)!.entries[0]!;
  await f.pinned.save(0, { version: 3, entries: [{ ...entry, connectionId: f.a.id, filters: [entry.filters[0]!],
    composition: { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: ['n'] }] } }] });
}
function load() {
  fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
  fireEvent.click(screen.getByRole('button', { name: 'Load Runtime set for review' }));
}
const finalDsl = () => (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;

describe('pinned runtime workspace boundaries', () => {
  it('saves observed fields only after separate script confirmation, without applying or re-executing', async () => {
    const f = await fixture(false, true);
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('["9,007,199,254,740,995"]');
    f.clickCell('["9,007,199,254,740,995"]', 'n');
    add();
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.pin }));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Observed runtime' } });
    expect(screen.getByLabelText('Script source: n')).toHaveValue('emit(9007199254740995L);');
    fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent }));
    expect(screen.getByRole('button', { name: enPinnedFilters.save })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.scriptConsent }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.save }));
    await screen.findByRole('dialog', { name: 'Query filters' });
    const stored = (await f.pinned.load()).library;
    expect(stored.version).toBe(3);
    expect(stored.entries[0]!.filters[0]).toMatchObject({ field: 'n', value: '9007199254740995',
      runtimeMapping: { type: 'long', script: { source: 'emit(9007199254740995L);' } } });
    expect(stored.entries[0]).not.toHaveProperty('snapshot');
    close();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
  });

  it('loads before any execution and preserves time, parameter templates, sort and zero observations', async () => {
    const f = await fixture(true, true, true, true);
    await seed(f);
    f.mount();
    await f.saved();
    load();
    expect(screen.getByText(enPinnedFilters.literal)).toBeVisible();
    expect(screen.getByText(enPinnedFilters.runtime)).toBeVisible();
    expect(screen.queryByText(enQueryFilters.runtime)).not.toBeInTheDocument();
    preview();
    const final = finalDsl();
    expect(final).toContain('"n": 9007199254740995');
    expect(JSON.parse(final).runtime_mappings).toEqual(JSON.parse(f.query.dsl).runtime_mappings);
    apply();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(f.backend.openPit).not.toHaveBeenCalled();
    expect(f.backend.readResource.mock.calls.some(([r]) => r.resource === 'fieldCaps' || r.resource === 'mapping')).toBe(false);
    await f.saved();
    const recovery = (await f.recovery.load()).document;
    expect(recovery.workspace!.tabs[0]!.document).toMatchObject({ dsl: final, timeRange: f.query.timeRange, parameters: f.query.parameters });
    expect(recovery.history).toEqual([]);
    expect(JSON.stringify(recovery)).not.toContain('"runtimeMapping"');
    expect(JSON.parse(final).sort).toEqual(JSON.parse(f.query.dsl).sort);
  });

  it('does not inject runtime declarations into a locked index or create a query from a failed review', async () => {
    const f = await fixture(false, true);
    await seed(f);
    f.mount();
    await f.saved();
    fireEvent.click(await screen.findByRole('button', { name: 'events' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    load();
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.runtimeChanged);
    expect(screen.getByRole('button', { name: 'Open filtered query' })).toBeDisabled();
    expect(screen.queryByLabelText('Final filtered DSL')).not.toBeInTheDocument();
    close();
    expect(screen.getByRole('button', { name: 'Refresh index' })).toBeDisabled();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    expect(f.backend.execute.mock.calls[0]![0].rawDsl).toBe(DATA_PREVIEW_DSL);
    const recovered = (await f.recovery.load()).document.workspace!;
    expect(recovered.tabs.find((tab) => tab.kind === 'index')!.document.dsl).toBe(DATA_PREVIEW_DSL);
    expect(recovered.tabs.filter((tab) => tab.kind === 'query')).toHaveLength(1);
  });

  it('keeps an old PIT and genuine later observations while saved literals remain saved', async () => {
    const f = await fixture(false, true, true);
    await seed(f);
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('["9,007,199,254,740,995"]');
    const original = f.backend.execute.mock.calls[0]![0];
    load();
    preview();
    const final = finalDsl();
    apply();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(2));
    expect(f.backend.execute.mock.calls[1]![0]).toMatchObject({ rawDsl: original.rawDsl, pitId: original.pitId, searchAfter: '[2]' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run query' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(3));
    await screen.findByText('["9,007,199,254,740,995"]');
    expect(f.backend.execute.mock.calls[2]![0].rawDsl).toBe(final);
    fireEvent.click(screen.getByRole('button', { name: 'Edit session filters' }));
    expect(screen.getByText(enPinnedFilters.literal)).toBeVisible();
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for n' }));
    preview();
    expect(finalDsl()).toBe(f.query.dsl);
    apply();
    expect(f.backend.execute).toHaveBeenCalledTimes(3);
    await f.saved();
    const history = (await f.recovery.load()).document.history;
    expect(history).toHaveLength(3);
    expect(history.find((item) => item.kind === 'continuation')!.snapshot.rawDsl).toBe(original.rawDsl);
    expect(history.some((item) => item.snapshot.rawDsl === final)).toBe(true);
  });

  it('retains applied scripts after library deletion and restores DSL without restoring trusted bindings', async () => {
    const f = await fixture(false, true);
    await seed(f);
    const view = f.mount();
    await f.saved();
    load();
    preview();
    const final = finalDsl();
    apply();
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Runtime set' }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.delete }));
    await screen.findByText(enPinnedFilters.empty);
    close();
    fireEvent.click(screen.getByRole('button', { name: 'Edit session filters' }));
    expect(screen.getByText('Runtime declaration: n')).toBeVisible();
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for n' }));
    close();
    await f.saved();
    view.unmount();
    f.mount();
    await waitFor(() => expect(screen.getByLabelText('Query DSL')).toHaveValue(final));
    expect(screen.queryByRole('button', { name: 'Edit session filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review pending filters' })).not.toBeInTheDocument();
    expect((await f.pinned.load()).library.entries).toEqual([]);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect((await f.recovery.load()).document.history).toEqual([]);
  });
});

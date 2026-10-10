import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import nestedFixture from '../fixtures/pinned-filters-v2.json';
import { parsePinnedFilterLibrary } from '../../src/domain/pinned-filters';
import { DATA_PREVIEW_DSL } from '../../src/domain/query-pagination';
import { enPinnedFilters } from '../../src/locales/pinned-filters';
import { add, apply, fixture, preview } from './query-filter-workspace-fixture';

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const library = parsePinnedFilterLibrary(nestedFixture)!;
  await f.pinned.save(0, { version: 2, entries: [{ ...library.entries[0]!, connectionId: f.a.id, index: 'events' }] });
}
function load() {
  fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
  fireEvent.click(screen.getByRole('button', { name: 'Load Nested set for review' }));
}
async function check() {
  fireEvent.click(screen.getByRole('button', { name: 'Check Mapping and field capabilities' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview filtered DSL' })).toBeEnabled());
  preview();
}
const finalDsl = () => (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;

describe('pinned nested workspace boundaries', () => {
  it('loads without execution, reviews current evidence and keeps a loaded copy after library deletion', async () => {
    const f = await fixture();
    await seed(f);
    f.mount();
    await f.saved();
    load();
    expect(f.backend.readResource.mock.calls.some(([request]) => request.resource === 'mapping')).toBe(false);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(screen.getAllByText(enPinnedFilters.literal)).toHaveLength(6);
    preview();
    expect(screen.getByRole('button', { name: 'Apply filters to draft' })).toBeDisabled();
    await check();
    const final = finalDsl();
    expect(final).toContain('"comments.n": 9007199254740993');
    expect(final).not.toContain('"tags"');
    expect(screen.getByLabelText('Group 3 parent match')).toHaveValue('exclude');
    apply();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(screen.getByRole('group', { name: '6 session filters' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Nested set' }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.delete }));
    await screen.findByText(enPinnedFilters.empty);
    fireEvent.click(screen.getByText('Close', { selector: 'button' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit session filters' }));
    expect(screen.getByRole('list', { name: '6 pending filters' })).toBeVisible();
    expect(screen.getByLabelText('Group 3 parent match')).toHaveValue('exclude');
    expect((await f.pinned.load()).library.entries).toEqual([]);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect((await f.recovery.load()).document.history).toEqual([]);
  });

  it('restores only applied DSL and local definitions, not an unreviewed edit or a serialized trusted binding', async () => {
    const f = await fixture();
    await seed(f);
    const view = f.mount();
    await f.saved();
    load();
    await check();
    const final = finalDsl();
    apply();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Edit session filters' }));
    fireEvent.change(screen.getByLabelText('Group 3 parent match'), { target: { value: 'include' } });
    view.unmount();
    f.mount();
    await waitFor(() => expect(screen.getByLabelText('Query DSL')).toHaveValue(final));
    expect(screen.queryByRole('button', { name: 'Edit session filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review pending filters' })).not.toBeInTheDocument();
    expect((await f.pinned.load()).library.entries[0]!.composition.groups[2]!.nested!.match).toBe('exclude');
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect((await f.recovery.load()).document.history).toEqual([]);
  });

  it('opens an explicit index-derived query, then accepts a real later observation without altering its source index', async () => {
    const f = await fixture();
    await seed(f);
    f.mount();
    await f.saved();
    fireEvent.click(await screen.findByRole('button', { name: 'events' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    load();
    await check();
    const final = finalDsl();
    fireEvent.click(screen.getByRole('button', { name: 'Open filtered query' }));
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('ready', { selector: '.rg-cell' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('other', { selector: '.rg-cell' });
    expect(f.backend.execute).toHaveBeenCalledTimes(2);
    expect(f.backend.execute.mock.calls[1]![0].rawDsl).toBe(final);
    f.clickCell('other', 'status');
    add();
    preview();
    expect(finalDsl()).toContain('"other"');
    apply();
    expect(screen.getByRole('group', { name: '7 session filters' })).toBeVisible();
    await f.saved();
    const restored = (await f.recovery.load()).document;
    expect(restored.workspace!.tabs.find((tab) => tab.kind === 'index')!.document.dsl).toBe(DATA_PREVIEW_DSL);
    expect(restored.history).toHaveLength(2);
    expect(f.backend.execute).toHaveBeenCalledTimes(2);
    expect((await f.pinned.load()).library.entries[0]!.filters).toHaveLength(6);
  });

  it('keeps the existing PIT cursor bound to the old request after applying saved nested conditions', async () => {
    const f = await fixture(false, false, true);
    await seed(f);
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    const original = f.backend.execute.mock.calls[0]![0];
    load();
    await check();
    const final = finalDsl();
    apply();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(2));
    expect(f.backend.execute.mock.calls[1]![0].rawDsl).toBe(original.rawDsl);
    expect(f.backend.execute.mock.calls[1]![0].pitId).toBe(original.pitId);
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(original.rawDsl).not.toContain('"nested"');
  });
});

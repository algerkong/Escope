import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { enPinnedFilters } from '../../src/locales/pinned-filters';
import { DATA_PREVIEW_DSL } from '../../src/domain/query-pagination';
import { add, apply, fixture, preview, savedFilterSet } from './query-filter-workspace-fixture';

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  await f.pinned.save(0, { version: 1, entries: [savedFilterSet(f.a.id)] });
}
async function load() {
  fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
  fireEvent.click(screen.getByRole('button', { name: 'Load Saved set for review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check field capabilities' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview filtered DSL' })).toBeEnabled());
  preview();
}
const finalDsl = () => (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;

describe('pinned filter lifecycle isolation', () => {
  it('retains definitions after restart without restoring session bindings, pending changes or execution evidence', async () => {
    const f = await fixture();
    await seed(f);
    const first = f.mount();
    await f.saved();
    await load();
    const final = finalDsl();
    apply();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Edit session filters' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for n' }));
    first.unmount();
    f.mount();
    await waitFor(() => expect(screen.getByLabelText('Query DSL')).toHaveValue(final));
    expect(screen.queryByRole('button', { name: 'Edit session filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review pending filters' })).not.toBeInTheDocument();
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect((await f.recovery.load()).document.history).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
    expect(screen.getByRole('button', { name: 'Load Saved set for review' })).toBeEnabled();
    expect((await f.pinned.load()).library.entries[0]!.filters[0]!.enabled).toBe(true);
  });

  it('opens an explicit same-target query from an index, with no fabricated execution and repeatable baseline edits', async () => {
    const f = await fixture();
    await seed(f);
    f.mount();
    await f.saved();
    fireEvent.click(await screen.findByRole('button', { name: 'events' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    await load();
    const final = finalDsl();
    fireEvent.click(screen.getByRole('button', { name: 'Open filtered query' }));
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('ready', { selector: '.rg-cell' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit session filters' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for n' }));
    preview();
    expect(finalDsl()).toBe(DATA_PREVIEW_DSL);
    apply();
    fireEvent.click(screen.getByRole('button', { name: 'Edit session filters' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for n' }));
    preview();
    expect(finalDsl()).toBe(final);
    apply();
    await f.saved();
    const restored = (await f.recovery.load()).document;
    expect(restored.workspace!.tabs.find((tab) => tab.kind === 'index')!.document.dsl).toBe(DATA_PREVIEW_DSL);
    expect(restored.history).toHaveLength(1);
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
  });

  it('accepts real cell evidence after explicit execution, preserving saved-literal labels and old PIT requests', async () => {
    const f = await fixture(false, false, true);
    await seed(f);
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    const original = f.backend.execute.mock.calls[0]![0];
    await load();
    const final = finalDsl();
    apply();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(2));
    expect(f.backend.execute.mock.calls[1]![0].rawDsl).toBe(original.rawDsl);
    expect(f.backend.execute.mock.calls[1]![0].pitId).toBe(original.pitId);
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run query' })).toBeEnabled());
    expect(f.backend.execute.mock.calls[2]![0].rawDsl).toBe(final);
    f.clickCell('ready', 'status');
    add();
    expect(screen.getAllByText(enPinnedFilters.literal)).toHaveLength(2);
    preview();
    expect(finalDsl()).toContain('"ready"');
    apply();
    expect(screen.getByRole('group', { name: '3 session filters' })).toBeVisible();
    expect(f.backend.execute).toHaveBeenCalledTimes(3);
    await f.saved();
    expect((await f.pinned.load()).library.entries[0]!.filters).toHaveLength(2);
  });
});

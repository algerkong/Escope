import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { enPinnedFilters } from '../../src/locales/pinned-filters';
import { add, apply, fixture, inspect, preview, savedFilterSet as savedSet } from './query-filter-workspace-fixture';

const closeDialog = () => fireEvent.click(screen.getByText('Close', { selector: 'button' }));
async function load(f: Awaited<ReturnType<typeof fixture>>) {
  fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
  fireEvent.click(await screen.findByRole('button', { name: 'Load Saved set for review' }));
  expect(screen.getAllByText(enPinnedFilters.literal)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Check field capabilities' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview filtered DSL' })).toBeEnabled());
  expect(f.backend.execute).not.toHaveBeenCalled();
}

describe('pinned filters in the workspace', () => {
  it('explicitly saves a complete current filter set without running or applying it', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    f.clickCell('ready', 'status');
    await inspect();
    add();
    fireEvent.click(screen.getByRole('switch', { name: 'Filter enabled for status' }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.pin }));
    fireEvent.change(screen.getByLabelText(enPinnedFilters.name), { target: { value: 'Ready status' } });
    expect(screen.getByRole('button', { name: enPinnedFilters.save })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: enPinnedFilters.literalConsent }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.save }));
    await screen.findByRole('dialog', { name: 'Query filters' });
    const stored = (await f.pinned.load()).library.entries;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'Ready status', connectionId: f.a.id, index: 'events',
      filters: [{ field: 'status', value: '"ready"', enabled: false }] });
    expect(stored[0]).not.toHaveProperty('snapshot');
    expect(stored[0]).not.toHaveProperty('endpoint');
    expect(screen.getByRole('switch', { name: 'Filter enabled for status' })).not.toBeChecked();
    closeDialog();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
  });

  it('loads before the first execution, rechecks evidence and applies only after complete DSL review', async () => {
    const f = await fixture(true, false, true, true);
    await f.pinned.save(0, { version: 1, entries: [savedSet(f.a.id)] });
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Load Saved set for review' }));
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent('No current field-capability evidence.');
    expect(screen.getByRole('button', { name: 'Apply filters to draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check field capabilities' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview filtered DSL' })).toBeEnabled());
    preview();
    const final = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    expect(final).toContain('9007199254740993');
    expect(final).not.toContain('"other"');
    expect(JSON.parse(final).sort).toEqual([{ n: 'desc' }, '_score']);
    apply();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(screen.getByRole('group', { name: '2 session filters' })).toHaveTextContent('1 / 2 enabled');
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(f.backend.openPit).not.toHaveBeenCalled();
    await f.saved();
    const document = (await f.recovery.load()).document.workspace!.tabs[0]!.document;
    expect(document).toMatchObject({ dsl: final, parameters: f.query.parameters, timeRange: f.query.timeRange });
    expect(document).not.toHaveProperty('filters');
    expect(document).not.toHaveProperty('snapshot');
    expect((await f.recovery.load()).document.history).toEqual([]);
  });

  it('leaves pending literals session-only across settings and never overwrites them with another load', async () => {
    const f = await fixture();
    await f.pinned.save(0, { version: 1, entries: [savedSet(f.a.id)] });
    f.mount();
    await f.saved();
    await load(f);
    closeDialog();
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Query DSL'), { key: 'Enter', ctrlKey: true });
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Back to query' }));
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
    expect(screen.getByRole('button', { name: 'Load Saved set for review' })).toBeDisabled();
    expect(screen.getByText(enPinnedFilters.loadBlocked)).toBeVisible();
    closeDialog();
    expect(screen.getByRole('group', { name: '2 pending filters' })).toBeVisible();
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect((await f.recovery.load()).document.workspace!.tabs[0]!.document.dsl).toBe(f.query.dsl);
  });

  it('deleting a saved set does not remove or rewrite its loaded pending copy', async () => {
    const f = await fixture();
    await f.pinned.save(0, { version: 1, entries: [savedSet(f.a.id)] });
    f.mount();
    await f.saved();
    await load(f);
    closeDialog();
    fireEvent.click(screen.getByRole('button', { name: enPinnedFilters.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Saved set' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: enPinnedFilters.deleteTitle })).getByRole('button', { name: enPinnedFilters.delete }));
    await waitFor(() => expect(screen.getByText(enPinnedFilters.empty)).toBeVisible());
    closeDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Review pending filters' }));
    expect(screen.getAllByText(enPinnedFilters.literal)).toHaveLength(2);
    preview();
    expect((screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value).toContain('9007199254740993');
    apply();
    expect((await f.pinned.load()).library.entries).toEqual([]);
    expect(f.backend.execute).not.toHaveBeenCalled();
    await f.saved();
  });
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { addWorkspaceTab, createIndexTab, createSnapshot, createWorkspace, selectWorkspaceTab } from '../../src/domain/query';
import { finishHistory, historyEntry, recoveryWorkspace, type WorkspaceRecoveryDocument } from '../../src/domain/workspace-recovery';
import { i18n } from '../../src/locales';
import { enQueryHistory, enWorkspaceRecovery, zhQueryHistory, zhWorkspaceRecovery } from '../../src/locales/workspace-recovery';
import type { PitOpenRequest, QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';
import { createSessionStorage } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService, type WorkspaceRecoveryService } from '../../src/services/workspace-recovery';

const dsl = '{"query":{"term":{"n":9007199254740993}},"size":65}';

async function fixture() {
  const storage = createSessionStorage();
  const a = await storage.saveConnection({ displayName: 'Primary', endpoint: 'https://primary.test', environment: 'development' });
  const b = await storage.saveConnection({ displayName: 'Other', endpoint: 'https://other.test', environment: 'development' });
  await storage.selectConnection(b.id);
  const initial = await storage.load();
  initial.preferences.locale = 'en-US';
  let workspace = createWorkspace(a.id);
  const query = workspace.tabs[0]!.document;
  query.name = 'Working draft';
  query.index = 'orders';
  query.dsl = dsl;
  workspace = addWorkspaceTab(workspace, createIndexTab(a.id, 'orders', 'json'));
  workspace = selectWorkspaceTab(workspace, query.id);
  const document: WorkspaceRecoveryDocument = { version: 1, workspace: recoveryWorkspace(workspace), history: [] };
  const memory = createSessionWorkspaceRecoveryService();
  await memory.save(0, document);
  const recovery: WorkspaceRecoveryService = { ...memory, kind: 'desktop', load: vi.fn(memory.load), save: vi.fn(memory.save) };
  const endpoint = (id: string) => id === a.id ? a.endpoint : b.endpoint;
  const hits = Array.from({ length: 65 }, (_, i) => `{"_index":"orders","_id":"private-id-${i}",`
    + `"_source":{"n":${9007199254740993n + BigInt(i)},"label":"result-body-${i}"}}`).join(',');
  const api = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: endpoint(request.connectionId), rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"orders","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : '{"indices":["orders"],"fields":{}}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({
      requestId: request.requestId, connectionId: request.connectionId, endpoint: endpoint(request.connectionId),
      partial: false, pitId: request.pitId ?? null,
      rawResponse: `{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":65,"relation":"eq"},"hits":[${hits}]}}`,
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({ ...request, endpoint: endpoint(request.connectionId), pitId: 'private-pit-token' })),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  const mount = () => render(<I18nextProvider i18n={i18n}><App service={{ ...storage, kind: 'desktop' }} initial={initial}
    queryBackend={api} workspaceRecoveryService={recovery} /></I18nextProvider>);
  const saved = async () => waitFor(() => expect(screen.getByText('Workspace saved')).toBeInTheDocument());
  return { storage, a, b, initial, query, document, recovery, memory, api, mount, saved, user: userEvent.setup() };
}

describe('app workspace recovery', () => {
  it('restores ordered query/index tabs and active context without executing or opening a PIT', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    expect(screen.getByRole('tab', { name: 'Working draft' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'orders (Primary)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Active connection')).toHaveValue(f.a.id);
    expect(screen.getByLabelText('Query DSL')).toHaveValue(dsl);
    await f.user.click(screen.getByRole('tab', { name: 'orders (Primary)' }));
    expect(screen.getByRole('button', { name: 'JSON' })).toHaveAttribute('aria-pressed', 'true');
    // Even clicking the catalog entry for an already restored index only focuses its tab.
    await f.user.click(await screen.findByRole('button', { name: 'orders' }));
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    await f.user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await f.user.click(screen.getByRole('button', { name: 'Appearance' }));
    await f.user.click(screen.getByRole('button', { name: 'Dark' }));
    await f.user.click(screen.getByRole('button', { name: 'Back to query' }));
    expect(f.api.execute).not.toHaveBeenCalled();
    expect(f.api.openPit).not.toHaveBeenCalled();
  });

  it('persists edited drafts and all column preferences but resets old pages, selection and bodies on restart', async () => {
    const f = await fixture();
    const first = f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('Completed');
    fireEvent.change(screen.getByLabelText('Query name'), { target: { value: 'Renamed unsaved draft' } });
    const width = screen.getByRole('separator', { name: 'Resize column n' });
    const originalWidth = Number(width.getAttribute('aria-valuenow'));
    fireEvent.keyDown(width, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Sort by n' }));
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move n left' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show column Index (_index)' }));
    await f.user.keyboard('{Escape}');
    await f.user.click(document.querySelector('tbody tr') as HTMLElement);
    expect(document.querySelector('tbody tr[aria-selected="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 2')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    await f.saved();
    const before = await f.recovery.load();
    const encoded = JSON.stringify(before);
    expect(encoded).not.toMatch(/private-id|private-pit|result-body|rowSelection|pageIndex|rawResponse/);
    expect(before.document.workspace!.tabs[0]!.grid).toMatchObject({
      columnSizing: { 'field:n': originalWidth + 12 }, columnVisibility: { 'meta:index': false },
      sorting: [{ id: 'field:n', desc: false }],
    });
    first.unmount();
    f.mount();
    await f.saved();
    expect(screen.getByRole('tab', { name: 'Renamed unsaved draft' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'JSON' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(dsl);
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(document.querySelector('tbody')).toBeNull();
    expect(f.api.execute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('Completed');
    expect(screen.getByText('Page 1 of 2')).toBeVisible();
    expect(document.querySelectorAll('tbody tr[aria-selected="true"]')).toHaveLength(0);
    expect(screen.getByRole('separator', { name: 'Resize column n' })).toHaveAttribute('aria-valuenow', String(originalWidth + 12));
    expect([...document.querySelectorAll('thead th')].map((th) => th.getAttribute('data-column-id')))
      .toEqual(['meta:row', 'field:n', 'meta:id', 'field:label']);
    expect(document.querySelector('th[data-column-id="field:n"]')).toHaveAttribute('aria-sort', 'ascending');
    expect(f.api.execute).toHaveBeenCalledTimes(2);
    await f.saved();
  });

  it('retains invalid visual drafts across restart without silently falling back to the older executable DSL', async () => {
    const f = await fixture();
    const first = f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'unfinished-' } });
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    await f.saved();
    expect((await f.recovery.load()).document.workspace!.tabs[0]!.visualDraft?.form?.conditions[0]?.value).toBe('unfinished-');
    first.unmount();
    f.mount();
    await f.saved();
    expect(screen.getByRole('button', { name: 'Visual' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Value 1')).toHaveValue('unfinished-');
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Value 1'), { key: 'Enter', ctrlKey: true });
    expect(f.api.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'DSL' }));
    expect(screen.getByLabelText('Query DSL')).toHaveValue(dsl);
    expect(f.api.openPit).not.toHaveBeenCalled();
    await f.saved();
  });

  it('shows honest history outcomes and restores a removed connection into a fresh unbound-to-current query', async () => {
    const f = await fixture();
    const snapshot = createSnapshot({ ...f.query, connectionId: 'removed-id' }, 'old-run', new Date('2026-10-09T12:00:00.000Z'));
    const pending = historyEntry(snapshot, 'Old target', 'query');
    const failed = finishHistory(historyEntry({ ...snapshot, requestId: 'failed-run' }, 'Failed query', 'query'), 'failed', 'timeout',
      new Date('2026-10-09T12:00:01.000Z'));
    await f.memory.save(1, { ...f.document, history: [pending, failed] });
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Execution history' }));
    const dialog = screen.getByRole('dialog', { name: 'Execution History' });
    expect(within(dialog).getByText('Interrupted')).toBeInTheDocument();
    expect(within(dialog).getByText('Failed')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Removed connection')).toHaveLength(2);
    const entry = within(dialog).getByText('Old target').closest('li')!;
    fireEvent.click(within(entry).getByRole('button', { name: 'Restore as new query' }));
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: 'Old target' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(dsl);
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(screen.getByLabelText('Active connection')).toHaveValue(f.a.id);
    expect(f.api.execute).not.toHaveBeenCalled();
    expect(f.api.openPit).not.toHaveBeenCalled();
    await f.saved();
    const restored = (await f.memory.load()).document.workspace!.tabs.at(-1)!;
    expect(restored.document.connectionId).toBe('removed-id');
    expect(restored.document.id).not.toBe(f.query.id);
    fireEvent.click(screen.getByRole('button', { name: 'Execution history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear execution history' }));
    const confirmation = screen.getByRole('dialog', { name: 'Clear Execution History?' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText('No execution history')).toBeVisible());
    await f.saved();
    expect((await f.memory.load()).document.history).toEqual([]);
  });

  it('keeps damaged recovery untouched, explains session-only changes and requires explicit reload', async () => {
    const f = await fixture();
    vi.mocked(f.recovery.load).mockRejectedValue({ code: 'invalidResponse' });
    f.mount();
    expect(await screen.findByText(enWorkspaceRecovery.damaged)).toBeVisible();
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    fireEvent.change(screen.getByLabelText('Query DSL'), { target: { value: 'my session draft' } });
    await act(async () => {});
    expect(f.recovery.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: enWorkspaceRecovery.reload }));
    const dialog = screen.getByRole('dialog', { name: enWorkspaceRecovery.reloadTitle });
    expect(within(dialog).getByText(enWorkspaceRecovery.reloadDetail)).toBeVisible();
    vi.mocked(f.recovery.load).mockImplementation(f.memory.load);
    fireEvent.click(within(dialog).getByRole('button', { name: enWorkspaceRecovery.reload }));
    await f.saved();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(dsl);
    expect(f.api.execute).not.toHaveBeenCalled();
    expect(f.api.openPit).not.toHaveBeenCalled();
  });

  it('maintains matching bilingual recovery and history keys', () => {
    expect(Object.keys(zhWorkspaceRecovery).sort()).toEqual(Object.keys(enWorkspaceRecovery).sort());
    expect(Object.keys(zhQueryHistory).sort()).toEqual(Object.keys(enQueryHistory).sort());
    for (const value of [...Object.values(zhWorkspaceRecovery), ...Object.values(zhQueryHistory)]) expect(value.trim()).not.toBe('');
  });
});

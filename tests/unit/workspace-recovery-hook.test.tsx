import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../../src/domain/connection';
import { createQuery, createSnapshot, createWorkspace, updateWorkspaceDocument } from '../../src/domain/query';
import { finishHistory, historyEntry, recoveryWorkspace, type WorkspaceRecoveryRecord } from '../../src/domain/workspace-recovery';
import { useWorkspaceRecovery } from '../../src/features/query/useWorkspaceRecovery';
import { createSessionWorkspaceRecoveryService, type WorkspaceRecoveryService } from '../../src/services/workspace-recovery';

const profiles: ConnectionProfile[] = [
  { id: 'a', displayName: 'A', endpoint: 'https://a.test', environment: 'development', auth: 'none', sortOrder: 0 },
  { id: 'b', displayName: 'B', endpoint: 'https://b.test', environment: 'development', auth: 'none', sortOrder: 1 },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const workspace = createWorkspace('a');
  const id = workspace.tabs[0]!.document.id;
  workspace.activeTabId = id;
  workspace.tabs[0]!.document.dsl = '{"query":';
  workspace.tabs[0]!.document.resultView = 'json';
  const saved: WorkspaceRecoveryRecord = { revision: 7, document: { version: 1, workspace: recoveryWorkspace(workspace), history: [] } };
  const service: WorkspaceRecoveryService = {
    kind: 'desktop', load: vi.fn(async () => structuredClone(saved)), save: vi.fn(async (revision) => revision + 1),
  };
  return { workspace, id, saved, service };
}

describe('workspace recovery load and write ownership', () => {
  it('restores drafts and layout, resolves active context without rebinding deleted targets', async () => {
    const { workspace, id, saved, service } = fixture();
    saved.document.workspace!.activeConnectionId = 'b';
    const first = renderHook(() => useWorkspaceRecovery(service, createWorkspace('b'), profiles));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    expect(first.result.current.workspace).toMatchObject({ activeTabId: id, activeConnectionId: 'a' });
    expect(first.result.current.workspace.tabs[0]!.document.dsl).toBe('{"query":');
    expect(first.result.current.restoreVersion).toBe(0);
    first.unmount();
    const second = renderHook(() => useWorkspaceRecovery(service, workspace, [profiles[1]!]));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    expect(second.result.current.workspace.activeConnectionId).toBe('b');
    expect(second.result.current.workspace.tabs[0]!.document.connectionId).toBe('a');
  });

  it('keeps a damaged store untouched while local edits remain usable', async () => {
    const { workspace, id, service } = fixture();
    vi.mocked(service.load).mockRejectedValue({ code: 'invalidResponse' });
    const { result } = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    await waitFor(() => expect(result.current.status).toBe('error'));
    act(() => result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { dsl: 'keep local' })));
    act(() => result.current.retrySave());
    expect(result.current.workspace.tabs[0]!.document.dsl).toBe('keep local');
    expect(service.save).not.toHaveBeenCalled();
    expect(result.current.loadError).toBe('invalidResponse');
  });

  it('does not apply a late initial restore over edits made before it resolved', async () => {
    const { workspace, id, saved, service } = fixture();
    const pending = deferred<WorkspaceRecoveryRecord>();
    vi.mocked(service.load).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    act(() => result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'new intent' })));
    await act(async () => { pending.resolve(saved); });
    expect(result.current.status).toBe('conflict');
    expect(result.current.workspace.tabs[0]!.document.name).toBe('new intent');
    expect(service.save).not.toHaveBeenCalled();
  });

  it('guards edits made after an explicit reload began as well', async () => {
    const { workspace, id, saved, service } = fixture();
    const { result } = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const pending = deferred<WorkspaceRecoveryRecord>();
    vi.mocked(service.load).mockReturnValueOnce(pending.promise);
    act(() => result.current.reload());
    act(() => result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'after reload' })));
    await act(async () => { pending.resolve(saved); });
    expect(result.current.status).toBe('conflict');
    expect(result.current.workspace.tabs[0]!.document.name).toBe('after reload');
  });

  it('serializes writes, coalesces queued edits, and never rolls back on an older acknowledgement', async () => {
    const { workspace, id, service } = fixture();
    const pending = deferred<number>();
    vi.mocked(service.save).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'first' })));
    await waitFor(() => expect(service.save).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'second' }));
      result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'latest', resultView: 'table' }));
    });
    expect(service.save).toHaveBeenCalledTimes(1);
    expect(result.current.workspace.tabs[0]!.document.name).toBe('latest');
    await act(async () => { pending.resolve(8); });
    await waitFor(() => expect(result.current.saveStatus.status).toBe('saved'));
    expect(service.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(service.save).mock.calls[1]![0]).toBe(8);
    expect(vi.mocked(service.save).mock.calls[1]![1].workspace!.tabs[0]!.document).toMatchObject({ name: 'latest', resultView: 'table' });
    expect(result.current.workspace.tabs[0]!.document.name).toBe('latest');
  });

  it('reports write failure and retries the current draft, but never retries a CAS conflict blindly', async () => {
    const { workspace, id, service } = fixture();
    vi.mocked(service.save).mockRejectedValueOnce({ code: 'storageUnavailable' });
    const { result } = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'unsaved' })));
    await waitFor(() => expect(result.current.saveStatus).toEqual({ status: 'error', code: 'storageUnavailable' }));
    act(() => result.current.retrySave());
    await waitFor(() => expect(result.current.saveStatus.status).toBe('saved'));
    vi.mocked(service.save).mockRejectedValueOnce({ code: 'workspaceConflict' });
    act(() => result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'conflicting' })));
    await waitFor(() => expect(result.current.status).toBe('conflict'));
    act(() => result.current.retrySave());
    expect(service.save).toHaveBeenCalledTimes(3);
    expect(result.current.workspace.tabs[0]!.document.name).toBe('conflicting');
  });

  it('flushes an already queued final edit after component unmount without rendering stale state', async () => {
    const { workspace, id, service } = fixture();
    const hook = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    act(() => {
      hook.result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'last edit' }));
      hook.unmount();
    });
    await waitFor(() => expect(service.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(service.save).mock.calls[0]![1].workspace!.tabs[0]!.document.name).toBe('last edit');
  });

  it('restores running history as interrupted, not successful, and does not revive externally removed terminal history', async () => {
    const { workspace, saved, service } = fixture();
    const query = { ...createQuery('a'), index: 'orders' };
    const entry = historyEntry(createSnapshot(query, 'run-1', new Date('2026-10-09T12:00:00.000Z')), '', 'query');
    vi.mocked(service.load).mockResolvedValueOnce({ ...saved, document: { ...saved.document, history: [entry] } });
    const { result } = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.history[0]).toMatchObject({ status: 'interrupted', finishedAt: null });
    await waitFor(() => expect(result.current.saveStatus.status).toBe('saved'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.history).toEqual([]);
  });

  it('keeps live history while an initial load is pending and persists no result payload', async () => {
    const { workspace, service } = fixture();
    const pending = deferred<WorkspaceRecoveryRecord>();
    vi.mocked(service.load).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    const query = { ...createQuery('a'), index: 'orders' };
    const entry = historyEntry(createSnapshot(query, 'run-live', new Date('2026-10-09T12:00:00.000Z')), '', 'index');
    act(() => result.current.onHistory(entry));
    await act(async () => { pending.resolve({ revision: 0, document: { version: 1, workspace: null, history: [] } }); });
    expect(result.current.history[0]!.status).toBe('running');
    act(() => result.current.onHistory(finishHistory(entry, 'partial', null, new Date('2026-10-09T12:00:01.000Z'))));
    await waitFor(() => expect(result.current.saveStatus.status).toBe('saved'));
    expect(result.current.history[0]!.status).toBe('partial');
    const latest = vi.mocked(service.save).mock.calls.at(-1)![1];
    expect(JSON.stringify(latest)).not.toMatch(/rawResponse|pitId|searchAfter|rowSelection/);
  });

  it('two controller lifetimes cannot overwrite each other silently', async () => {
    const { workspace, id, saved } = fixture();
    const service = createSessionWorkspaceRecoveryService();
    await service.save(0, saved.document);
    const first = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    const second = renderHook(() => useWorkspaceRecovery(service, workspace, profiles));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    act(() => first.result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'first window' })));
    await waitFor(() => expect(first.result.current.saveStatus.status).toBe('saved'));
    act(() => second.result.current.updateWorkspace((state) => updateWorkspaceDocument(state, id, { name: 'second window' })));
    await waitFor(() => expect(second.result.current.status).toBe('conflict'));
    expect((await service.load()).document.workspace!.tabs[0]!.document.name).toBe('first window');
    expect(second.result.current.workspace.tabs[0]!.document.name).toBe('second window');
  });
});

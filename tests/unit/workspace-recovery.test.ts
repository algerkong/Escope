import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { addWorkspaceTab, createIndexTab, createQuery, createSnapshot, createWorkspace } from '../../src/domain/query';
import { utf8ByteLength } from '../../src/domain/query-library';
import { INITIAL_RESULT_GRID_STATE } from '../../src/domain/result-grid';
import {
  emptyRecoveryDocument, finishHistory, gridLayout, historyEntry, interruptHistory,
  MAX_EXECUTION_HISTORY, MAX_HISTORY_BYTES, parseRecoveryDocument, parseRecoveryRecord, recordHistory,
  recoveryWorkspace, restoreHistoryQuery, type ExecutionHistoryEntry, type WorkspaceRecoveryDocument,
} from '../../src/domain/workspace-recovery';
import { createSessionWorkspaceRecoveryService, desktopWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ipc);

const dsl = '{"query":{"range":{"n":{"gte":9007199254740993,"lte":1.1000000000000000001}}},"size":1}';
const query = { ...createQuery('original-id'), name: 'Orders', index: 'orders-*', dsl, resultView: 'json' as const };
const started = new Date('2026-10-09T12:00:00.000Z');
const finished = new Date('2026-10-09T12:00:01.234Z');
const running = historyEntry(createSnapshot(query, 'request-1', started), query.name, 'query');
const completed = finishHistory(running, 'success', null, finished);

function document(): WorkspaceRecoveryDocument {
  const workspace = addWorkspaceTab(createWorkspace('original-id'), { kind: 'query', document: query });
  return { version: 1, workspace: recoveryWorkspace(workspace), history: [completed] };
}

describe('bounded workspace and execution metadata', () => {
  it('accepts the same v1 fixture as the Rust IPC contract', () => {
    const fixture: unknown = JSON.parse(readFileSync('tests/fixtures/workspace-recovery-v1.json', 'utf8'));
    const parsed = parseRecoveryDocument(fixture);
    expect(parsed).not.toBeNull();
    expect(parsed!.workspace!.tabs[0]!.visualDraft?.form?.conditions[0]!.original?.raw).toBe('9007199254740993');
    expect(JSON.stringify(parsed)).toContain('9007199254740993');
  });

  it('round-trips exact drafts, views and column layout, excluding transient rows and transports', () => {
    const value = document();
    const layout = gridLayout({
      ...INITIAL_RESULT_GRID_STATE, columnOrder: ['meta:row', 'field:n', 'meta:id'],
      columnSizing: { 'field:n': 240 }, columnVisibility: { 'meta:index': false },
      sorting: [{ id: 'field:n', desc: true }], rowSelection: { 'sensitive-hit': true }, pageIndex: 5,
    } as typeof INITIAL_RESULT_GRID_STATE);
    const saved: WorkspaceRecoveryDocument = {
      ...value, workspace: { ...value.workspace!, tabs: value.workspace!.tabs.map((tab) => ({ ...tab, grid: layout })) },
    };
    expect(parseRecoveryDocument(saved)).toEqual(saved);
    const encoded = JSON.stringify(saved);
    expect(encoded).toContain('9007199254740993');
    expect(encoded).toContain('1.1000000000000000001');
    for (const excluded of ['rowSelection', 'pageIndex', 'rawResponse', 'pitId', 'sensitive-hit', 'credentialRef']) {
      expect(encoded).not.toContain(excluded);
    }
    const snapshotWithExtras = { ...running.snapshot, rawResponse: 'body', pitId: 'server-token', credentialRef: 'secret-reference' };
    expect(historyEntry(snapshotWithExtras, 'name', 'query').snapshot).toEqual(running.snapshot);
    expect(Object.isFrozen(historyEntry(snapshotWithExtras, 'name', 'query').snapshot)).toBe(true);
  });

  it('keeps incomplete DSL and invalid visual values as text without marking them runnable', () => {
    const value = document();
    const tab = value.workspace!.tabs[1]!;
    const visual = {
      source: dsl,
      form: { mode: 'all' as const, size: 'not a number', sort: null, conditions: [{
        id: 'row-1', field: 'n', operator: 'eq' as const, context: 'filter' as const, valueType: 'number' as const, value: 'unfinished-',
        original: { field: 'n', valueType: 'number' as const, value: '9007199254740993', raw: '9007199254740993' },
      }] },
      problems: [{ code: 'valueInvalidNumber' as const, conditionId: 'row-1' }, { code: 'sizeInvalid' as const }],
    };
    const saved = { ...value, workspace: { ...value.workspace!, tabs: [{ ...tab, editorMode: 'visual', visualDraft: visual }] } };
    expect(parseRecoveryDocument(saved)).not.toBeNull();
    const incomplete = { ...saved, workspace: {
      ...saved.workspace, tabs: [{ ...tab, document: { ...tab.document, dsl: '{"query":' }, visualDraft: null }],
    } };
    expect(parseRecoveryDocument(incomplete)).not.toBeNull();
  });

  it('rejects old/future, corrupt and secret-bearing shapes instead of repairing a subset', () => {
    const value = document();
    const workspace = value.workspace!;
    const tab = workspace.tabs[1]!;
    const malformed: unknown[] = [
      null, [], { ...value, version: 0 }, { ...value, version: 2 }, { ...value, response: 'private' },
      { ...value, workspace: { ...workspace, activeTabId: 'missing' } },
      { ...value, workspace: { ...workspace, tabs: [tab, tab] } },
      { ...value, workspace: { ...workspace, tabs: [{ ...tab, rawResponse: 'private' }] } },
      { ...value, workspace: { ...workspace, tabs: [{ ...tab, document: { ...tab.document, credentialRef: 'private' } }] } },
      { ...value, workspace: { ...workspace, tabs: [{ ...tab, document: { ...tab.document, revision: Number.MAX_SAFE_INTEGER + 1 } }] } },
      { ...value, workspace: { ...workspace, tabs: [{ ...tab, document: { ...tab.document, name: 'line\nbreak' } }] } },
      { ...value, workspace: { ...workspace, tabs: [{ ...tab, document: { ...tab.document, dsl: 'x'.repeat(256 * 1024 + 1) } }] } },
      { ...value, history: [{ ...completed, snapshot: { ...completed.snapshot, pitId: 'old-pit' } }] },
      { ...value, history: [{ ...completed, snapshot: { ...completed.snapshot, startedAt: '2026-02-30T00:00:00.000Z' } }] },
      { ...value, history: [{ ...completed, finishedAt: '2026-10-09T11:00:00.000Z' }] },
      { ...value, history: [{ ...completed, status: 'running' }] },
      { ...value, history: [{ ...running, status: 'failed' }] },
      { ...value, history: [{ ...completed, errorCode: 'Authorization: fixture' }] },
      { ...value, history: [completed, completed] },
    ];
    for (const bad of malformed) expect(parseRecoveryDocument(bad)).toBeNull();
    expect(parseRecoveryRecord({ revision: -1, document: value })).toBeNull();
    expect(parseRecoveryRecord({ revision: 1, document: value, endpoint: 'https://bad.test' })).toBeNull();
  });

  it('validates layout and visual fields, index identity, tab count and remembered targets', () => {
    const value = document();
    const workspace = value.workspace!;
    const tab = workspace.tabs[1]!;
    const withTab = (replacement: unknown) => ({ ...value, workspace: { ...workspace, tabs: [replacement] } });
    for (const grid of [
      { ...tab.grid, rowSelection: { a: true } },
      { ...tab.grid, columnOrder: ['field:a', 'field:a'] },
      { ...tab.grid, columnSizing: { 'field:a': 999 } },
      { ...tab.grid, columnVisibility: { 'meta:row': false } },
      { ...tab.grid, sorting: [{ id: 'field:a', desc: 'false' }] },
      { ...tab.grid, columnSizing: { 'field:a': Number.NaN } },
    ]) expect(parseRecoveryDocument(withTab({ ...tab, grid }))).toBeNull();
    expect(parseRecoveryDocument(withTab({ ...tab, visualDraft: { source: 'stale', form: null, problems: [] } }))).toBeNull();
    expect(parseRecoveryDocument(withTab({ ...tab, visualDraft: { source: dsl, form: null, problems: [{ code: 'unknown' }] } }))).toBeNull();
    expect(parseRecoveryDocument({ ...value, workspace: { ...workspace, lastTabByConnection: { different: query.id } } })).toBeNull();
    expect(parseRecoveryDocument({ ...value, workspace: { ...workspace, tabs: Array.from({ length: 51 }, (_, i) => ({
      ...tab, document: { ...tab.document, id: `tab-${i}` },
    })), activeTabId: null, lastTabByConnection: {} } })).toBeNull();
    const indexTab = createIndexTab('original-id', 'orders', 'table');
    const saved = recoveryWorkspace(addWorkspaceTab(createWorkspace('original-id'), indexTab));
    expect(parseRecoveryDocument({ ...value, workspace: saved })).not.toBeNull();
    expect(parseRecoveryDocument({ ...value, workspace: { ...saved, tabs: [...saved.tabs, {
      ...saved.tabs[1]!, document: { ...indexTab.document, id: 'duplicate-target' },
    }] } })).toBeNull();
  });

  it('restores a fresh query under the original stable ID and marks unfinished history interrupted', () => {
    const restored = restoreHistoryQuery(completed);
    expect(restored.id).not.toBe(query.id);
    expect(restored).toMatchObject({ connectionId: 'original-id', index: query.index, dsl, revision: 0 });
    expect(interruptHistory([running, completed])).toEqual([
      { ...running, status: 'interrupted', finishedAt: null }, completed,
    ]);
    expect(restoreHistoryQuery(completed).id).not.toBe(restored.id);
  });

  it('never rewrites terminal outcomes or snapshot identity with a late completion', () => {
    const cancelled = finishHistory(running, 'cancelled', 'cancelled', finished);
    const history = [cancelled];
    expect(recordHistory(history, completed)).toBe(history);
    expect(recordHistory([running], { ...completed, snapshot: { ...completed.snapshot, connectionId: 'other-id' } })).toEqual([running]);
    expect(recordHistory([running], completed)).toEqual([completed]);
  });

  it('evicts oldest history by count and serialized byte budget', () => {
    let history: readonly ExecutionHistoryEntry[] = [];
    for (let index = 0; index < 105; index++) {
      history = recordHistory(history, { ...completed, snapshot: { ...completed.snapshot, requestId: `request-${index}` } });
    }
    expect(history).toHaveLength(MAX_EXECUTION_HISTORY);
    expect(history[0]!.snapshot.requestId).toBe('request-104');
    expect(history.at(-1)!.snapshot.requestId).toBe('request-5');
    history = [];
    for (let index = 0; index < 25; index++) {
      history = recordHistory(history, {
        ...completed, snapshot: { ...completed.snapshot, requestId: `large-${index}`, rawDsl: 'x'.repeat(200 * 1024) },
      });
    }
    expect(history.length).toBeLessThan(25);
    expect(utf8ByteLength(JSON.stringify(history))).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
  });
});

describe('typed recovery service', () => {
  beforeEach(() => { ipc.invoke.mockReset(); ipc.isTauri.mockReturnValue(true); });

  it('uses explicit session storage, cloned reads and compare-and-swap saves', async () => {
    const service = createSessionWorkspaceRecoveryService();
    expect(await service.load()).toEqual({ revision: 0, document: emptyRecoveryDocument() });
    expect(await service.save(0, document())).toBe(1);
    await expect(service.save(0, emptyRecoveryDocument())).rejects.toMatchObject({ code: 'workspaceConflict' });
    const read = await service.load();
    read.document.workspace!.tabs[1]!.document.dsl = 'local mutation';
    expect((await service.load()).document.workspace!.tabs[1]!.document.dsl).toBe(dsl);
    await expect(service.save(1, { ...document(), version: 2 })).rejects.toMatchObject({ code: 'invalidInput' });
    expect((await service.load()).revision).toBe(1);
  });

  it('calls only fixed IPC commands with typed documents, never a network/file proxy', async () => {
    ipc.invoke.mockResolvedValueOnce({ revision: 7, document: document() }).mockResolvedValueOnce({ revision: 8 });
    const loaded = await desktopWorkspaceRecoveryService.load();
    expect(loaded.revision).toBe(7);
    expect(await desktopWorkspaceRecoveryService.save(7, loaded.document)).toBe(8);
    expect(ipc.invoke.mock.calls).toEqual([
      ['workspace_recovery_load'],
      ['workspace_recovery_save', { expectedRevision: 7, document: loaded.document }],
    ]);
  });

  it('fails closed on corrupt responses, stale acknowledgements and unavailable desktop storage', async () => {
    ipc.invoke.mockResolvedValueOnce({ revision: 7, document: { ...document(), version: 2 } });
    await expect(desktopWorkspaceRecoveryService.load()).rejects.toMatchObject({ code: 'invalidResponse' });
    ipc.invoke.mockResolvedValueOnce({ revision: 7 });
    await expect(desktopWorkspaceRecoveryService.save(7, document())).rejects.toMatchObject({ code: 'invalidResponse' });
    ipc.invoke.mockRejectedValueOnce({ code: 'storageUnavailable' });
    await expect(desktopWorkspaceRecoveryService.load()).rejects.toMatchObject({ code: 'storageUnavailable' });
    ipc.isTauri.mockReturnValue(false);
    await expect(desktopWorkspaceRecoveryService.load()).rejects.toMatchObject({ code: 'unsupported' });
    expect(ipc.invoke).toHaveBeenCalledTimes(3);
  });
});

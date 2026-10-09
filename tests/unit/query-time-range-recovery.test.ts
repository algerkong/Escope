import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createValidatedSnapshot, createWorkspace, type ExecutionSnapshot, type QueryDocument } from '../../src/domain/query';
import { parseExecutionTimeRange, parseQueryTimeRange, previewTimeRange } from '../../src/domain/query-time-range';
import { createEmptyLibrary, documentFromEntry, entryFromDocument, libraryPayload, parseLibraryPayload } from '../../src/domain/query-library';
import { buildQueryExchange, importQueryExchange } from '../../src/domain/query-exchange';
import { finishHistory, historyEntry, parseRecoveryDocument, recoveryWorkspace, restoreHistoryQuery } from '../../src/domain/workspace-recovery';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

const fixture = JSON.parse(readFileSync('tests/fixtures/query-time-range-v1.json', 'utf8')) as { draft: QueryDocument; snapshot: ExecutionSnapshot };
const { draft, snapshot } = fixture;
const now = new Date(snapshot.startedAt);
const saved = () => entryFromDocument(draft, { id: 'time-saved', name: draft.name, favorite: true, now });
function recovery() {
  const workspace = { ...createWorkspace(draft.connectionId), activeTabId: draft.id, tabs: [{ kind: 'query' as const, document: draft }] };
  return { version: 1, workspace: recoveryWorkspace(workspace),
    history: [finishHistory(historyEntry(snapshot, 'Time fixture', 'query'), 'success', null, new Date('2026-10-09T12:30:01.000Z'))] };
}

describe('time range recovery and shared Rust fixture', () => {
  it('reproduces the exact executed body at the frozen clock without reserializing a long integer', () => {
    expect(parseQueryTimeRange(draft.timeRange, draft.connectionId, draft.index, draft.dsl)).toEqual(draft.timeRange);
    expect(parseExecutionTimeRange(snapshot.timeRange, snapshot.rawDsl)).toEqual(snapshot.timeRange);
    const executed = createValidatedSnapshot(draft, snapshot.requestId, now);
    if (!executed.ok) throw new Error(executed.error.code);
    expect(executed.snapshot).toEqual({ ...snapshot, dslContractVersion: 4 });
    expect(executed.snapshot.rawDsl).toContain('9007199254740993');
    expect(draft.dsl).not.toBe(snapshot.rawDsl);
  });

  it('keeps independent library/workspace/history copies and restores historical absolute bounds without moving intent', () => {
    const entry = saved();
    const library = libraryPayload({ version: 1, entries: [entry] });
    expect(parseLibraryPayload(library)).toEqual({ ok: true, library });
    const restored = documentFromEntry(entry);
    expect(restored.timeRange).toEqual(draft.timeRange);
    expect(restored.timeRange).not.toBe(draft.timeRange);
    expect(restored.timeRange!.definition.range).not.toBe(draft.timeRange!.definition.range);
    const document = recovery();
    expect(parseRecoveryDocument(document)).not.toBeNull();
    expect(document.workspace.tabs[0]!.document.timeRange!.bounds).not.toBe(draft.timeRange!.bounds);
    expect(document.history[0]!.snapshot.timeRange!.definition.range).not.toBe(snapshot.timeRange!.definition.range);
    const history = restoreHistoryQuery(document.history[0]!);
    expect(history.timeRange).toBeUndefined();
    expect(history.dsl).toBe(snapshot.rawDsl);
    const replay = createValidatedSnapshot(history, 'replay', new Date('2026-10-10T12:00:00.000Z'));
    expect(replay.ok && replay.snapshot.rawDsl).toBe(snapshot.rawDsl);
    const rerun = createValidatedSnapshot(restored, 'new-run', new Date('2026-10-10T12:00:00.000Z'));
    expect(rerun.ok && rerun.snapshot.rawDsl).toContain('2026-10-10T11:45:00.000000000Z');
  });

  it('preserves the last valid CAS record after damaged, unknown, mismatched or index-tab writes', async () => {
    const service = createSessionWorkspaceRecoveryService();
    const document = recovery();
    expect(await service.save(0, document)).toBe(1);
    for (const timeRange of [null, { ...draft.timeRange, version: 2 }, { ...draft.timeRange, secret: 'fixture-only' },
      { ...draft.timeRange, binding: { connectionId: 'other', index: draft.index } },
      { ...draft.timeRange, bounds: { ...draft.timeRange!.bounds, from: snapshot.timeRange!.bounds.from } }]) {
      const invalid = structuredClone(document);
      Object.assign(invalid.workspace.tabs[0]!.document, { timeRange });
      expect(parseRecoveryDocument(invalid)).toBeNull();
      await expect(service.save(1, invalid)).rejects.toMatchObject({ code: 'invalidInput' });
      const entry = { ...saved(), timeRange };
      expect(parseLibraryPayload({ version: 1, entries: [entry] }).ok).toBe(false);
    }
    const locked = structuredClone(document);
    Object.assign(locked.workspace.tabs[0]!, { kind: 'index' });
    expect(parseRecoveryDocument(locked)).toBeNull();
    const stale = structuredClone(document);
    stale.workspace.tabs[0]!.document.dsl = '{}';
    expect(parseRecoveryDocument(stale)).toBeNull();
    await expect(service.save(0, document)).rejects.toMatchObject({ code: 'workspaceConflict' });
    expect(await service.load()).toEqual({ revision: 1, document });
  });

  it('validates history bounds against the executed DSL and preserves the original anchor for continuation', () => {
    const document = recovery();
    for (const change of ['dsl', 'time', 'future', 'kind'] as const) {
      const copy = structuredClone(document);
      const entry = copy.history[0]!;
      if (change === 'dsl') Object.assign(entry.snapshot, { rawDsl: draft.dsl });
      if (change === 'time') Object.assign(entry.snapshot.timeRange!, { version: 2 });
      if (change === 'future') Object.assign(entry.snapshot, { startedAt: '2026-10-09T12:29:00.000Z' });
      if (change === 'kind') Object.assign(entry, { kind: 'index' });
      expect(parseRecoveryDocument(copy)).toBeNull();
    }
    const continuation = historyEntry({ ...snapshot, requestId: 'page-two', startedAt: '2026-10-09T12:32:00.000Z' }, 'Time fixture', 'continuation');
    expect(parseRecoveryDocument({ ...document, history: [continuation] })).not.toBeNull();
    expect(continuation.snapshot.timeRange?.bounds.resolvedAt).toBe(snapshot.startedAt);
    expect(parseRecoveryDocument({ ...document, history: [{ ...continuation, kind: 'query' }] })).toBeNull();
  });

  it('preserves applied absolute DSL in query exchange but excludes local moving management and stable IDs', () => {
    const library = { version: 1, entries: [saved()] };
    const bundle = buildQueryExchange(library, [library.entries[0]!.id], []);
    expect(bundle.queries[0]!.dsl).toBe(draft.dsl);
    const text = JSON.stringify(bundle);
    expect(text).not.toMatch(/timeRange|hadQuery|resolvedAt|3f2f2c9a|time-query/);
    const imported = importQueryExchange(bundle, [{ sourceKey: bundle.connections[0]!.key, target: null }], createEmptyLibrary());
    expect(imported.entries[0]!.timeRange).toBeUndefined();
    expect(imported.entries[0]!.connectionId).toBeNull();
    expect(imported.entries[0]!.dsl).toBe(draft.dsl);
  });

  it('keeps managed bounds fixed when reapplying an absolute definition at a later clock', () => {
    const original = { ...draft, timeRange: undefined, dsl: '{}' };
    const time = { ...draft.timeRange!.definition, fieldType: 'date_nanos' as const, range: {
      kind: 'absolute' as const, from: '2026-10-01T08:00:00.123456789', to: '2026-10-01T09:00:00.123456789',
    } };
    const preview = previewTimeRange(original, time, now);
    if (!preview.ok) throw new Error(preview.code);
    const query = { ...original, dsl: preview.dsl, timeRange: preview.timeRange };
    const executed = createValidatedSnapshot(query, 'absolute', new Date('2026-10-10T12:00:00.000Z'));
    if (!executed.ok) throw new Error(executed.error.code);
    expect(executed.snapshot.rawDsl).toBe(preview.dsl);
    expect(executed.snapshot.timeRange!.bounds.resolvedAt).toBe('2026-10-10T12:00:00.000Z');
    expect(executed.snapshot.rawDsl).toContain('00:00:00.123456789Z');
  });
});

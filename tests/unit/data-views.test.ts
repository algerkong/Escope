import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dataViewTimeFields, dataViewTimeFieldStatus, MAX_DATA_VIEWS, MAX_DATA_VIEWS_BYTES, parseDataViewDefinition, parseDataViewLibrary,
  parseDataViewRecord, parseDataViewSelection, sameDataView, selectDataView, validDataViewIndex, type DataViewLibrary,
} from '../../src/domain/data-views';
import { addWorkspaceTab, createIndexTab, createSnapshot, createWorkspace, matchesQueryDraft, updateWorkspaceDocument } from '../../src/domain/query';
import { createEmptyLibrary, documentFromEntry, entryFromDocument, libraryPayload, parseLibraryPayload } from '../../src/domain/query-library';
import { parseRecoveryDocument, recoveryWorkspace } from '../../src/domain/workspace-recovery';
import { buildQueryExchange, importQueryExchange } from '../../src/domain/query-exchange';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { enDataViews, zhDataViews } from '../../src/locales/data-views';

const fixture = JSON.parse(readFileSync('tests/fixtures/data-views-v1.json', 'utf8')) as DataViewLibrary;
const definition = fixture.entries[0]!;
const selected = selectDataView(definition);

describe('bounded Data View definitions', () => {
  it('shares the v1 contract with Rust and checks every localized key', () => {
    expect(parseDataViewLibrary(fixture)).toEqual(fixture);
    expect(parseDataViewRecord({ revision: 7, library: fixture })).toEqual({ revision: 7, library: fixture });
    expect(Object.keys(enDataViews).sort()).toEqual(Object.keys(zhDataViews).sort());
  });

  it.each(['', ' a', 'a ', 'a,,b', '_all', '-a', '.', '..', 'a/_search', 'https://a', 'remote:a', 'a?x=1', 'a%2fb', 'a#b', 'a b'])(
    'rejects an unsupported target %s', (index) => {
      expect(validDataViewIndex(index)).toBe(false);
      expect(parseDataViewDefinition({ ...definition, index })).toBeNull();
    },
  );

  it.each(['orders-*', 'orders,archive', '.hidden-*', 'audit', '*'])('uses the existing target grammar for %s', (index) => {
    expect(validDataViewIndex(index)).toBe(true);
  });

  it('refuses unknown fields, versions, duplicate IDs and null or malformed metadata', () => {
    const cases: unknown[] = [
      { ...fixture, version: 2 }, { ...fixture, endpoint: 'https://fixture.test' },
      { ...fixture, entries: [definition, definition] },
      { ...fixture, entries: [{ ...definition, credentialRef: 'fixture' }] },
      { ...fixture, entries: [{ ...definition, defaultTimeField: undefined }] },
      { ...fixture, entries: [{ ...definition, name: 'line\nbreak' }] },
      { ...fixture, entries: [{ ...definition, name: ' ' }] },
      { ...fixture, entries: [{ ...definition, connectionId: null }] },
      { ...fixture, entries: [{ ...definition, defaultTimeField: '' }] },
      { ...fixture, entries: [{ ...definition, defaultTimeField: 'line\nbreak' }] },
    ];
    for (const candidate of cases) expect(parseDataViewLibrary(candidate)).toBeNull();
    expect(parseDataViewRecord({ revision: Number.MAX_SAFE_INTEGER + 1, library: fixture })).toBeNull();
    expect(parseDataViewRecord({ revision: -1, library: fixture })).toBeNull();
    expect(parseDataViewRecord({ revision: 1, library: fixture, rawResponse: '{}' })).toBeNull();
  });

  it('bounds count, UTF-8 names/fields, individual targets and the aggregate serialized document', () => {
    const entries = Array.from({ length: MAX_DATA_VIEWS }, (_, index) => ({ ...definition, id: `view-${index}` }));
    expect(parseDataViewLibrary({ version: 1, entries })).not.toBeNull();
    expect(parseDataViewLibrary({ version: 1, entries: [...entries, { ...definition, id: 'excess' }] })).toBeNull();
    expect(parseDataViewDefinition({ ...definition, name: 'x'.repeat(121) })).toBeNull();
    expect(parseDataViewDefinition({ ...definition, defaultTimeField: 'x'.repeat(1025) })).toBeNull();
    expect(validDataViewIndex('x'.repeat(256))).toBe(false);
    expect(validDataViewIndex(Array.from({ length: 65 }, () => 'x').join(','))).toBe(false);
    const large = { version: 1, entries: entries.map((entry) => ({
      ...entry, name: 'x'.repeat(120), index: Array.from({ length: 4 }, () => 'x'.repeat(250)).join(','),
      defaultTimeField: '"'.repeat(1024),
    })) };
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(MAX_DATA_VIEWS_BYTES);
    expect(parseDataViewLibrary(large)).toBeNull();
  });
});

describe('time field evidence', () => {
  const parsed = parseFieldCaps(JSON.stringify({ indices: ['orders-1', 'orders-2'], fields: {
    date: { date: { searchable: true } }, nanos: { date_nanos: { searchable: true } },
    conflict: { date: { searchable: true }, keyword: { searchable: true } },
    text: { keyword: { searchable: true } }, unsearchable: { date: { searchable: false } },
    mixedSearchable: { date: { searchable: true, non_searchable_indices: ['orders-2'] } },
    unknown: {},
  } }));
  const catalog: FieldCatalog = parsed.ok ? parsed.value : { indices: [], fields: [] };
  it.each([
    [null, 'none'], ['date', 'valid'], ['nanos', 'valid'], ['conflict', 'conflict'],
    ['text', 'notDate'], ['unsearchable', 'notSearchable'], ['missing', 'missing'], ['unknown', 'missing'],
    ['mixedSearchable', 'notSearchable'],
  ] as const)('diagnoses %s as %s without inferring a usable default', (field, status) => {
    expect(dataViewTimeFieldStatus(field, catalog)).toBe(status);
  });
  it('does not equate a missing or failed field check with an empty catalog', () => {
    expect(dataViewTimeFieldStatus('date')).toBe('unchecked');
    expect(dataViewTimeFieldStatus('date', { indices: [], fields: [] })).toBe('missing');
  });
  it('offers only unambiguous searchable date fields', () => {
    expect(dataViewTimeFields(catalog).map((field) => field.name)).toEqual(['date', 'nanos']);
  });
});

describe('draft binding and recovery', () => {
  function workspace() {
    const state = createWorkspace(definition.connectionId);
    const query = state.tabs[0]!.document;
    query.index = 'previous';
    query.dsl = '{"query":{"term":{"n":9007199254740993}}}';
    return { state, query };
  }

  it('applies by value without changing DSL or an old execution snapshot, and detaches on manual target edits', () => {
    const { state, query } = workspace();
    const snapshot = createSnapshot(query, 'request', new Date('2026-10-10T00:00:00.000Z'));
    const next = updateWorkspaceDocument(state, query.id, { index: definition.index, dataView: selected });
    const draft = next.tabs[0]!.document;
    expect(draft).toMatchObject({ connectionId: definition.connectionId, index: definition.index, revision: 1, dsl: query.dsl });
    expect(draft.dataView).toEqual(selected);
    expect(draft.dataView).not.toBe(selected);
    expect(snapshot).toMatchObject({ index: 'previous', revision: 0, rawDsl: query.dsl });
    const changedDefinition = { ...definition, name: 'Renamed', index: 'other' };
    expect(sameDataView(draft.dataView!.definition, changedDefinition)).toBe(false);
    expect(draft.index).toBe(definition.index);
    const detached = updateWorkspaceDocument(next, query.id, { index: 'manual' }).tabs[0]!.document;
    expect(detached.dataView).toBeUndefined();
    expect(detached.revision).toBe(2);
    expect(snapshot.index).toBe('previous');
  });

  it('rejects cross-connection selections, protects index tabs and notices changed selection copies', () => {
    const { state, query } = workspace();
    const other = selectDataView(fixture.entries[1]!);
    expect(updateWorkspaceDocument(state, query.id, { index: other.definition.index, dataView: other }).tabs[0]).toBe(state.tabs[0]);
    const indexed = addWorkspaceTab(state, createIndexTab(definition.connectionId, 'locked', 'table'));
    const id = indexed.activeTabId!;
    expect(updateWorkspaceDocument(indexed, id, { index: definition.index, dataView: selected }).tabs.at(-1)?.document.index).toBe('locked');
    expect(matchesQueryDraft({ ...query, dataView: selected }, query)).toBe(false);
  });

  it('retains deleted-library copies in saved queries and workspace restoration, with no transport or result payload', () => {
    const { state, query } = workspace();
    const next = updateWorkspaceDocument(state, query.id, { index: definition.index, dataView: selected });
    const draft = next.tabs[0]!.document;
    const saved = entryFromDocument(draft, { id: 'saved', name: 'Saved', favorite: true, now: new Date('2026-10-10T00:00:00.000Z') });
    const library = libraryPayload({ version: 1, entries: [saved] });
    expect(parseLibraryPayload(library).ok).toBe(true);
    expect(documentFromEntry(saved).dataView).toEqual(selected);
    const document = { version: 1, workspace: recoveryWorkspace(next), history: [] };
    expect(parseRecoveryDocument(document)).toEqual(document);
    expect(document.workspace.tabs[0]!.document.dataView).toEqual(selected);
    for (const candidate of [null, { ...selected, version: 2 }, { ...selected, endpoint: 'https://fixture.test' },
      selectDataView({ ...definition, connectionId: 'another-id' }), selectDataView({ ...definition, index: 'another-target' })]) {
      expect(parseDataViewSelection(candidate, definition.connectionId, definition.index)).toBeNull();
      expect(parseLibraryPayload({ version: 1, entries: [{ ...saved, dataView: candidate }] }).ok).toBe(false);
      const changed = structuredClone(document);
      Object.assign(changed.workspace.tabs[0]!.document, { dataView: candidate });
      expect(parseRecoveryDocument(changed)).toBeNull();
    }
    const indexTab = structuredClone(document);
    Object.assign(indexTab.workspace.tabs[0]!, { kind: 'index' });
    expect(parseRecoveryDocument(indexTab)).toBeNull();
  });

  it('exchanges only explicit query definitions, never a local data-view ID or connection binding', () => {
    const { state, query } = workspace();
    const draft = updateWorkspaceDocument(state, query.id, { index: definition.index, dataView: selected }).tabs[0]!.document;
    const entry = entryFromDocument(draft, { id: 'saved', name: 'Saved', favorite: false, now: new Date() });
    const bundle = buildQueryExchange({ version: 1, entries: [entry] }, ['saved'], []);
    expect(bundle.queries[0]).not.toHaveProperty('dataView');
    expect(JSON.stringify(bundle)).not.toContain(definition.connectionId);
    expect(JSON.stringify(bundle)).not.toContain(definition.id);
    const restored = importQueryExchange(bundle, [{ sourceKey: bundle.connections[0]!.key, target: null }], createEmptyLibrary());
    expect(restored.entries[0]!.dataView).toBeUndefined();
    expect(restored.entries[0]!.index).toBe(definition.index);
  });
});

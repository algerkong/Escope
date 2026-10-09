import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDataViewDefinition, parseDataViewLibrary, sameDataView, selectDataView, type DataViewLibrary } from '../../src/domain/data-views';
import {
  MAX_RUNTIME_FIELDS, MAX_RUNTIME_FIELDS_BYTES, parseRuntimeFields, parseRuntimeMapping, parseRuntimeMappings,
  runtimeFieldEvidence, runtimeFieldsPayload,
} from '../../src/domain/runtime-fields';
import { previewRuntimeFields, runtimeFieldNamesFromDsl } from '../../src/domain/runtime-fields-dsl';
import { createQuery, createValidatedSnapshot, createWorkspace } from '../../src/domain/query';
import { validateQueryDsl } from '../../src/domain/query-dsl';
import { buildCsvExport, createEmptyLibrary, documentFromEntry, entryFromDocument, libraryPayload, parseLibraryPayload } from '../../src/domain/query-library';
import { buildQueryExchange, importQueryExchange } from '../../src/domain/query-exchange';
import { prepareSnapshotExportDsl } from '../../src/domain/query-export';
import { parseQueryResult, sliceRaw } from '../../src/domain/query-result';
import { parseFieldCaps } from '../../src/domain/resource';
import { finishHistory, historyEntry, parseRecoveryDocument, recoveryWorkspace, restoreHistoryQuery } from '../../src/domain/workspace-recovery';
import { enRuntimeFields, zhRuntimeFields } from '../../src/locales/runtime-fields';

const fixture = JSON.parse(readFileSync('tests/fixtures/data-view-runtime-fields-v1.json', 'utf8')) as DataViewLibrary;
const definition = fixture.entries[0]!;
const runtime = definition.runtimeFields!;
const one = { version: 1, entries: [runtime.entries[0]!] };
const source = '{"query":{"term":{"id":9007199254740993}},"boost":1E+400,"value":1.0000000000000000001,"text":"\\u0061"}';

describe('bounded query-time field contracts', () => {
  it('round trips the shared Rust fixture and deep-copies scripts without evaluating them', () => {
    expect(parseDataViewLibrary(fixture)).toEqual(fixture);
    expect(parseRuntimeFields(runtime)).toEqual(runtime);
    const copy = runtimeFieldsPayload(runtime);
    expect(copy).toEqual(runtime);
    expect(copy.entries[0]!.script).not.toBe(runtime.entries[0]!.script);
    expect(Object.keys(enRuntimeFields).sort()).toEqual(Object.keys(zhRuntimeFields).sort());
    const { runtimeFields: omitted, ...legacy } = definition;
    expect(omitted).toBeDefined();
    expect(parseDataViewDefinition(legacy)).toEqual(legacy);
    expect(sameDataView(definition, selectDataView(definition).definition)).toBe(true);
    expect(sameDataView(definition, { ...definition, runtimeFields: { version: 1, entries: [] } })).toBe(false);
  });

  it.each([
    null, undefined, {}, { version: 2, entries: [] }, { version: 1, entries: [], endpoint: 'https://fixture.test' },
    { version: 1, entries: [one.entries[0], one.entries[0]] },
    { version: 1, entries: [{ field: 'n', type: 'lookup', target_index: 'other' }] },
    { version: 1, entries: [{ field: 'n', type: 'composite', fields: {} }] },
    { version: 1, entries: [{ field: 'n', type: 'date_nanos' }] },
    { version: 1, entries: [{ field: 'n', type: 'long', on_script_error: 'continue' }] },
  ])('refuses unknown, duplicated or executable outer options: %j', (runtimeFields) => {
    expect(parseDataViewDefinition({ ...definition, runtimeFields })).toBeNull();
  });

  it.each([
    null, '', { source: '' }, { source: '   ' }, { id: 'stored-script' },
    { source: 'emit(1);', lang: 'javascript' }, { source: 'emit(1);', lang: null },
    { source: 'emit(params.n);', params: { n: 1 } }, { source: 'emit(1);', options: {} },
    { source: 'emit(1);\u0000' }, { source: 'emit(1);\u0085' },
    { source: 'x'.repeat(4097) }, { source: '\u4e2d'.repeat(1366) },
  ])('refuses unsupported script payloads: %j', (script) => {
    expect(parseRuntimeMapping({ type: 'long', script })).toBeNull();
    expect(parseRuntimeFields({ version: 1, entries: [{ field: 'n', type: 'long', script }] })).toBeNull();
    expect(validateQueryDsl(JSON.stringify({ runtime_mappings: { n: { type: 'long', script } } })))
      .toMatchObject({ ok: false, error: { code: 'dslRuntimeFieldsUnsupported' } });
  });

  it('bounds field names, source text and aggregate UTF-8 sizes, including serialized escaping', () => {
    for (const field of ['', ' n', 'n ', '$param', '_source', '_id', 'x*', '?', '\u007f', '\u0085', 'x'.repeat(1025), '\u4e2d'.repeat(342)]) {
      expect(parseRuntimeFields({ version: 1, entries: [{ field, type: 'long' }] })).toBeNull();
    }
    expect(parseRuntimeMapping({ type: 'long', script: { source: 'x'.repeat(4096) } })).not.toBeNull();
    expect(parseRuntimeMapping({ type: 'long', script: { source: '\n\t emit(1);\r\n', lang: 'painless' } })).not.toBeNull();
    const entries = Array.from({ length: MAX_RUNTIME_FIELDS }, (_, index) => ({ field: `f${index}`, type: 'keyword' }));
    expect(parseRuntimeFields({ version: 1, entries })).not.toBeNull();
    expect(parseRuntimeFields({ version: 1, entries: [...entries, { field: 'extra', type: 'long' }] })).toBeNull();
    const large = { version: 1, entries: entries.map((entry) => ({ ...entry, script: { source: '"'.repeat(2048) } })) };
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(MAX_RUNTIME_FIELDS_BYTES);
    expect(parseRuntimeFields(large)).toBeNull();
    expect(parseRuntimeMappings(Object.fromEntries(large.entries.map(({ field, ...mapping }) => [field, mapping])))).toBeNull();
  });

  it('distinguishes absent, unknown, same-type, changed-type and conflicting catalog evidence', () => {
    const parsed = parseFieldCaps('{"fields":{"same":{"long":{"searchable":false}},"different":{"keyword":{}},"mixed":{"long":{},"keyword":{}}}}');
    if (!parsed.ok) throw new Error('fixture');
    expect(runtimeFieldEvidence({ field: 'same', type: 'long' })).toBe('unchecked');
    for (const [field, expected] of [['same', 'shadow'], ['different', 'typeChange'], ['mixed', 'conflict'], ['new', 'absent']] as const) {
      expect(runtimeFieldEvidence({ field, type: 'long' }, parsed.value)).toBe(expected);
    }
  });
});

describe('lossless final DSL preview', () => {
  it('adds only reviewed mappings and requested field names without rewriting existing number or string tokens', () => {
    const result = previewRuntimeFields(source, one, true);
    if (!result.ok) throw new Error(result.code);
    for (const token of ['9007199254740993', '1E+400', '1.0000000000000000001', '\\u0061']) expect(result.dsl).toContain(token);
    expect(result.dsl).toContain('"runtime_mappings"');
    expect(JSON.parse(result.dsl).fields).toEqual(['sequence']);
    expect(runtimeFieldNamesFromDsl(result.dsl)).toEqual(['sequence']);
    expect(source).not.toContain('runtime_mappings');
  });

  it('merges with hand-written mappings and fields without overriding or duplicating them', () => {
    const before = '{"runtime_mappings":{"manual":{"type":"keyword"}},"fields":[{"field":"sequence","format":"epoch_millis"},"manual"],"size":25}';
    const result = previewRuntimeFields(before, one, true);
    if (!result.ok) throw new Error(result.code);
    const parsed = JSON.parse(result.dsl);
    expect(parsed.runtime_mappings.manual).toEqual({ type: 'keyword' });
    expect(parsed.fields).toEqual([{ field: 'sequence', format: 'epoch_millis' }, 'manual']);
    expect(previewRuntimeFields(result.dsl, one, true)).toEqual({ ok: true, dsl: result.dsl });
    const same = '{"runtime_mappings":{"sequence":{"script":{"source":"emit(9007199254740993L);"},"type":"long"}}}';
    expect(previewRuntimeFields(same, one, false)).toEqual({ ok: true, dsl: same });
  });

  it('refuses different existing definitions and ambiguous JSON without altering the input', () => {
    expect(previewRuntimeFields('{"runtime_mappings":{"sequence":{"type":"long"}}}', one, true))
      .toEqual({ ok: false, code: 'dslConflict', field: 'sequence' });
    for (const before of [
      '{"runtime_mappings":null}', '{"runtime_mappings":[]}',
      '{"runtime_mappings":{"__proto__":{"type":"long"}}}',
      '{"runtime_mappings":{"n":{"type":"long","type":"keyword"}}}',
      '{"runtime_mappings":{"n":{"type":"long"},"\\u006e":{"type":"long"}}}',
      '{"query":{"term":{"n":{"$param":"n"}}}}', '[]', '{"size":1,}', '{ incomplete',
    ]) expect(previewRuntimeFields(before, one, true)).toMatchObject({ ok: false, code: 'invalidDsl' });
    expect(previewRuntimeFields('{"fields":"manual"}', one, true)).toEqual({ ok: false, code: 'fieldsConflict' });
    const kept = previewRuntimeFields('{"fields":"manual"}', one, false);
    expect(kept.ok && JSON.parse(kept.dsl).fields).toBe('manual');
  });

  it('handles empty containers and escaped field names without prototype mutation', () => {
    const unusual = { version: 1, entries: [{ field: 'a"\\b', type: 'keyword' as const }, { field: 'constructor', type: 'long' as const }] };
    for (const before of ['{}', '{"runtime_mappings":{},"fields":[]}', '{\n "fields": []\n}']) {
      const preview = previewRuntimeFields(before, unusual, true);
      if (!preview.ok) throw new Error(preview.code);
      expect(Object.keys(JSON.parse(preview.dsl).runtime_mappings)).toEqual(['a"\\b', 'constructor']);
      expect(runtimeFieldNamesFromDsl(preview.dsl)).toEqual(['a"\\b', 'constructor']);
    }
    expect(Object.hasOwn(Object.prototype, 'field')).toBe(false);
  });

  it('enforces final size, combined count and nesting limits rather than dropping manual fields', () => {
    const manual = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, { type: 'long' }]));
    expect(previewRuntimeFields(JSON.stringify({ runtime_mappings: manual }), one, true)).toEqual({ ok: false, code: 'tooLarge' });
    expect(previewRuntimeFields(JSON.stringify({ padding: 'x'.repeat(256 * 1024) }), one, true)).toEqual({ ok: false, code: 'tooLarge' });
    expect(previewRuntimeFields('{"x":'.repeat(66) + '1' + '}'.repeat(66), one, true)).toEqual({ ok: false, code: 'invalidDsl' });
    expect(previewRuntimeFields('{}', { version: 1, entries: [] }, true)).toEqual({ ok: false, code: 'empty' });
  });
});

describe('query copies, recovery and raw returned values', () => {
  function draft() {
    const preview = previewRuntimeFields(source, runtime, true);
    if (!preview.ok) throw new Error(preview.code);
    return { ...createQuery(definition.connectionId), index: definition.index, dsl: preview.dsl, dataView: selectDataView(definition) };
  }

  it('freezes every nested script and restores original history independently of library/draft edits', () => {
    const query = draft();
    const validated = createValidatedSnapshot(query, 'request', new Date('2026-10-10T00:00:00.000Z'));
    if (!validated.ok) throw new Error(validated.error.code);
    const snapshot = validated.snapshot;
    const frozen = snapshot.dataView!.definition.runtimeFields!;
    for (const value of [frozen, frozen.entries, frozen.entries[0], frozen.entries[0]!.script]) expect(Object.isFrozen(value)).toBe(true);
    Object.assign(query.dataView.definition.runtimeFields!.entries[0]!.script!, { source: 'emit(0);' });
    expect(frozen.entries[0]!.script!.source).toBe('emit(9007199254740993L);');
    expect(snapshot.rawDsl).toBe(query.dsl);
    const entry = finishHistory(historyEntry(snapshot, 'Runtime', 'query'), 'success', null, new Date('2026-10-10T00:00:01.000Z'));
    const workspace = createWorkspace(definition.connectionId);
    workspace.tabs = [{ kind: 'query', document: query }];
    const document = { version: 1, workspace: recoveryWorkspace(workspace), history: [entry] };
    const recovered = parseRecoveryDocument(document);
    expect(recovered).not.toBeNull();
    const restored = restoreHistoryQuery(recovered!.history[0]!);
    expect(restored.dataView!.definition.runtimeFields).toEqual(frozen);
    expect(restored.dsl).toBe(snapshot.rawDsl);
    expect(restored.dataView!.definition.runtimeFields!.entries[0]!.script).not.toBe(frozen.entries[0]!.script);
    for (const invalid of [null, { ...runtime, version: 2 }, { version: 1, entries: [{ field: 'n', type: 'lookup' }] }]) {
      const copy = structuredClone(document);
      Object.assign(copy.history[0]!.snapshot.dataView!.definition, { runtimeFields: invalid });
      expect(parseRecoveryDocument(copy)).toBeNull();
    }
  });

  it('keeps query-library copies but exchanges only reviewed DSL, without local view configuration', () => {
    const query = draft();
    const entry = entryFromDocument(query, { id: 'saved', name: 'Runtime', favorite: false, now: new Date() });
    const library = libraryPayload({ version: 1, entries: [entry] });
    expect(parseLibraryPayload(library).ok).toBe(true);
    expect(documentFromEntry(entry).dataView).toEqual(query.dataView);
    const bundle = buildQueryExchange(library, ['saved'], []);
    expect(bundle.queries[0]).not.toHaveProperty('dataView');
    const encoded = JSON.stringify(bundle);
    expect(encoded).not.toMatch(/runtimeFields|runtime-view|connection-a/);
    expect(encoded).toContain('runtime_mappings');
    const imported = importQueryExchange(bundle, [{ sourceKey: bundle.connections[0]!.key, target: null }], createEmptyLibrary());
    expect(imported.entries[0]!.dsl).toBe(query.dsl);
    expect(imported.entries[0]!.dataView).toBeUndefined();
    expect(prepareSnapshotExportDsl(query.dsl, 100)).toEqual({ ok: false, code: 'unsupportedDsl' });
  });

  it('reads runtime values exclusively from fields while leaving the complete response/source unchanged', () => {
    const raw = '{"hits":{"hits":[{"_id":"a","_source":{"sequence":1,"missing":2,"plain":3},'
      + '"fields":{"sequence":[9007199254740993],"added":["runtime"],"plain":[4]}}]}}';
    const parsed = parseQueryResult(raw, ['sequence', 'missing', 'added']);
    if (!parsed.ok) throw new Error('fixture');
    const hit = parsed.summary.hits[0]!;
    expect(hit.columns.map(({ name, value }) => [name, value.text])).toEqual([
      ['plain', '3'], ['sequence', '[9007199254740993]'], ['added', '["runtime"]'],
    ]);
    expect(hit.columns.find((entry) => entry.name === 'sequence')!.runtime).toBe(true);
    expect(hit.columns.find((entry) => entry.name === 'missing')).toBeUndefined();
    expect(sliceRaw(raw, hit.source!)).toBe('{"sequence":1,"missing":2,"plain":3}');
    expect(buildCsvExport([hit]).content).toContain('[9007199254740993]');
    const legacy = parseQueryResult(raw);
    expect(legacy.ok && legacy.summary.hits[0]!.columns.map(({ name }) => name)).toEqual(['sequence', 'missing', 'plain']);
    const sourceOnly = parseQueryResult('{"hits":{"hits":[{"_source":{"sequence":1}}]}}', ['sequence']);
    expect(sourceOnly.ok && sourceOnly.summary.hits[0]!.columns).toEqual([]);
  });
});

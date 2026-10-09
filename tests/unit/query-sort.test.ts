import { describe, expect, it } from 'vitest';
import sortFixture from '../fixtures/query-sort-v1.json';
import { createQuery, createSnapshot, createWorkspace, updateWorkspaceDocument, type QueryDocument } from '../../src/domain/query';
import {
  MAX_QUERY_SORT_FIELDS, MAX_SORT_DSL_BYTES, parseQuerySort, previewQuerySort, querySortEvidence, type QuerySortClause,
} from '../../src/domain/query-sort';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { parseQueryTimeRange, previewTimeRange, removeAppliedTimeRange } from '../../src/domain/query-time-range';
import { parseVisualForm } from '../../src/domain/visual-query';
import { selectDataView } from '../../src/domain/data-views';
import { previewQueryFilters, type QueryFilter } from '../../src/domain/query-filters';

const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events-*', dsl: '{}' };
function clause(field = 'n', patch: Partial<QuerySortClause> = {}): QuerySortClause {
  return { field, direction: 'asc', missing: 'default', unmappedType: null, ...patch };
}
function caps(fields: Record<string, Record<string, object>>): FieldCatalog {
  const parsed = parseFieldCaps(JSON.stringify({ indices: ['events-a', 'events-b'], fields }));
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value;
}
const catalog = caps({
  n: { long: { searchable: true, aggregatable: true } }, other: { keyword: { searchable: true, aggregatable: true } },
  date: { date: { searchable: true, aggregatable: true } }, nanos: { date_nanos: { searchable: true, aggregatable: true } },
});
const preview = (dsl: string, clauses: readonly QuerySortClause[] = [clause()], fields = catalog) =>
  previewQuerySort({ ...source, dsl }, clauses, fields);
const evidence = (field: string, fields?: FieldCatalog, dsl = '{}') => querySortEvidence(dsl, [field], fields)[0];

describe('bounded server sort parsing', () => {
  it.each([
    ['"_score"', '_score', 'desc'], ['"_doc"', '_doc', 'asc'], ['["_shard_doc"]', '_shard_doc', 'asc'],
    ['{"n":"desc"}', 'n', 'desc'], ['[{"n":{"order":"desc"}}]', 'n', 'desc'],
    ['{"n":{}}', 'n', 'asc'], ['{"_score":{}}', '_score', 'desc'],
  ])('reuses the explicit and implicit ES directions for %s', (sort, field, direction) => {
    const raw = `{"sort":${sort}}`;
    const parsed = parseQuerySort(raw);
    expect(parsed).toEqual({ ok: true, clauses: [clause(field, { direction: direction as 'asc' | 'desc' })] });
    const visual = parseVisualForm(raw);
    if (sort !== '{"n":{}}' && sort !== '{"_score":{}}') {
      expect(visual.ok && visual.form.sort).toEqual({ field, direction });
    }
    if (parsed.ok) expect(preview(raw, parsed.clauses)).toMatchObject({ ok: true, dsl: raw, changed: false });
  });

  it('reads ordered fields, default missing, explicit missing and unmapped without normalization', () => {
    expect(parseQuerySort('{"sort":["_score",{"n":{"missing":"_first","unmapped_type":"long"}},{"other":"desc"}]}'))
      .toEqual({ ok: true, clauses: [clause('_score', { direction: 'desc' }),
        clause('n', { missing: '_first', unmappedType: 'long' }), clause('other', { direction: 'desc' })] });
    expect(parseQuerySort('{"sort":[]}')).toEqual({ ok: true, clauses: [] });
    expect(parseQuerySort('{}')).toEqual({ ok: true, clauses: [] });
  });

  it.each([
    '{"n":{"mode":"max"}}', '{"n":{"nested":{"path":"items"}}}', '{"n":{"numeric_type":"double"}}',
    '{"n":{"format":"epoch_millis"}}', '{"n":{"missing":9007199254740993}}', '{"n":{"missing":"default"}}',
    '{"n":{"missing":"custom"}}', '{"n":{"unmapped_type":"scaled_float"}}', '{"n":{"ignore_unmapped":true}}',
    '{"n":{"order":null}}', '{"n":{"order":"ascending"}}', '{"n":{"unmapped_type":null}}',
    '{"_score":{"missing":"_last"}}', '{"_doc":{"unmapped_type":"long"}}',
    '{"n":"asc","other":"desc"}', '{"object.n":"asc"}', '{"_id":"asc"}',
    '{"_script":{"type":"number","script":"1"}}', '{"_geo_distance":{"location":[1,2]}}', 'null', '42', '[["n"]]',
  ])('keeps unsupported sort %s intact even when all rows would be removed', (sort) => {
    const raw = `{"query":{"term":{"n":9007199254740993}},"sort":${sort}}`;
    expect(parseQuerySort(raw)).toMatchObject({ ok: false, code: 'unsupportedSort' });
    expect(preview(raw, [])).toMatchObject({ ok: false, code: 'unsupportedSort' });
    expect(preview(raw)).not.toHaveProperty('dsl');
  });

  it('rejects duplicate fields, malformed JSON, duplicate escaped keys and unresolved parameters', () => {
    expect(parseQuerySort('{"sort":["n",{"n":"desc"}]}')).toMatchObject({ ok: false, code: 'duplicateField' });
    for (const raw of ['', '{"sort":["n",]}', '[]', '{"sort":[{"n":"asc","\\u006e":"desc"}]}', '{"query":{"term":{"n":{"$param":"n"}}}}']) {
      expect(parseQuerySort(raw)).toMatchObject({ ok: false, code: 'invalidDsl' });
    }
  });

  it.each(['search_after', 'pit', 'collapse', 'knn', 'retriever', 'rescore', 'unknown'])('never rewrites a request with %s', (key) => {
    expect(preview(`{"sort":["n"],"${key}":{}}`)).toEqual({ ok: false, code: 'unsupportedDsl' });
  });
});

describe('sort field evidence', () => {
  it('separates unchecked, absent, unmapped, conflict, nested, non-sortable and unsupported evidence', () => {
    expect(evidence('n')).toMatchObject({ ok: false, code: 'fieldUnchecked' });
    expect(evidence('absent', catalog)).toMatchObject({ ok: false, code: 'fieldMissing' });
    expect(evidence('n', caps({ n: { unmapped: { aggregatable: false } } }))).toMatchObject({ ok: false, code: 'fieldUnmapped' });
    expect(evidence('n', caps({ n: { long: { aggregatable: true }, double: { aggregatable: true } } }))).toMatchObject({ ok: false, code: 'fieldConflict' });
    expect(evidence('items', caps({ items: { nested: {} } }))).toMatchObject({ ok: false, code: 'fieldNested' });
    expect(evidence('items.n', caps({ items: { nested: {} } }))).toMatchObject({ ok: false, code: 'fieldNested' });
    expect(evidence('object.n', catalog)).toMatchObject({ ok: false, code: 'fieldPath' });
    expect(evidence('n', caps({ n: { long: { aggregatable: false } } }))).toMatchObject({ ok: false, code: 'fieldNotSortable' });
    for (const type of ['text', 'match_only_text', 'geo_point', 'geo_shape', 'object', 'unknown']) {
      expect(evidence('n', caps({ n: { [type]: { aggregatable: true } } }))).toMatchObject({ ok: false, code: 'fieldUnsupported' });
    }
    expect(evidence('n', caps({ n: { long: { aggregatable: true, metadata_field: true } } }))).toMatchObject({ ok: false, code: 'fieldUnsupported' });
  });

  it('does not guess keyword subfields or require searchable for doc-values-only sorts', () => {
    const fields = caps({ message: { text: { aggregatable: false } }, 'message.keyword': { keyword: { aggregatable: true } },
      value: { long: { searchable: false, aggregatable: true } } });
    expect(evidence('message', fields)).toMatchObject({ ok: false, code: 'fieldUnsupported' });
    expect(evidence('message.keyword', fields)).toMatchObject({ ok: false, code: 'fieldPath' });
    expect(evidence('value', fields)).toMatchObject({ ok: true, fieldType: 'long', origin: 'mapped' });
    expect(preview('{}', [clause('value')], fields)).toMatchObject({ ok: true });
  });

  it('rejects a global aggregatable flag when any reported index lacks it', () => {
    const fields = caps({ n: { long: { aggregatable: true, non_aggregatable_indices: ['events-b'] } } });
    expect(evidence('n', fields)).toMatchObject({ ok: false, code: 'fieldNotSortable' });
    expect(preview('{}', [clause()], fields)).toMatchObject({ ok: false, code: 'fieldNotSortable' });
  });

  it('uses only applied runtime declarations, even when the mapped field disagrees', () => {
    const dsl = '{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(9007199254740993L);"}}}}';
    const fields = caps({ n: { text: { aggregatable: false } } });
    expect(evidence('n', undefined, dsl)).toMatchObject({ ok: true, fieldType: 'long', origin: 'runtime' });
    expect(preview(dsl, [clause()], fields)).toMatchObject({ ok: true });
    expect(preview(dsl, [clause()], fields)).toHaveProperty('dsl', expect.stringContaining('"source":"emit(9007199254740993L);"'));
    expect(evidence('n', fields, '{"runtime_mappings":{"n":{"type":"geo_point"}}}')).toMatchObject({ ok: false, code: 'fieldUnsupported' });
    const unapplied = { ...source, dataView: selectDataView({ id: 'view', name: 'View', connectionId: 'connection',
      index: 'events-*', defaultTimeField: null, runtimeFields: { version: 1, entries: [{ field: 'n', type: 'long' }] } }) };
    expect(previewQuerySort(unapplied, [clause()], fields)).toMatchObject({ ok: false, code: 'fieldUnsupported' });
  });

  it('makes unmapped handling explicit without casting mapped type conflicts', () => {
    const fields = caps({ n: { long: { aggregatable: true }, unmapped: { aggregatable: false } } });
    expect(evidence('n', fields)).toMatchObject({ ok: true, reportedUnmapped: true });
    expect(preview('{}', [clause()], fields)).toMatchObject({ ok: false, code: 'unmappedRequired' });
    expect(preview('{}', [clause('n', { unmappedType: 'long', missing: '_first' })], fields)).toMatchObject({ ok: true });
    expect(preview('{}', [clause('n', { unmappedType: 'double' })], fields)).toMatchObject({ ok: false, code: 'unmappedMismatch' });
    expect(preview('{}', [clause('n', { unmappedType: 'long' })], caps({ n: { date: { aggregatable: true }, date_nanos: { aggregatable: true } } })))
      .toMatchObject({ ok: false, code: 'fieldConflict' });
  });

  it.each(['', '_id', '$param', ' n', 'n ', 'n*', 'n?', 'a\nb', 'a\u007fb', 'n'.repeat(1025)])('refuses invalid field %j', (field) => {
    expect(evidence(field, catalog)).toMatchObject({ ok: false, code: 'invalidField' });
    expect(preview('{}', [clause(field)])).toMatchObject({ ok: false, code: 'invalidField' });
  });
});

describe('lossless sort review', () => {
  it('edits only sort and preserves exact query, scripts, fields, aggregations and source tokens', () => {
    const raw = '{\n "query": {"bool":{"should":[{"term":{"n":9007199254740993}},{"term":{"n":-0}}],"minimum_should_match":1}},'
      + '\n "sort": ["_score"], "size":25, "_source":["\\u006e"],"aggs":{"x":{"max":{"field":"n","missing":1.000000000000000001}}},'
      + '"runtime_mappings":{"computed":{"type":"double","script":{"source":"emit(1.25);"}}},"fields":["computed"]\n}';
    const result = preview(raw, [clause('other', { direction: 'desc', missing: '_last' }), clause('computed')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sort = '[{"other":{"order":"desc","missing":"_last"}},{"computed":{"order":"asc"}}]';
    expect(result.dsl).toBe(raw.replace('["_score"]', sort));
    expect(result.patch).toEqual({ dsl: result.dsl });
    expect(result.dsl).not.toContain('unmapped_type');
    expect(result.dsl).not.toContain('numeric_type');
    expect(result.dsl).not.toContain('_shard_doc');
  });

  it.each(['{"sort":["n"]}', '{"sort":["n"],"size":25}', '{"size":25,"sort":["n"]}', '{"size":25,"sort":["n"],"track_total_hits":true}'])(
    'removes only the sort property in %s after explicit preview', (raw) => {
      const result = preview(raw, []);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expected = JSON.parse(raw) as Record<string, unknown>;
      delete expected.sort;
      expect(JSON.parse(result.dsl)).toEqual(expected);
      expect(result.changed).toBe(true);
    });

  it('round-trips additions, direction and priority without changing untouched shorthand', () => {
    const raw = '{"sort":["_score",{"n":"asc"}],"size":25}';
    const parsed = parseQuerySort(raw);
    if (!parsed.ok) throw new Error(parsed.code);
    expect(preview(raw, parsed.clauses)).toMatchObject({ ok: true, dsl: raw, changed: false });
    const changed = preview(raw, [clause('n', { direction: 'desc' }), parsed.clauses[0]!]);
    expect(changed.ok && parseQuerySort(changed.dsl)).toEqual({ ok: true, clauses: [clause('n', { direction: 'desc' }), clause('_score', { direction: 'desc' })] });
    expect(preview('{}', [])).toEqual({ ok: true, dsl: '{}', patch: { dsl: '{}' }, changed: false });
  });

  it('preserves managed time through patching, freezing and removal with exact original query values', () => {
    const query = { ...source, dsl: '{"query":{"term":{"n":9007199254740993}},"sort":["_score"]}' };
    const time = previewTimeRange(query, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, new Date('2026-10-10T00:00:00.000Z'));
    if (!time.ok) throw new Error(time.code);
    const timed = { ...query, dsl: time.dsl, timeRange: time.timeRange };
    const sorted = previewQuerySort(timed, [clause('date', { direction: 'desc' }), clause()], catalog);
    if (!sorted.ok) throw new Error(sorted.code);
    expect(sorted.patch.timeRange).toEqual(time.timeRange);
    expect(sorted.patch.timeRange).not.toBe(time.timeRange);
    const workspace = { ...createWorkspace('connection'), tabs: [{ kind: 'query' as const, document: timed }] };
    const updated = updateWorkspaceDocument(workspace, source.id, sorted.patch).tabs[0]!.document;
    expect(parseQueryTimeRange(updated.timeRange, updated.connectionId, updated.index, updated.dsl)).toEqual(time.timeRange);
    const snapshot = createSnapshot(updated, 'request', new Date('2026-10-10T01:00:00.000Z'));
    expect(snapshot.rawDsl).toContain('9007199254740993');
    expect(snapshot.rawDsl).toContain('2026-10-10T01:00:00.000000000Z');
    expect(parseQuerySort(snapshot.rawDsl)).toEqual(parseQuerySort(sorted.dsl));
    const removed = removeAppliedTimeRange(updated);
    expect(removed).toContain('"query":{"term":{"n":9007199254740993}}');
    expect(removed && parseQuerySort(removed)).toEqual(parseQuerySort(sorted.dsl));
    expect(previewQuerySort({ ...timed, index: 'other' }, [clause()], catalog)).toMatchObject({ ok: false, code: 'invalidBinding' });
  });

  it('retains a no-query time binding and removes only its time wrapper after applying sort', () => {
    const time = previewTimeRange({ ...source, dsl: '{"size":25}' }, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, new Date('2026-10-10T00:00:00.000Z'));
    if (!time.ok) throw new Error(time.code);
    const sorted = previewQuerySort({ ...source, dsl: time.dsl, timeRange: time.timeRange }, [clause('date')], catalog);
    if (!sorted.ok) throw new Error(sorted.code);
    expect(sorted.patch.timeRange?.hadQuery).toBe(false);
    const removed = removeAppliedTimeRange({ ...source, dsl: sorted.dsl, timeRange: time.timeRange });
    expect(removed).not.toBeNull();
    expect(JSON.parse(removed!)).toEqual({ size: 25, sort: [{ date: { order: 'asc' } }] });
  });

  it('shares the complete sorted DSL and precise multi-value cursor fixture with the backend', () => {
    const result = preview(sortFixture.sourceDsl, sortFixture.clauses as QuerySortClause[]);
    expect(result).toMatchObject({ ok: true, dsl: sortFixture.sortedDsl, changed: true });
    expect(result.ok && result.dsl).toContain('9007199254740993');
    expect(result.ok && result.dsl).toContain('0.100000000000000001');
  });

  it('composes with applied cell filters without rewriting a parameter template', () => {
    const parameters = { version: 1, template: '{"query":{"term":{"n":{"$param":"value"}}}}',
      definitions: [{ name: 'value', type: 'number' as const }] };
    const query = { ...source, dsl: '{"query":{"term":{"n":2}},"sort":["_score"]}', parameters };
    const snapshot = createSnapshot(query, 'request', new Date('2026-10-10T00:00:00.000Z'));
    const filter: QueryFilter = { id: 'filter', field: 'n', fieldType: 'long', evidence: 'mapped',
      operation: 'include', origin: 'source', value: '9007199254740993' };
    const filtered = previewQueryFilters(query, snapshot, [filter], catalog);
    if (!filtered.ok) throw new Error(filtered.code);
    const sorted = previewQuerySort({ ...query, dsl: filtered.dsl }, [clause()], catalog);
    if (!sorted.ok) throw new Error(sorted.code);
    expect(sorted.dsl).toContain('"n":2');
    expect(sorted.dsl).toContain('"n":9007199254740993');
    const workspace = { ...createWorkspace('connection'), tabs: [{ kind: 'query' as const, document: query }] };
    expect(updateWorkspaceDocument(workspace, query.id, sorted.patch).tabs[0]!.document.parameters).toEqual(parameters);
    expect(sorted.patch).not.toHaveProperty('parameters');
  });

  it('does not enable _shard_doc without managed first-page PIT eligibility or change paging options', () => {
    for (const raw of ['{"from":10}', '{"from":0.0}', '{"size":0}']) {
      expect(preview(raw, [clause('_shard_doc')])).toMatchObject({ ok: false, code: 'pitRequired' });
    }
    expect(preview('{"from":0,"size":25}', [clause('_shard_doc')])).toMatchObject({ ok: true });
    expect(preview('{"from":10}', [clause()])).toHaveProperty('dsl', expect.stringContaining('"from":10'));
  });

  it('rejects invalid row options, duplicate fields and field/DSL bounds without partial edits', () => {
    expect(preview('{}', [clause(), clause()])).toMatchObject({ ok: false, code: 'duplicateField' });
    for (const patch of [{ direction: 'up' }, { missing: 'custom' }, { unmappedType: 'text' }, { mode: 'avg' }]) {
      expect(preview('{}', [clause('n', patch as Partial<QuerySortClause>)])).toMatchObject({ ok: false, code: 'invalidOptions' });
    }
    const many = Array.from({ length: MAX_QUERY_SORT_FIELDS + 1 }, (_, index) => clause(`n${index}`));
    expect(preview('{}', many)).toMatchObject({ ok: false, code: 'tooMany' });
    expect(parseQuerySort(JSON.stringify({ sort: many.map((item) => item.field) }))).toMatchObject({ ok: false, code: 'tooMany' });
    expect(preview(JSON.stringify({ query: { term: { other: 'x'.repeat(MAX_SORT_DSL_BYTES) } } }))).toMatchObject({ ok: false, code: 'tooLarge' });
    const almost = '{"query":{"term":{"other":"' + 'x'.repeat(MAX_SORT_DSL_BYTES - 32) + '"}}}';
    expect(new TextEncoder().encode(almost).length).toBeLessThan(MAX_SORT_DSL_BYTES);
    expect(preview(almost)).toMatchObject({ ok: false, code: 'tooLarge' });
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSnapshot, createQuery, updateWorkspaceDocument, type QueryDocument } from '../../src/domain/query';
import { selectDataView } from '../../src/domain/data-views';
import {
  MAX_FILTER_CELL_BYTES, MAX_FILTER_DSL_BYTES, MAX_FILTER_VALUES, MAX_FILTER_VALUE_BYTES, MAX_QUERY_FILTERS,
  createQueryFilter, previewQueryFilters, queryFilterFieldEvidence, queryFilterValues,
  type CellFilterSelection, type QueryFilter, type QueryFilterOperation,
} from '../../src/domain/query-filters';
import { parseRawJson, property, sliceRaw } from '../../src/domain/query-result';
import { freezeTimeRange, parseQueryTimeRange, previewTimeRange, removeAppliedTimeRange, type QueryTimeRange, type ExecutionTimeRange } from '../../src/domain/query-time-range';
import { formatQueryDsl } from '../../src/domain/query-dsl';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';

const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events-*', dsl: '{"query":{"term":{"original":9007199254740993}},"size":25}' };
const snapshot = createSnapshot(source, 'execution', new Date('2026-10-10T00:00:00.000Z'));
const fields = (types: Record<string, string>): FieldCatalog => {
  const parsed = parseFieldCaps(JSON.stringify({ fields: Object.fromEntries(Object.entries(types).map(([field, type]) =>
    [field, { [type]: { searchable: true, aggregatable: true } }])) }));
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value;
};
const catalog = fields({ status: 'keyword', message: 'text', n: 'long', u: 'unsigned_long', d: 'double', flag: 'boolean', date: 'date', ip: 'ip' });
const selection = (field: string, kind: NonNullable<CellFilterSelection['value']>['kind'], text: string): CellFilterSelection =>
  ({ field, value: { kind, text }, origin: 'source' });

function filter(field = 'n', text = '9007199254740993', operation: QueryFilterOperation = 'include'): QueryFilter {
  const selected = selection(field, field === 'status' || field === 'message' ? 'string' : field === 'flag' ? 'boolean' : 'number', text);
  const values = queryFilterValues(selected.value);
  const created = createQueryFilter(source, snapshot, selected, operation, values.ok ? values.values[0]! : null, catalog);
  if (!created.ok) throw new Error(created.code);
  return { ...created.filter, id: `${field}-${operation}` };
}

describe('execution-cell filter values and evidence', () => {
  it('retains exact numeric tokens, escapes, empty strings and one explicitly selected array element', () => {
    expect(queryFilterValues({ kind: 'number', text: '9007199254740993' })).toEqual({ ok: true, values: ['9007199254740993'], array: false });
    expect(queryFilterValues({ kind: 'string', text: 'a"\\\n\t' })).toEqual({ ok: true, values: ['"a\\"\\\\\\n\\t"'], array: false });
    expect(queryFilterValues({ kind: 'string', text: '' })).toEqual({ ok: true, values: ['""'], array: false });
    const selected = selection('d', 'array', '[null, 1.2300e+2, 9007199254740993, 1.2300e+2]');
    expect(queryFilterValues(selected.value)).toEqual({ ok: true, values: ['1.2300e+2', '9007199254740993'], array: true });
    const created = createQueryFilter(source, snapshot, selected, 'exclude', '1.2300e+2', catalog);
    expect(created).toMatchObject({ ok: true, filter: { value: '1.2300e+2', operation: 'exclude' } });
    expect(createQueryFilter(source, snapshot, selected, 'include', '123', catalog)).toEqual({ ok: false, code: 'invalidValue' });
  });

  it.each([undefined, { kind: 'null', text: 'null' }, { kind: 'array', text: '[]' }, { kind: 'array', text: '[null,null]' }] as const)(
    'never infers indexed missing from the returned value %j', (value) => {
      expect(queryFilterValues(value)).toEqual({ ok: false, code: 'noScalarValue' });
      const selected: CellFilterSelection = { field: 'status', value, origin: 'source' };
      expect(createQueryFilter(source, snapshot, selected, 'include', null, catalog)).toEqual({ ok: false, code: 'noScalarValue' });
      expect(createQueryFilter(source, snapshot, selected, 'missing', null, catalog)).toMatchObject({ ok: true, filter: { operation: 'missing', value: null } });
      expect(createQueryFilter(source, snapshot, selected, 'exists', null, catalog)).toMatchObject({ ok: true, filter: { operation: 'exists', value: null } });
    },
  );

  it.each([
    [{ kind: 'object', text: '{"n":1}' }, 'compoundValue'],
    [{ kind: 'array', text: '[1,{"n":2}]' }, 'compoundValue'],
    [{ kind: 'array', text: '[1,[2]]' }, 'compoundValue'],
    [{ kind: 'number', text: '1,"injected":true' }, 'invalidValue'],
    [{ kind: 'boolean', text: '1' }, 'invalidValue'],
    [{ kind: 'array', text: `[${Array(MAX_FILTER_VALUES + 1).fill('1').join(',')}]` }, 'tooMany'],
    [{ kind: 'string', text: 'x'.repeat(MAX_FILTER_VALUE_BYTES) }, 'tooLarge'],
    [{ kind: 'string', text: 'x'.repeat(MAX_FILTER_CELL_BYTES + 1) }, 'tooLarge'],
  ] as const)('rejects unsupported or excessive cell values: %s', (value, code) => {
    expect(queryFilterValues(value)).toEqual({ ok: false, code });
  });

  it('requires inspected, unambiguous, searchable top-level mapping evidence', () => {
    expect(queryFilterFieldEvidence(source, snapshot, 'n')).toEqual({ ok: false, code: 'fieldUnchecked' });
    expect(queryFilterFieldEvidence(source, snapshot, 'unknown', catalog)).toEqual({ ok: false, code: 'fieldMissing' });
    expect(queryFilterFieldEvidence(source, snapshot, 'n', fields({ n: 'object' }))).toEqual({ ok: false, code: 'fieldUnsupported' });
    for (const field of ['', '_id', '$param', 'n*', 'n?', 'n\n', ' x', 'x'.repeat(1025)]) {
      expect(queryFilterFieldEvidence(source, snapshot, field, catalog)).toEqual({ ok: false, code: 'invalidField' });
    }
    expect(queryFilterFieldEvidence(source, snapshot, 'user.name', fields({ 'user.name': 'keyword' }))).toEqual({ ok: false, code: 'fieldPath' });
    expect(queryFilterFieldEvidence(source, snapshot, 'user.name', fields({ user: 'nested', 'user.name': 'keyword' })))
      .toEqual({ ok: false, code: 'fieldNested' });
    const conflict = parseFieldCaps('{"fields":{"n":{"long":{"searchable":true},"keyword":{"searchable":true}}}}');
    const blocked = parseFieldCaps('{"fields":{"n":{"long":{"searchable":true,"non_searchable_indices":["private"]}}}}');
    if (!conflict.ok || !blocked.ok) throw new Error('fixture');
    expect(queryFilterFieldEvidence(source, snapshot, 'n', conflict.value)).toEqual({ ok: false, code: 'fieldConflict' });
    expect(queryFilterFieldEvidence(source, snapshot, 'n', blocked.value)).toEqual({ ok: false, code: 'fieldNotSearchable' });
  });

  it.each(['query', 'connection', 'index'] as const)('rejects values from a different %s', (changed) => {
    const current = { ...source, ...(changed === 'query' ? { id: 'other' } : changed === 'connection' ? { connectionId: 'other' } : { index: 'other' }) };
    expect(queryFilterFieldEvidence(current, snapshot, 'n', catalog)).toEqual({ ok: false, code: 'targetChanged' });
  });

  it('uses only actual runtime DSL and returned fields, never unapplied library definitions or old source values', () => {
    const current = { ...source, dsl: '{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(1);"}}},"fields":["n"]}' };
    const executed = createSnapshot(current, 'runtime', new Date());
    const cell = { ...selection('n', 'array', '[9007199254740995]'), origin: 'fields' as const };
    expect(createQueryFilter(current, executed, cell, 'include', '9007199254740995', fields({ n: 'keyword' })))
      .toMatchObject({ ok: true, filter: { evidence: 'runtime', fieldType: 'long', value: '9007199254740995' } });
    expect(createQueryFilter(current, executed, { ...cell, origin: 'source' }, 'include', '9007199254740995', catalog))
      .toEqual({ ok: false, code: 'runtimeValueRequired' });
    for (const dsl of [source.dsl, current.dsl.replace('"long"', '"keyword"'), current.dsl.replace('emit(1)', 'emit(2)')]) {
      expect(queryFilterFieldEvidence({ ...current, dsl }, executed, 'n', catalog)).toEqual({ ok: false, code: 'runtimeChanged' });
    }
    expect(queryFilterFieldEvidence(current, snapshot, 'n', catalog)).toEqual({ ok: false, code: 'runtimeChanged' });
    const unapplied = { ...source, dataView: selectDataView({ id: 'view', connectionId: 'connection', name: 'View', index: source.index,
      defaultTimeField: null, runtimeFields: { version: 1, entries: [{ field: 'n', type: 'keyword' }] } }) };
    expect(queryFilterFieldEvidence(unapplied, snapshot, 'n', catalog)).toMatchObject({ ok: true, fieldType: 'long', evidence: 'mapped' });
  });

  it.each([
    ['n', 'number', '9223372036854775808', 'valueOutOfRange'],
    ['u', 'number', '-1', 'valueOutOfRange'],
    ['n', 'number', '1.01', 'valueOutOfRange'],
    ['d', 'number', '1e9999', 'valueOutOfRange'],
    ['n', 'string', '12', 'valueTypeMismatch'],
    ['status', 'number', '12', 'valueTypeMismatch'],
    ['flag', 'string', 'true', 'valueTypeMismatch'],
    ['date', 'string', '2026-10-10', 'valueUnsupported'],
    ['ip', 'string', '127.0.0.1', 'valueUnsupported'],
    ['message', 'string', ' \t', 'emptyPhrase'],
  ] as const)('rejects incompatible %s values without coercing them', (name, kind, text, code) => {
    const cell = selection(name, kind, text);
    const values = queryFilterValues(cell.value);
    expect(values.ok).toBe(true);
    if (!values.ok) return;
    expect(createQueryFilter(source, snapshot, cell, 'include', values.values[0]!, catalog)).toEqual({ ok: false, code });
  });

  it.each(['-9223372036854775808', '9223372036854775807', '1.000', '1e3', '-0e-9999'])('preserves valid exact integer %s', (text) => {
    expect(filter('n', text).value).toBe(text);
  });

  it('escapes actual field names and never substitutes a text keyword subfield', () => {
    const name = 'quote"\\field';
    const selected = selection(name, 'string', 'v"\\\n');
    const values = queryFilterValues(selected.value);
    if (!values.ok) throw new Error(values.code);
    const created = createQueryFilter(source, snapshot, selected, 'include', values.values[0]!, fields({ [name]: 'keyword' }));
    if (!created.ok) throw new Error(created.code);
    const result = previewQueryFilters(source, snapshot, [{ ...created.filter, id: 'quoted' }], fields({ [name]: 'keyword' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dsl).toContain(`"term":{${JSON.stringify(name)}:${JSON.stringify('v"\\\n')}}`);
    const text = createQueryFilter(source, snapshot, selection('message', 'string', 'hello'), 'include', '"hello"', fields({ 'message.keyword': 'keyword' }));
    expect(text).toEqual({ ok: false, code: 'fieldMissing' });
  });
});

describe('lossless filter draft application', () => {
  it('matches the backend shared fixture and retains cell filters while only managed time freezes', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/query-filters-time-v1.json', 'utf8')) as {
      baseDsl: string; previewAt: string; freezeAt: string; filters: QueryFilter[];
      appliedDsl: string; timeRange: QueryTimeRange; frozenDsl: string; executionTimeRange: ExecutionTimeRange;
    };
    const base = { ...source, index: fixture.timeRange.binding.index, dsl: fixture.baseDsl };
    const executed = createSnapshot(base, 'request', new Date(fixture.previewAt));
    const timed = previewTimeRange(base, fixture.timeRange.definition, new Date(fixture.previewAt));
    if (!timed.ok) throw new Error(timed.code);
    const filtered = previewQueryFilters({ ...base, dsl: timed.dsl, timeRange: timed.timeRange }, executed, fixture.filters, catalog);
    if (!filtered.ok) throw new Error(filtered.code);
    expect(formatQueryDsl(filtered.dsl)).toMatchObject({ ok: true, formatted: (formatQueryDsl(fixture.appliedDsl) as { formatted: string }).formatted });
    expect(filtered.patch.timeRange).toEqual(fixture.timeRange);
    const frozen = freezeTimeRange({ ...base, dsl: filtered.dsl, timeRange: fixture.timeRange }, new Date(fixture.freezeAt));
    if (!frozen.ok) throw new Error(frozen.code);
    expect(formatQueryDsl(frozen.dsl)).toMatchObject({ ok: true, formatted: (formatQueryDsl(fixture.frozenDsl) as { formatted: string }).formatted });
    expect(frozen.timeRange).toEqual(fixture.executionTimeRange);
  });
  it('keeps the entire original query, scoring/MSM, post_filter, sort, aggregations and escapes untouched', () => {
    const original = '{"bool":{"should":[{"term":{"raw":9007199254740993}},{"match":{"s":"\\u0061"}}]}}';
    const current = { ...source, dsl: `{"query":${original},"post_filter":{"term":{"x":1.2300e+2}},"sort":[{"n":"desc"},{"status":"asc"}],"aggs":{"all":{"global":{}}}}` };
    const result = previewQueryFilters(current, snapshot, [filter(), filter('status', 'a"\\\n', 'exclude'), filter('message', 'some words')], catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const root = parseRawJson(result.dsl)!;
    const bool = property(property(root, 'query'), 'bool');
    expect(sliceRaw(result.dsl, property(bool, 'must')!.children![0]!)).toBe(original);
    expect(result.dsl).toContain('"post_filter":{"term":{"x":1.2300e+2}},"sort":[{"n":"desc"},{"status":"asc"}],"aggs":{"all":{"global":{}}}');
    expect(result.dsl).toContain('"filter":[{"term":{"n":9007199254740993}},{"match_phrase":{"message":"some words"}}]');
    expect(result.dsl).toContain('"must_not":[{"term":{"status":"a\\"\\\\\\n"}}]');
    expect(result.dsl).not.toContain('minimum_should_match');
    expect(result.patch).toEqual({ dsl: result.dsl });
    expect(current.dsl).toContain(original);
  });

  it('defines exclusion to include documents without a value and emits missing only after an explicit choice', () => {
    const result = previewQueryFilters(source, snapshot, [filter('status', 'ok', 'exclude'), filter('n', '', 'missing'), filter('flag', '', 'exists')], catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dsl).toContain('"filter":[{"exists":{"field":"flag"}}]');
    expect(result.dsl).toContain('"must_not":[{"term":{"status":"ok"}},{"exists":{"field":"n"}}]');
    expect(result.dsl).not.toContain('"exists":{"field":"status"}');
  });

  it.each(['{}', '{"size":25}'])('preserves default match_all scoring for a body without query: %s', (dsl) => {
    const result = previewQueryFilters({ ...source, dsl }, snapshot, [filter()], catalog);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dsl).toContain('"must":[{"match_all":{}}],"filter":[{"term":{"n":9007199254740993}}]');
  });

  it.each([source.dsl, '{"size":25}'])('preserves managed time binding, frozen bounds and added filters on removal: %s', (dsl) => {
    const timed = previewTimeRange({ ...source, dsl }, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, new Date('2026-10-10T00:00:00.000Z'));
    if (!timed.ok) throw new Error(timed.code);
    const current = { ...source, dsl: timed.dsl, timeRange: timed.timeRange };
    const result = previewQueryFilters(current, snapshot, [filter()], catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.timeRange).toEqual({ ...timed.timeRange, hadQuery: true });
    const state = updateWorkspaceDocument({ activeTabId: current.id, activeConnectionId: current.connectionId,
      tabs: [{ kind: 'query', document: current }], lastTabByConnection: {} }, current.id, result.patch);
    const updated = state.tabs[0]!.document;
    expect(parseQueryTimeRange(updated.timeRange, updated.connectionId, updated.index, updated.dsl)).not.toBeNull();
    expect(updated.timeRange?.bounds).toEqual(timed.timeRange.bounds);
    const frozen = freezeTimeRange(updated, new Date('2026-10-10T01:00:00.000Z'));
    expect(frozen).toMatchObject({ ok: true, timeRange: { bounds: { to: '2026-10-10T01:00:00.000000000Z' } } });
    if (frozen.ok) expect(frozen.dsl).toContain('"term":{"n":9007199254740993}');
    expect(removeAppliedTimeRange(updated)).toContain('"term":{"n":9007199254740993}');
    expect(removeAppliedTimeRange(updated)).not.toContain('"range"');
    expect(timed.timeRange.hadQuery).toBe(dsl === source.dsl);
  });

  it('fails closed on unknown root semantics, broken bindings, excess filters and oversized DSL', () => {
    for (const key of ['knn', 'retriever', 'rescore', 'search_after', 'pit', 'unknown']) {
      expect(previewQueryFilters({ ...source, dsl: `{"${key}":{}}` }, snapshot, [filter()], catalog))
        .toEqual({ ok: false, code: 'unsupportedDsl' });
    }
    expect(previewQueryFilters({ ...source, dsl: '{"query":null}' }, snapshot, [filter()], catalog)).toEqual({ ok: false, code: 'unsupportedDsl' });
    expect(previewQueryFilters({ ...source, dsl: '{"query":{"term":{"n":{"$param":"n"}}}}' }, snapshot, [filter()], catalog))
      .toEqual({ ok: false, code: 'invalidDsl' });
    expect(previewQueryFilters({ ...source, dsl: ' '.repeat(MAX_FILTER_DSL_BYTES) + '{}' }, snapshot, [filter()], catalog))
      .toEqual({ ok: false, code: 'tooLarge' });
    expect(previewQueryFilters(source, snapshot, [], catalog)).toEqual({ ok: false, code: 'empty' });
    expect(previewQueryFilters(source, snapshot, Array(MAX_QUERY_FILTERS + 1).fill(filter()), catalog)).toEqual({ ok: false, code: 'tooMany' });
    expect(previewQueryFilters(source, snapshot, [filter(), { ...filter(), id: 'duplicate' }], catalog)).toEqual({ ok: false, code: 'duplicate' });
    const time = previewTimeRange(source, { field: 'date', fieldType: 'date', timeZone: 'UTC', range: { kind: 'relative', amount: 1, unit: 'hours' } }, new Date());
    if (!time.ok) throw new Error(time.code);
    expect(previewQueryFilters({ ...source, timeRange: time.timeRange }, snapshot, [filter()], catalog)).toEqual({ ok: false, code: 'invalidBinding' });
  });

  it('revalidates field evidence and every value at preview instead of trusting a stored proposal', () => {
    expect(previewQueryFilters(source, snapshot, [filter()], fields({ n: 'keyword' }))).toEqual({ ok: false, code: 'fieldChanged' });
    expect(previewQueryFilters(source, snapshot, [{ ...filter(), value: '1,"script":{}' }], catalog)).toEqual({ ok: false, code: 'invalidValue' });
    expect(previewQueryFilters(source, snapshot, [{ ...filter(), operation: 'exists' }], catalog)).toEqual({ ok: false, code: 'invalidValue' });
    expect(previewQueryFilters(source, snapshot, [{ ...filter(), value: null }], catalog)).toEqual({ ok: false, code: 'invalidValue' });
  });
});

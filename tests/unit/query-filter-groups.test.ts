import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/query-filter-groups-v1.json';
import { createQuery, createSnapshot, createWorkspace, updateWorkspaceDocument, type QueryDocument } from '../../src/domain/query';
import {
  MAX_FILTER_DSL_BYTES, MAX_FILTER_GROUPS, MAX_QUERY_FILTERS, previewQueryFilters,
  type QueryFilter, type QueryFilterComposition, type QueryFilterJoin,
} from '../../src/domain/query-filters';
import { parseRawJson, property, sliceRaw } from '../../src/domain/query-result';
import { freezeTimeRange, parseQueryTimeRange, previewTimeRange, removeAppliedTimeRange } from '../../src/domain/query-time-range';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { parseVisualForm } from '../../src/domain/visual-query';

const at = new Date('2026-10-10T00:00:00.000Z');
const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events-*', dsl: '{"query":{"match_all":{}},"size":25}' };
const snapshot = createSnapshot(source, 'execution', at);
function fields(types: Record<string, string>): FieldCatalog {
  const parsed = parseFieldCaps(JSON.stringify({ fields: Object.fromEntries(Object.entries(types).map(([field, type]) =>
    [field, { [type]: { searchable: true, aggregatable: true } }])) }));
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value;
}
const catalog = fields({ a: 'keyword', b: 'keyword', c: 'keyword', d: 'keyword', n: 'long', message: 'text' });
const atom = (field: string, operation: QueryFilter['operation'] = 'include'): QueryFilter =>
  ({ id: `${field}-${operation}`, field, fieldType: 'keyword', evidence: 'mapped', operation,
    value: operation === 'exists' || operation === 'missing' ? null : '"yes"', origin: 'source' });
const leaves = [atom('a'), atom('b', 'exclude'), atom('c', 'exists'), atom('d', 'missing')];
const grouped = (mode: QueryFilterJoin = 'all', first: QueryFilterJoin = 'any', second: QueryFilterJoin = 'all'): QueryFilterComposition =>
  ({ mode, groups: [
    { id: 'first', mode: first, filterIds: leaves.slice(0, 2).map((filter) => filter.id) },
    { id: 'second', mode: second, filterIds: leaves.slice(2).map((filter) => filter.id) },
  ] });
function preview(composition = grouped(), filters = leaves, document = source, evidence = catalog) {
  const result = previewQueryFilters(document, snapshot, filters, evidence, composition);
  if (!result.ok) throw new Error(result.code);
  return result;
}

type BooleanClause = {
  match_all?: object;
  term?: Record<string, string>;
  exists?: { field: string };
  bool?: { must?: BooleanClause[]; filter?: BooleanClause[]; must_not?: BooleanClause[]; should?: BooleanClause[]; minimum_should_match?: number };
};
// Truth-table oracle for the generated term/exists/bool subset, not an Elasticsearch simulator.
function matches(clause: BooleanClause, present: ReadonlySet<string>): boolean {
  if (clause.match_all) return true;
  if (clause.term) return present.has(Object.keys(clause.term)[0]!);
  if (clause.exists) return present.has(clause.exists.field);
  if (!clause.bool) throw new Error('Unexpected test clause');
  const { must = [], filter = [], must_not = [], should = [], minimum_should_match } = clause.bool;
  const minimum = minimum_should_match ?? (should.length && !must.length && !filter.length ? 1 : 0);
  return [...must, ...filter].every((child) => matches(child, present)) && !must_not.some((child) => matches(child, present))
    && should.filter((child) => matches(child, present)).length >= minimum;
}

describe('bounded non-scoring filter groups', () => {
  it('matches the frontend/backend shared request fixture without normalizing literals or escapes', () => {
    const document = { ...source, dsl: fixture.sourceDsl };
    const result = previewQueryFilters(document, createSnapshot(document, 'fixture', at), fixture.filters as QueryFilter[],
      fields({ status: 'keyword', message: 'text' }), fixture.composition as QueryFilterComposition);
    if (!result.ok) throw new Error(result.code);
    expect(result.dsl).toBe(fixture.groupedDsl);
    expect(result.patch).toEqual({ dsl: fixture.groupedDsl });
    expect(result.dsl).toContain('"message":"\\u0061"');
    expect(result.dsl).toContain('"min_score":1.2300e+2');
  });

  it.each([
    ['all', 'all', 'all'], ['all', 'all', 'any'], ['all', 'any', 'all'], ['all', 'any', 'any'],
    ['any', 'all', 'all'], ['any', 'all', 'any'], ['any', 'any', 'all'], ['any', 'any', 'any'],
  ] as const)('matches every truth-table row for %s groups with %s / %s leaves', (rootMode, firstMode, secondMode) => {
    const result = preview(grouped(rootMode, firstMode, secondMode));
    const body = JSON.parse(result.dsl) as { query: BooleanClause };
    for (let bits = 0; bits < 16; bits += 1) {
      const [a, b, c, d] = [1, 2, 4, 8].map((mask) => Boolean(bits & mask));
      const first = firstMode === 'all' ? a && !b : a || !b;
      const second = secondMode === 'all' ? c && !d : c || !d;
      const present = new Set(['a', 'b', 'c', 'd'].filter((_, index) => Boolean(bits & (1 << index))));
      expect(matches(body.query, present), `row ${bits}`).toBe(rootMode === 'all' ? first && second : first || second);
    }
    const root = body.query.bool!;
    expect(root.must).toEqual([{ match_all: {} }]);
    expect(root.should).toBeUndefined();
    expect(root.must_not).toBeUndefined();
    expect(root.filter?.length).toBeGreaterThan(0);
  });

  it('retains negative OR branches locally, including the all-negative and missing cases', () => {
    const filters = [atom('a', 'exclude'), atom('b', 'missing')];
    const result = preview({ mode: 'all', groups: [{ id: 'g', mode: 'any', filterIds: filters.map((filter) => filter.id) }] }, filters);
    const body = JSON.parse(result.dsl);
    expect(body.query.bool.filter).toEqual([{ bool: { should: [
      { bool: { must_not: [{ term: { a: 'yes' } }] } },
      { bool: { must_not: [{ exists: { field: 'b' } }] } },
    ], minimum_should_match: 1 } }]);
    expect(matches(body.query, new Set(['a']))).toBe(true);
    expect(matches(body.query, new Set(['b']))).toBe(true);
    expect(matches(body.query, new Set(['a', 'b']))).toBe(false);
    expect(matches(body.query, new Set())).toBe(true);
    expect(result.dsl).not.toContain('"exists":{"field":"a"}');
  });

  it.each([
    ['all', 'all', 'all'], ['all', 'all', 'any'], ['all', 'any', 'all'], ['all', 'any', 'any'],
    ['any', 'all', 'all'], ['any', 'all', 'any'], ['any', 'any', 'all'], ['any', 'any', 'any'],
  ] as const)('omits inactive branches for %s / %s / %s without interpreting an inactive group as true or false', (rootMode, firstMode, secondMode) => {
    const composition = grouped(rootMode, firstMode, secondMode);
    for (let enabledMask = 0; enabledMask < 16; enabledMask += 1) {
      const filters = leaves.map((filter, index) => ({ ...filter, enabled: Boolean(enabledMask & (1 << index)) }));
      const saved = structuredClone({ composition, filters });
      const result = preview(composition, filters);
      const body = JSON.parse(result.dsl) as { query: BooleanClause };
      expect(result.dsl).not.toContain('"should":[]');
      expect(result.dsl).not.toContain('"filter":[]');
      if (enabledMask === 0) expect(result).toEqual({ ok: true, dsl: source.dsl, patch: { dsl: source.dsl } });
      for (let bits = 0; bits < 16; bits += 1) {
        const [a, b, c, d] = [1, 2, 4, 8].map((mask) => Boolean(bits & mask));
        const members = [[a, !b], [c, !d]].map((values, group) =>
          values.filter((_, index) => Boolean(enabledMask & (1 << (group * 2 + index)))));
        const groups = members.flatMap((values, index) => values.length
          ? [(index === 0 ? firstMode : secondMode) === 'all' ? values.every(Boolean) : values.some(Boolean)] : []);
        const expected = !groups.length || (rootMode === 'all' ? groups.every(Boolean) : groups.some(Boolean));
        const present = new Set(['a', 'b', 'c', 'd'].filter((_, index) => Boolean(bits & (1 << index))));
        expect(matches(body.query, present), `enabled ${enabledMask}, row ${bits}`).toBe(expected);
      }
      expect({ composition, filters }).toEqual(saved);
    }
  });

  it('writes minimum_should_match for every generated OR, even singleton groups', () => {
    const filters = [leaves[0]!];
    const result = preview({ mode: 'any', groups: [{ id: 'g', mode: 'any', filterIds: [filters[0]!.id] }] }, filters);
    expect(result.dsl.match(/"minimum_should_match":1/g)).toHaveLength(2);
    expect(JSON.parse(result.dsl).query.bool.should).toBeUndefined();
  });

  it('keeps the existing single-AND DSL contract byte-for-byte and never mutates the grouping input', () => {
    const composition: QueryFilterComposition = { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: leaves.map((filter) => filter.id) }] };
    const saved = structuredClone({ composition, leaves, source, snapshot });
    const result = preview(composition);
    expect(previewQueryFilters(source, snapshot, leaves, catalog)).toEqual(result);
    expect({ composition, leaves, source, snapshot }).toEqual(saved);
  });

  it.each([
    '{"bool":{"should":[{"term":{"raw":9007199254740993}},{"match":{"s":"\\u0061"}}]}}',
    '{"bool":{"must":[{"match_all":{}}],"should":[{"match":{"message":"words"}}],"minimum_should_match":0}}',
    '{"bool":{"should":[{"term":{"a":"x"}},{"term":{"b":"y"}}],"minimum_should_match":"75%","boost":1.1000000000000000001}}',
    '{"function_score":{"query":{"match_all":{}},"functions":[{"weight":1.2300e+2}],"boost_mode":"multiply"}}',
    '{"constant_score":{"filter":{"term":{"n":9007199254740995}},"boost":2}}',
    '{"dis_max":{"queries":[{"match":{"a":"one"}},{"match":{"b":"two"}}],"tie_breaker":0.1}}',
  ])('preserves the original scoring query verbatim: %s', (original) => {
    const suffix = ',"sort":[{"n":{"order":"desc","missing":"_last"}},"_score"],"min_score":1.1000000000000000001,'
      + '"post_filter":{"term":{"n":1.2300e+2}},"aggs":{"all":{"global":{}}},"size":25}';
    const document = { ...source, dsl: `{"query":${original}${suffix}` };
    const result = preview(grouped('any'), leaves, document);
    const root = parseRawJson(result.dsl)!;
    const must = property(property(property(root, 'query'), 'bool'), 'must')!.children![0]!;
    expect(sliceRaw(result.dsl, must)).toBe(original);
    expect(result.dsl.endsWith(suffix)).toBe(true);
    expect(JSON.parse(result.dsl).query.bool.should).toBeUndefined();
    expect(result.patch).toEqual({ dsl: result.dsl });
    expect(parseVisualForm(result.dsl).ok).toBe(false);
  });

  it('preserves text phrase filtering and exact runtime tokens while rechecking actual runtime evidence', () => {
    const document = { ...source, dsl: '{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(9007199254740995L);"}}},"fields":["n"]}' };
    const executed = createSnapshot(document, 'runtime', at);
    const filters: QueryFilter[] = [
      { ...atom('n'), fieldType: 'long', evidence: 'runtime', value: '9007199254740995', origin: 'fields' },
      { ...atom('message', 'exclude'), fieldType: 'text', value: '"quoted \\"words\\""' },
    ];
    const composition: QueryFilterComposition = { mode: 'all', groups: [{ id: 'g', mode: 'any', filterIds: filters.map((filter) => filter.id) }] };
    const result = previewQueryFilters(document, executed, filters, catalog, composition);
    if (!result.ok) throw new Error(result.code);
    expect(result.dsl).toContain('"term":{"n":9007199254740995}');
    expect(result.dsl).toContain('"match_phrase":{"message":"quoted \\"words\\""}');
    expect(JSON.parse(result.dsl).query.bool.must).toEqual([{ match_all: {} }]);
    expect(previewQueryFilters({ ...document, dsl: document.dsl.replace('emit(9007199254740995L)', 'emit(2L)') }, executed, filters, catalog, composition))
      .toEqual({ ok: false, code: 'runtimeChanged' });
    expect(previewQueryFilters(document, executed, [{ ...filters[0]!, origin: 'source' }, filters[1]!], catalog, composition))
      .toEqual({ ok: false, code: 'runtimeValueRequired' });
    expect(previewQueryFilters(document, executed, filters, fields({ message: 'keyword' }), composition))
      .toEqual({ ok: false, code: 'fieldChanged' });
  });

  it.each([source.dsl, '{"size":25,"sort":[{"n":"desc"}]}'])('retains groups through time freeze/removal and leaves the parameter template untouched: %s', (dsl) => {
    const parameters = { version: 1, template: '{"query":{"term":{"a":{"$param":"value"}}}}',
      definitions: [{ name: 'value', type: 'string' as const }] };
    const base = { ...source, dsl, parameters };
    const timed = previewTimeRange(base, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, at);
    if (!timed.ok) throw new Error(timed.code);
    const current = { ...base, dsl: timed.dsl, timeRange: timed.timeRange };
    const result = preview(grouped('any'), leaves, current);
    const workspace = createWorkspace(source.connectionId);
    workspace.tabs = [{ kind: 'query', document: current }];
    const updated = updateWorkspaceDocument(workspace, current.id, result.patch).tabs[0]!.document;
    expect(updated.parameters).toEqual(parameters);
    expect(updated.timeRange).toEqual({ ...timed.timeRange, hadQuery: true });
    expect(parseQueryTimeRange(updated.timeRange, updated.connectionId, updated.index, updated.dsl)).not.toBeNull();
    const frozen = freezeTimeRange(updated, new Date('2026-10-10T01:00:00.000Z'));
    if (!frozen.ok) throw new Error(frozen.code);
    const before = property(property(property(parseRawJson(result.dsl), 'query'), 'bool'), 'must')!.children![0]!;
    const after = property(property(property(parseRawJson(frozen.dsl), 'query'), 'bool'), 'must')!.children![0]!;
    expect(sliceRaw(frozen.dsl, after)).toBe(sliceRaw(result.dsl, before));
    expect(frozen.timeRange?.bounds.to).toBe('2026-10-10T01:00:00.000000000Z');
    const removed = removeAppliedTimeRange(updated)!;
    expect(sliceRaw(removed, property(parseRawJson(removed), 'query')!)).toBe(sliceRaw(result.dsl, before));
    expect(JSON.parse(removed).sort).toEqual(JSON.parse(dsl).sort);
    expect(snapshot.rawDsl).toBe(source.dsl);
  });
});

describe('filter group bounds and rejected shapes', () => {
  it.each([
    null, [], {}, { mode: 'any', groups: [] }, { mode: 'not', groups: grouped().groups },
    { ...grouped(), minimum_should_match: 0 }, { ...grouped(), disabled: true },
    { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: [] }] },
    { mode: 'all', groups: [{ id: 'g', mode: 'any', filterIds: [leaves[0]!.id] }] },
    { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: [...leaves.map((filter) => filter.id), 'unknown'] }] },
    { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: [...leaves.map((filter) => filter.id), leaves[0]!.id] }] },
    { mode: 'all', groups: grouped().groups.map((group) => ({ ...group, id: 'same' })) },
    { mode: 'all', groups: [{ id: '', mode: 'all', filterIds: leaves.map((filter) => filter.id) }] },
    { mode: 'all', groups: [{ id: 'x'.repeat(129), mode: 'all', filterIds: leaves.map((filter) => filter.id) }] },
    { mode: 'all', groups: [{ id: 'g', mode: 'not', filterIds: leaves.map((filter) => filter.id) }] },
    { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: leaves.map((filter) => filter.id), minimum_should_match: '50%' }] },
    { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: leaves.map((filter) => filter.id), groups: [] }] },
    { mode: 'all', groups: [null] }, { mode: 'all', groups: [{}] },
  ])('rejects invalid, omitted, duplicated, deeper or unsupported grouping: %j', (composition) => {
    expect(previewQueryFilters(source, snapshot, leaves, catalog, composition as QueryFilterComposition)).toEqual({ ok: false, code: 'invalidComposition' });
  });

  it('rejects a filter repeated across groups even if all other leaves are accounted for', () => {
    const composition = grouped();
    expect(previewQueryFilters(source, snapshot, leaves, catalog, { ...composition,
      groups: [...composition.groups, { id: 'repeat', mode: 'all', filterIds: [leaves[0]!.id] }] }))
      .toEqual({ ok: false, code: 'invalidComposition' });
    const duplicated = [...leaves, { ...leaves[0]!, id: 'other-id' }];
    expect(previewQueryFilters(source, snapshot, duplicated, catalog,
      { mode: 'all', groups: [{ id: 'g', mode: 'any', filterIds: duplicated.map((filter) => filter.id) }] }))
      .toEqual({ ok: false, code: 'duplicate' });
  });

  it('accepts exactly 8 groups and 32 leaves while rejecting larger drafts and final DSL', () => {
    const filters = Array.from({ length: MAX_QUERY_FILTERS }, (_, index) => ({ ...atom('a'), id: `a-${index}`, value: JSON.stringify(`v${index}`) }));
    const composition: QueryFilterComposition = { mode: 'any', groups: Array.from({ length: MAX_FILTER_GROUPS }, (_, index) => ({
      id: `g-${index}`, mode: index % 2 ? 'all' : 'any', filterIds: filters.slice(index * 4, index * 4 + 4).map((filter) => filter.id),
    })) };
    expect(previewQueryFilters(source, snapshot, filters, catalog, composition).ok).toBe(true);
    expect(previewQueryFilters(source, snapshot, filters, catalog, { ...composition,
      groups: [...composition.groups, { id: 'extra', mode: 'all', filterIds: [filters[0]!.id] }] })).toEqual({ ok: false, code: 'tooManyGroups' });
    expect(previewQueryFilters(source, snapshot, [...filters, { ...atom('b'), id: 'extra' }], catalog, composition))
      .toEqual({ ok: false, code: 'tooMany' });
    const large = { ...source, dsl: ' '.repeat(MAX_FILTER_DSL_BYTES - source.dsl.length - 1) + source.dsl };
    expect(previewQueryFilters(large, snapshot, filters, catalog, composition)).toEqual({ ok: false, code: 'tooLarge' });
  });
});

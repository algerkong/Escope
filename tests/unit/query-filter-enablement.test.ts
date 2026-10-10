import { describe, expect, it } from 'vitest';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import {
  MAX_FILTER_DSL_BYTES, MAX_FILTER_GROUPS, MAX_FILTER_VALUE_BYTES, MAX_QUERY_FILTERS,
  previewQueryFilters, queryFilterEnabled, type QueryFilter, type QueryFilterComposition,
} from '../../src/domain/query-filters';
import { freezeTimeRange, parseQueryTimeRange, previewTimeRange, removeAppliedTimeRange } from '../../src/domain/query-time-range';
import { parseFieldCaps } from '../../src/domain/resource';

const at = new Date('2026-10-10T00:00:00.000Z');
const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events',
  dsl: '{"query":{"bool":{"should":[{"term":{"n":9007199254740993}},{"term":{"status":"\\u0061"}}],"minimum_should_match":"75%"}},"size":25}' };
const snapshot = createSnapshot(source, 'request', at);
const parsed = parseFieldCaps('{"fields":{"n":{"long":{"searchable":true}},"status":{"keyword":{"searchable":true}}}}');
if (!parsed.ok) throw new Error('fixture');
const catalog = parsed.value;
const n: QueryFilter = { id: 'n', field: 'n', fieldType: 'long', evidence: 'mapped', origin: 'source',
  operation: 'include', value: '9007199254740995' };
const status: QueryFilter = { id: 'status', field: 'status', fieldType: 'keyword', evidence: 'mapped', origin: 'source',
  operation: 'exclude', value: '"blocked"' };
const off = (filter: QueryFilter): QueryFilter => ({ ...filter, enabled: false });
const grouping = (filters: readonly QueryFilter[]): QueryFilterComposition => ({ mode: 'any',
  groups: filters.map((filter) => ({ id: `group-${filter.id}`, mode: 'any', filterIds: [filter.id] })) });

describe('session filter enablement', () => {
  it('defaults only an omitted state to enabled and produces the unchanged legacy output for explicit true', () => {
    expect(queryFilterEnabled(n)).toBe(true);
    expect(queryFilterEnabled(off(n))).toBe(false);
    expect(previewQueryFilters(source, snapshot, [{ ...n, enabled: true }], catalog))
      .toEqual(previewQueryFilters(source, snapshot, [n], catalog));
    const inherited = Object.assign(Object.create({ enabled: false }), n) as QueryFilter;
    expect(queryFilterEnabled(inherited)).toBe(true);
    expect(previewQueryFilters(source, snapshot, [inherited], catalog)).toEqual(previewQueryFilters(source, snapshot, [n], catalog));
  });

  it.each([null, 'false', 'true', 0, 1, [], {}, ['false'], undefined])('rejects a present non-boolean state: %j', (enabled) => {
    expect(previewQueryFilters(source, snapshot, [{ ...n, enabled } as QueryFilter], catalog))
      .toEqual({ ok: false, code: 'invalidFilterState' });
  });

  it('does not need live evidence for a disabled definition, but rechecks before re-enabling it', () => {
    const unavailable: QueryFilter = { ...n, field: 'unavailable', enabled: false };
    const filters = [unavailable, status];
    const result = previewQueryFilters(source, snapshot, filters, catalog, grouping(filters));
    if (!result.ok) throw new Error(result.code);
    expect(result.dsl).not.toContain('unavailable');
    expect(result.dsl).toContain('"must_not":[{"term":{"status":"blocked"}}]');
    expect(previewQueryFilters(source, snapshot, [{ ...unavailable, enabled: true }, status], catalog, grouping(filters)))
      .toEqual({ ok: false, code: 'fieldMissing' });
    expect(previewQueryFilters(source, snapshot, [off(n)], undefined)).toEqual({ ok: true, dsl: source.dsl, patch: { dsl: source.dsl } });
    expect(previewQueryFilters(source, snapshot, [n], undefined)).toEqual({ ok: false, code: 'fieldUnchecked' });
  });

  it('does not reintroduce old runtime values when a disabled condition is enabled again', () => {
    const base = { ...source, dsl: '{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(1);"}}},"fields":["n"]}' };
    const executed = createSnapshot(base, 'runtime', at);
    const changed = { ...base, dsl: base.dsl.replace('emit(1)', 'emit(2)') };
    const runtime: QueryFilter = { ...n, evidence: 'runtime', origin: 'fields' };
    expect(previewQueryFilters(changed, executed, [off(runtime)], undefined))
      .toEqual({ ok: true, dsl: changed.dsl, patch: { dsl: changed.dsl } });
    expect(previewQueryFilters(changed, executed, [runtime], undefined)).toEqual({ ok: false, code: 'runtimeChanged' });
  });

  it.each([
    source.dsl, '{ "size" : 25 }', '{}',
    '{"query":{"nested":{"path":"comments","query":{"term":{"comments.n":9007199254740993}}}},"min_score":1.2300e+2}',
  ])('returns exact original DSL when all filters are disabled, without reverse-converting existing conditions: %s', (dsl) => {
    const current = { ...source, dsl };
    const filters = [off(n), off(status)];
    const result = previewQueryFilters(current, snapshot, filters, undefined, grouping(filters));
    expect(result).toEqual({ ok: true, dsl, patch: { dsl } });
    expect(current.dsl).toBe(dsl);
  });

  it.each([source.dsl, '{"size":25,"sort":[{"n":"desc"}]}'])('keeps the exact time binding and hadQuery flag for a fully inactive draft: %s', (dsl) => {
    const base = { ...source, dsl, parameters: { version: 1, template: '{"query":{"term":{"n":{"$param":"n"}}}}',
      definitions: [{ name: 'n', type: 'number' as const }] } };
    const time = previewTimeRange(base, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, at);
    if (!time.ok) throw new Error(time.code);
    const current = { ...base, dsl: time.dsl, timeRange: time.timeRange };
    const result = previewQueryFilters(current, snapshot, [off(n)], undefined);
    if (!result.ok) throw new Error(result.code);
    expect(result.dsl).toBe(current.dsl);
    expect(result.patch.timeRange).toEqual(current.timeRange);
    expect(result.patch.timeRange).not.toBe(current.timeRange);
    expect(parseQueryTimeRange(result.patch.timeRange, current.connectionId, current.index, result.dsl)).not.toBeNull();
    expect(removeAppliedTimeRange(current)).toBe(dsl);
    expect(freezeTimeRange(current, new Date('2026-10-10T01:00:00.000Z')).ok).toBe(true);
    expect(result.patch).not.toHaveProperty('parameters');
    expect(result.patch).not.toHaveProperty('enabled');
    expect(result.patch).not.toHaveProperty('filters');
  });

  it('keeps source/target/DSL/time guards in force even with no enabled filters', () => {
    expect(previewQueryFilters({ ...source, index: 'other' }, snapshot, [off(n)], undefined))
      .toEqual({ ok: false, code: 'targetChanged' });
    expect(previewQueryFilters({ ...source, dsl: '{"query":{"term":{"n":{"$param":"n"}}}}' }, snapshot, [off(n)], undefined))
      .toEqual({ ok: false, code: 'invalidDsl' });
    expect(previewQueryFilters({ ...source, dsl: '{"knn":{}}' }, snapshot, [off(n)], undefined))
      .toEqual({ ok: false, code: 'unsupportedDsl' });
    const time = previewTimeRange(source, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 1, unit: 'hours' } }, at);
    if (!time.ok) throw new Error(time.code);
    expect(previewQueryFilters({ ...source, timeRange: time.timeRange }, snapshot, [off(n)], undefined))
      .toEqual({ ok: false, code: 'invalidBinding' });
  });

  it.each([
    [{ field: '_id' }, 'invalidField'], [{ field: 'a.b' }, 'fieldPath'],
    [{ fieldType: 'object' }, 'fieldUnsupported'], [{ value: '"2"' }, 'valueTypeMismatch'],
    [{ value: '{"x":1}' }, 'invalidValue'], [{ value: null }, 'invalidValue'],
    [{ value: '9223372036854775808' }, 'valueOutOfRange'],
    [{ operation: 'exists' }, 'invalidValue'], [{ operation: 'anything' }, 'invalidValue'],
    [{ evidence: 'other' }, 'invalidValue'], [{ origin: 'other' }, 'invalidValue'],
    [{ evidence: 'runtime', origin: 'source' }, 'runtimeValueRequired'],
    [{ fieldType: 'keyword', value: JSON.stringify('x'.repeat(MAX_FILTER_VALUE_BYTES)) }, 'tooLarge'],
  ])('still validates a disabled definition: %j', (patch, code) => {
    expect(previewQueryFilters(source, snapshot, [{ ...off(n), ...patch } as QueryFilter], undefined)).toEqual({ ok: false, code });
  });

  it('counts disabled definitions for duplicates, group membership and all quotas', () => {
    expect(previewQueryFilters(source, snapshot, [n, { ...off(status), id: n.id }], catalog))
      .toEqual({ ok: false, code: 'duplicate' });
    expect(previewQueryFilters(source, snapshot, [n, { ...off(n), id: 'duplicate' }], catalog))
      .toEqual({ ok: false, code: 'duplicate' });
    const filters = [off(n), off(status)];
    for (const filterIds of [[], [n.id], [n.id, status.id, 'unknown'], [n.id, status.id, n.id]]) {
      expect(previewQueryFilters(source, snapshot, filters, undefined, { mode: 'any', groups: [{ id: 'g', mode: 'all', filterIds }] }))
        .toEqual({ ok: false, code: 'invalidComposition' });
    }
    const many = Array.from({ length: MAX_QUERY_FILTERS }, (_, index) => ({ ...off(n), id: `f${index}`, value: String(index) }));
    const composition: QueryFilterComposition = { mode: 'any',
      groups: Array.from({ length: MAX_FILTER_GROUPS }, (_, index) => ({ id: `g${index}`, mode: 'any',
        filterIds: many.slice(index * 4, index * 4 + 4).map((filter) => filter.id) })) };
    expect(previewQueryFilters(source, snapshot, many, undefined, composition).ok).toBe(true);
    expect(previewQueryFilters(source, snapshot, [...many, { ...off(status), id: 'extra' }], undefined, composition))
      .toEqual({ ok: false, code: 'tooMany' });
    expect(previewQueryFilters(source, snapshot, many, undefined, { ...composition, groups: [...composition.groups, composition.groups[0]!] }))
      .toEqual({ ok: false, code: 'tooManyGroups' });
    expect(previewQueryFilters({ ...source, dsl: ' '.repeat(MAX_FILTER_DSL_BYTES) + '{}' }, snapshot, many, undefined, composition))
      .toEqual({ ok: false, code: 'tooLarge' });
  });
});

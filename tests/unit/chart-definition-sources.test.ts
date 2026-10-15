import { describe, expect, it } from 'vitest';
import { chartDefinitionFromResult, legacyChartDefinition } from '../../src/domain/chart-definition-sources';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { readAggregationPage } from '../../src/domain/query-aggregations';
import type { SavedChartDefinition } from '../../src/domain/saved-charts';

function fixture(definition: unknown, response: unknown, name = 'by_kind') {
  const dsl = JSON.stringify({ query: { term: { original: 'kept' } }, aggs: { [name]: definition } });
  const snapshot = createSnapshot({ ...createQuery('connection1'), index: 'events-*', dsl }, 'executed', new Date('2026-10-15T00:00:00Z'));
  const parsed = readAggregationPage(dsl, JSON.stringify({ aggregations: { [name]: response } }));
  if (!parsed.ok || !parsed.entries[0]) throw new Error('valid aggregation fixture');
  return { snapshot, entry: parsed.entries[0] };
}

function legacy(patch: Partial<SavedChartDefinition> = {}): SavedChartDefinition {
  return {
    id: 'legacy1', connectionId: 'connection1', name: 'Previous', index: 'events-*', chartType: 'bar',
    updatedAt: '2026-10-13T00:00:00Z',
    clauses: [{ id: 'clause1', name: 'by_kind', aggregationType: 'terms', field: 'kind', size: 23,
      subMetrics: [{ id: 'metric1', name: 'total', metricType: 'sum', field: 'amount' }] }],
    ...patch,
  };
}

describe('executed chart definition capture', () => {
  it('keeps escaped fields, metric fields and requested size instead of using response labels or bucket counts', () => {
    const f = fixture({ terms: { field: 'kind"\\name', size: 91 },
      aggs: { average: { avg: { field: 'actual_rating' } } } },
    { buckets: [{ key: 'only-returned-bucket', doc_count: 1, average: { value: 7 } }] });
    const source = chartDefinitionFromResult(f.snapshot, f.entry, 'average');
    expect(source).toMatchObject({
      connectionId: 'connection1', index: 'events-*', measure: 'average',
      draft: { group: { type: 'terms', field: 'kind"\\name', size: '91' },
        metrics: [{ name: 'average', type: 'avg', field: 'actual_rating' }] },
    });
    expect(JSON.stringify(source)).not.toContain('only-returned-bucket');
    expect(JSON.stringify(source)).not.toContain('actual_rating":7');
  });

  it('keeps the executed interval and time zone without inferring them from returned dates', () => {
    const f = fixture({ date_histogram: { field: 'time', fixed_interval: '3h', time_zone: '+08:00' } },
      { buckets: [{ key: 0, key_as_string: 'server text', doc_count: 1 }] }, 'per_interval');
    expect(chartDefinitionFromResult(f.snapshot, f.entry)).toMatchObject({
      measure: 'doc_count',
      draft: { group: { type: 'date_histogram', field: 'time', interval: 'fixed_interval', intervalValue: '3h', timeZone: '+08:00' } },
    });
  });

  it('captures a single metric by its actual source field', () => {
    const f = fixture({ cardinality: { field: 'user_id' } }, { value: 4 }, 'unique_users');
    expect(chartDefinitionFromResult(f.snapshot, f.entry)).toMatchObject({
      measure: 'unique_users', draft: { group: null, metrics: [{ name: 'unique_users', type: 'cardinality', field: 'user_id' }] },
    });
  });

  it.each([
    { terms: { field: 'kind', order: { _count: 'asc' } } },
    { date_histogram: { field: 'time', calendar_interval: '1d', min_doc_count: 0 } },
    { sum: { field: 'amount' }, meta: { unit: 'currency' } },
    { terms: { field: 'kind' }, aggs: { total: { sum: { field: 'amount' }, meta: { unit: 'currency' } } } },
  ])('refuses a definition whose options or metadata would be lost: %j', (definition) => {
    const f = fixture(definition, { value: 1, buckets: [{ key: 0, doc_count: 1, total: { value: 1 } }] });
    expect(chartDefinitionFromResult(f.snapshot, f.entry)).toBeNull();
  });

  it('refuses an entry from another definition or an unknown measure', () => {
    const f = fixture({ terms: { field: 'kind' } }, { buckets: [{ key: 'a', doc_count: 1 }] });
    expect(chartDefinitionFromResult(f.snapshot, { ...f.entry, rawDefinition: '{"terms":{"field":"other"}}' })).toBeNull();
    expect(chartDefinitionFromResult(f.snapshot, f.entry, 'unknown')).toBeNull();
    expect(chartDefinitionFromResult({ ...f.snapshot, rawDsl: '{"aggs":{},"aggregations":{}}' }, f.entry)).toBeNull();
  });
});

describe('previous chart library compatibility', () => {
  it('only returns a reuse copy and never changes the legacy definition', () => {
    const original = legacy({ preferredMetric: 'total' });
    const before = structuredClone(original);
    expect(legacyChartDefinition(original)).toMatchObject({
      id: 'legacy1', connectionId: 'connection1', index: 'events-*', measure: 'total',
      draft: { group: { type: 'terms', field: 'kind', size: '23' }, metrics: [{ name: 'total', type: 'sum', field: 'amount' }] },
    });
    expect(original).toEqual(before);
    expect(legacyChartDefinition(legacy({ preferredMetric: '_count' }))?.measure).toBe('doc_count');
  });

  it('preserves the old default interval and refuses unsupported options or mixed groups', () => {
    const dated = legacy({ clauses: [{ id: 'date1', name: 'per_day', aggregationType: 'date_histogram', field: 'time' }] });
    expect(legacyChartDefinition(dated)?.draft.group).toMatchObject({ interval: 'calendar_interval', intervalValue: '1d' });
    expect(legacyChartDefinition({ ...dated, clauses: [{ ...dated.clauses[0]!, minDocCount: 0 }] })).toBeNull();
    const original = legacy();
    expect(legacyChartDefinition({ ...original, clauses: [{ ...original.clauses[0]!, orderDirection: 'asc', orderMetric: '_count' }] })).toBeNull();
    expect(legacyChartDefinition({ ...original, clauses: [...original.clauses,
      { id: 'other', name: 'other', aggregationType: 'sum', field: 'amount' }] })).toBeNull();
  });

  it('does not invent connection ownership or silently accept an unavailable measure', () => {
    expect(legacyChartDefinition(legacy({ connectionId: null }))).toBeNull();
    expect(legacyChartDefinition(legacy({ preferredMetric: 'not-a-metric' }))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildAggregationDslObject,
  isFieldSuitableForAggregation,
  parseAggregationClausesFromDsl,
  previewAggregationDsl,
  suggestAggregationFieldList,
} from '../../src/domain/query-aggregation-builder';
import type { FieldCatalog } from '../../src/domain/resource';
import type { ChartAggregationClause } from '../../src/domain/saved-charts';

describe('query-aggregation-builder domain', () => {
  const sampleCatalog: FieldCatalog = {
    indices: ['logs-2026'],
    fields: [
      {
        name: 'status.keyword',
        conflict: false,
        types: [{
          type: 'keyword',
          searchable: true,
          aggregatable: true,
          metadata: false,
        }],
      },
      {
        name: 'response_time',
        conflict: false,
        types: [{
          type: 'float',
          searchable: true,
          aggregatable: true,
          metadata: false,
        }],
      },
      {
        name: '@timestamp',
        conflict: false,
        types: [{
          type: 'date',
          searchable: true,
          aggregatable: true,
          metadata: false,
        }],
      },
      {
        name: 'message',
        conflict: false,
        types: [{
          type: 'text',
          searchable: true,
          aggregatable: false,
          metadata: false,
        }],
      },
      {
        name: 'conflicted_field',
        conflict: true,
        types: [
          { type: 'long', searchable: true, aggregatable: true, metadata: false },
          { type: 'keyword', searchable: true, aggregatable: true, metadata: false },
        ],
      },
    ],
  };

  it('determines field suitability correctly based on field catalog', () => {
    // date_histogram
    expect(isFieldSuitableForAggregation('@timestamp', 'date_histogram', sampleCatalog).suitable).toBe(true);
    expect(isFieldSuitableForAggregation('response_time', 'date_histogram', sampleCatalog).suitable).toBe(false);

    // metric (sum / avg)
    expect(isFieldSuitableForAggregation('response_time', 'avg', sampleCatalog).suitable).toBe(true);
    expect(isFieldSuitableForAggregation('status.keyword', 'avg', sampleCatalog).suitable).toBe(false);

    // terms
    expect(isFieldSuitableForAggregation('status.keyword', 'terms', sampleCatalog).suitable).toBe(true);
    expect(isFieldSuitableForAggregation('message', 'terms', sampleCatalog).suitable).toBe(false);

    // conflicted field
    expect(isFieldSuitableForAggregation('conflicted_field', 'terms', sampleCatalog).suitable).toBe(false);

    // not reported field
    const unknown = isFieldSuitableForAggregation('unknown_field', 'terms', sampleCatalog);
    expect(unknown.suitable).toBe(true);
    expect(unknown.warning).toBe('fieldNotReported');
  });

  it('suggests aggregation field list sorted by suitability', () => {
    const dateFields = suggestAggregationFieldList('date_histogram', sampleCatalog);
    expect(dateFields[0]).toBe('@timestamp');

    const numFields = suggestAggregationFieldList('sum', sampleCatalog);
    expect(numFields[0]).toBe('response_time');
  });

  it('builds aggregation DSL object correctly', () => {
    const clauses: ChartAggregationClause[] = [
      {
        id: 'c1',
        name: 'avg_time',
        aggregationType: 'avg',
        field: 'response_time',
      },
      {
        id: 'c2',
        name: 'status_dist',
        aggregationType: 'terms',
        field: 'status.keyword',
        size: 5,
        orderMetric: '_count',
        orderDirection: 'desc',
        subMetrics: [
          {
            id: 'sm1',
            name: 'max_time',
            metricType: 'max',
            field: 'response_time',
          },
        ],
      },
      {
        id: 'c3',
        name: 'timeline',
        aggregationType: 'date_histogram',
        field: '@timestamp',
        intervalType: 'calendar',
        interval: '1d',
        minDocCount: 0,
      },
    ];

    const dslObj = buildAggregationDslObject(clauses);
    expect(dslObj.avg_time).toEqual({ avg: { field: 'response_time' } });
    expect(dslObj.status_dist).toEqual({
      terms: {
        field: 'status.keyword',
        size: 5,
        order: { _count: 'desc' },
      },
      aggs: {
        max_time: { max: { field: 'response_time' } },
      },
    });
    expect(dslObj.timeline).toEqual({
      date_histogram: {
        field: '@timestamp',
        calendar_interval: '1d',
        min_doc_count: 0,
      },
    });
  });

  it('parses aggregation clauses from existing DSL', () => {
    const sourceDsl = JSON.stringify({
      query: { match_all: {} },
      aggs: {
        total_count: { value_count: { field: 'id' } },
        top_hosts: {
          terms: { field: 'host.keyword', size: 10, order: { _key: 'asc' } },
          aggs: {
            avg_resp: { avg: { field: 'resp' } },
          },
        },
        over_time: {
          date_histogram: { field: '@timestamp', fixed_interval: '1h' },
        },
      },
    }, null, 2);

    const parsed = parseAggregationClausesFromDsl(sourceDsl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.clauses.length).toBe(3);
    expect(parsed.clauses[0]?.name).toBe('total_count');
    expect(parsed.clauses[0]?.aggregationType).toBe('value_count');

    expect(parsed.clauses[1]?.name).toBe('top_hosts');
    expect(parsed.clauses[1]?.aggregationType).toBe('terms');
    expect(parsed.clauses[1]?.size).toBe(10);
    expect(parsed.clauses[1]?.subMetrics?.length).toBe(1);
    expect(parsed.clauses[1]?.subMetrics?.[0]?.name).toBe('avg_resp');

    expect(parsed.clauses[2]?.name).toBe('over_time');
    expect(parsed.clauses[2]?.aggregationType).toBe('date_histogram');
    expect(parsed.clauses[2]?.intervalType).toBe('fixed');
    expect(parsed.clauses[2]?.interval).toBe('1h');
  });

  it('previews and applies aggregation DSL edit preserving other query properties', () => {
    const originalDsl = `{
  "query": {
    "match": { "status": "200" }
  },
  "size": 50,
  "sort": [{ "@timestamp": "desc" }]
}`;

    const clauses: ChartAggregationClause[] = [
      {
        id: 'c1',
        name: 'status_terms',
        aggregationType: 'terms',
        field: 'status.keyword',
        size: 10,
      },
    ];

    const preview = previewAggregationDsl(originalDsl, clauses);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.changed).toBe(true);
    expect(preview.dsl).toContain('"aggs"');
    expect(preview.dsl).toContain('"status_terms"');
    // Ensure query and sort are untouched
    expect(preview.dsl).toContain('"status": "200"');
    expect(preview.dsl).toContain('"size": 50');
    expect(preview.dsl).toContain('"@timestamp": "desc"');

    // Applying empty clauses removes aggs
    const previewRemove = previewAggregationDsl(preview.dsl, []);
    expect(previewRemove.ok).toBe(true);
    if (!previewRemove.ok) return;
    expect(previewRemove.changed).toBe(true);
    expect(previewRemove.dsl).not.toContain('"aggs"');
    expect(previewRemove.dsl).toContain('"status": "200"');
  });

  it('rejects invalid or too large DSL in preview', () => {
    expect(previewAggregationDsl('not json', []).ok).toBe(false);
  });
});

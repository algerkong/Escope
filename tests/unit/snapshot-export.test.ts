import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOT_EXPORT_BYTES, MAX_SNAPSHOT_EXPORT_DSL_BYTES, MAX_SNAPSHOT_EXPORT_ROWS,
  prepareSnapshotExportDsl, validSnapshotExportFileName, validSnapshotExportRequest,
  type SnapshotExportRequest,
} from '../../src/domain/query-export';
import { enQueryExport, zhQueryExport } from '../../src/locales/query-export';
import fixture from '../fixtures/query-export-v1.json';

const request = fixture.request as SnapshotExportRequest;

describe('full snapshot export preparation', () => {
  it('changes only paging controls and retains exact numeric and escape tokens', () => {
    const original = '{"query":{"range":{"n":{"gte":9007199254740993,"lt":1.234567890123456789}}},'
      + '"min_score":-0,"size":25,"_source":["n","\\u0061"],"track_total_hits":false}';
    const result = prepareSnapshotExportDsl(original, 17);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rawDsl).toContain('"gte":9007199254740993');
    expect(result.rawDsl).toContain('"lt":1.234567890123456789');
    expect(result.rawDsl).toContain('"min_score": -0');
    expect(result.rawDsl).toContain('"\\u0061"');
    expect(result.rawDsl).toContain('"track_total_hits": false');
    expect(result.rawDsl).toContain('"size": 17');
    expect(result.rawDsl).toContain('"sort": ["_shard_doc"]');
    expect(original).toContain('"size":25');
  });

  it.each([
    ['"price"', '["price", "_shard_doc"]'],
    ['{"price":"desc"}', '[{"price":"desc"}, "_shard_doc"]'],
    ['["price",{"_shard_doc":"desc"}]', '["price", {"_shard_doc":"desc"}]'],
    ['["_shard_doc"]', '["_shard_doc"]'],
  ])('preserves the explicit sort %s and adds only a missing tie-breaker', (sort, expected) => {
    const result = prepareSnapshotExportDsl(`{"sort":${sort},"from":0,"_source":false,"fields":["*"]}`, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rawDsl).toContain(`"sort": ${expected}`);
    expect(result.rawDsl).toContain('"from": 0');
    expect(result.rawDsl).toContain('"_source": false');
  });

  it.each([
    '{"size":0}', '{"from":1}', '{"from":-1}', '{"from":0.0}', '{"size":"20"}',
    '{"collapse":{"field":"n"}}', '{"aggs":{}}', '{"pit":{"id":"ui-pit"}}', '{"search_after":[1]}',
    '{"terminate_after":10}', '{"runtime_mappings":{}}', '{"slice":{"id":0,"max":2}}',
    '{"retriever":{}}', '{"sort":[]}', '{"sort":null}', '{"sort":["_shard_doc","n"]}',
    '{"sort":[{"_shard_doc":{"order":"asc"}}]}', '{"unknown":true}',
    '{"sort":[{"date":{"format":"dd/MM/yyyy"}}]}', '{"sort":[1]}', '{"sort":[{"a":"asc","b":"desc"}]}',
  ])('refuses unsupported scan semantics without discarding fields: %s', (dsl) => {
    expect(prepareSnapshotExportDsl(dsl, 100)).toEqual({ ok: false, code: 'unsupportedDsl' });
  });

  it.each([
    '{"query":{"range":{"time":{"gte":"now-1d/d"}}}}',
    '{"query":{"query_string":{"query":"time:[now-1h TO now]"}}}',
    '{"query":{"query_string":{"query":"time:[2026-01-01 TO now]"}}}',
    '{"query":{"term":{"time":"now"}}}',
    '{"query":{"script":{"script":"x"}}}',
    '{"query":{"function_score":{"random_score":{"seed":10}}}}',
    '{"query":{"function_score":{"gauss":{"time":{"scale":"7d"}}}}}',
    '{"query":{"terms_set":{"n":{"terms":["a"],"minimum_should_match_script":{"source":"x"}}}}}',
    '{"query":{"terms":{"n":{"index":"other","id":"1","path":"values"}}}}',
    '{"query":{"geo_shape":{"shape":{"indexed_shape":{"index":"other","id":"1","path":"shape"}}}}}',
    '{"query":{"percolate":{"field":"query","index":"other","id":"1"}}}',
    '{"query":{"more_like_this":{"fields":["text"],"like":[{"_index":"other","_id":"1"}]}}}',
  ])('refuses moving time or scripted/random membership: %s', (dsl) => {
    expect(prepareSnapshotExportDsl(dsl, 100)).toEqual({ ok: false, code: 'unstableDsl' });
  });

  it('does not confuse ordinary text containing now with date math', () => {
    expect(prepareSnapshotExportDsl('{"query":{"term":{"name":"snowfall knowledge nowish"}}}', 1).ok).toBe(true);
  });

  it.each(['', '[]', '{', '{"query":{},"query":{}}', '{"size":1,"\\u0073ize":2}', '{"query":{"term":{"a":1,"a":2}}}'])(
    'rejects invalid JSON and decoded duplicate keys: %s', (dsl) => {
      expect(prepareSnapshotExportDsl(dsl, 1)).toEqual({ ok: false, code: 'invalidDsl' });
    },
  );

  it('bounds body bytes, depth, batch size and sort width', () => {
    expect(prepareSnapshotExportDsl(`{"query":"${'x'.repeat(MAX_SNAPSHOT_EXPORT_DSL_BYTES)}"}`, 1).ok).toBe(false);
    const deeplyNested = `{"query":${'{"x":'.repeat(65)}1${'}'.repeat(65)}}`;
    expect(prepareSnapshotExportDsl(deeplyNested, 1).ok).toBe(false);
    for (const size of [0, -1, 1.5, 1001, Infinity, NaN]) {
      expect(prepareSnapshotExportDsl('{}', size)).toEqual({ ok: false, code: 'invalidPageSize' });
    }
    const sorts = Array.from({ length: 16 }, (_, index) => `"field${index}"`).join(',');
    expect(prepareSnapshotExportDsl(`{"sort":[${sorts}]}`, 1).ok).toBe(false);
  });

  it('accepts the shared final-body contract and rejects unreviewed or oversized options', () => {
    expect(validSnapshotExportRequest(request)).toBe(true);
    expect(request.rawDsl).toContain('9007199254740993');
    for (const patch of [
      { requestId: 'not-a-request' }, { connectionId: '' }, { maxRows: 0 }, { maxRows: MAX_SNAPSHOT_EXPORT_ROWS + 1 },
      { maxBytes: MAX_SNAPSHOT_EXPORT_BYTES + 1 }, { maxBytes: NaN }, { maxRows: 10.5 }, { expectedEndpoint: '' },
      { rawDsl: '{}' }, { rawDsl: '{"size":1,"sort":"_shard_doc"}' }, { rawDsl: '{"size":1,"sort":["n"]}' },
      { rawDsl: ' '.repeat(MAX_SNAPSHOT_EXPORT_DSL_BYTES + 1) },
      { rawDsl: '{"size":1,"sort":["_shard_doc"],"pit":{"id":"existing"}}' },
    ]) expect(validSnapshotExportRequest({ ...request, ...patch })).toBe(false);
  });

  it('keeps file suggestions path-free and format-specific', () => {
    expect(validSnapshotExportFileName('escope-orders.jsonl', 'jsonl')).toBe(true);
    expect(validSnapshotExportFileName('escope-orders.CSV', 'csv')).toBe(true);
    for (const name of ['x.jsonl', '../x.csv', 'C:\\x.csv', '.csv', 'NUL.csv', 'lpt1.data.csv', 'x\r.csv', 'x\u0085.csv', ' x.csv', `${'n'.repeat(129)}.csv`]) {
      expect(validSnapshotExportFileName(name, 'csv')).toBe(false);
    }
  });

  it('keeps every safety, outcome and control label bilingual', () => {
    expect(Object.keys(enQueryExport).sort()).toEqual(Object.keys(zhQueryExport).sort());
    expect(Object.values(enQueryExport).every((value) => value.trim() !== '')).toBe(true);
    expect(Object.values(zhQueryExport).every((value) => value.trim() !== '')).toBe(true);
  });
});

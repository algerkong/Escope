import { describe, expect, it } from 'vitest';
import { isIncomplete, parseQueryResult, sliceRaw } from '../../src/domain/query-result';

/** Built as text so the unsafe integer never passes through `JSON.parse`. */
const response = `{
  "took": 7,
  "timed_out": false,
  "_shards": {
    "total": 5, "successful": 4, "skipped": 0, "failed": 1,
    "failures": [ { "shard": 2, "_index": "orders-1", "reason": { "type": "search_phase_execution_exception", "reason": "shard failed" } } ]
  },
  "hits": {
    "total": { "value": 9007199254740993, "relation": "gte" },
    "max_score": null,
    "hits": [
      { "_index": "orders-1", "_id": "a", "_score": null,
        "_source": { "id": 9007199254740993, "price": 1.1000000000000001, "nested": { "a": 1 }, "tags": ["x", "y"] } },
      { "_index": "orders-1", "_id": "b", "fields": { "amount": [12.5] } }
    ]
  }
}`;

describe('lossless _search response parsing', () => {
  it('keeps verbatim numbers, hit count relation and shard failures', () => {
    const parsed = parseQueryResult(response);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { summary } = parsed;
    expect(summary.tookMs).toBe(7);
    expect(summary.timedOut).toBe(false);
    expect(summary.totals).toEqual({ text: '9007199254740993', relation: 'gte' });
    expect(summary.maxScore).toBe('null');
    expect(summary.shards).toMatchObject({ total: 5, successful: 4, skipped: 0, failed: 1 });
    expect(summary.shards.failures).toEqual([{ index: 'orders-1', shard: 2, reason: 'shard failed' }]);
    expect(isIncomplete(summary, false)).toBe(true);
  });

  it('never re-serializes a data value into the table preview', () => {
    const parsed = parseQueryResult(response);
    if (!parsed.ok) throw new Error('expected a parsed response');
    const [first, second] = parsed.summary.hits;
    expect(first?.id).toBe('a');
    expect(first?.index).toBe('orders-1');
    expect(first?.score).toBe('null');
    expect(first?.hasSource).toBe(true);
    expect(first?.columns).toEqual([
      { name: 'id', preview: '9007199254740993', nested: false },
      { name: 'price', preview: '1.1000000000000001', nested: false },
      { name: 'nested', preview: '{ "a": 1 }', nested: true },
      { name: 'tags', preview: '["x", "y"]', nested: true },
    ]);
    expect(second?.hasSource).toBe(false);
    expect(second?.source).toBeNull();
    expect(second?.columns).toEqual([{ name: 'amount', preview: '[12.5]', nested: true }]);
  });

  it('slices the verbatim document source for the detail view', () => {
    const parsed = parseQueryResult(response);
    if (!parsed.ok) throw new Error('expected a parsed response');
    const source = parsed.summary.hits[0]?.source;
    expect(source).not.toBeNull();
    expect(sliceRaw(response, source!)).toBe('{ "id": 9007199254740993, "price": 1.1000000000000001, "nested": { "a": 1 }, "tags": ["x", "y"] }');
  });

  it('reads a bare numeric total as an exact count', () => {
    const parsed = parseQueryResult('{"hits":{"total":42,"hits":[]}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary.totals).toEqual({ text: '42', relation: 'eq' });
    expect(parsed.summary.tookMs).toBeNull();
    expect(parsed.summary.hits).toEqual([]);
  });

  it.each(['not json', '[]', '{"took":1}', '{"hits":3}', ''])('rejects a body without hits (%s)', (raw) => {
    expect(parseQueryResult(raw)).toEqual({ ok: false, code: 'invalidResponse' });
  });

  it.each([
    ['duplicate keys', '{"hits":{"total":1,"total":2,"hits":[]}}'],
    ['comments', '{"hits":{"hits":[]}} // trailing'],
    ['non-array hits', '{"hits":{"hits":{}}}'],
    ['non-object hit', '{"hits":{"hits":[3]}}'],
    ['non-boolean timed_out', '{"timed_out":"no","hits":{"hits":[]}}'],
    ['non-object shards', '{"_shards":3,"hits":{"hits":[]}}'],
    ['negative shard count', '{"_shards":{"failed":-1},"hits":{"hits":[]}}'],
    ['fractional shard count', '{"_shards":{"failed":1.5},"hits":{"hits":[]}}'],
    ['fractional took', '{"took":1.5,"hits":{"hits":[]}}'],
    ['negative total', '{"hits":{"total":{"value":-1,"relation":"eq"},"hits":[]}}'],
    ['non-integer total', '{"hits":{"total":{"value":1.5,"relation":"eq"},"hits":[]}}'],
    ['unknown total relation', '{"hits":{"total":{"value":1,"relation":"approx"},"hits":[]}}'],
    ['total without relation', '{"hits":{"total":{"value":1},"hits":[]}}'],
    ['non-boolean terminated_early', '{"terminated_early":"yes","hits":{"hits":[]}}'],
  ])('rejects a malformed %s instead of reporting success', (_name, raw) => {
    expect(parseQueryResult(raw)).toEqual({ ok: false, code: 'invalidResponse' });
  });

  it('treats terminated early and unreported shard failures as incomplete', () => {
    const terminated = parseQueryResult('{"terminated_early":true,"_shards":{"failed":0},"hits":{"total":{"value":5,"relation":"gte"},"hits":[]}}');
    if (!terminated.ok) throw new Error('expected a parsed response');
    expect(terminated.summary.terminatedEarly).toBe(true);
    expect(isIncomplete(terminated.summary, false)).toBe(true);
    const unknownShards = parseQueryResult('{"hits":{"total":{"value":1,"relation":"eq"},"hits":[]}}');
    if (!unknownShards.ok) throw new Error('expected a parsed response');
    expect(unknownShards.summary.shards.failed).toBeNull();
    expect(isIncomplete(unknownShards.summary, false)).toBe(true);
  });

  it('only treats backend partial, timeout or failed shards as incomplete', () => {
    const parsed = parseQueryResult('{"hits":{"total":1,"hits":[]},"_shards":{"total":1,"successful":1,"failed":0}}');
    if (!parsed.ok) throw new Error('expected a parsed response');
    expect(isIncomplete(parsed.summary, false)).toBe(false);
    expect(isIncomplete(parsed.summary, true)).toBe(true);
  });
});

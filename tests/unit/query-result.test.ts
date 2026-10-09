import { describe, expect, it } from 'vitest';
import { formatRawJson, isIncomplete, MAX_PIT_ID_LENGTH, parseQueryResult, sliceRaw } from '../../src/domain/query-result';

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
    expect(first?.columns.map(({ name, preview, nested }) => ({ name, preview, nested }))).toEqual([
      { name: 'id', preview: '9007199254740993', nested: false },
      { name: 'price', preview: '1.1000000000000001', nested: false },
      { name: 'nested', preview: '{"a":1}', nested: true },
      { name: 'tags', preview: '["x","y"]', nested: true },
    ]);
    expect(second?.hasSource).toBe(false);
    expect(second?.source).toBeNull();
    expect(second?.columns.map(({ name, preview, nested }) => ({ name, preview, nested }))).toEqual([{ name: 'amount', preview: '[12.5]', nested: true }]);
  });

  it('keeps whitespace inside nested strings and discovers every source column', () => {
    const properties = Array.from({ length: 40 }, (_, index) => `"field_${index}":${index}`).join(',');
    const parsed = parseQueryResult(`{"hits":{"hits":[{"_source":{${properties},"nested":{"value":"a  b\\t c","n":9007199254740993}}}]}}`);
    if (!parsed.ok) throw new Error('expected a parsed response');
    expect(parsed.summary.hits[0]?.columns).toHaveLength(41);
    expect(parsed.summary.hits[0]?.columns.at(-1)?.preview).toBe('{"value":"a  b\\t c","n":9007199254740993}');
  });

  it('indents JSON with whitespace edits only and leaves malformed responses untouched', () => {
    const raw = '{"n":9007199254740993,"price":1.1000000000000000001,"exponent":1E+400,"text":"a  b","escape":"\\u0061"}';
    expect(formatRawJson(raw)).toBe('{\n  "n": 9007199254740993,\n  "price": 1.1000000000000000001,\n  "exponent": 1E+400,\n  "text": "a  b",\n  "escape": "\\u0061"\n}');
    expect(formatRawJson('[1,9007199254740993]')).toBe('[\n  1,\n  9007199254740993\n]');
    expect(formatRawJson('{"n": 1,')).toBe('{"n": 1,');
    expect(formatRawJson('{"n":1,"n":2}')).toBe('{"n":1,"n":2}');
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

describe('snapshot continuation parsing', () => {
  it('accepts multi-index PIT ids up to the same 64 KiB bound as Rust', () => {
    for (const length of [608, MAX_PIT_ID_LENGTH]) {
      const parsed = parseQueryResult(`{"pit_id":"${'p'.repeat(length)}","hits":{"hits":[]}}`);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.summary.pitId).toHaveLength(length);
    }
    expect(parseQueryResult(`{"pit_id":"${'p'.repeat(MAX_PIT_ID_LENGTH + 1)}","hits":{"hits":[]}}`).ok).toBe(false);
  });
  it('reads the snapshot id and per-hit sort cursors verbatim', () => {
    const withPit = `{
      "pit_id": "pit-abc-123",
      "took": 1, "timed_out": false,
      "_shards": { "total": 1, "successful": 1, "failed": 0 },
      "hits": { "total": { "value": 2, "relation": "eq" }, "hits": [
        { "_index": "orders-1", "_id": "a", "_source": { "n": 1 }, "sort": [9007199254740993, "tie"] },
        { "_index": "orders-1", "_id": "b", "_source": { "n": 2 }, "sort": [1.1000000000000000001] }
      ] }
    }`;
    const parsed = parseQueryResult(withPit);
    if (!parsed.ok) throw new Error('expected a parsed response');
    expect(parsed.summary.pitId).toBe('pit-abc-123');
    const [first, second] = parsed.summary.hits;
    expect(first?.sort).not.toBeNull();
    expect(sliceRaw(withPit, first!.sort!)).toBe('[9007199254740993, "tie"]');
    expect(sliceRaw(withPit, second!.sort!)).toBe('[1.1000000000000000001]');
  });

  it('stays null without a snapshot and rejects an unusable snapshot id', () => {
    const plain = '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},'
      + '"hits":{"hits":[{"_index":"i","_id":"x","_source":{}}]}}';
    const parsed = parseQueryResult(plain);
    if (!parsed.ok) throw new Error('expected a parsed response');
    expect(parsed.summary.pitId).toBeNull();
    expect(parsed.summary.hits[0]?.sort).toBeNull();
    // A present but unusable id rejects the body: it would be used verbatim in the next request.
    for (const pit of ['42', '""', '"pit with space"']) {
      const raw = `{"pit_id": ${pit}, "took":1, "timed_out":false, "_shards":{"total":1,"successful":1,"failed":0}, "hits":{"hits":[]}}`;
      expect(parseQueryResult(raw).ok, pit).toBe(false);
    }
  });
});

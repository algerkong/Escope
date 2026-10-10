import { describe, expect, it } from 'vitest';
import {
  AGGREGATION_LIMITS, readAggregationPage, type AggregationResult,
} from '../../src/domain/query-aggregations';

function read(definitions: string, aggregations: string | undefined, extraDsl = '', extraResponse = '') {
  return readAggregationPage(
    `{"aggs":${definitions}${extraDsl}}`,
    `{${aggregations === undefined ? '' : `"aggregations":${aggregations},`}"hits":{"hits":[]},`
      + `"_shards":{"total":1,"successful":1,"failed":0},"timed_out":false${extraResponse}}`,
  );
}

function entries(definitions: string, aggregations: string) {
  const result = read(definitions, aggregations);
  if (!result.ok) throw new Error(result.code);
  return result.entries;
}

function buckets(result: AggregationResult | undefined) {
  if (result?.status !== 'buckets') throw new Error('buckets fixture required');
  return result;
}

function metric(result: AggregationResult | undefined) {
  if (result?.status !== 'metric') throw new Error('metric fixture required');
  return result.metric;
}

describe('lossless aggregation metrics', () => {
  it.each(['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'])('reads an executed %s without decoding its numeric token', (type) => {
    const result = entries(`{"n":{"${type}":{"field":"amount"}}}`, '{"n":{"value":9007199254740993,"value_as_string":"9.007e15"}}');
    expect(metric(result[0])).toEqual({
      name: 'n', type, value: { kind: 'number', raw: '9007199254740993' },
      valueAsString: { kind: 'string', raw: '"9.007e15"' },
    });
    expect(result[0]?.rawDefinition).toBe(`{"${type}":{"field":"amount"}}`);
    expect(result[0]?.rawResponse).toBe('{"value":9007199254740993,"value_as_string":"9.007e15"}');
  });

  it.each(['0', '-0', '1.0000000000000000001', '-3.400e-23', '1E+999'])('retains %s without rounding or normalization', (raw) => {
    expect(metric(entries('{"n":{"sum":{}}}', `{"n":{"value":${raw}}}`)[0]).value.raw).toBe(raw);
  });

  it('distinguishes missing aggregation, missing value, null and zero', () => {
    const result = entries('{"a":{"avg":{}},"b":{"avg":{}},"c":{"avg":{}},"d":{"sum":{}}}',
      '{"b":{},"c":{"value":null},"d":{"value":0}}');
    expect(result[0]).toMatchObject({ name: 'a', status: 'missing', rawResponse: null });
    expect(metric(result[1]).value).toEqual({ kind: 'missing', raw: null });
    expect(metric(result[2]).value).toEqual({ kind: 'null', raw: 'null' });
    expect(metric(result[3]).value).toEqual({ kind: 'number', raw: '0' });
  });

  it('preserves escaped names, formatted strings and request metadata literally', () => {
    const result = entries('{"\\u006e":{"sum":{"field":"amount"},"meta":{"label":"<img src=x>"}}}',
      '{"n":{"value":1,"value_as_string":"\\u0031","meta":{"label":"<script>"}}}');
    expect(result[0]?.name).toBe('n');
    expect(metric(result[0]).valueAsString.raw).toBe('"\\u0031"');
    expect(result[0]?.rawDefinition).toContain('<img src=x>');
    expect(result[0]?.rawResponse).toContain('<script>');
  });

  it.each(['value_count', 'cardinality'])('does not publish negative/fractional %s counts', (type) => {
    for (const raw of ['-1', '1.5', '1e3']) {
      expect(entries(`{"n":{"${type}":{}}}`, `{"n":{"value":${raw}}}`)[0]?.status).toBe('invalid');
    }
    expect(metric(entries(`{"n":{"${type}":{}}}`, '{"n":{"value":null}}')[0]).value.kind).toBe('null');
  });

  it.each(['null', '[]', '1', '{"value":"1"}', '{"value":{}}', '{"value":[]}',
    '{"value":true}', '{"value":1,"value_as_string":null}', '{"value":1,"unexpected":2}'])(
    'does not turn a mismatched metric response %s into a value', (response) => {
      const [result] = entries('{"n":{"avg":{}}}', `{"n":${response}}`);
      expect(result).toMatchObject({ status: 'invalid', rawResponse: response });
    },
  );
});

describe('single-level aggregation buckets', () => {
  it('reads terms with direct metrics, precise counts, errors and unreturned counts without summing', () => {
    const [result] = entries('{"groups":{"terms":{"field":"group","size":2,"order":{"_count":"desc"}},'
      + '"aggs":{"n":{"sum":{"field":"n"}},"unique":{"cardinality":{"field":"id"}}}}}',
    '{"groups":{"doc_count_error_upper_bound":9007199254740993,"sum_other_doc_count":9007199254740994,'
      + '"buckets":[{"key":"\\u0061","doc_count":9007199254740993,"doc_count_error_upper_bound":-1,'
      + '"n":{"value":1.000000000000000001},"unique":{"value":4}},'
      + '{"key":false,"doc_count":0,"n":{"value":null}}]}}');
    const group = buckets(result);
    expect(group.buckets).toHaveLength(2);
    expect(group.docCountError.raw).toBe('9007199254740993');
    expect(group.sumOtherDocCount.raw).toBe('9007199254740994');
    expect(group.options).toContainEqual({ name: 'order', raw: '{"_count":"desc"}' });
    expect(group.buckets[0]).toMatchObject({
      key: { kind: 'string', raw: '"\\u0061"' }, docCount: { kind: 'number', raw: '9007199254740993' },
      docCountError: { kind: 'number', raw: '-1' },
    });
    expect(group.buckets[0]?.metrics[0]?.value.raw).toBe('1.000000000000000001');
    expect(group.buckets[1]?.metrics[1]?.value).toEqual({ kind: 'missing', raw: null });
    expect(group.buckets[1]?.docCountError).toEqual({ kind: 'missing', raw: null });
    expect(group.buckets[0]?.raw).toContain('"key":"\\u0061"');
  });

  it('keeps date histogram starts, calendar zone/offset and bounds without inventing bucket ends or filling gaps', () => {
    const group = buckets(entries('{"days":{"date_histogram":{"field":"at","calendar_interval":"day",'
      + '"time_zone":"America/New_York","offset":"+6h","min_doc_count":0,'
      + '"extended_bounds":{"min":"2026-03-07","max":"2026-03-10"}}}}',
    '{"days":{"buckets":[{"key":-86400000,"key_as_string":"1969-12-31","doc_count":0},'
      + '{"key":1773036000000,"doc_count":2}]}}')[0]);
    expect(group.buckets.map((bucket) => bucket.key.raw)).toEqual(['-86400000', '1773036000000']);
    expect(group.buckets).toHaveLength(2);
    expect(group.buckets[0]?.keyAsString.raw).toBe('"1969-12-31"');
    expect(group.buckets[1]?.keyAsString.kind).toBe('missing');
    expect(group.options).toContainEqual({ name: 'time_zone', raw: '"America/New_York"' });
    expect(group.options).toContainEqual({ name: 'extended_bounds', raw: '{"min":"2026-03-07","max":"2026-03-10"}' });
    expect(JSON.stringify(group)).not.toContain('"end"');
  });

  it('keeps explicit keyed date-histogram member names separate from returned numeric keys', () => {
    const group = buckets(entries('{"days":{"date_histogram":{"field":"at","fixed_interval":"1h","keyed":true}}}',
      '{"days":{"buckets":{"literal-label":{"key":0,"key_as_string":"1970","doc_count":1},'
        + '"other":{"key":7200000,"doc_count":3}}}}')[0]);
    expect(group.buckets.map(({ member, key }) => [member, key.raw])).toEqual([['literal-label', '0'], ['other', '7200000']]);
  });

  it.each([
    ['terms', '{}', '{"buckets":{}}'],
    ['terms', '{}', '{"buckets":null}'],
    ['date_histogram', '{"keyed":true}', '{"buckets":[]}'],
    ['date_histogram', '{}', '{"buckets":{}}'],
    ['date_histogram', '{}', '{"buckets":[{"key":"1970","doc_count":1}]}'],
    ['date_histogram', '{}', '{"buckets":[{"key":1.5,"doc_count":1}]}'],
  ])('does not infer mismatched bucket layouts (%s %s %s)', (type, options, response) => {
    expect(entries(`{"a":{"${type}":${options}}}`, `{"a":${response}}`)[0]?.status).toBe('invalid');
  });

  it.each(['-2', '0.5', '1e3', '"1"', 'null', 'true'])('rejects malformed counts %s without dropping a bucket', (count) => {
    const [entry] = entries('{"a":{"terms":{}}}', `{"a":{"buckets":[{"key":"a","doc_count":1},{"key":"b","doc_count":${count}}]}}`);
    expect(entry?.status).toBe('invalid');
    expect(entry?.rawResponse).toContain('"key":"a"');
    expect(entry?.rawResponse).toContain('"key":"b"');
    expect(entry).not.toHaveProperty('buckets');
  });

  it('does not fill missing counts or error reports with zero', () => {
    const group = buckets(entries('{"a":{"terms":{}}}', '{"a":{"buckets":[{"key":9007199254740993}]}}')[0]);
    expect(group.buckets[0]?.key.raw).toBe('9007199254740993');
    expect(group.buckets[0]?.docCount.kind).toBe('missing');
    expect(group.docCountError.kind).toBe('missing');
    expect(group.sumOtherDocCount.kind).toBe('missing');
  });

  it('keeps zero buckets distinct from a missing bucket array or aggregation', () => {
    expect(buckets(entries('{"a":{"terms":{}}}', '{"a":{"buckets":[]}}')[0]).buckets).toEqual([]);
    expect(entries('{"a":{"terms":{}}}', '{"a":{}}')[0]?.status).toBe('invalid');
    expect(entries('{"a":{"terms":{}}}', '{}')[0]?.status).toBe('missing');
  });

  it.each(['-2', 'null', '"-1"', '1.5'])('rejects invalid reported error bounds %s', (error) => {
    expect(entries('{"a":{"terms":{}}}', `{"a":{"doc_count_error_upper_bound":${error},"buckets":[]}}`)[0]?.status).toBe('invalid');
    expect(entries('{"a":{"terms":{}}}', `{"a":{"buckets":[{"key":"x","doc_count_error_upper_bound":${error}}]}}`)[0]?.status).toBe('invalid');
  });

  it('does not silently omit unexpected fields or unsupported child responses', () => {
    expect(entries('{"a":{"terms":{}}}', '{"a":{"buckets":[{"key":"a","count_extra":1}]}}')[0]?.status).toBe('invalid');
    expect(entries('{"a":{"terms":{},"aggs":{"n":{"sum":{}}}}}',
      '{"a":{"buckets":[{"key":"a","n":{"values":[1,2]}}]}}')[0]?.status).toBe('invalid');
  });
});

describe('aggregation provenance and unsupported shapes', () => {
  it('uses the execution definition, not a value/buckets response heuristic or typed-key guessing', () => {
    const result = entries('{"known":{"sum":{}}}', '{"avg#known":{"value":3},"known":{"value":4},"mystery":{"value":5},"buckets":{"buckets":[]}}');
    expect(result.map(({ name, status }) => [name, status])).toEqual([
      ['known', 'metric'], ['avg#known', 'unrequested'], ['mystery', 'unrequested'], ['buckets', 'unrequested'],
    ]);
    expect(result[1]?.rawDefinition).toBeNull();
  });

  it.each([
    '{"percentiles":{"field":"x"}}', '{"stats":{"field":"x"}}', '{"scripted_metric":{}}',
    '{"derivative":{"buckets_path":"x"}}', '{"global":{},"aggs":{"n":{"sum":{}}}}',
    '{"terms":{},"aggs":{"child":{"terms":{}}}}', '{"terms":{},"aggs":{"p":{"percentiles":{}}}}',
    '{"avg":{},"aggs":{"n":{"sum":{}}}}', '{"sum":{},"avg":{}}', '{"terms":{},"unknown":{}}',
    '{"terms":{},"aggs":{},"aggregations":{}}', '{"terms":{"keyed":true}}', '[]', 'null',
  ])('preserves unsupported definition %s and its raw response intact', (definition) => {
    const [result] = entries(`{"a":${definition}}`, '{"a":{"value":1,"buckets":[]}}');
    expect(result).toMatchObject({ status: 'unsupported', rawDefinition: definition, rawResponse: '{"value":1,"buckets":[]}' });
  });

  it('accepts the long aggregation alias in the DSL and direct metric children', () => {
    const result = readAggregationPage('{"aggregations":{"a":{"terms":{},"aggregations":{"n":{"sum":{}}}}}}',
      '{"aggregations":{"a":{"buckets":[{"key":"x","n":{"value":9}}]}}}');
    if (!result.ok) throw new Error(result.code);
    expect(buckets(result.entries[0]).buckets[0]?.metrics[0]?.value.raw).toBe('9');
  });

  it('reports absent and empty aggregation containers without inventing definitions', () => {
    const missing = readAggregationPage('{}', '{"hits":{"hits":[]}}');
    const empty = readAggregationPage('{}', '{"aggregations":{}}');
    expect(missing).toMatchObject({ ok: true, responseState: 'missing', entries: [] });
    expect(empty).toMatchObject({ ok: true, responseState: 'empty', entries: [] });
  });

  it('never combines reports from separate pages or uses hit counts as aggregation counts', () => {
    const dsl = '{"size":1,"sort":["_doc"],"aggs":{"n":{"sum":{}}}}';
    const first = readAggregationPage(dsl, '{"hits":{"total":999,"hits":[]},"aggregations":{"n":{"value":3}}}');
    const second = readAggregationPage(dsl, '{"hits":{"total":999,"hits":[]},"aggregations":{"n":{"value":4}}}');
    if (!first.ok || !second.ok) throw new Error('valid fixture');
    expect(metric(first.entries[0]).value.raw).toBe('3');
    expect(metric(second.entries[0]).value.raw).toBe('4');
    expect(JSON.stringify([first, second])).not.toContain('999');
  });

  it('preserves partial/search-scope/runtime/post-filter caveats independently of hit totals', () => {
    const result = readAggregationPage('{"aggs":{},"post_filter":{"term":{"x":"y"}},'
      + '"runtime_mappings":{},"knn":{},"terminate_after":1}',
    '{"timed_out":true,"terminated_early":true,"_shards":{"failed":1,"failures":[{}]},'
      + '"_clusters":{"skipped":1},"aggregations":{}}');
    expect(result).toMatchObject({ ok: true, notices: [
      'postFilter', 'runtime', 'searchScope', 'timedOut', 'terminatedEarly', 'shardFailures', 'clusterReport',
    ] });
    expect(readAggregationPage('{}', '{}')).toMatchObject({ ok: true, notices: ['unknownShards'] });
  });

  it('warns about known inline aggregation scripts without publishing script text in derived values', () => {
    for (const definition of [
      '{"a":{"avg":{"script":{"source":"_value * 2"}}}}',
      '{"a":{"terms":{"script":{"source":"emit(1)"}}}}',
      '{"a":{"terms":{},"aggs":{"n":{"avg":{"script":{"source":"_value * 2"}}}}}}',
    ]) {
      expect(read(definition, '{}')).toMatchObject({ ok: true, notices: ['script'] });
    }
    expect(read('{"a":{"terms":{"field":"script"}}}', '{}')).toMatchObject({ ok: true, notices: [] });
  });

  it('uses exact decoded names without treating prototype keys as object properties or identity aliases', () => {
    const result = entries('{"__proto__":{"sum":{}},"constructor":{"avg":{}}}', '{"__proto__":{"value":3},"constructor":{"value":4}}');
    expect(result.map((result) => metric(result).value.raw)).toEqual(['3', '4']);
  });
});

describe('aggregation reading bounds', () => {
  it.each(['{"aggs":{},"aggregations":{}}', '{"aggs":[]}', '{"aggs":null}', '{"aggs":{},"aggs":{}}',
    '{"aggs":{"x":{"sum":{},"\\u0073um":{}}}}', '{"aggs":{},}', '{/*x*/"aggs":{}}'])(
    'rejects ambiguous or malformed execution DSL %s', (dsl) => {
      expect(readAggregationPage(dsl, '{}')).toEqual({ ok: false, code: 'invalidDsl' });
    },
  );

  it.each(['{"aggregations":[]}', '{"aggregations":null}', '{"aggregations":1}',
    '{"aggregations":{"a":{"value":1,"value":2}}}', '{"aggregations":{"a":{},"\\u0061":{}}}', '{"aggregations":{},}', '[]'])(
    'rejects malformed or ambiguous response %s', (raw) => {
      expect(readAggregationPage('{}', raw)).toEqual({ ok: false, code: 'invalidResponse' });
    },
  );

  it('rejects bytes before parsing, including UTF-8 instead of only UTF-16 length', () => {
    expect(readAggregationPage(' '.repeat(AGGREGATION_LIMITS.dslBytes) + '{}', '{}')).toEqual({ ok: false, code: 'tooLarge' });
    expect(readAggregationPage('{}', ' '.repeat(AGGREGATION_LIMITS.responseBytes) + '{}')).toEqual({ ok: false, code: 'tooLarge' });
    expect(readAggregationPage(`{"padding":"${'界'.repeat(AGGREGATION_LIMITS.dslBytes / 2)}"}`, '{}'))
      .toEqual({ ok: false, code: 'tooLarge' });
  });

  it('allows the byte limit itself and bounds depth before recursive tree allocation', () => {
    expect(readAggregationPage('{}' + ' '.repeat(AGGREGATION_LIMITS.dslBytes - 2), '{}').ok).toBe(true);
    expect(readAggregationPage('{}', '{"x":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}'))
      .toEqual({ ok: false, code: 'tooDeep' });
    expect(readAggregationPage('{"x":' + '['.repeat(63) + '0' + ']'.repeat(63) + '}', '{}').ok).toBe(true);
  });

  it('limits numeric token length without converting it to a floating-point value', () => {
    const number = '9'.repeat(AGGREGATION_LIMITS.numberLength);
    expect(metric(entries('{"a":{"sum":{}}}', `{"a":{"value":${number}}}`)[0]).value.raw).toBe(number);
    expect(read('{"a":{"sum":{}}}', `{"a":{"value":${number}9}}`)).toEqual({ ok: false, code: 'tooComplex' });
  });

  it('rejects excessive tokens even when bytes and nesting fit', () => {
    expect(readAggregationPage('{}', `{"padding":[${Array.from({ length: 50_001 }, () => '0').join(',')}]}`))
      .toEqual({ ok: false, code: 'tooComplex' });
  });

  it('counts top-level and direct child definitions together, including unmatched response names', () => {
    const metrics = Array.from({ length: 31 }, (_, n) => `"n${n}":{"sum":{}}`).join(',');
    expect(read(`{"a":{"terms":{},"aggs":{${metrics}}}}`, '{"a":{"buckets":[]}}').ok).toBe(true);
    expect(read(`{"a":{"terms":{},"aggs":{${metrics},"extra":{"sum":{}}}}}`, '{"a":{"buckets":[]}}'))
      .toEqual({ ok: false, code: 'tooComplex' });
    expect(read(`{"a":{"terms":{},"aggs":{${metrics}}}}`, '{"a":{"buckets":[]},"extra":{"value":1}}'))
      .toEqual({ ok: false, code: 'tooComplex' });
  });

  it('counts bucket limits across aggregations, rejects the whole view and does not truncate valid earlier entries', () => {
    const body = (count: number) => `{"buckets":[${Array.from({ length: count }, (_, n) => `{"key":${n},"doc_count":1}`).join(',')}]}`;
    const definition = '{"a":{"terms":{}},"b":{"terms":{}}}';
    expect(read(definition, `{"a":${body(2048)},"b":${body(2048)}}`).ok).toBe(true);
    expect(read(definition, `{"a":${body(2048)},"b":${body(2049)}}`)).toEqual({ ok: false, code: 'tooComplex' });
  });

  it('bounds decoded aggregation names in UTF-8, including direct metric and unrequested names', () => {
    const long = 'x'.repeat(1025);
    expect(read(`{"${long}":{"sum":{}}}`, '{}')).toEqual({ ok: false, code: 'tooComplex' });
    expect(read('{"a":{"terms":{},"aggs":{"' + '界'.repeat(342) + '":{"sum":{}}}}}', '{}'))
      .toEqual({ ok: false, code: 'tooComplex' });
    expect(read('{}', `{"${long}":{"value":1}}`)).toEqual({ ok: false, code: 'tooComplex' });
    expect(read(`{"a":{"${long}":{}}}`, '{"a":{}}')).toEqual({ ok: false, code: 'tooComplex' });
  });
});

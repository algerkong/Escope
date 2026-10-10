import { describe, expect, it } from 'vitest';
import { createQuery, createSnapshot, createWorkspace, updateWorkspaceDocument, type QueryDocument } from '../../src/domain/query';
import {
  AGGREGATION_BUILD_LIMITS, aggregationBuildEvidence, allowedFieldTypes, emptyAggregationDraft,
  parseAggregationBuild, previewAggregationBuild,
  type AggregationBuildDraft, type BuildGroup, type BuildInterval, type BuildMetric,
} from '../../src/domain/query-aggregation-build';
import { readAggregationPage } from '../../src/domain/query-aggregations';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { parseQueryTimeRange, previewTimeRange } from '../../src/domain/query-time-range';

const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events-*', dsl: '{}' };

function caps(fields: Record<string, Record<string, object>>): FieldCatalog {
  const parsed = parseFieldCaps(JSON.stringify({ indices: ['events-a', 'events-b'], fields }));
  if (!parsed.ok) throw new Error('fixture');
  return parsed.value;
}
const catalog = caps({
  n: { long: { searchable: true, aggregatable: true } },
  amount: { double: { searchable: true, aggregatable: true } },
  date: { date: { searchable: true, aggregatable: true } },
  nanos: { date_nanos: { searchable: true, aggregatable: true } },
  k: { keyword: { searchable: true, aggregatable: true } },
  flag: { boolean: { searchable: true, aggregatable: true } },
  txt: { text: { searchable: true, aggregatable: false } },
  hidden: { keyword: { searchable: true, aggregatable: false } },
  mixed: { keyword: { searchable: true, aggregatable: true }, long: { searchable: true, aggregatable: true } },
  ghost: { unmapped: { searchable: false, aggregatable: false } },
  items: { nested: { searchable: false, aggregatable: false } },
});
const histogram = (patch: Partial<Extract<BuildGroup, { type: 'date_histogram' }>> = {}): BuildGroup => ({
  name: 'per_day', type: 'date_histogram', field: 'date', interval: 'fixed_interval', intervalValue: '1d', timeZone: '', ...patch,
});
const terms = (patch: Partial<Extract<BuildGroup, { type: 'terms' }>> = {}): BuildGroup => ({
  name: 'by_host', type: 'terms', field: 'k', size: '', ...patch,
});
const metric = (patch: Partial<BuildMetric> = {}): BuildMetric => ({ name: 'total', type: 'sum', field: 'n', ...patch });
const draft = (group: BuildGroup | null, metrics: readonly BuildMetric[] = []): AggregationBuildDraft => ({ group, metrics });
const preview = (dsl: string, next: AggregationBuildDraft, fields = catalog) =>
  previewAggregationBuild({ ...source, dsl }, next, fields);
/** Same review without a field read, so the evidence gate is observable. */
const uncaptured = (dsl: string, next: AggregationBuildDraft) => previewAggregationBuild({ ...source, dsl }, next, undefined);
const built = (dsl: string, next: AggregationBuildDraft, fields = catalog) => {
  const result = preview(dsl, next, fields);
  if (!result.ok) throw new Error(result.code);
  return result;
};
/** `{"aggs":{"<name>":<value>}}` with the value text left as the caller wrote it. */
const single = (name: string, value: string) => `{"aggs":{"${name}":${value}}}`;

describe('aggregation build reversal', () => {
  it('reads an absent, empty and flat-metric aggregation block', () => {
    const empty = { ok: true, draft: emptyAggregationDraft(), preserved: [] } as const;
    expect(parseAggregationBuild('{}')).toEqual(empty);
    expect(parseAggregationBuild('{"aggs":{}}')).toEqual(empty);
    expect(parseAggregationBuild('{"aggregations":{}}')).toEqual(empty);
    expect(parseAggregationBuild('{"aggs":{"total":{"sum":{"field":"n"}},"uniq":{"cardinality":{"field":"k"}}}}'))
      .toEqual({ ok: true, draft: draft(null, [metric(), { name: 'uniq', type: 'cardinality', field: 'k' }]), preserved: [] });
  });

  it('reads a single-level group with its direct metrics from either spelling', () => {
    for (const key of ['aggs', 'aggregations']) {
      expect(parseAggregationBuild(`{"${key}":{"per_day":{"date_histogram":{"field":"date","fixed_interval":"1d"},"aggs":{"total":{"sum":{"field":"n"}}}}}}`))
        .toEqual({ ok: true, draft: draft(histogram(), [metric()]), preserved: [] });
    }
    expect(parseAggregationBuild('{"aggs":{"by_host":{"terms":{"field":"k","size":10},"aggs":{"peak":{"max":{"field":"n"}}}}}}'))
      .toEqual({ ok: true, draft: draft(terms({ size: '10' }), [{ name: 'peak', type: 'max', field: 'n' }]), preserved: [] });
    expect(parseAggregationBuild('{"aggs":{"per_day":{"date_histogram":{"field":"date","calendar_interval":"1M","time_zone":"UTC"}}}}'))
      .toEqual({ ok: true, draft: draft(histogram({ interval: 'calendar_interval', intervalValue: '1M', timeZone: 'UTC' })), preserved: [] });
    expect(parseAggregationBuild('{"aggs":{"by_host":{"terms":{"field":"k"}}}}'))
      .toEqual({ ok: true, draft: draft(terms()), preserved: [] });
  });

  it('keeps the size token exactly as written, including the cap itself', () => {
    expect(parseAggregationBuild(single('g', '{"terms":{"field":"k","size":1000}}')))
      .toEqual({ ok: true, draft: draft(terms({ name: 'g', size: '1000' })), preserved: [] });
  });

  it.each([
    ['a pipeline aggregation', 'p', '{"percentiles":{"field":"n"}}'],
    ['a scripted metric', 's', '{"sum":{"script":{"source":"doc[n]"}}}'],
    ['a metric option outside the draft', 'a', '{"avg":{"field":"n","missing":0}}'],
    ['a metric format option', 'a', '{"avg":{"field":"n","format":"0.00"}}'],
    ['a metric with children', 'm', '{"sum":{"field":"n"},"aggs":{"x":{"sum":{"field":"n"}}}}'],
    ['a group order option', 'g', '{"terms":{"field":"k","order":{"_count":"asc"}}}'],
    ['a legacy histogram interval', 'g', '{"date_histogram":{"field":"date","interval":"1d"}}'],
    ['a keyed histogram', 'g', '{"date_histogram":{"field":"date","fixed_interval":"1d","keyed":true}}'],
    ['extended bounds', 'g', '{"date_histogram":{"field":"date","fixed_interval":"1d","extended_bounds":{"min":0}}}'],
    ['a numeric histogram interval', 'g', '{"date_histogram":{"field":"date","fixed_interval":86400000}}'],
    ['a null histogram time zone', 'g', '{"date_histogram":{"field":"date","fixed_interval":"1d","time_zone":null}}'],
    ['two intervals', 'g', '{"date_histogram":{"field":"date","fixed_interval":"1d","calendar_interval":"1d"}}'],
    ['a group without a field', 'g', '{"terms":{}}'],
    ['a string size token', 'g', '{"terms":{"field":"k","size":"10"}}'],
    ['a negative size token', 'g', '{"terms":{"field":"k","size":-1}}'],
    ['a meta annotation', 'g', '{"terms":{"field":"k"},"meta":{"a":1}}'],
    ['a two-level group', 'g', '{"terms":{"field":"k"},"aggs":{"h":{"terms":{"field":"k"},"aggs":{"m":{"sum":{"field":"n"}}}}}}'],
    ['a group with a non-metric child', 'g', '{"terms":{"field":"k"},"aggs":{"h":{"terms":{"field":"k"}}}}'],
    ['a group with ambiguous children', 'g', '{"terms":{"field":"k"},"aggs":{},"aggregations":{}}'],
    ['an ambiguous child container', 'm', '{"sum":{"field":"n"},"aggs":{},"aggregations":{}}'],
    ['an array-valued entry', 'a', '[]'],
    ['an entry named after a container key', 'aggregations', '{"x":{"sum":{"field":"n"}}}'],
  ])('keeps %s handwritten instead of re-emitting it', (_label, name, value) => {
    const parsed = parseAggregationBuild(single(name, value));
    if (!parsed.ok) throw new Error(parsed.code);
    expect(parsed.draft).toEqual(emptyAggregationDraft());
    expect(parsed.preserved).toEqual([{ name, raw: value }]);
  });

  it('splits owned and handwritten entries in one block', () => {
    const parsed = parseAggregationBuild('{"aggs":{"p":{"percentiles":{"field":"n"}},"total":{"sum":{"field":"n"}}}}');
    if (!parsed.ok) throw new Error(parsed.code);
    expect(parsed.draft).toEqual(draft(null, [metric()]));
    expect(parsed.preserved).toEqual([{ name: 'p', raw: '{"percentiles":{"field":"n"}}' }]);
  });

  it('preserves nested metric order and names inside a handwritten group', () => {
    const value = '{"terms":{"field":"k","missing":"x"},"aggs":{"z":{"sum":{"field":"n"}},"a":{"avg":{"field":"n"}}}}';
    const parsed = parseAggregationBuild(single('g', value));
    if (!parsed.ok) throw new Error(parsed.code);
    expect(parsed.preserved).toEqual([{ name: 'g', raw: value }]);
  });

  it.each([
    ['two representable groups', '{"aggs":{"a":{"terms":{"field":"k"}},"b":{"terms":{"field":"n"}}}}', 'tooManyGroups'],
    ['a group and a flat metric', '{"aggs":{"a":{"terms":{"field":"k"},"aggs":{"m":{"sum":{"field":"n"}}}},"b":{"sum":{"field":"n"}}}}', 'mixedShape'],
    [`over ${AGGREGATION_BUILD_LIMITS.metrics} metrics`,
      `{"aggs":{${Array.from({ length: AGGREGATION_BUILD_LIMITS.metrics + 1 }, (_, index) => `"m${index}":{"sum":{"field":"n"}}`).join(',')}}}`,
      'tooManyMetrics'],
    ['both container spellings', '{"aggs":{"a":{"sum":{"field":"n"}}},"aggregations":{"b":{"sum":{"field":"n"}}}}', 'ambiguousAggs'],
    ['a non-object container', '{"aggs":[]}', 'invalidAggs'],
    ['a numeric container', '{"aggs":9007199254740993.5}', 'invalidAggs'],
    ['an empty draft', '', 'invalidDsl'],
    ['a trailing comma', '{"aggs":{"a":{"sum":{"field":"n"}},}}', 'invalidDsl'],
    ['a non-object root', '[]', 'invalidDsl'],
    ['unresolved parameters', '{"query":{"term":{"n":{"$param":"value"}}},"aggs":{"a":{"sum":{"field":"n"}}}}', 'invalidDsl'],
    ['comments', '{"aggs":{"a":{"sum":{"field":"n"}}}}//x', 'invalidDsl'],
  ])('refuses the whole block for %s', (_label, raw, code) => {
    expect(parseAggregationBuild(raw)).toMatchObject({ ok: false, code });
  });

  it('refuses a source DSL beyond the build byte cap', () => {
    const raw = `{"query":{"term":{"k":"${'x'.repeat(AGGREGATION_BUILD_LIMITS.dslBytes)}"}}}`;
    expect(parseAggregationBuild(raw)).toEqual({ ok: false, code: 'tooLarge' });
  });
});

describe('aggregation build emission', () => {
  it('leaves the DSL untouched when the draft matches what was reversed', () => {
    for (const raw of [
      '{"aggs":{"total":{"sum":{"field":"n"}}}}',
      '{"aggs":{"per_day":{"date_histogram":{"field":"date","fixed_interval":"1d"},"aggs":{"total":{"sum":{"field":"n"}}}}}}',
      '{"aggs":{"by_host":{"terms":{"field":"k","size":10}}}}',
      '{"aggs":{"p":{"percentiles":{"field":"n"}}}}',
      '{"aggs":{}}',
      '{}',
    ]) {
      const parsed = parseAggregationBuild(raw);
      if (!parsed.ok) throw new Error(parsed.code);
      expect(preview(raw, parsed.draft)).toMatchObject({ ok: true, dsl: raw, changed: false });
    }
    expect(preview('{}', emptyAggregationDraft())).toMatchObject({ ok: true, dsl: '{}', changed: false, patch: { dsl: '{}' } });
  });

  it('writes only the aggregation block and keeps other root text byte-for-byte', () => {
    const raw = '{"query":{"bool":{"filter":[{"term":{"k":"a\\u0062"}},{"range":{"n":{"gte":9007199254740993}}}]}},"sort":[{"n":"desc"}],'
      + '"runtime_mappings":{"rt":{"type":"double","script":{"source":"1"}}},"size":25,"_source":{"includes":["k"]}}';
    const result = built(raw, draft(terms(), [metric(), { name: 'uniq', type: 'cardinality', field: 'k' }]));
    expect(result.changed).toBe(true);
    for (const part of [
      '"query":{"bool":{"filter":[{"term":{"k":"a\\u0062"}},{"range":{"n":{"gte":9007199254740993}}}]}}',
      '"sort":[{"n":"desc"}]',
      '"runtime_mappings":{"rt":{"type":"double","script":{"source":"1"}}}',
      '"size":25',
      '"_source":{"includes":["k"]}',
    ]) expect(result.dsl).toContain(part);
    expect(result.dsl).toContain('"aggs":{"by_host":{"terms":{"field":"k"},"aggs":{"total":{"sum":{"field":"n"}},"uniq":{"cardinality":{"field":"k"}}}}}');
    // Compared as text: the long integer and the escape must survive as written, not as rounded numbers.
    expect(result.dsl).toContain('9007199254740993');
    expect(result.dsl).toContain('a\\u0062');
    expect(JSON.parse(result.dsl)).toMatchObject({
      sort: [{ n: 'desc' }], size: 25, _source: { includes: ['k'] },
      runtime_mappings: { rt: { type: 'double', script: { source: '1' } } },
      aggs: { by_host: { terms: { field: 'k' }, aggs: { total: { sum: { field: 'n' } }, uniq: { cardinality: { field: 'k' } } } } },
    });
  });

  it('adds the block after the last property when the draft has none', () => {
    expect(built('{"query":{"match_all":{}}}', draft(null, [metric()])).dsl)
      .toBe('{"query":{"match_all":{}},"aggs":{"total":{"sum":{"field":"n"}}}}');
    expect(built('{}', draft(histogram(), [metric()])).dsl)
      .toBe('{"aggs":{"per_day":{"date_histogram":{"field":"date","fixed_interval":"1d"},"aggs":{"total":{"sum":{"field":"n"}}}}}}');
    expect(built('{\n  "size": 5\n}', draft(null, [metric()])).dsl)
      .toBe('{\n  "size": 5,"aggs":{"total":{"sum":{"field":"n"}}}\n}');
  });

  it('rewrites the long spelling in place instead of adding a second block', () => {
    const raw = '{"aggregations":{"total":{"avg":{"field":"amount"}}}}';
    expect(preview(raw, draft(null, [metric({ type: 'avg', field: 'amount' })])))
      .toMatchObject({ ok: true, dsl: raw, changed: false });
    const changed = built(raw, draft(null, [metric({ type: 'avg' })]));
    expect(changed.dsl).toBe('{"aggregations":{"total":{"avg":{"field":"n"}}}}');
    expect(changed.changed).toBe(true);
    expect(changed.dsl).not.toContain('"aggs"');
  });

  it.each([
    ['the only property', '{"aggs":{"total":{"sum":{"field":"n"}}}}', '{}'],
    ['the only long property', '{"aggregations":{"total":{"sum":{"field":"n"}}}}', '{}'],
    ['beside others', '{"query":{"match_all":{}},"aggs":{"total":{"sum":{"field":"n"}}},"size":5}', '{"query":{"match_all":{}},"size":5}'],
    ['as the first property', '{"aggs":{"total":{"sum":{"field":"n"}}},"size":5}', '{"size":5}'],
    ['as the last property', '{"size":5,"aggs":{"total":{"sum":{"field":"n"}}}}', '{"size":5}'],
  ])('removes the aggregation block when it held only owned entries and the draft is empty: %s', (_label, raw, expected) => {
    const result = built(raw, emptyAggregationDraft());
    expect(result.dsl).toBe(expected);
    expect(result.changed).toBe(true);
  });

  it('keeps handwritten entries verbatim while replacing the owned ones', () => {
    const handwritten = '{"percentiles":{"field":"n","tdigest":{"compression":200},"missing":9007199254740993}}';
    const raw = `{"aggs":{"p":${handwritten},"drop":{"avg":{"field":"amount"}}}}`;
    const result = built(raw, draft(null, [metric()]));
    expect(result.dsl).toBe(`{"aggs":{"total":{"sum":{"field":"n"}},"p":${handwritten}}}`);
    expect(parseAggregationBuild(result.dsl)).toEqual({
      ok: true, draft: draft(null, [metric()]), preserved: [{ name: 'p', raw: handwritten }],
    });
  });

  it('emits drafted entries before handwritten ones and reverses back to the same model', () => {
    const raw = '{"aggs":{"p":{"percentiles":{"field":"n"}},"by_host":{"terms":{"field":"k","size":5}}}}';
    const result = built(raw, draft(terms({ size: '7' }), [metric()]));
    expect(result.dsl).toBe('{"aggs":{"by_host":{"terms":{"field":"k","size":7},"aggs":{"total":{"sum":{"field":"n"}}}},'
      + '"p":{"percentiles":{"field":"n"}}}}');
    expect(parseAggregationBuild(result.dsl)).toEqual({
      ok: true, draft: draft(terms({ size: '7' }), [metric()]), preserved: [{ name: 'p', raw: '{"percentiles":{"field":"n"}}' }],
    });
  });

  it('moves metrics out of a removed group without touching handwritten ones', () => {
    const raw = '{"aggs":{"per_day":{"date_histogram":{"field":"date","fixed_interval":"1d"},"aggs":{"total":{"sum":{"field":"n"}}}},"p":{"percentiles":{"field":"n"}}}}';
    expect(built(raw, draft(null, [metric()])).dsl)
      .toBe('{"aggs":{"total":{"sum":{"field":"n"}},"p":{"percentiles":{"field":"n"}}}}');
  });

  it('builds a DSL the aggregation reader interprets without an unsupported or invalid entry', () => {
    const raw = '{"aggs":{"p":{"percentiles":{"field":"n"}}}}';
    const dsl = built(raw, draft(histogram({ intervalValue: '30d', timeZone: 'UTC' }),
      [metric(), { name: 'uniq', type: 'cardinality', field: 'k' }])).dsl;
    const response = JSON.stringify({
      aggregations: {
        per_day: { buckets: [{ key: 1734998400000, key_as_string: '2024-12-24T00:00:00.000Z', doc_count: 2, total: { value: 5.5 }, uniq: { value: 3 } }] },
        p: { values: {} },
      },
      _shards: { total: 1, successful: 1, failed: 0 },
    });
    const read = readAggregationPage(dsl, response);
    if (!read.ok) throw new Error(read.code);
    expect(read.entries.map((entry) => entry.status)).toEqual(['buckets', 'unsupported']);
    const buckets = read.entries[0]!;
    if (buckets.status !== 'buckets') throw new Error('fixture');
    expect(buckets.metrics.map(({ name, type }) => [name, type])).toEqual([['total', 'sum'], ['uniq', 'cardinality']]);
    expect(buckets.buckets[0]!.metrics.map(({ value }) => value.raw)).toEqual(['5.5', '3']);
    expect(buckets.options.map(({ name }) => name)).toEqual(['field', 'fixed_interval', 'time_zone']);
  });

  it('refuses a built DSL beyond the byte cap', () => {
    const filler = 'y'.repeat(AGGREGATION_BUILD_LIMITS.dslBytes - 60);
    const raw = `{"aggs":{"p":{"percentiles":{"field":"n"},"x":"${filler}"}}}`;
    if (new TextEncoder().encode(raw).length > AGGREGATION_BUILD_LIMITS.dslBytes || !parseAggregationBuild(raw).ok) throw new Error('fixture');
    expect(preview(raw, draft(null, [metric()]))).toMatchObject({ ok: false, code: 'tooLarge' });
  });

  it('preserves the managed time binding through the patch and refuses a moved target', () => {
    const query = { ...source, dsl: '{"query":{"term":{"n":9007199254740993}}}' };
    const time = previewTimeRange(query, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, new Date('2026-10-10T00:00:00.000Z'));
    if (!time.ok) throw new Error(time.code);
    const timed = { ...query, dsl: time.dsl, timeRange: time.timeRange };
    const result = previewAggregationBuild(timed, draft(null, [metric()]), catalog);
    if (!result.ok) throw new Error(result.code);
    expect(result.patch.timeRange).toEqual(time.timeRange);
    expect(result.patch.timeRange).not.toBe(time.timeRange);
    expect(result.dsl).toContain('"n":9007199254740993');
    const workspace = { ...createWorkspace('connection'), tabs: [{ kind: 'query' as const, document: timed }] };
    const updated = updateWorkspaceDocument(workspace, source.id, result.patch).tabs[0]!.document;
    expect(parseQueryTimeRange(updated.timeRange, updated.connectionId, updated.index, updated.dsl)).toEqual(time.timeRange);
    const snapshot = createSnapshot(updated, 'request', new Date('2026-10-10T01:00:00.000Z'));
    expect(snapshot && snapshot.rawDsl).toContain('9007199254740993');
    expect(parseAggregationBuild(snapshot!.rawDsl).ok).toBe(true);
    expect(previewAggregationBuild({ ...timed, index: 'other' }, draft(null, [metric()]), catalog))
      .toMatchObject({ ok: false, code: 'invalidBinding' });
  });
});

describe('aggregation build gates', () => {
  it('requires a successful same-target field read', () => {
    expect(uncaptured('{}', draft(null, [metric()]))).toMatchObject({ ok: false, code: 'fieldUnchecked' });
    expect(uncaptured('{}', draft(terms()))).toMatchObject({ ok: false, code: 'fieldUnchecked' });
  });

  it.each([
    ['an unknown field', draft(null, [metric({ field: 'absent' })]), 'fieldMissing'],
    ['an unmapped field', draft(null, [metric({ field: 'ghost' })]), 'fieldUnmapped'],
    ['a conflicting field', draft(null, [metric({ field: 'mixed' })]), 'fieldConflict'],
    ['a field without doc values', draft(null, [metric({ type: 'value_count', field: 'hidden' })]), 'fieldNotAggregatable'],
    ['a nested field', draft(terms({ field: 'items' })), 'fieldNested'],
    ['a dotted path', draft(null, [metric({ field: 'items.n' })]), 'fieldPath'],
    ['a keyword for sum', draft(null, [metric({ field: 'k' })]), 'fieldUnsupported'],
    ['a text field for terms', draft(terms({ field: 'txt' })), 'fieldUnsupported'],
    ['a non-date field for a histogram', draft(histogram({ field: 'n' })), 'fieldUnsupported'],
    ['a long for terms', draft(terms({ field: 'n' })), null],
    ['a date for terms', draft(terms({ field: 'date' })), null],
    ['a boolean for cardinality', draft(null, [metric({ type: 'cardinality', field: 'flag' })]), null],
    ['date_nanos for a histogram', draft(histogram({ field: 'nanos' })), null],
    ['a double for avg', draft(null, [metric({ type: 'avg', field: 'amount' })]), null],
  ])('gates %s against the evidence matrix', (_label, next, code) => {
    const result = preview('{}', next);
    if (code === null) {
      expect(result.ok).toBe(true);
      expect(parseAggregationBuild(built('{}', next).dsl).ok).toBe(true);
      return;
    }
    expect(result.ok || 'code' in result ? (result.ok ? null : result.code) : null).toBe(code);
  });

  it('uses only the current DSL runtime declaration as field evidence', () => {
    const dsl = '{"runtime_mappings":{"rt":{"type":"double","script":{"source":"1"}},"kw":{"type":"keyword","script":{"source":"2"}}}}';
    expect(preview(dsl, draft(null, [metric({ field: 'rt' })]))).toMatchObject({ ok: true });
    expect(preview(dsl, draft(null, [metric({ field: 'kw' })]))).toMatchObject({ ok: false, code: 'fieldUnsupported' });
    expect(preview(dsl, draft(histogram({ field: 'rt' })))).toMatchObject({ ok: false, code: 'fieldUnsupported' });
    expect(aggregationBuildEvidence(dsl, draft(null, [metric({ field: 'rt' })]), catalog)[0])
      .toEqual({ ok: true, fieldType: 'double', origin: 'runtime' });
  });

  it.each([
    ['a group named as its metric', draft(terms({ name: 'total' }), [metric()]), 'duplicateName'],
    ['two metrics sharing a name', draft(null, [metric(), metric({ field: 'amount' })]), 'duplicateName'],
    ['a draft name that is handwritten', draft(null, [metric({ name: 'p' })]), 'nameConflict'],
    ['an empty name', draft(null, [metric({ name: '' })]), 'invalidName'],
    ['an untrimmed name', draft(null, [metric({ name: ' m' })]), 'invalidName'],
    ['a $param name', draft(null, [metric({ name: '$param' })]), 'invalidName'],
    ['a control character', draft(null, [metric({ name: 'a\u0000b' })]), 'invalidName'],
    ['a long name', draft(null, [metric({ name: 'm'.repeat(AGGREGATION_BUILD_LIMITS.nameBytes + 1) })]), 'invalidName'],
    ['an empty field', draft(null, [metric({ field: '' })]), 'invalidField'],
    ['an unknown metric type', draft(null, [metric({ type: 'percentiles' as BuildMetric['type'] })]), 'invalidMetricType'],
    ['terms size zero', draft(terms({ size: '0' })), 'invalidSize'],
    ['terms size with a leading zero', draft(terms({ size: '05' })), 'invalidSize'],
    ['terms size above the cap', draft(terms({ size: `${AGGREGATION_BUILD_LIMITS.sizeMax + 1}` })), 'invalidSize'],
    ['a missing histogram interval value', draft(histogram({ intervalValue: '' })), 'invalidInterval'],
    ['an untrimmed histogram interval', draft(histogram({ intervalValue: ' 1d' })), 'invalidInterval'],
    ['an unknown interval kind', draft(histogram({ interval: 'quarter' as unknown as BuildInterval })), 'invalidInterval'],
    ['an over-long interval', draft(histogram({ intervalValue: '1'.repeat(AGGREGATION_BUILD_LIMITS.intervalChars + 1) })), 'invalidInterval'],
    ['an untrimmed time zone', draft(histogram({ timeZone: 'UTC ' })), 'invalidZone'],
    ['an over-long time zone', draft(histogram({ timeZone: 'Z'.repeat(AGGREGATION_BUILD_LIMITS.zoneChars + 1) })), 'invalidZone'],
    ['stray draft keys', { group: null, metrics: [metric()], extra: 1 } as AggregationBuildDraft, 'invalidShape'],
    ['stray metric keys', draft(null, [{ name: 'total', type: 'sum', field: 'n', missing: 0 } as BuildMetric]), 'invalidShape'],
    ['stray group keys', draft({ ...terms(), format: 'x' } as unknown as BuildGroup), 'invalidShape'],
    ['a group of an unknown type', draft({ name: 'g', type: 'histogram' } as unknown as BuildGroup), 'invalidShape'],
  ])('refuses %s as a whole build', (_label, next, code) => {
    expect(preview('{"aggs":{"p":{"percentiles":{"field":"n"}}}}', next)).toMatchObject({ ok: false, code });
  });

  it('counts every definition the built DSL carries against the reader cap', () => {
    const metrics = Array.from({ length: AGGREGATION_BUILD_LIMITS.metrics }, (_, index) => metric({ name: `m${index}` }));
    expect(preview('{}', draft(histogram(), metrics))).toMatchObject({ ok: true });
    expect(preview('{}', draft(null, [...metrics, metric({ name: 'extra' })]))).toMatchObject({ ok: false, code: 'tooManyMetrics' });
    const nested = `{"aggs":{"p":{"terms":{"field":"k","missing":"x"},"aggs":{${metrics.map(({ name }) => `"${name}":{"sum":{"field":"n"}}`).join(',')}}}}}`;
    // The handwritten group keeps its 31 children, so one more drafted entry crosses the same cap the reader uses.
    expect(preview(nested, draft(terms(), [metric()]))).toMatchObject({ ok: false, code: 'tooComplex' });
    const roomy = '{"aggs":{"p":{"terms":{"field":"k","missing":"x"},"aggs":{"one":{"sum":{"field":"n"}},"two":{"sum":{"field":"n"}}}}}}';
    expect(preview(roomy, draft(terms(), [metric()]))).toMatchObject({ ok: true, changed: true });
  });

  it('reports evidence per drafted row in group-then-metric order', () => {
    const next = draft(terms({ field: 'hidden' }), [metric({ field: 'k' }), metric({ name: 'ok', field: 'amount' })]);
    const evidence = aggregationBuildEvidence('{}', next, catalog);
    expect(evidence.map((entry) => entry.ok ? entry.origin : entry.code)).toEqual(['fieldNotAggregatable', 'fieldUnsupported', 'mapped']);
    expect(allowedFieldTypes(next)).toHaveLength(3);
    expect(allowedFieldTypes(draft(null, [metric({ type: 'avg' })]))[0]).toContain('double');
    expect(aggregationBuildEvidence('{', next, catalog).every((entry) => !entry.ok && entry.code === 'invalidDsl')).toBe(true);
  });
});

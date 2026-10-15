import { describe, expect, it } from 'vitest';
import { buildAggregationChart, chartAxisSlots, chartValueDomain } from '../../src/domain/query-aggregation-charts';
import { readAggregationPage } from '../../src/domain/query-aggregations';

const DSL = '{"aggs":{"kinds":{"terms":{"field":"kind"},"aggs":{"total":{"sum":{"field":"amount"}},"unique":{"cardinality":{"field":"user"}}}}}}';

function entry(buckets: string, extra = '') {
  const parsed = readAggregationPage(DSL, `{"aggregations":{"kinds":{"buckets":[${buckets}]${extra}}}}`);
  if (!parsed.ok || !parsed.entries[0]) throw new Error('valid aggregation fixture');
  return parsed.entries[0];
}

function bars(result: ReturnType<typeof buildAggregationChart>) {
  if (!result.ok) throw new Error(`expected bars, got ${result.code}`);
  if (result.chart.kind !== 'bars') throw new Error('expected terms bars');
  return result.chart;
}

describe('terms second measure on an independent axis', () => {
  it('preserves category slots, raw tokens, source order and independent value domains', () => {
    const source = entry('{"key":"z","doc_count":3,"total":{"value":800000}},{"key":"a","doc_count":1,"total":{"value":400000}}');
    const before = JSON.stringify(source);
    const chart = bars(buildAggregationChart(source, null, 'total'));
    expect(chart.slotLabels).toEqual(['"z"', '"a"']);
    expect(chart.bars.map(({ slot, row, raw }) => [slot, row, raw])).toEqual([[0, 1, '3'], [1, 2, '1']]);
    expect(chart.secondary?.bars.map(({ slot, row, raw }) => [slot, row, raw])).toEqual([[0, 1, '800000'], [1, 2, '400000']]);
    expect(chartValueDomain(chart.valueExtent)).toEqual({ min: 0, max: 3 });
    expect(chartValueDomain(chart.secondary!.valueExtent)).toEqual({ min: 0, max: 800000 });
    expect(chart.buckets).toBe(2);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('retains independent gaps and real zeros without adding buckets or values', () => {
    const chart = bars(buildAggregationChart(entry(
      '{"key":"a","total":{"value":5}},{"key":"b","doc_count":2,"total":{"value":null}},'
      + '{"key":"c","doc_count":0,"total":{"value":0}}',
    ), null, 'total'));
    expect(chart.bars.map(({ slot, value }) => [slot, value])).toEqual([[1, 2], [2, 0]]);
    expect(chart.secondary!.bars.map(({ slot, value }) => [slot, value])).toEqual([[0, 5], [2, 0]]);
    expect(chart.skipped).toEqual([expect.objectContaining({ row: 1, reason: 'missing', raw: null })]);
    expect(chart.secondary!.skipped).toEqual([expect.objectContaining({ row: 2, reason: 'null', raw: 'null' })]);
    expect(chart.slots).toBe(3);
  });

  it('checks each measure precision and range separately', () => {
    const chart = bars(buildAggregationChart(entry(
      '{"key":"a","doc_count":9007199254740993,"total":{"value":9007199254740993}},'
      + '{"key":"b","doc_count":2,"total":{"value":1e-5000}},{"key":"c","doc_count":1,"total":{"value":1.50}}',
      ',"doc_count_error_upper_bound":-1,"sum_other_doc_count":3',
    ), null, 'total'));
    expect(chart.skipped[0]).toMatchObject({ row: 1, raw: '9007199254740993', reason: 'outOfRange' });
    expect(chart.secondary!.bars[0]).toMatchObject({ row: 1, raw: '9007199254740993', precise: false });
    expect(chart.secondary!.skipped[0]).toMatchObject({ row: 2, raw: '1e-5000', reason: 'outOfRange' });
    expect(chart.secondary!.bars[1]).toMatchObject({ raw: '1.50', precise: true });
    expect(chart.notices).toEqual(['errorUnknown', 'omittedBuckets', 'termsScope']);
    expect(chart.secondary!.notices).toEqual(['imprecise']);
  });

  it('keeps a secondary cardinality approximation separate from the exact document count', () => {
    const chart = bars(buildAggregationChart(entry('{"key":"a","doc_count":3,"unique":{"value":2}}'), null, 'unique'));
    expect(chart.notices).not.toContain('approximate');
    expect(chart.secondary!.notices).toEqual(['approximate']);
  });

  it('refuses unknown, identical and empty second measures without falling back', () => {
    const source = entry('{"key":"a","doc_count":1}');
    expect(buildAggregationChart(source, null, 'nope')).toEqual({ ok: false, code: 'unknownSecondary' });
    expect(buildAggregationChart(source, null, 'doc_count')).toEqual({ ok: false, code: 'secondarySame' });
    expect(buildAggregationChart(source, null, 'total')).toMatchObject({ ok: false, code: 'secondaryNoValues', buckets: 1 });
    expect(bars(buildAggregationChart(source, null)).secondary).toBeNull();
  });

  it('refuses an empty primary before evaluating the requested pair', () => {
    expect(buildAggregationChart(entry('{"key":"a","total":{"value":1}}'), null, 'total'))
      .toMatchObject({ ok: false, code: 'noPlottableValues' });
  });

  it('allows doc_count on the right and preserves negative values on the left', () => {
    const chart = bars(buildAggregationChart(entry(
      '{"key":"a","doc_count":2,"total":{"value":-12}},{"key":"b","doc_count":4,"total":{"value":3}}',
    ), 'total', 'doc_count'));
    expect(chart.valueExtent).toEqual({ min: -12, max: 3 });
    expect(chart.secondary!.measure).toEqual({ name: 'doc_count', type: 'doc_count' });
    expect(chart.secondary!.valueExtent).toEqual({ min: 2, max: 4 });
  });

  it('keeps one 200-bucket budget for both measures and no more than 12 labels', () => {
    const buckets = Array.from({ length: 200 }, (_, index) => `{"key":"${index}","doc_count":1,"total":{"value":2}}`);
    const chart = bars(buildAggregationChart(entry(buckets.join(',')), null, 'total'));
    expect(chart.plotted).toBe(200);
    expect(chart.secondary!.plotted).toBe(200);
    expect(chartAxisSlots(chart.slots)).toHaveLength(12);
    expect(buildAggregationChart(entry([...buckets, '{"key":"over","doc_count":1,"total":{"value":2}}'].join(',')), null, 'total'))
      .toEqual({ ok: false, code: 'tooManyBuckets', buckets: 201, skipped: [] });
  });

  it.each([
    ['total', null, 'valueDomainOutOfRange'],
    [null, 'total', 'secondaryDomainOutOfRange'],
  ])('refuses an overflowing axis span for primary %s and secondary %s', (measure, secondary, code) => {
    const source = entry('{"key":"a","doc_count":1,"total":{"value":-1e308}},{"key":"b","doc_count":2,"total":{"value":1e308}}');
    expect(buildAggregationChart(source, measure, secondary)).toEqual({ ok: false, code });
  });
});

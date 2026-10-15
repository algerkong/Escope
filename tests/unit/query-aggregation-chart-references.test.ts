import { describe, expect, it } from 'vitest';
import {
  CHART_REFERENCE_LIMIT, applyChartReference, type ChartReferenceLine, type ChartReferenceResult,
} from '../../src/domain/query-aggregation-chart-references';
import { buildAggregationChart, chartValueDomain } from '../../src/domain/query-aggregation-charts';
import { AGGREGATION_LIMITS, readAggregationPage } from '../../src/domain/query-aggregations';

function chartFixture(type = 'terms', primary = 'total', secondary: string | null = 'mean', values = ['10', '20']) {
  const group = type === 'terms' ? { terms: { field: 'kind' } } : { date_histogram: { field: 'at', fixed_interval: '1h' } };
  const dsl = JSON.stringify({ aggs: { grouped: {
    ...group, aggs: { total: { sum: { field: 'amount' } }, mean: { avg: { field: 'duration' } } },
  } } });
  const response = `{"aggregations":{"grouped":{"buckets":[${values.map((value, index) =>
    `{"key":${index * 3600000},"doc_count":${index + 1},"total":{"value":${value}},"mean":{"value":${(index + 1) * 1000}}}`
  ).join(',')}]}}}`;
  const page = readAggregationPage(dsl, response);
  if (!page.ok || !page.entries[0]) throw new Error('valid aggregation fixture');
  const result = buildAggregationChart(page.entries[0], primary, secondary);
  if (!result.ok) throw new Error(`valid chart fixture: ${result.code}`);
  return result.chart;
}

function linesOf(result: ChartReferenceResult) {
  if (!result.ok) throw new Error(`expected a reference: ${result.code}`);
  return result.lines;
}

describe('bounded session reference lines', () => {
  it.each(['terms', 'date_histogram'])('binds %s references to the selected independent axis and keeps the exact input', (type) => {
    const chart = chartFixture(type);
    const left = linesOf(applyChartReference(chart, [], { id: null, axis: 'left', raw: '1.00e+1' }));
    expect(left[0]).toMatchObject({
      id: 1, axis: 'left', measure: { name: 'total', type: 'sum' },
      raw: '1.00e+1', value: 10, precise: true, placement: 'inside', position: 0.5,
    });
    const both = linesOf(applyChartReference(chart, left, { id: null, axis: 'right', raw: '10.00' }));
    expect(both[1]).toMatchObject({
      id: 2, axis: 'right', measure: { name: 'mean', type: 'avg' }, raw: '10.00', position: 0.005,
    });
    expect(left).toHaveLength(1);
    expect(Object.isFrozen(both[1]?.measure)).toBe(true);
  });

  it('refuses a right axis without a second measure and refuses implicit or unknown axes', () => {
    const chart = chartFixture('terms', 'total', null);
    expect(applyChartReference(chart, [], { id: null, axis: 'right', raw: '1' }))
      .toEqual({ ok: false, code: 'rightUnavailable' });
    for (const axis of ['', 'secondary', 'unknown', '__proto__']) {
      expect(applyChartReference(chart, [], { id: null, axis, raw: '1' }))
        .toEqual({ ok: false, code: 'axisRequired' });
    }
  });

  it('does not add references to a single metric', () => {
    const parsed = readAggregationPage('{"aggs":{"total":{"sum":{"field":"amount"}}}}', '{"aggregations":{"total":{"value":1}}}');
    if (!parsed.ok) throw new Error('valid fixture');
    const result = buildAggregationChart(parsed.entries[0]!, null);
    if (!result.ok) throw new Error('valid chart');
    expect(applyChartReference(result.chart, [], { id: null, axis: 'left', raw: '1' }))
      .toEqual({ ok: false, code: 'unsupported' });
  });

  it('limits the whole chart to four references, including outside values, but allows atomic edits at the limit', () => {
    const chart = chartFixture();
    let lines: readonly ChartReferenceLine[] = [];
    for (let index = 0; index < CHART_REFERENCE_LIMIT; index += 1) {
      lines = linesOf(applyChartReference(chart, lines, { id: null, axis: index % 2 ? 'right' : 'left', raw: '9000' }));
    }
    const before = JSON.stringify(lines);
    expect(applyChartReference(chart, lines, { id: null, axis: 'left', raw: '2' })).toEqual({ ok: false, code: 'limit' });
    expect(applyChartReference(chart, lines, { id: 2, axis: 'left', raw: 'NaN' })).toEqual({ ok: false, code: 'invalidToken' });
    expect(JSON.stringify(lines)).toBe(before);
    const edited = linesOf(applyChartReference(chart, lines, { id: 2, axis: 'left', raw: '2.00' }));
    expect(edited).toHaveLength(4);
    expect(edited[1]).toMatchObject({ id: 2, axis: 'left', measure: { name: 'total' }, raw: '2.00', position: 0.1 });
    expect(edited[0]).toBe(lines[0]);
    const removed = edited.filter((line) => line.id !== 2);
    const added = linesOf(applyChartReference(chart, removed, { id: null, axis: 'right', raw: '500' }));
    expect(added.map((line) => line.id)).toEqual([1, 3, 4, 2]);
    expect(applyChartReference(chart, removed, { id: 2, axis: 'right', raw: '500' }))
      .toEqual({ ok: false, code: 'notFound' });
  });

  it.each(['', ' ', ' 1', '1 ', '1\n', '1\r\n', '+1', '.5', '1.', '01', '0x10', '1_000', '1,000',
    '"1"', 'true', 'null', 'NaN', 'Infinity', '-Infinity', '1e', '1e+', '1 2', '1/2'])('rejects invalid numeric input %j', (raw) => {
    expect(applyChartReference(chartFixture(), [], { id: null, axis: 'left', raw }))
      .toEqual({ ok: false, code: 'invalidToken' });
  });

  it.each(['1e400', '-1e400', '1e-400', '-1e-400'])('refuses numeric range loss %s instead of drawing zero or infinity', (raw) => {
    expect(applyChartReference(chartFixture(), [], { id: null, axis: 'left', raw }))
      .toEqual({ ok: false, code: 'outOfRange' });
  });

  it('accepts exactly the existing numeric token limit and rejects one more character without truncating it', () => {
    const raw = `1.${'0'.repeat(AGGREGATION_LIMITS.numberLength - 2)}`;
    expect(raw).toHaveLength(4096);
    expect(linesOf(applyChartReference(chartFixture(), [], { id: null, axis: 'left', raw }))[0])
      .toMatchObject({ raw, value: 1, precise: true });
    expect(applyChartReference(chartFixture(), [], { id: null, axis: 'left', raw: `${raw}0` }))
      .toEqual({ ok: false, code: 'invalidToken' });
  });

  it.each(['-0', '0.000e+2', '5e-324', '-1.5000', '1E+1'])('keeps the valid original spelling %s', (raw) => {
    const lines = linesOf(applyChartReference(chartFixture(), [], { id: null, axis: 'left', raw }));
    expect(lines[0]?.raw).toBe(raw);
    expect(Object.is(lines[0]?.value, Number(raw))).toBe(true);
    expect(lines[0]?.precise).toBe(true);
  });

  it('uses shortest round-trip precision accounting without silently rewriting a long decimal or large metric integer', () => {
    for (const [raw, value] of [['0.10000000000000000001', 0.1], ['9007199254740993', 9007199254740992]] as const) {
      expect(linesOf(applyChartReference(chartFixture(), [], { id: null, axis: 'left', raw }))[0])
        .toMatchObject({ raw, value, precise: false });
    }
  });

  it('requires safe exact integers on doc_count while retaining literal zero and integral exponent spellings', () => {
    const chart = chartFixture('terms', 'doc_count', 'total');
    for (const raw of ['9007199254740991', '-9007199254740991', '-0', '1.00', '1e0']) {
      expect(applyChartReference(chart, [], { id: null, axis: 'left', raw }).ok).toBe(true);
    }
    for (const raw of ['9007199254740992', '-9007199254740992', '1.5', '1.000000000000000001']) {
      expect(applyChartReference(chart, [], { id: null, axis: 'left', raw }))
        .toEqual({ ok: false, code: 'unsafeCount' });
    }
    const rightCount = chartFixture('date_histogram', 'total', 'doc_count');
    expect(applyChartReference(rightCount, [], { id: null, axis: 'right', raw: '9007199254740993' }))
      .toEqual({ ok: false, code: 'unsafeCount' });
  });

  it('checks original decimals at both data boundaries, including a value rounded onto the upper edge', () => {
    const chart = chartFixture();
    for (const [raw, placement, position] of [
      ['-1', 'below', null], ['21', 'above', null], ['20.000000000000000001', 'above', null],
      ['0', 'inside', 0], ['20.00', 'inside', 1],
    ] as const) {
      expect(linesOf(applyChartReference(chart, [], { id: null, axis: 'left', raw }))[0])
        .toMatchObject({ raw, placement, position });
    }
  });

  it('keeps negative and all-zero axes unchanged', () => {
    const negative = chartFixture('terms', 'total', null, ['-20', '-10']);
    expect(linesOf(applyChartReference(negative, [], { id: null, axis: 'left', raw: '-5' }))[0]?.position).toBe(0.75);
    const zero = chartFixture('date_histogram', 'total', null, ['0', '0']);
    expect(linesOf(applyChartReference(zero, [], { id: null, axis: 'left', raw: '0.5' }))[0]?.position).toBe(0.5);
    expect(zero.valueExtent).toEqual({ min: 0, max: 0 });
  });

  it('refuses finite opposite extremes whose span overflows without extending either data axis', () => {
    const chart = chartFixture('terms', 'total', 'mean', ['-1e308', '-1e307']);
    expect(applyChartReference(chart, [], { id: null, axis: 'left', raw: '1e308' }))
      .toEqual({ ok: false, code: 'spanOutOfRange' });
    const second = chartFixture('date_histogram', 'mean', 'total', ['1e307', '1e308']);
    expect(applyChartReference(second, [], { id: null, axis: 'right', raw: '-1e308' }))
      .toEqual({ ok: false, code: 'spanOutOfRange' });
    expect(applyChartReference(second, [], { id: null, axis: 'left', raw: '-1e308' }).ok).toBe(true);
  });

  it('also rejects a non-finite data span at the domain boundary', () => {
    const chart = chartFixture();
    expect(applyChartReference({ ...chart, valueExtent: { min: -1e308, max: 1e308 } }, [], { id: null, axis: 'left', raw: '0' }))
      .toEqual({ ok: false, code: 'spanOutOfRange' });
  });

  it('does not silently move existing references to a different bound measure', () => {
    const chart = chartFixture();
    const lines = linesOf(applyChartReference(chart, [], { id: null, axis: 'right', raw: '500' }));
    expect(applyChartReference(chartFixture('terms', 'mean', 'total'), lines, { id: null, axis: 'left', raw: '20' }))
      .toEqual({ ok: false, code: 'bindingChanged' });
  });

  it('does not mutate the chart, its order, raw tokens, gaps or either data domain', () => {
    const chart = chartFixture('date_histogram', 'total', 'mean', ['20', 'null', '-10', '0']);
    const before = JSON.stringify(chart);
    const domain = chartValueDomain(chart.valueExtent);
    let lines: readonly ChartReferenceLine[] = [];
    for (const raw of ['-10000', '-1.00', '0.1', '10000']) {
      lines = linesOf(applyChartReference(chart, lines, { id: null, axis: 'left', raw }));
    }
    expect(JSON.stringify(chart)).toBe(before);
    expect(chartValueDomain(chart.valueExtent)).toEqual(domain);
  });
});

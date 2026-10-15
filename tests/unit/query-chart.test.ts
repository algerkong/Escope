import { describe, expect, it } from 'vitest';
import {
  buildDateHistogramChartData,
  buildMetricChartData,
  buildTermsBarChartData,
  parsePlottableNumber,
} from '../../src/domain/query-chart';
import type { AggregationBucket, AggregationMetric } from '../../src/domain/query-aggregations';

describe('parsePlottableNumber', () => {
  it('parses finite integers and floats without coercing or rounding', () => {
    expect(parsePlottableNumber({ kind: 'number', raw: '123' }, 'test')).toEqual({
      valid: true,
      numericValue: 123,
      raw: '123',
      label: 'test',
    });
    expect(parsePlottableNumber({ kind: 'number', raw: '45.67' }, 'test')).toEqual({
      valid: true,
      numericValue: 45.67,
      raw: '45.67',
      label: 'test',
    });
    expect(parsePlottableNumber({ kind: 'number', raw: '1e4' }, 'test')).toEqual({
      valid: true,
      numericValue: 10000,
      raw: '1e4',
      label: 'test',
    });
  });

  it('rejects missing, null and non-finite numbers without converting to zero', () => {
    expect(parsePlottableNumber({ kind: 'missing', raw: null }, 'test')).toEqual({
      valid: false,
      numericValue: null,
      raw: null,
      label: 'test',
    });
    expect(parsePlottableNumber({ kind: 'null', raw: 'null' }, 'test')).toEqual({
      valid: false,
      numericValue: null,
      raw: 'null',
      label: 'test',
    });
    expect(parsePlottableNumber({ kind: 'string', raw: 'not_a_number' }, 'test')).toEqual({
      valid: false,
      numericValue: null,
      raw: 'not_a_number',
      label: 'test',
    });
    expect(parsePlottableNumber({ kind: 'number', raw: 'Infinity' }, 'test')).toEqual({
      valid: false,
      numericValue: null,
      raw: 'Infinity',
      label: 'test',
    });
  });
});

describe('buildMetricChartData', () => {
  it('identifies approximate cardinality and value_count correctly', () => {
    const cardMetric: AggregationMetric = {
      name: 'unique_users',
      type: 'cardinality',
      value: { kind: 'number', raw: '42' },
      valueAsString: { kind: 'missing', raw: null },
    };
    const cardData = buildMetricChartData(cardMetric);
    expect(cardData.isApproximate).toBe(true);
    expect(cardData.isValueCount).toBe(false);
    expect(cardData.value.numericValue).toBe(42);

    const countMetric: AggregationMetric = {
      name: 'total_events',
      type: 'value_count',
      value: { kind: 'number', raw: '100' },
      valueAsString: { kind: 'missing', raw: null },
    };
    const countData = buildMetricChartData(countMetric);
    expect(countData.isApproximate).toBe(false);
    expect(countData.isValueCount).toBe(true);
    expect(countData.value.numericValue).toBe(100);
  });
});

describe('buildTermsBarChartData', () => {
  it('maps buckets to bar items and counts unplottable values', () => {
    const buckets: AggregationBucket[] = [
      {
        member: null,
        key: { kind: 'string', raw: '"electronics"' },
        keyAsString: { kind: 'string', raw: 'Electronics' },
        docCount: { kind: 'number', raw: '150' },
        docCountError: { kind: 'number', raw: '0' },
        metrics: [
          {
            name: 'avg_price',
            type: 'avg',
            value: { kind: 'number', raw: '99.5' },
            valueAsString: { kind: 'missing', raw: null },
          },
        ],
        raw: '{"key":"electronics","doc_count":150}',
      },
      {
        member: null,
        key: { kind: 'string', raw: '"books"' },
        keyAsString: { kind: 'missing', raw: null },
        docCount: { kind: 'null', raw: 'null' },
        docCountError: { kind: 'number', raw: '0' },
        metrics: [],
        raw: '{"key":"books","doc_count":null}',
      },
    ];

    const data = buildTermsBarChartData({
      name: 'categories',
      buckets,
      metrics: [{ name: 'avg_price', type: 'avg' }],
      docCountError: { kind: 'number', raw: '0' },
      sumOtherDocCount: { kind: 'number', raw: '20' },
    });

    expect(data.name).toBe('categories');
    expect(data.items.length).toBe(2);
    expect(data.items[0]!.key).toBe('Electronics');
    expect(data.items[0]!.docCount.numericValue).toBe(150);
    expect(data.items[1]!.docCount.valid).toBe(false);
    expect(data.unplottableCount).toBe(1); // books has doc_count null
    expect(data.maxValue).toBe(150);
    expect(data.sumOtherDocCount).toBe('20');

    // Switch to active sub-metric avg_price
    const subMetricData = buildTermsBarChartData(
      {
        name: 'categories',
        buckets,
        metrics: [{ name: 'avg_price', type: 'avg' }],
        docCountError: { kind: 'number', raw: '0' },
        sumOtherDocCount: { kind: 'number', raw: '20' },
      },
      'avg_price',
    );
    expect(subMetricData.selectedMetric).toBe('avg_price');
    expect(subMetricData.maxValue).toBe(99.5);
    // second item has no avg_price metric, so it's unplottable
    expect(subMetricData.unplottableCount).toBe(1);
  });
});

describe('buildDateHistogramChartData', () => {
  it('preserves returned order without inferring missing dates or boundaries', () => {
    const buckets: AggregationBucket[] = [
      {
        member: null,
        key: { kind: 'number', raw: '1609459200000' },
        keyAsString: { kind: 'string', raw: '2021-01-01' },
        docCount: { kind: 'number', raw: '10' },
        docCountError: { kind: 'missing', raw: null },
        metrics: [],
        raw: '{"key":1609459200000,"doc_count":10}',
      },
      {
        member: null,
        key: { kind: 'number', raw: '1609632000000' }, // skipped 2021-01-02!
        keyAsString: { kind: 'string', raw: '2021-01-03' },
        docCount: { kind: 'number', raw: '25' },
        docCountError: { kind: 'missing', raw: null },
        metrics: [],
        raw: '{"key":1609632000000,"doc_count":25}',
      },
    ];

    const data = buildDateHistogramChartData({
      name: 'daily_logs',
      buckets,
      metrics: [],
      options: [{ name: 'interval', raw: '"1d"' }],
    });

    expect(data.points.length).toBe(2);
    expect(data.points[0]!.xLabel).toBe('2021-01-01');
    expect(data.points[0]!.value.numericValue).toBe(10);
    expect(data.points[1]!.xLabel).toBe('2021-01-03');
    expect(data.points[1]!.value.numericValue).toBe(25);
    expect(data.minValue).toBe(10);
    expect(data.maxValue).toBe(25);
    expect(data.unplottableCount).toBe(0);
    expect(data.options).toEqual([{ name: 'interval', raw: '"1d"' }]);
  });
});

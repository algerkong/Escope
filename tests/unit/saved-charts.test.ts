import { describe, expect, it } from 'vitest';
import {
  CHART_LIBRARY_VERSION,
  emptySavedCharts,
  parseAggregationClause,
  parseChartDefinition,
  parseChartLibrary,
  parseChartRecord,
  parseSubMetric,
  sameChartDefinition,
  type SavedChartDefinition,
  type SavedChartLibrary,
} from '../../src/domain/saved-charts';
import { createSessionSavedChartService } from '../../src/services/saved-charts';

describe('saved-charts domain and service', () => {
  const sampleDef: SavedChartDefinition = {
    id: 'chart_1',
    name: 'Status breakdown',
    connectionId: 'conn_1',
    index: 'logs-*',
    chartType: 'bar',
    clauses: [
      {
        id: 'c_1',
        name: 'by_status',
        aggregationType: 'terms',
        field: 'status.keyword',
        size: 20,
        orderDirection: 'desc',
        orderMetric: '_count',
        subMetrics: [
          {
            id: 'sm_1',
            name: 'avg_bytes',
            metricType: 'avg',
            field: 'bytes',
          },
        ],
      },
    ],
    preferredMetric: '_count',
    description: 'HTTP status distribution bar chart',
    updatedAt: '2026-10-13T10:00:00.000Z',
  };

  it('parses valid sub metrics and rejects invalid fields/types', () => {
    const parsed = parseSubMetric({
      id: 'sub_1',
      name: 'avg_load',
      metricType: 'avg',
      field: 'load_time',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('avg_load');

    expect(parseSubMetric({ id: 'bad!', name: 'avg', metricType: 'avg', field: 'f' })).toBeNull();
    expect(parseSubMetric({ id: 's1', name: '', metricType: 'avg', field: 'f' })).toBeNull();
    expect(parseSubMetric({ id: 's1', name: 'm', metricType: 'terms', field: 'f' })).toBeNull();
    expect(parseSubMetric({ id: 's1', name: 'm', metricType: 'avg', field: '' })).toBeNull();
  });

  it('parses aggregation clauses and rejects out of bound options', () => {
    const clause = parseAggregationClause({
      id: 'c1',
      name: 'daily_active',
      aggregationType: 'date_histogram',
      field: '@timestamp',
      intervalType: 'calendar',
      interval: '1d',
      minDocCount: 0,
    });
    expect(clause).not.toBeNull();
    expect(clause?.aggregationType).toBe('date_histogram');
    expect(clause?.interval).toBe('1d');

    // Invalid size
    expect(parseAggregationClause({
      id: 'c1',
      name: 't',
      aggregationType: 'terms',
      field: 'f',
      size: -1,
    })).toBeNull();

    // Invalid direction
    expect(parseAggregationClause({
      id: 'c1',
      name: 't',
      aggregationType: 'terms',
      field: 'f',
      orderDirection: 'sideways',
    })).toBeNull();
  });

  it('parses chart definition and validates properties', () => {
    const parsed = parseChartDefinition(sampleDef);
    expect(parsed).toEqual(sampleDef);

    // Missing clauses
    expect(parseChartDefinition({ ...sampleDef, clauses: [] })).toBeNull();

    // Invalid chart type
    expect(parseChartDefinition({ ...sampleDef, chartType: 'unknown' })).toBeNull();

    // Bad updated at
    expect(parseChartDefinition({ ...sampleDef, updatedAt: 'not-a-date' })).toBeNull();
  });

  it('parses chart library and detects duplicate entry IDs', () => {
    const empty = emptySavedCharts();
    expect(parseChartLibrary(empty)).toEqual(empty);

    const lib: SavedChartLibrary = {
      version: CHART_LIBRARY_VERSION,
      entries: [sampleDef],
    };
    expect(parseChartLibrary(lib)).toEqual(lib);

    const dupLib = {
      version: CHART_LIBRARY_VERSION,
      entries: [sampleDef, { ...sampleDef, name: 'Copy' }],
    };
    expect(parseChartLibrary(dupLib)).toBeNull();
  });

  it('parses chart record with valid revisions', () => {
    const record = parseChartRecord({
      revision: 1,
      library: {
        version: CHART_LIBRARY_VERSION,
        entries: [sampleDef],
      },
    });
    expect(record).not.toBeNull();
    expect(record?.revision).toBe(1);

    expect(parseChartRecord({ revision: -1, library: emptySavedCharts() })).toBeNull();
  });

  it('sameChartDefinition checks exact equality', () => {
    expect(sameChartDefinition(sampleDef, { ...sampleDef })).toBe(true);
    expect(sameChartDefinition(sampleDef, { ...sampleDef, name: 'other' })).toBe(false);
  });

  it('session service provides in-memory CAS and validation', async () => {
    const service = createSessionSavedChartService();
    const initial = await service.load();
    expect(initial.revision).toBe(0);
    expect(initial.library.entries.length).toBe(0);

    const libToSave: SavedChartLibrary = {
      version: CHART_LIBRARY_VERSION,
      entries: [sampleDef],
    };

    const nextRev = await service.save(0, libToSave);
    expect(nextRev).toBe(1);

    const loaded = await service.load();
    expect(loaded.revision).toBe(1);
    expect(loaded.library.entries.length).toBe(1);
    expect(loaded.library.entries[0]?.id).toBe('chart_1');

    // CAS conflict with stale revision
    await expect(service.save(0, libToSave)).rejects.toMatchObject({
      code: 'savedChartConflict',
    });
  });
});

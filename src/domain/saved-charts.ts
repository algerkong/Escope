export const CHART_LIBRARY_VERSION = 1;
export const MAX_CHART_ENTRIES = 100;
export const MAX_CHART_BYTES = 256 * 1024;
export const MAX_CHART_ID_LENGTH = 64;
export const MAX_CHART_NAME_CHARS = 120;
export const MAX_CHART_INDEX_BYTES = 1024;
export const MAX_CLAUSES = 32;
export const MAX_SUB_METRICS = 16;
export const MAX_REVISION = 9_007_199_254_740_991;

export type ChartType = 'metric' | 'bar' | 'line' | 'table';

export const VALID_METRIC_TYPES = ['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'] as const;
export type MetricType = typeof VALID_METRIC_TYPES[number];

export const VALID_BUCKET_TYPES = ['terms', 'date_histogram'] as const;
export type BucketType = typeof VALID_BUCKET_TYPES[number];

export type AggregationBuilderType = MetricType | BucketType;

export interface ChartSubMetric {
  readonly id: string;
  readonly name: string;
  readonly metricType: MetricType;
  readonly field: string;
}

export interface ChartAggregationClause {
  readonly id: string;
  readonly name: string;
  readonly aggregationType: AggregationBuilderType;
  readonly field: string;
  readonly size?: number;
  readonly orderDirection?: 'asc' | 'desc';
  readonly orderMetric?: string;
  readonly intervalType?: 'calendar' | 'fixed';
  readonly interval?: string;
  readonly minDocCount?: number;
  readonly subMetrics?: readonly ChartSubMetric[];
}

export interface SavedChartDefinition {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string | null;
  readonly index: string;
  readonly chartType: ChartType;
  readonly clauses: readonly ChartAggregationClause[];
  readonly preferredMetric?: string | null;
  readonly description?: string | null;
  readonly updatedAt: string;
}

export interface SavedChartLibrary {
  readonly version: number;
  readonly entries: readonly SavedChartDefinition[];
}

export interface SavedChartRecord {
  readonly revision: number;
  readonly library: SavedChartLibrary;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_PATTERN = /^[0-9A-Za-z:.+-]+$/;
const encoder = new TextEncoder();

export function emptySavedCharts(): SavedChartLibrary {
  return { version: CHART_LIBRARY_VERSION, entries: [] };
}

export function parseSubMetric(raw: unknown): ChartSubMetric | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id) || item.id.length > MAX_CHART_ID_LENGTH) return null;
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > MAX_CHART_NAME_CHARS) return null;
  if (typeof item.metricType !== 'string' || !(VALID_METRIC_TYPES as readonly string[]).includes(item.metricType)) return null;
  if (typeof item.field !== 'string' || !item.field.trim() || encoder.encode(item.field).length > MAX_CHART_INDEX_BYTES) return null;

  return {
    id: item.id,
    name: item.name.trim(),
    metricType: item.metricType as MetricType,
    field: item.field.trim(),
  };
}

export function parseAggregationClause(raw: unknown): ChartAggregationClause | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id) || item.id.length > MAX_CHART_ID_LENGTH) return null;
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > MAX_CHART_NAME_CHARS) return null;
  if (typeof item.aggregationType !== 'string'
    || !([...VALID_METRIC_TYPES, ...VALID_BUCKET_TYPES] as readonly string[]).includes(item.aggregationType)) return null;
  if (typeof item.field !== 'string' || !item.field.trim() || encoder.encode(item.field).length > MAX_CHART_INDEX_BYTES) return null;

  let size: number | undefined;
  if (item.size !== undefined) {
    if (typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size < 1 || item.size > 10000) return null;
    size = item.size;
  }

  let orderDirection: 'asc' | 'desc' | undefined;
  if (item.orderDirection !== undefined) {
    if (item.orderDirection !== 'asc' && item.orderDirection !== 'desc') return null;
    orderDirection = item.orderDirection;
  }

  let orderMetric: string | undefined;
  if (item.orderMetric !== undefined) {
    if (typeof item.orderMetric !== 'string' || !item.orderMetric.trim() || item.orderMetric.length > MAX_CHART_NAME_CHARS) return null;
    orderMetric = item.orderMetric.trim();
  }

  let intervalType: 'calendar' | 'fixed' | undefined;
  if (item.intervalType !== undefined) {
    if (item.intervalType !== 'calendar' && item.intervalType !== 'fixed') return null;
    intervalType = item.intervalType;
  }

  let interval: string | undefined;
  if (item.interval !== undefined) {
    if (typeof item.interval !== 'string' || !item.interval.trim() || item.interval.length > 64) return null;
    interval = item.interval.trim();
  }

  let minDocCount: number | undefined;
  if (item.minDocCount !== undefined) {
    if (typeof item.minDocCount !== 'number' || !Number.isInteger(item.minDocCount) || item.minDocCount < 0) return null;
    minDocCount = item.minDocCount;
  }

  let subMetrics: readonly ChartSubMetric[] | undefined;
  if (item.subMetrics !== undefined) {
    if (!Array.isArray(item.subMetrics) || item.subMetrics.length > MAX_SUB_METRICS) return null;
    const parsedSub: ChartSubMetric[] = [];
    const subIds = new Set<string>();
    const subNames = new Set<string>();
    for (const subItem of item.subMetrics) {
      const parsed = parseSubMetric(subItem);
      if (!parsed || subIds.has(parsed.id) || subNames.has(parsed.name)) return null;
      subIds.add(parsed.id);
      subNames.add(parsed.name);
      parsedSub.push(parsed);
    }
    subMetrics = parsedSub;
  }

  return {
    id: item.id,
    name: item.name.trim(),
    aggregationType: item.aggregationType as AggregationBuilderType,
    field: item.field.trim(),
    ...(size !== undefined ? { size } : {}),
    ...(orderDirection !== undefined ? { orderDirection } : {}),
    ...(orderMetric !== undefined ? { orderMetric } : {}),
    ...(intervalType !== undefined ? { intervalType } : {}),
    ...(interval !== undefined ? { interval } : {}),
    ...(minDocCount !== undefined ? { minDocCount } : {}),
    ...(subMetrics !== undefined ? { subMetrics } : {}),
  };
}

export function parseChartDefinition(raw: unknown): SavedChartDefinition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id) || item.id.length > MAX_CHART_ID_LENGTH) return null;
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > MAX_CHART_NAME_CHARS) return null;
  if (item.connectionId !== null && (typeof item.connectionId !== 'string' || !ID_PATTERN.test(item.connectionId) || item.connectionId.length > MAX_CHART_ID_LENGTH)) return null;
  if (typeof item.index !== 'string' || encoder.encode(item.index).length > MAX_CHART_INDEX_BYTES) return null;
  if (typeof item.chartType !== 'string' || !['metric', 'bar', 'line', 'table'].includes(item.chartType)) return null;

  if (!Array.isArray(item.clauses) || item.clauses.length === 0 || item.clauses.length > MAX_CLAUSES) return null;
  const parsedClauses: ChartAggregationClause[] = [];
  const clauseIds = new Set<string>();
  const clauseNames = new Set<string>();
  for (const clauseItem of item.clauses) {
    const parsed = parseAggregationClause(clauseItem);
    if (!parsed || clauseIds.has(parsed.id) || clauseNames.has(parsed.name)) return null;
    clauseIds.add(parsed.id);
    clauseNames.add(parsed.name);
    parsedClauses.push(parsed);
  }

  let preferredMetric: string | null = null;
  if (item.preferredMetric !== undefined && item.preferredMetric !== null) {
    if (typeof item.preferredMetric !== 'string' || item.preferredMetric.length > MAX_CHART_NAME_CHARS) return null;
    preferredMetric = item.preferredMetric;
  }

  let description: string | null = null;
  if (item.description !== undefined && item.description !== null) {
    if (typeof item.description !== 'string' || item.description.length > 500) return null;
    description = item.description;
  }

  if (typeof item.updatedAt !== 'string' || !TIMESTAMP_PATTERN.test(item.updatedAt) || item.updatedAt.length > 40 || Number.isNaN(Date.parse(item.updatedAt))) return null;

  return {
    id: item.id,
    name: item.name.trim(),
    connectionId: item.connectionId,
    index: item.index,
    chartType: item.chartType as ChartType,
    clauses: parsedClauses,
    preferredMetric,
    description,
    updatedAt: item.updatedAt,
  };
}

export function parseChartLibrary(raw: unknown): SavedChartLibrary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== CHART_LIBRARY_VERSION || !Array.isArray(record.entries) || record.entries.length > MAX_CHART_ENTRIES) return null;

  const entries: SavedChartDefinition[] = [];
  const ids = new Set<string>();
  for (const entryRaw of record.entries) {
    const entry = parseChartDefinition(entryRaw);
    if (!entry || ids.has(entry.id)) return null;
    ids.add(entry.id);
    entries.push(entry);
  }

  const lib: SavedChartLibrary = {
    version: CHART_LIBRARY_VERSION,
    entries,
  };

  const serialized = JSON.stringify(lib);
  if (encoder.encode(serialized).length > MAX_CHART_BYTES) return null;

  return lib;
}

export function parseChartRecord(raw: unknown): SavedChartRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0 || record.revision > MAX_REVISION) return null;
  const library = parseChartLibrary(record.library);
  if (!library) return null;
  return {
    revision: record.revision,
    library,
  };
}

export function sameChartDefinition(a: SavedChartDefinition, b: SavedChartDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

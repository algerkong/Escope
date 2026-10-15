import { parseChartDefinition, parseChartDefinitionBody, type ChartDefinition, type ChartDefinitionBody } from './chart-definitions';
import type { ExecutionSnapshot } from './query';
import { parseAggregationBuild, type AggregationBuildDraft } from './query-aggregation-build';
import { DOC_COUNT_MEASURE } from './query-aggregation-charts';
import type { AggregationResult, MetricAggregationType } from './query-aggregations';
import { boundedParameterJson } from './query-parameters';
import { property, rawTextOf } from './query-result';
import type { ChartAggregationClause, SavedChartDefinition } from './saved-charts';

export interface ResultChartDefinitionSource extends ChartDefinitionBody {
  readonly connectionId: string;
  readonly aggregation: string;
}

/** The executed definition, not bucket counts, labels or the current editor, owns every field. */
export function chartDefinitionFromResult(
  snapshot: ExecutionSnapshot,
  entry: AggregationResult,
  measure: string | null = null,
): ResultChartDefinitionSource | null {
  if ((entry.status !== 'metric' && entry.status !== 'buckets') || entry.rawDefinition === null) return null;
  const root = boundedParameterJson(snapshot.rawDsl);
  if (!root || root.type !== 'object') return null;
  const short = property(root, 'aggs');
  const long = property(root, 'aggregations');
  if (short && long) return null;
  const container = short ?? long;
  if (container?.type !== 'object') return null;
  const definition = property(container, entry.name);
  if (!definition || rawTextOf(snapshot.rawDsl, definition) !== entry.rawDefinition) return null;
  if (property(definition, 'meta')) return null;
  const children = property(definition, 'aggs') ?? property(definition, 'aggregations');
  if (children?.children?.some((child) => {
    const value = child.children?.[1];
    return value !== undefined && property(value, 'meta') !== undefined;
  })) return null;
  const parsed = parseAggregationBuild(`{"aggs":{${JSON.stringify(entry.name)}:${entry.rawDefinition}}}`);
  if (!parsed.ok || parsed.preserved.length > 0) return null;
  if (entry.status === 'metric'
    ? parsed.draft.group !== null || parsed.draft.metrics.length !== 1 || parsed.draft.metrics[0]?.type !== entry.type
    : parsed.draft.group?.type !== entry.type) return null;
  const body = parseChartDefinitionBody({
    index: snapshot.index,
    draft: parsed.draft,
    measure: measure ?? (entry.status === 'metric' ? entry.name : DOC_COUNT_MEASURE),
  });
  return body ? { ...body, connectionId: snapshot.connectionId, aggregation: entry.name } : null;
}

const METRIC_KEYS = ['id', 'name', 'aggregationType', 'field'];
const TERMS_KEYS = [...METRIC_KEYS, 'size', 'subMetrics'];
const DATE_KEYS = [...METRIC_KEYS, 'intervalType', 'interval', 'subMetrics'];

function supportedClause(clause: ChartAggregationClause): boolean {
  const allowed = clause.aggregationType === 'terms' ? TERMS_KEYS
    : clause.aggregationType === 'date_histogram' ? DATE_KEYS : METRIC_KEYS;
  return Object.entries(clause).every(([key, value]) => value === undefined || allowed.includes(key));
}

/**
 * Legacy rows stay in their own library. Only a lossless supported shape can seed the canonical
 * build review; ordering/min_doc_count/mixed groups are not silently discarded or auto-migrated.
 */
export function legacyChartDefinition(legacy: SavedChartDefinition): ChartDefinition | null {
  if (!legacy.connectionId || legacy.clauses.length === 0 || !legacy.clauses.every(supportedClause)) return null;
  const groups = legacy.clauses.filter((clause) => clause.aggregationType === 'terms' || clause.aggregationType === 'date_histogram');
  if (groups.length > 1 || groups.length === 1 && legacy.clauses.length !== 1) return null;
  const group = groups[0];
  const metrics = group
    ? (group.subMetrics ?? []).map((metric) => ({ name: metric.name, type: metric.metricType, field: metric.field }))
    : legacy.clauses.map((clause) => ({ name: clause.name, type: clause.aggregationType as MetricAggregationType, field: clause.field }));
  const draft: AggregationBuildDraft = {
    group: !group ? null : group.aggregationType === 'terms'
      ? { name: group.name, type: 'terms', field: group.field, size: String(group.size ?? 10) }
      : {
        name: group.name, type: 'date_histogram', field: group.field,
        interval: group.intervalType === 'fixed' ? 'fixed_interval' : 'calendar_interval',
        intervalValue: group.interval ?? '1d', timeZone: '',
      },
    metrics,
  };
  return parseChartDefinition({
    id: legacy.id, name: legacy.name, connectionId: legacy.connectionId, index: legacy.index, draft,
    measure: legacy.preferredMetric === '_count' ? DOC_COUNT_MEASURE
      : legacy.preferredMetric ?? (group ? DOC_COUNT_MEASURE : metrics[0]?.name ?? ''),
  });
}

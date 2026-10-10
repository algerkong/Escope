import { validDataViewIndex } from './data-views';
import {
  AGGREGATION_BUILD_LIMITS, BUILD_INTERVALS, BUILD_METRIC_TYPES, validateAggregationDraft,
  type AggregationBuildDraft, type BuildGroup, type BuildInterval, type BuildMetric,
} from './query-aggregation-build';
import { DOC_COUNT_MEASURE } from './query-aggregation-charts';
import type { MetricAggregationType } from './query-aggregations';

/**
 * Bounded local chart definitions: what to group by, which metrics to collect and which measure
 * to plot, plus the query target they belong to.
 *
 * A definition is a *review input*, not a result. It stores literal names, types and fields only:
 * no parsed aggregation values, plotted numbers, field-capability evidence, time boundaries,
 * endpoints, credentials or result bodies. Saving, loading, reuse and import never run a query or
 * open a PIT; reuse only seeds the aggregation build review, which still needs an explicit
 * preview and apply. The chart kind stays derived from the executed DSL, so no display kind is
 * stored here either.
 */

export const CHART_DEFINITION_VERSION = 1;
export const MAX_CHART_DEFINITIONS = 100;
export const MAX_CHART_DEFINITIONS_BYTES = 256 * 1024;
export const MAX_CHART_NAME_CHARS = 120;
export const MAX_CHART_MEASURE_BYTES = AGGREGATION_BUILD_LIMITS.nameBytes;

export interface ChartDefinition {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly index: string;
  readonly draft: AggregationBuildDraft;
  readonly measure: string;
}

export interface ChartDefinitionLibrary {
  readonly version: number;
  readonly entries: readonly ChartDefinition[];
}

export interface ChartDefinitionRecord {
  readonly revision: number;
  readonly library: ChartDefinitionLibrary;
}

/** A reuse copy owned by the dialog; library edits never rewrite an already captured selection. */
export interface ChartDefinitionSelection {
  readonly version: number;
  readonly definition: ChartDefinition;
}

/** The saved target must follow the same index grammar Data Views and storage accept. */
export const validChartTarget = (index: string): boolean => validDataViewIndex(index);

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string';

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function validName(value: unknown): value is string {
  return text(value) && value.trim() === value && value !== '' && [...value].length <= MAX_CHART_NAME_CHARS
    && ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    });
}

/** Literal text fields only: a stored number or object is a corrupt definition, never a coercion. */
function parseMetric(value: unknown): BuildMetric | null {
  if (!shape(value, ['name', 'type', 'field'])) return null;
  if (!text(value.name) || !text(value.type) || !text(value.field)) return null;
  if (!(BUILD_METRIC_TYPES as readonly string[]).includes(value.type)) return null;
  return { name: value.name, type: value.type as MetricAggregationType, field: value.field };
}

function parseGroup(value: unknown): BuildGroup | null {
  if (value === null) return null;
  if (shape(value, ['name', 'type', 'field', 'size'])) {
    if (!text(value.name) || value.type !== 'terms' || !text(value.field) || !text(value.size)) return null;
    return { name: value.name, type: 'terms', field: value.field, size: value.size };
  }
  if (shape(value, ['name', 'type', 'field', 'interval', 'intervalValue', 'timeZone'])) {
    if (!text(value.name) || value.type !== 'date_histogram' || !text(value.field) || !text(value.intervalValue)
      || !text(value.timeZone) || !BUILD_INTERVALS.includes(value.interval as BuildInterval)) return null;
    return {
      name: value.name, type: 'date_histogram', field: value.field,
      interval: value.interval as BuildInterval, intervalValue: value.intervalValue, timeZone: value.timeZone,
    };
  }
  return null;
}

function parseDraft(value: unknown): AggregationBuildDraft | null {
  if (!shape(value, ['group', 'metrics']) || !Array.isArray(value.metrics)) return null;
  const group = value.group === null ? null : parseGroup(value.group);
  if (value.group !== null && group === null) return null;
  const metrics: BuildMetric[] = [];
  for (const metric of value.metrics) {
    const parsed = parseMetric(metric);
    if (!parsed) return null;
    metrics.push(parsed);
  }
  const draft: AggregationBuildDraft = { group, metrics };
  return validateAggregationDraft(draft) === null ? draft : null;
}

/** The measure must exist in the definition: `doc_count` for a grouped chart, a metric for a single value. */
function validMeasure(measure: unknown, draft: AggregationBuildDraft): measure is string {
  if (!text(measure) || measure === '' || bytes(measure) > MAX_CHART_MEASURE_BYTES) return false;
  const names = draft.metrics.map((metric) => metric.name);
  return draft.group === null ? names.includes(measure) : measure === DOC_COUNT_MEASURE || names.includes(measure);
}

export function parseChartDefinition(value: unknown): ChartDefinition | null {
  if (!shape(value, ['id', 'name', 'connectionId', 'index', 'draft', 'measure'])) return null;
  if (!identifier(value.id) || !identifier(value.connectionId) || !validName(value.name)) return null;
  if (!text(value.index) || !validDataViewIndex(value.index)) return null;
  const draft = parseDraft(value.draft);
  if (!draft || (draft.group === null && draft.metrics.length === 0)) return null;
  if (!validMeasure(value.measure, draft)) return null;
  return { id: value.id, name: value.name, connectionId: value.connectionId, index: value.index, draft, measure: value.measure };
}

export function chartDefinitionPayload(definition: ChartDefinition): ChartDefinition {
  const parsed = parseChartDefinition(definition);
  if (!parsed) throw new Error('invalidChartDefinition');
  return parsed;
}

export function emptyChartDefinitions(): ChartDefinitionLibrary {
  return { version: CHART_DEFINITION_VERSION, entries: [] };
}

export function parseChartDefinitionLibrary(value: unknown): ChartDefinitionLibrary | null {
  if (!shape(value, ['version', 'entries']) || value.version !== CHART_DEFINITION_VERSION || !Array.isArray(value.entries)) return null;
  if (value.entries.length > MAX_CHART_DEFINITIONS) return null;
  const ids = new Set<string>();
  const entries: ChartDefinition[] = [];
  for (const candidate of value.entries) {
    const entry = parseChartDefinition(candidate);
    if (!entry || ids.has(entry.id)) return null;
    ids.add(entry.id);
    entries.push(entry);
  }
  const library: ChartDefinitionLibrary = { version: CHART_DEFINITION_VERSION, entries };
  return bytes(JSON.stringify(library)) <= MAX_CHART_DEFINITIONS_BYTES ? library : null;
}

export function parseChartDefinitionRecord(value: unknown): ChartDefinitionRecord | null {
  if (!shape(value, ['revision', 'library']) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return null;
  const library = parseChartDefinitionLibrary(value.library);
  return library && (value.revision !== 0 || library.entries.length === 0)
    ? { revision: value.revision as number, library } : null;
}

export function sameChartDefinition(left: ChartDefinition, right: ChartDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Reuse keeps its own frozen copy: later library edits never change an already opened review. */
export function selectChartDefinition(definition: ChartDefinition): ChartDefinitionSelection {
  const parsed = parseChartDefinition(definition);
  if (!parsed) throw new Error('invalidChartDefinition');
  return { version: CHART_DEFINITION_VERSION, definition: parsed };
}

export function freezeChartDefinitionSelection(selection: ChartDefinitionSelection): ChartDefinitionSelection {
  const copy = selectChartDefinition({ ...selection.definition, draft: { ...selection.definition.draft } });
  const { group, metrics } = copy.definition.draft;
  if (group) Object.freeze(group);
  for (const metric of metrics) Object.freeze(metric);
  Object.freeze(metrics);
  Object.freeze(copy.definition.draft);
  Object.freeze(copy.definition);
  return Object.freeze(copy);
}

/** A definition is reusable only on the exact connection ID and target it was saved for. */
export function parseChartDefinitionForTarget(value: unknown, connectionId: string | null, index: string): ChartDefinitionSelection | null {
  if (!shape(value, ['version', 'definition']) || value.version !== CHART_DEFINITION_VERSION) return null;
  const definition = parseChartDefinition(value.definition);
  return definition && definition.connectionId === connectionId && definition.index === index
    ? selectChartDefinition(definition) : null;
}

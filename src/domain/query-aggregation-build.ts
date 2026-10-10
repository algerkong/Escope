import { applyEdits, type Edit, type Node } from 'jsonc-parser';
import { AGGREGATION_LIMITS, type MetricAggregationType } from './query-aggregations';
import type { QueryDocument, QueryDocumentPatch } from './query';
import { validateQueryDsl } from './query-dsl';
import { boundedParameterJson } from './query-parameters';
import { property, rawTextOf, textOf } from './query-result';
import { copyQueryTimeRange, parseQueryTimeRange } from './query-time-range';
import type { FieldCatalog } from './resource';

/**
 * Review-only "group + metric" aggregation build.
 *
 * The draft model is exactly the shape the aggregation reader can interpret: one single-level
 * `terms`/`date_histogram` group holding direct metrics, or a flat set of metrics with no group.
 * Top-level entries that are not that shape stay in the DSL as `preserved` members with their
 * original value text instead of being re-emitted or dropped, so building never deletes an
 * advanced aggregation. Nothing here sends a request, opens a PIT or executes; the only output
 * is a complete DSL text for explicit review.
 */

export const AGGREGATION_BUILD_LIMITS = Object.freeze({
  dslBytes: AGGREGATION_LIMITS.dslBytes,
  nameBytes: AGGREGATION_LIMITS.nameBytes,
  definitions: AGGREGATION_LIMITS.definitions,
  /** One group plus its direct metrics fills the reader's definition cap. */
  metrics: AGGREGATION_LIMITS.definitions - 1,
  sizeMax: 1000,
  intervalChars: 64,
  zoneChars: 100,
});

export const BUILD_METRIC_TYPES: readonly MetricAggregationType[] = ['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'];
export const BUILD_GROUP_TYPES: readonly BuildGroupType[] = ['terms', 'date_histogram'];
export const BUILD_INTERVALS: readonly BuildInterval[] = ['calendar_interval', 'fixed_interval'];

export type BuildGroupType = 'terms' | 'date_histogram';
export type BuildInterval = 'calendar_interval' | 'fixed_interval';

export type BuildGroup =
  | { readonly name: string; readonly type: 'terms'; readonly field: string; readonly size: string }
  | {
    readonly name: string;
    readonly type: 'date_histogram';
    readonly field: string;
    readonly interval: BuildInterval;
    readonly intervalValue: string;
    readonly timeZone: string;
  };

export interface BuildMetric { readonly name: string; readonly type: MetricAggregationType; readonly field: string }

export interface AggregationBuildDraft { readonly group: BuildGroup | null; readonly metrics: readonly BuildMetric[] }

/** A top-level aggregation this build does not own; its value text is carried unchanged. */
export interface PreservedAggregation { readonly name: string; readonly raw: string }

export type AggregationBuildProblem =
  | 'invalidDsl' | 'tooLarge' | 'ambiguousAggs' | 'invalidAggs'
  | 'tooManyGroups' | 'tooManyMetrics' | 'mixedShape' | 'tooComplex'
  | 'invalidName' | 'duplicateName' | 'nameConflict'
  | 'invalidField' | 'fieldPath' | 'fieldNested' | 'fieldUnchecked' | 'fieldMissing'
  | 'fieldUnmapped' | 'fieldConflict' | 'fieldNotAggregatable' | 'fieldUnsupported'
  | 'invalidShape' | 'invalidSize' | 'invalidInterval' | 'invalidZone' | 'invalidMetricType'
  | 'invalidBinding' | 'emissionMismatch';

type Failure = { readonly ok: false; readonly code: AggregationBuildProblem; readonly name?: string };

export type AggregationBuildParse = Failure | Reversed;

export type AggregationBuildPreview = Failure | {
  readonly ok: true;
  readonly dsl: string;
  readonly patch: QueryDocumentPatch;
  readonly changed: boolean;
  readonly preserved: readonly PreservedAggregation[];
};

type FieldEvidenceOk = { readonly ok: true; readonly fieldType: string; readonly origin: 'mapped' | 'runtime' };
export type BuildFieldEvidence = Failure | FieldEvidenceOk;

const GROUP_KEYS = { terms: ['name', 'type', 'field', 'size'], date_histogram: ['name', 'type', 'field', 'interval', 'intervalValue', 'timeZone'] } as const;
const NUMERIC_TYPES = ['byte', 'short', 'integer', 'long', 'unsigned_long', 'half_float', 'float', 'double', 'scaled_float'];
const KEYWORD_TYPES = ['keyword', 'constant_keyword', 'wildcard'];
const DATE_TYPES = ['date', 'date_nanos'];
/** Doc-values types the conservative first-batch gate lets through for buckets and value counts. */
const VALUES_TYPES = [...NUMERIC_TYPES, ...KEYWORD_TYPES, ...DATE_TYPES, 'boolean', 'ip'];
const METRIC_TYPES = {
  sum: NUMERIC_TYPES, avg: NUMERIC_TYPES, min: VALUES_TYPES, max: VALUES_TYPES,
  value_count: VALUES_TYPES, cardinality: VALUES_TYPES,
} as const satisfies Record<MetricAggregationType, readonly string[]>;
const SIZE_TOKEN = /^(?:0|[1-9]\d*)$/;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

function membersOf(node: Node | undefined): readonly { name: string; value: Node }[] {
  return node?.type === 'object'
    ? (node.children ?? []).flatMap((entry) => {
      const name = textOf(entry.children?.[0]);
      const value = entry.children?.[1];
      return typeof name === 'string' && value ? [{ name, value }] : [];
    })
    : [];
}

/** The single aggregation-type member of a definition, ignoring `meta` and child buckets. */
function typeMember(node: Node): { name: string; value: Node } | null {
  if (node.type !== 'object') return null;
  const types = membersOf(node).filter(({ name }) => name !== 'meta' && name !== 'aggs' && name !== 'aggregations');
  return types.length === 1 ? types[0]! : null;
}

/** Direct child aggregation members, or `null` when the node is ambiguous or malformed about them. */
function childMembers(node: Node): readonly { name: string; value: Node }[] | null {
  const short = property(node, 'aggs');
  const long = property(node, 'aggregations');
  if (short && long) return null;
  const children = short ?? long;
  if (children === undefined) return [];
  return children.type === 'object' ? membersOf(children) : null;
}

/** `{"<metric>":{"field":"f"}}` and nothing else; any other option stays handwritten. */
function reverseMetric(name: string, node: Node): BuildMetric | null {
  if (property(node, 'aggs') || property(node, 'aggregations')) return null;
  const type = typeMember(node);
  if (!type || !(BUILD_METRIC_TYPES as readonly string[]).includes(type.name)) return null;
  const options = membersOf(type.value);
  if (options.length !== 1 || options[0]!.name !== 'field' || options[0]!.value.type !== 'string') return null;
  const field = textOf(options[0]!.value);
  return typeof field === 'string' ? { name, type: type.name as MetricAggregationType, field } : null;
}

/** One single-level group plus its direct metrics, or `null` when any part is handwritten work. */
function reverseGroup(source: string, name: string, node: Node): { group: BuildGroup; metrics: BuildMetric[] } | null {
  if (property(node, 'meta')) return null;
  const type = typeMember(node);
  if (!type || !BUILD_GROUP_TYPES.includes(type.name as BuildGroupType)) return null;
  const children = childMembers(node);
  if (children === null) return null;
  const metrics: BuildMetric[] = [];
  for (const child of children) {
    const metric = reverseMetric(child.name, child.value);
    if (!metric) return null;
    metrics.push(metric);
  }
  const options = membersOf(type.value);
  const field = options.find((entry) => entry.name === 'field');
  if (!field || field.value.type !== 'string' || typeof textOf(field.value) !== 'string') return null;
  const value = textOf(field.value)!;
  if (type.name === 'terms') {
    if (!options.every((entry) => entry.name === 'field' || entry.name === 'size')) return null;
    const size = options.find((entry) => entry.name === 'size');
    const token = size ? rawTextOf(source, size.value) : null;
    if (size && (size.value.type !== 'number' || token === null || !SIZE_TOKEN.test(token))) return null;
    return { group: { name, type: 'terms', field: value, size: size ? token! : '' }, metrics };
  }
  const intervals = options.filter((entry) => BUILD_INTERVALS.includes(entry.name as BuildInterval));
  const zones = options.filter((entry) => entry.name === 'time_zone');
  if (intervals.length !== 1 || zones.length > 1) return null;
  if (!options.every((entry) => entry.name === 'field' || entry.name === 'time_zone'
    || BUILD_INTERVALS.includes(entry.name as BuildInterval))) return null;
  const interval = intervals[0]!;
  const intervalValue = textOf(interval.value);
  if (interval.value.type !== 'string' || typeof intervalValue !== 'string') return null;
  const zone = zones[0];
  const timeZone = zone ? textOf(zone.value) : null;
  if (zone && (zone.value.type !== 'string' || timeZone === null)) return null;
  return {
    group: {
      name, type: 'date_histogram', field: value, interval: interval.name as BuildInterval,
      intervalValue, timeZone: timeZone ?? '',
    },
    metrics,
  };
}

function reverseContainer(source: string, container: Node): AggregationBuildParse {
  let grouped: { group: BuildGroup; metrics: BuildMetric[] } | null = null;
  let groups = 0;
  const flat: BuildMetric[] = [];
  const preserved: PreservedAggregation[] = [];
  for (const { name, value } of membersOf(container)) {
    const metric = reverseMetric(name, value);
    if (metric) { flat.push(metric); continue; }
    const entry = reverseGroup(source, name, value);
    if (entry) {
      groups += 1;
      grouped ??= entry;
      continue;
    }
    const raw = rawTextOf(source, value);
    if (raw === null || raw === '') return { ok: false, code: 'invalidAggs' };
    preserved.push({ name, raw });
  }
  if (groups > 1) return { ok: false, code: 'tooManyGroups' };
  if (grouped && flat.length > 0) return { ok: false, code: 'mixedShape' };
  const draft: AggregationBuildDraft = grouped
    ? { group: grouped.group, metrics: grouped.metrics }
    : { group: null, metrics: flat };
  if (draft.metrics.length > AGGREGATION_BUILD_LIMITS.metrics) return { ok: false, code: 'tooManyMetrics' };
  return { ok: true, draft, preserved };
}

type Container = { readonly status: 'ambiguous' } | { readonly status: 'absent' }
  | { readonly status: 'found'; readonly node: Node };

function containerOf(root: Node): Container {
  const short = property(root, 'aggs');
  const long = property(root, 'aggregations');
  if (short && long) return { status: 'ambiguous' };
  const found = short ?? long;
  if (found === undefined) return { status: 'absent' };
  return { status: 'found', node: found };
}

interface Reversed { readonly ok: true; readonly draft: AggregationBuildDraft; readonly preserved: readonly PreservedAggregation[] }
type Body = Failure | { readonly ok: true; readonly root: Node; readonly container: Node | undefined; readonly parsed: Reversed };

function readBody(rawDsl: string): Body {
  if (bytes(rawDsl) > AGGREGATION_BUILD_LIMITS.dslBytes) return { ok: false, code: 'tooLarge' };
  if (!validateQueryDsl(rawDsl).ok) return { ok: false, code: 'invalidDsl' };
  const root = boundedParameterJson(rawDsl);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidDsl' };
  const current = containerOf(root);
  if (current.status === 'ambiguous') return { ok: false, code: 'ambiguousAggs' };
  if (current.status === 'absent') {
    return { ok: true, root, container: undefined, parsed: { ok: true, draft: { group: null, metrics: [] }, preserved: [] } };
  }
  if (current.node.type !== 'object') return { ok: false, code: 'invalidAggs' };
  const parsed = reverseContainer(rawDsl, current.node);
  return parsed.ok ? { ok: true, root, container: current.node, parsed } : parsed;
}

/** Reverse the aggregations this build owns, and list the handwritten ones it keeps verbatim. */
export function parseAggregationBuild(rawDsl: string): AggregationBuildParse {
  const body = readBody(rawDsl);
  return body.ok ? body.parsed : body;
}

function validLabel(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || bytes(value) > AGGREGATION_BUILD_LIMITS.nameBytes) return false;
  return value !== '$param' && ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });
}

/**
 * Same-target field capabilities and the current DSL runtime declarations gate the draft.
 * They are evidence only: doc values, index coverage, script compilation and permissions are
 * still decided by Elasticsearch, and a refusal here never means a query was rejected.
 */
function fieldEvidence(root: Node, field: string, allowed: readonly string[], catalog?: FieldCatalog): BuildFieldEvidence {
  if (!validLabel(field)) return { ok: false, code: 'invalidField' };
  if (field.includes('.')) return { ok: false, code: 'fieldPath' };
  if (!catalog) return { ok: false, code: 'fieldUnchecked' };
  if (catalog.fields.some((entry) => entry.types.some((type) => type.type === 'nested')
    && (entry.name === field || field.startsWith(`${entry.name}.`)))) return { ok: false, code: 'fieldNested' };
  const runtime = property(property(root, 'runtime_mappings'), field);
  if (runtime) {
    const type = textOf(property(runtime, 'type'));
    return typeof type === 'string' && allowed.includes(type)
      ? { ok: true, fieldType: type, origin: 'runtime' } : { ok: false, code: 'fieldUnsupported' };
  }
  const capability = catalog.fields.find((entry) => entry.name === field);
  if (!capability || !capability.types.length) return { ok: false, code: 'fieldMissing' };
  const mapped = capability.types.filter((type) => type.type !== 'unmapped');
  if (!mapped.length) return { ok: false, code: 'fieldUnmapped' };
  if (mapped.length !== 1 || capability.conflict) return { ok: false, code: 'fieldConflict' };
  const type = mapped[0]!;
  if (type.metadata || !allowed.includes(type.type)) return { ok: false, code: 'fieldUnsupported' };
  if (!type.aggregatable) return { ok: false, code: 'fieldNotAggregatable' };
  return { ok: true, fieldType: type.type, origin: 'mapped' };
}

/** The doc-values types one draft row may use, so the UI can request evidence per row. */
export function allowedFieldTypes(draft: AggregationBuildDraft): readonly (readonly string[])[] {
  return [
    ...(draft.group ? [draft.group.type === 'date_histogram' ? DATE_TYPES : VALUES_TYPES] : []),
    ...draft.metrics.map((metric) => METRIC_TYPES[metric.type] ?? VALUES_TYPES),
  ];
}

const draftFields = (draft: AggregationBuildDraft): readonly string[] =>
  [...(draft.group ? [draft.group.field] : []), ...draft.metrics.map((metric) => metric.field)];

/** Field evidence per drafted row, in group-then-metric order. Missing capabilities are evidence, not refusal by Elasticsearch. */
export function aggregationBuildEvidence(rawDsl: string, draft: AggregationBuildDraft, catalog?: FieldCatalog): readonly BuildFieldEvidence[] {
  const body = readBody(rawDsl);
  const fields = draftFields(draft);
  const allowed = allowedFieldTypes(draft);
  return fields.map((field, position) => body.ok
    ? fieldEvidence(body.root, field, allowed[position] ?? VALUES_TYPES, catalog)
    : body);
}

export function emptyAggregationDraft(): AggregationBuildDraft {
  return { group: null, metrics: [] };
}

function sameGroup(a: BuildGroup | null, b: BuildGroup | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.type !== b.type) return false;
  const terms = (x: BuildGroup): string => x.type === 'terms' ? x.size
    : `${x.interval}|${x.intervalValue}|${x.timeZone}`;
  return a.name === b.name && a.field === b.field && terms(a) === terms(b);
}

function sameDraft(a: AggregationBuildDraft, b: AggregationBuildDraft): boolean {
  if (!sameGroup(a.group, b.group) || a.metrics.length !== b.metrics.length) return false;
  return a.metrics.every((metric, index) => {
    const other = b.metrics[index]!;
    return metric.name === other.name && metric.type === other.type && metric.field === other.field;
  });
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validShape(draft: AggregationBuildDraft): boolean {
  if (!hasExactKeys(draft, ['group', 'metrics'])) return false;
  const group = draft.group;
  if (group && !hasExactKeys(group, GROUP_KEYS[group.type] ?? [])) return false;
  return draft.metrics.every((metric) => hasExactKeys(metric, ['name', 'type', 'field']));
}

function checkDraft(draft: AggregationBuildDraft): AggregationBuildProblem | null {
  const { group, metrics } = draft;
  if (metrics.length > AGGREGATION_BUILD_LIMITS.metrics) return 'tooManyMetrics';
  if (group) {
    if (!validLabel(group.name)) return 'invalidName';
    if (!validLabel(group.field)) return 'invalidField';
    if (group.type === 'terms') {
      if (group.size !== '' && (!SIZE_TOKEN.test(group.size)
        || Number(group.size) < 1 || Number(group.size) > AGGREGATION_BUILD_LIMITS.sizeMax)) return 'invalidSize';
    } else {
      if (!BUILD_INTERVALS.includes(group.interval)) return 'invalidInterval';
      if (group.intervalValue === '' || group.intervalValue !== group.intervalValue.trim()
        || group.intervalValue.length > AGGREGATION_BUILD_LIMITS.intervalChars) return 'invalidInterval';
      if (group.timeZone !== '' && (group.timeZone.length > AGGREGATION_BUILD_LIMITS.zoneChars
        || group.timeZone !== group.timeZone.trim())) return 'invalidZone';
    }
  }
  for (const metric of metrics) {
    if (!validLabel(metric.name)) return 'invalidName';
    if (!validLabel(metric.field)) return 'invalidField';
    if (!BUILD_METRIC_TYPES.includes(metric.type)) return 'invalidMetricType';
  }
  const names = [group?.name, ...metrics.map((metric) => metric.name)].filter((name): name is string => name !== undefined);
  return new Set(names).size === names.length ? null : 'duplicateName';
}

/**
 * Check a draft against the buildable shape and its own limits. Saved chart definitions reuse
 * this so a stored definition never describes something the builder would refuse to produce.
 */
export function validateAggregationDraft(draft: AggregationBuildDraft): AggregationBuildProblem | null {
  return validShape(draft) ? checkDraft(draft) : 'invalidShape';
}

/**
 * Top-level entries plus their direct children: the same quantity the aggregation reader caps.
 * Children of handwritten entries are counted because those entries stay in the built DSL.
 */
function definitionCount(container: Node | undefined, original: AggregationBuildDraft,
  draft: AggregationBuildDraft, preserved: readonly PreservedAggregation[]): number {
  const replaced = new Set<string>([original.group?.name, ...original.metrics.map((metric) => metric.name)]
    .filter((name): name is string => name !== undefined));
  let children = draft.group ? draft.metrics.length : 0;
  for (const { name, value } of membersOf(container)) {
    if (replaced.has(name)) continue;
    const nested = childMembers(value);
    children += nested === null ? membersOf(property(value, 'aggs')).length + membersOf(property(value, 'aggregations')).length : nested.length;
  }
  return preserved.length + (draft.group ? 1 : 0) + (draft.group ? 0 : draft.metrics.length) + children;
}

function metricText(metric: BuildMetric): string {
  return `${JSON.stringify(metric.name)}:{"${metric.type}":{"field":${JSON.stringify(metric.field)}}}`;
}

function groupText(group: BuildGroup, metrics: readonly BuildMetric[]): string {
  const options = group.type === 'terms'
    ? `"field":${JSON.stringify(group.field)}${group.size === '' ? '' : `,"size":${group.size}`}`
    : `"field":${JSON.stringify(group.field)},${JSON.stringify(group.interval)}:${JSON.stringify(group.intervalValue)}`
      + `${group.timeZone === '' ? '' : `,"time_zone":${JSON.stringify(group.timeZone)}`}`;
  const children = metrics.length === 0 ? '' : `,"aggs":{${metrics.map(metricText).join(',')}}`;
  return `${JSON.stringify(group.name)}:{"${group.type}":{${options}}${children}}`;
}

function draftText(draft: AggregationBuildDraft): string {
  return draft.group ? groupText(draft.group, draft.metrics) : draft.metrics.map(metricText).join(',');
}

/** Builder-managed entries first; handwritten entries keep their exact original value text. */
function contentText(draft: AggregationBuildDraft, preserved: readonly PreservedAggregation[]): string {
  return [draftText(draft), ...preserved.map(({ name, raw }) => `${JSON.stringify(name)}:${raw}`)]
    .filter((text) => text !== '').join(',');
}

/** Only the aggregation container is rewritten; every other root property keeps its original bytes. */
function aggsEdit(root: Node, original: AggregationBuildDraft, draft: AggregationBuildDraft,
  preserved: readonly PreservedAggregation[]): Edit | null {
  if (sameDraft(original, draft)) return null;
  const props = root.children ?? [];
  const index = props.findIndex((entry) => {
    const name = textOf(entry.children?.[0]);
    return name === 'aggs' || name === 'aggregations';
  });
  const target = props[index];
  const content = contentText(draft, preserved);
  if (!target) {
    if (content === '') return null;
    const last = props.at(-1);
    return { offset: last ? last.offset + last.length : root.offset + 1, length: 0, content: `${last ? ',' : ''}"aggs":{${content}}` };
  }
  const value = target.children?.[1];
  if (!value) return null;
  if (content !== '') return { offset: value.offset, length: value.length, content: `{${content}}` };
  if (props.length === 1) return { offset: target.offset, length: target.length, content: '' };
  if (index === 0) return { offset: target.offset, length: props[1]!.offset - target.offset, content: '' };
  const previous = props[index - 1]!;
  const offset = previous.offset + previous.length;
  return { offset, length: target.offset + target.length - offset, content: '' };
}

function samePreserved(a: readonly PreservedAggregation[], b: readonly PreservedAggregation[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index]!;
    return entry.name === other.name && entry.raw === other.raw;
  });
}

/**
 * Build the complete DSL for review. The aggregation block is re-read from `source` on every
 * call, so a stale draft, a newer field catalogue or an unexpected handwritten entry fails the
 * review instead of overwriting anything. Unsupported or over-limit combinations reject as a
 * whole; the result never combines with a run, a PIT or a request.
 */
export function previewAggregationBuild(source: QueryDocument, draft: AggregationBuildDraft, catalog?: FieldCatalog): AggregationBuildPreview {
  const body = readBody(source.dsl);
  if (!body.ok) return body;
  const { root, container, parsed } = body;
  const { preserved } = parsed;
  const problem = validateAggregationDraft(draft);
  if (problem) return { ok: false, code: problem };
  const names = new Set(preserved.map(({ name }) => name));
  const drafted = [draft.group?.name, ...draft.metrics.map((metric) => metric.name)].filter((name): name is string => name !== undefined);
  if (drafted.some((name) => names.has(name))) return { ok: false, code: 'nameConflict' };
  if (definitionCount(container, parsed.draft, draft, preserved) > AGGREGATION_BUILD_LIMITS.definitions) {
    return { ok: false, code: 'tooComplex' };
  }
  const allowed = allowedFieldTypes(draft);
  const fields = draftFields(draft);
  for (const [position, field] of fields.entries()) {
    const evidence = fieldEvidence(root, field, allowed[position] ?? VALUES_TYPES, catalog);
    if (!evidence.ok) return evidence;
  }
  const edit = aggsEdit(root, parsed.draft, draft, preserved);
  const dsl = edit ? applyEdits(source.dsl, [edit]) : source.dsl;
  if (bytes(dsl) > AGGREGATION_BUILD_LIMITS.dslBytes) return { ok: false, code: 'tooLarge' };
  const after = readBody(dsl);
  if (!after.ok) return after;
  if (!sameDraft(after.parsed.draft, draft) || !samePreserved(after.parsed.preserved, preserved)) {
    return { ok: false, code: 'emissionMismatch' };
  }
  const time = source.timeRange === undefined ? undefined
    : parseQueryTimeRange(source.timeRange, source.connectionId, source.index, source.dsl);
  if (time === null) return { ok: false, code: 'invalidBinding' };
  if (time && !parseQueryTimeRange(time, source.connectionId, source.index, dsl)) return { ok: false, code: 'invalidBinding' };
  return {
    ok: true, dsl, changed: dsl !== source.dsl, preserved,
    patch: { dsl, ...(time ? { timeRange: copyQueryTimeRange(time) } : {}) },
  };
}

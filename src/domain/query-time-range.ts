import { Temporal } from '@js-temporal/polyfill';
import { applyEdits, getNodeValue, type Node } from 'jsonc-parser';
import type { QueryDocument } from './query';
import { boundedParameterJson } from './query-parameters';
import { validateQueryDsl } from './query-dsl';
import { property, sliceRaw } from './query-result';
import { parseRuntimeMappings } from './runtime-fields';
import type { FieldCatalog } from './resource';

export const TIME_RANGE_VERSION = 1;
export const MAX_TIME_RANGE_DSL_BYTES = 256 * 1024;
export const MAX_TIME_RANGE_AMOUNT = 10000;
export const MAX_TIME_RANGE_DAYS = 3660;
export const TIME_RANGE_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const;
export type TimeRangeUnit = typeof TIME_RANGE_UNITS[number];

export interface TimeRangeDefinition {
  readonly field: string;
  readonly fieldType: 'date' | 'date_nanos';
  readonly timeZone: string;
  readonly range:
    | { readonly kind: 'relative'; readonly amount: number; readonly unit: TimeRangeUnit }
    | { readonly kind: 'absolute'; readonly from: string; readonly to: string };
}

export interface TimeRangeBounds {
  readonly resolvedAt: string;
  readonly from: string;
  readonly to: string;
}

export interface ExecutionTimeRange {
  readonly version: number;
  readonly definition: TimeRangeDefinition;
  readonly bounds: TimeRangeBounds;
}

/** Only an explicitly applied wrapper is managed; ordinary DSL edits detach this metadata. */
export interface QueryTimeRange extends ExecutionTimeRange {
  readonly binding: { readonly connectionId: string; readonly index: string };
  readonly hadQuery: boolean;
}

export type TimeRangeProblem =
  | 'invalidDefinition' | 'invalidTimeZone' | 'invalidDate' | 'ambiguousTime'
  | 'rangeOrder' | 'rangeLimit' | 'precisionMismatch' | 'dateOutOfRange'
  | 'invalidDsl' | 'unsupportedDsl' | 'manualConflict' | 'invalidBinding' | 'tooLarge'
  | 'fieldConflict' | 'fieldNotDate' | 'fieldNotSearchable' | 'fieldNested' | 'runtimeNotApplied';

export type TimeRangeResolution =
  | { readonly ok: true; readonly bounds: TimeRangeBounds }
  | { readonly ok: false; readonly code: TimeRangeProblem };

export type TimeRangePreview =
  | { readonly ok: true; readonly dsl: string; readonly timeRange: QueryTimeRange }
  | { readonly ok: false; readonly code: TimeRangeProblem };

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const SECONDS: Record<TimeRangeUnit, bigint> = { seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n };
const NANOSECOND = 1_000_000_000n;
const MAX_SPAN = BigInt(MAX_TIME_RANGE_DAYS) * SECONDS.days * NANOSECOND;
const MAX_DATE_NANOS = 9_223_372_036_854_775_807n;
const LOCAL_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](?:\.[0-9]{1,9})?$/;
const ANCHOR = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9]\.[0-9]{3}Z$/;
const BOUND = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9]\.[0-9]{9}Z$/;
const ROOT_KEYS = new Set([
  'query', 'post_filter', 'sort', 'size', 'from', '_source', 'fields', 'docvalue_fields',
  'stored_fields', 'track_scores', 'track_total_hits', 'version', 'seq_no_primary_term',
  'min_score', 'highlight', 'explain', 'timeout', 'terminate_after', 'profile',
  'aggs', 'aggregations', 'runtime_mappings',
]);

function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validTimeRangeField(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim() && bytes(value) <= 1024
    && value !== '$param' && !value.startsWith('_') && !/[*?]/.test(value)
    && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159);
}

export function validTimeRangeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100 || value === '-00:00'
    || !/^(?:UTC|[+-](?:0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try {
    return Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(value).timeZoneId === value;
  } catch { return false; }
}

function localDate(value: unknown): value is string {
  if (typeof value !== 'string' || !LOCAL_DATE.test(value) || value.startsWith('0000-')) return false;
  try {
    Temporal.PlainDateTime.from(value, { overflow: 'reject' });
    return true;
  } catch { return false; }
}

export function parseTimeRangeDefinition(value: unknown): TimeRangeDefinition | null {
  if (!shape(value, ['field', 'fieldType', 'timeZone', 'range']) || !validTimeRangeField(value.field)
    || value.fieldType !== 'date' && value.fieldType !== 'date_nanos' || !validTimeRangeZone(value.timeZone)) return null;
  const range = value.range;
  if (shape(range, ['kind', 'amount', 'unit']) && range.kind === 'relative'
    && typeof range.amount === 'number' && Number.isSafeInteger(range.amount) && range.amount >= 1 && range.amount <= MAX_TIME_RANGE_AMOUNT
    && TIME_RANGE_UNITS.includes(range.unit as TimeRangeUnit)
    && BigInt(range.amount) * SECONDS[range.unit as TimeRangeUnit] * NANOSECOND <= MAX_SPAN) {
    return { field: value.field, fieldType: value.fieldType, timeZone: value.timeZone,
      range: { kind: 'relative', amount: range.amount, unit: range.unit as TimeRangeUnit } };
  }
  if (shape(range, ['kind', 'from', 'to']) && range.kind === 'absolute' && localDate(range.from) && localDate(range.to)) {
    return { field: value.field, fieldType: value.fieldType, timeZone: value.timeZone,
      range: { kind: 'absolute', from: range.from, to: range.to } };
  }
  return null;
}

function canonical(instant: Temporal.Instant): string {
  return instant.toString({ fractionalSecondDigits: 9 });
}

export function resolveTimeRange(definition: TimeRangeDefinition, resolvedAt: string): TimeRangeResolution {
  if (!validTimeRangeZone(definition.timeZone)) return { ok: false, code: 'invalidTimeZone' };
  if (definition.range.kind === 'absolute' && (!localDate(definition.range.from) || !localDate(definition.range.to))) {
    return { ok: false, code: 'invalidDate' };
  }
  if (!parseTimeRangeDefinition(definition)) return { ok: false, code: 'invalidDefinition' };
  let now: Temporal.Instant;
  try {
    if (!ANCHOR.test(resolvedAt) || resolvedAt.startsWith('0000-')) return { ok: false, code: 'invalidDate' };
    now = Temporal.Instant.from(resolvedAt);
    if (now.toString({ fractionalSecondDigits: 3 }) !== resolvedAt) return { ok: false, code: 'invalidDate' };
  } catch { return { ok: false, code: 'invalidDate' }; }
  let from: Temporal.Instant;
  let to: Temporal.Instant;
  try {
    const range = definition.range;
    if (range.kind === 'relative') {
      to = now;
      from = Temporal.Instant.fromEpochNanoseconds(now.epochNanoseconds - BigInt(range.amount) * SECONDS[range.unit] * NANOSECOND);
    } else {
      from = Temporal.PlainDateTime.from(range.from).toZonedDateTime(definition.timeZone, { disambiguation: 'reject' }).toInstant();
      to = Temporal.PlainDateTime.from(range.to).toZonedDateTime(definition.timeZone, { disambiguation: 'reject' }).toInstant();
    }
  } catch { return { ok: false, code: 'ambiguousTime' }; }
  if (from.epochNanoseconds >= to.epochNanoseconds) return { ok: false, code: 'rangeOrder' };
  if (to.epochNanoseconds - from.epochNanoseconds > MAX_SPAN) return { ok: false, code: 'rangeLimit' };
  if (definition.fieldType === 'date' && (from.epochNanoseconds % 1_000_000n !== 0n || to.epochNanoseconds % 1_000_000n !== 0n)) {
    return { ok: false, code: 'precisionMismatch' };
  }
  const start = canonical(from);
  const end = canonical(to);
  if (!BOUND.test(start) || !BOUND.test(end) || start.startsWith('0000-') || end.startsWith('0000-')
    || definition.fieldType === 'date_nanos' && (from.epochNanoseconds < 0n || to.epochNanoseconds > MAX_DATE_NANOS)) {
    return { ok: false, code: 'dateOutOfRange' };
  }
  return { ok: true, bounds: { resolvedAt, from: start, to: end } };
}

export function copyExecutionTimeRange(value: ExecutionTimeRange): ExecutionTimeRange {
  const { field, fieldType, timeZone, range } = value.definition;
  const { resolvedAt, from, to } = value.bounds;
  return { version: value.version, definition: { field, fieldType, timeZone,
    range: range.kind === 'relative' ? { kind: range.kind, amount: range.amount, unit: range.unit } : { kind: range.kind, from: range.from, to: range.to } },
  bounds: { resolvedAt, from, to } };
}

export function copyQueryTimeRange(value: QueryTimeRange): QueryTimeRange {
  return { ...copyExecutionTimeRange(value), binding: { connectionId: value.binding.connectionId, index: value.binding.index }, hadQuery: value.hadQuery };
}

export function freezeExecutionTimeRange(value: ExecutionTimeRange): ExecutionTimeRange {
  const copy = copyExecutionTimeRange(value);
  Object.freeze(copy.definition.range);
  Object.freeze(copy.definition);
  Object.freeze(copy.bounds);
  return Object.freeze(copy);
}

function readBody(source: string): Node | null {
  if (bytes(source) > MAX_TIME_RANGE_DSL_BYTES || !validateQueryDsl(source).ok) return null;
  return boundedParameterJson(source);
}

function supportedBody(root: Node): boolean {
  return root.type === 'object' && (root.children ?? []).every((entry) => ROOT_KEYS.has(String(entry.children?.[0]?.value)))
    && (!property(root, 'query') || property(root, 'query')?.type === 'object');
}

function runtimeType(root: Node, field: string): string | undefined {
  const mappings = property(root, 'runtime_mappings');
  return mappings ? parseRuntimeMappings(getNodeValue(mappings))?.find((entry) => entry.field === field)?.type : undefined;
}

function rangeText(definition: TimeRangeDefinition, bounds: TimeRangeBounds): string {
  return `{"range":{${JSON.stringify(definition.field)}:{"gte":${JSON.stringify(bounds.from)},"lt":${JSON.stringify(bounds.to)},"format":"strict_date_optional_time_nanos"}}}`;
}

/** Exact shape and primitive values only; untouched user numbers never enter getNodeValue. */
function managedInner(root: Node, time: ExecutionTimeRange): Node | null {
  const query = property(root, 'query');
  const bool = property(query, 'bool');
  const must = property(bool, 'must');
  const filter = property(bool, 'filter');
  if (query?.type !== 'object' || query.children?.length !== 1 || bool?.type !== 'object' || bool.children?.length !== 2
    || must?.type !== 'array' || must.children?.length !== 1 || must.children[0]?.type !== 'object'
    || filter?.type !== 'array' || filter.children?.length !== 1) return null;
  const clause = filter.children[0];
  const range = property(clause, 'range');
  const options = property(range, time.definition.field);
  if (clause?.type !== 'object' || clause.children?.length !== 1 || range?.type !== 'object' || range.children?.length !== 1
    || options?.type !== 'object' || options.children?.length !== 3
    || property(options, 'gte')?.type !== 'string' || property(options, 'gte')?.value !== time.bounds.from
    || property(options, 'lt')?.type !== 'string' || property(options, 'lt')?.value !== time.bounds.to
    || property(options, 'format')?.value !== 'strict_date_optional_time_nanos') return null;
  return must.children[0];
}

function parseExecutionFields(value: Record<string, unknown>): ExecutionTimeRange | null {
  const definition = parseTimeRangeDefinition(value.definition);
  if (value.version !== TIME_RANGE_VERSION || !definition || !shape(value.bounds, ['resolvedAt', 'from', 'to'])
    || typeof value.bounds.resolvedAt !== 'string' || typeof value.bounds.from !== 'string' || typeof value.bounds.to !== 'string') return null;
  const resolved = resolveTimeRange(definition, value.bounds.resolvedAt);
  return resolved.ok && resolved.bounds.from === value.bounds.from && resolved.bounds.to === value.bounds.to
    ? { version: TIME_RANGE_VERSION, definition, bounds: resolved.bounds } : null;
}

export function parseExecutionTimeRange(value: unknown, dsl: string): ExecutionTimeRange | null {
  if (!shape(value, ['version', 'definition', 'bounds'])) return null;
  const time = parseExecutionFields(value);
  const root = readBody(dsl);
  if (!time || !root || !supportedBody(root) || !managedInner(root, time)) return null;
  const runtime = runtimeType(root, time.definition.field);
  return runtime !== undefined && (runtime !== 'date' || time.definition.fieldType !== 'date') ? null : time;
}

export function parseQueryTimeRange(value: unknown, connectionId: string | null, index: string, dsl: string): QueryTimeRange | null {
  if (!shape(value, ['version', 'definition', 'bounds', 'binding', 'hadQuery'])
    || !shape(value.binding, ['connectionId', 'index']) || value.binding.connectionId !== connectionId || value.binding.index !== index
    || typeof connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(connectionId)
    || index.trim() === '' || bytes(index) > 1024 || typeof value.hadQuery !== 'boolean') return null;
  const time = parseExecutionTimeRange({ version: value.version, definition: value.definition, bounds: value.bounds }, dsl);
  if (!time) return null;
  if (!value.hadQuery) {
    const inner = managedInner(readBody(dsl)!, time)!;
    const all = property(inner, 'match_all');
    if (inner.children?.length !== 1 || all?.type !== 'object' || all.children?.length !== 0) return null;
  }
  return { ...time, binding: { connectionId, index }, hadQuery: value.hadQuery };
}

export type TimeRangeFieldEvidence = 'valid' | 'runtime' | 'unchecked' | 'missing'
  | 'fieldConflict' | 'fieldNotDate' | 'fieldNotSearchable' | 'fieldNested' | 'runtimeNotApplied';

export function timeRangeFieldEvidence(query: Pick<QueryDocument, 'dsl' | 'dataView'>, definition: TimeRangeDefinition,
  catalog?: FieldCatalog): TimeRangeFieldEvidence {
  if (catalog?.fields.some((field) => field.types.some((type) => type.type === 'nested')
    && (field.name === definition.field || definition.field.startsWith(`${field.name}.`)))) return 'fieldNested';
  const root = readBody(query.dsl);
  const runtime = root ? runtimeType(root, definition.field) : undefined;
  if (runtime !== undefined) return runtime === 'date' && definition.fieldType === 'date' ? 'runtime' : 'fieldNotDate';
  if (query.dataView?.definition.runtimeFields?.entries.some((entry) => entry.field === definition.field)) return 'runtimeNotApplied';
  if (!catalog) return 'unchecked';
  const field = catalog.fields.find((entry) => entry.name === definition.field);
  if (!field || field.types.length === 0) return 'missing';
  if (field.conflict || field.types.length !== 1) return 'fieldConflict';
  if (field.types[0]!.type !== definition.fieldType) return 'fieldNotDate';
  return field.types[0]!.searchable ? 'valid' : 'fieldNotSearchable';
}

function manualRange(root: Node, field: string): boolean {
  const pending = [property(root, 'query'), property(root, 'post_filter')].filter((node): node is Node => node !== undefined);
  while (pending.length) {
    const node = pending.pop()!;
    const range = property(node, 'range');
    if (range?.type === 'object' && property(range, field)) return true;
    for (const child of node.children ?? []) pending.push(child);
  }
  return false;
}

function replaceQuery(source: string, root: Node, text: string): string {
  const query = property(root, 'query');
  if (query) return applyEdits(source, [{ offset: query.offset, length: query.length, content: text }]);
  const last = root.children?.at(-1);
  return applyEdits(source, [{ offset: last ? last.offset + last.length : root.offset + 1, length: 0,
    content: `${last ? ',' : ''}\n  "query": ${text}` }]);
}

/** Unwrap only our verified wrapper. Other root members and the entire original query survive. */
export function removeAppliedTimeRange(query: Pick<QueryDocument, 'dsl' | 'timeRange' | 'connectionId' | 'index'>): string | null {
  const time = query.timeRange && parseQueryTimeRange(query.timeRange, query.connectionId, query.index, query.dsl);
  const root = readBody(query.dsl);
  if (!time || !root) return null;
  const inner = managedInner(root, time)!;
  if (time.hadQuery) return replaceQuery(query.dsl, root, sliceRaw(query.dsl, inner));
  const members = root.children ?? [];
  const at = members.findIndex((entry) => entry.children?.[0]?.value === 'query');
  const member = members[at]!;
  const previous = members[at - 1];
  const next = members[at + 1];
  const start = previous ? previous.offset + previous.length : member.offset;
  const end = previous || !next ? member.offset + member.length : next.offset;
  return applyEdits(query.dsl, [{ offset: start, length: end - start, content: '' }]);
}

export function previewTimeRange(query: Pick<QueryDocument, 'dsl' | 'timeRange' | 'connectionId' | 'index' | 'dataView'>,
  definition: TimeRangeDefinition, now: Date, catalog?: FieldCatalog): TimeRangePreview {
  if (!query.connectionId || !/^[A-Za-z0-9_-]{1,64}$/.test(query.connectionId) || !query.index.trim() || bytes(query.index) > 1024) {
    return { ok: false, code: 'invalidBinding' };
  }
  if (Number.isNaN(now.getTime())) return { ok: false, code: 'invalidDate' };
  const resolved = resolveTimeRange(definition, now.toISOString());
  if (!resolved.ok) return resolved;
  const evidence = timeRangeFieldEvidence(query, definition, catalog);
  if (!['valid', 'runtime', 'unchecked', 'missing'].includes(evidence)) return { ok: false, code: evidence as TimeRangeProblem };
  const source = query.timeRange ? removeAppliedTimeRange(query) : query.dsl;
  if (source === null) return { ok: false, code: 'invalidBinding' };
  const root = readBody(source);
  if (!root) return { ok: false, code: 'invalidDsl' };
  if (!supportedBody(root)) return { ok: false, code: 'unsupportedDsl' };
  if (manualRange(root, definition.field)) return { ok: false, code: 'manualConflict' };
  const original = property(root, 'query');
  const dsl = replaceQuery(source, root, `{"bool":{"must":[${original ? sliceRaw(source, original) : '{"match_all":{}}'}],`
    + `"filter":[${rangeText(definition, resolved.bounds)}]}}`);
  if (bytes(dsl) > MAX_TIME_RANGE_DSL_BYTES || !readBody(dsl)) return { ok: false, code: 'tooLarge' };
  return { ok: true, dsl, timeRange: {
    version: TIME_RANGE_VERSION, definition: parseTimeRangeDefinition(definition)!, bounds: resolved.bounds,
    binding: { connectionId: query.connectionId, index: query.index }, hadQuery: original !== undefined,
  } };
}

/** Execution updates just the already-applied range. It cannot infer a field from a Data View. */
export function freezeTimeRange(query: Pick<QueryDocument, 'dsl' | 'timeRange' | 'connectionId' | 'index'>, now: Date):
  | { readonly ok: true; readonly dsl: string; readonly timeRange?: ExecutionTimeRange }
  | { readonly ok: false; readonly code: TimeRangeProblem } {
  if (query.timeRange === undefined) return { ok: true, dsl: query.dsl };
  if (Number.isNaN(now.getTime())) return { ok: false, code: 'invalidDate' };
  const time = parseQueryTimeRange(query.timeRange, query.connectionId, query.index, query.dsl);
  if (!time) return { ok: false, code: 'invalidBinding' };
  const resolved = resolveTimeRange(time.definition, now.toISOString());
  if (!resolved.ok) return resolved;
  const root = readBody(query.dsl)!;
  const filter = property(property(property(root, 'query'), 'bool'), 'filter')!.children![0]!;
  const dsl = applyEdits(query.dsl, [{ offset: filter.offset, length: filter.length, content: rangeText(time.definition, resolved.bounds) }]);
  return { ok: true, dsl, timeRange: freezeExecutionTimeRange({ version: TIME_RANGE_VERSION, definition: time.definition, bounds: resolved.bounds }) };
}

export function timeRangeLocalBound(bound: string, timeZone: string): string {
  return Temporal.Instant.from(bound).toZonedDateTimeISO(timeZone).toString({ fractionalSecondDigits: 9, calendarName: 'never' });
}

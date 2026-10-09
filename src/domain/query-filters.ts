import { applyEdits, getNodeValue, type Node } from 'jsonc-parser';
import type { ExecutionSnapshot, QueryDocument, QueryDocumentPatch } from './query';
import { validateQueryDsl } from './query-dsl';
import { boundedParameterJson } from './query-parameters';
import { parseRawJson, property, sliceRaw, type ResultColumn } from './query-result';
import { copyQueryTimeRange, parseQueryTimeRange, validTimeRangeField } from './query-time-range';
import type { FieldCatalog } from './resource';
import { compareDecimalText, parseDecimalToken } from './result-grid';
import { parseRuntimeMappings } from './runtime-fields';

export const MAX_QUERY_FILTERS = 32;
export const MAX_FILTER_VALUE_BYTES = 4096;
export const MAX_FILTER_CELL_BYTES = 64 * 1024;
export const MAX_FILTER_VALUES = 32;
export const MAX_FILTER_DSL_BYTES = 256 * 1024;

export type QueryFilterOperation = 'include' | 'exclude' | 'exists' | 'missing';
export type FilterValueOrigin = 'source' | 'fields';

export interface CellFilterSelection {
  readonly field: string;
  readonly value: ResultColumn['value'] | undefined;
  readonly origin: FilterValueOrigin;
}

export interface QueryFilter {
  readonly id: string;
  readonly field: string;
  readonly fieldType: string;
  readonly evidence: 'mapped' | 'runtime';
  readonly operation: QueryFilterOperation;
  /** A complete original scalar JSON token, not display text or a parsed JS number. */
  readonly value: string | null;
  readonly origin: FilterValueOrigin;
}

/** Pending filters are session-only. Only their explicitly applied DSL uses draft persistence. */
export interface QueryFilterDraft {
  readonly source: QueryDocument;
  readonly snapshot: ExecutionSnapshot;
  readonly endpoint: string;
  readonly filters: readonly QueryFilter[];
}

export type QueryFilterProblem =
  | 'invalidField' | 'fieldPath' | 'fieldNested' | 'fieldUnchecked' | 'fieldMissing'
  | 'fieldConflict' | 'fieldNotSearchable' | 'fieldUnsupported' | 'fieldChanged'
  | 'runtimeChanged' | 'runtimeValueRequired' | 'noScalarValue' | 'compoundValue'
  | 'valueTypeMismatch' | 'valueOutOfRange' | 'valueUnsupported' | 'invalidValue'
  | 'emptyPhrase' | 'tooLarge' | 'tooMany' | 'empty' | 'duplicate'
  | 'invalidDsl' | 'unsupportedDsl' | 'invalidBinding' | 'targetChanged';

type Failure = { readonly ok: false; readonly code: QueryFilterProblem };
type Family = 'keyword' | 'text' | 'number' | 'boolean' | 'existence';
export type FilterFieldEvidence = Failure | {
  readonly ok: true;
  readonly fieldType: string;
  readonly family: Family;
  readonly evidence: QueryFilter['evidence'];
};
export type FilterValues = Failure | { readonly ok: true; readonly values: readonly string[]; readonly array: boolean };
export type QueryFilterPreview = Failure | {
  readonly ok: true;
  readonly dsl: string;
  readonly patch: QueryDocumentPatch;
};

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const ROOT_KEYS = new Set([
  'query', 'post_filter', 'sort', 'size', 'from', '_source', 'fields', 'docvalue_fields',
  'stored_fields', 'track_scores', 'track_total_hits', 'version', 'seq_no_primary_term',
  'min_score', 'highlight', 'explain', 'timeout', 'terminate_after', 'profile',
  'aggs', 'aggregations', 'runtime_mappings',
]);
const INTEGER_BOUNDS: Readonly<Record<string, readonly [string, string]>> = {
  byte: ['-128', '127'], short: ['-32768', '32767'], integer: ['-2147483648', '2147483647'],
  long: ['-9223372036854775808', '9223372036854775807'], unsigned_long: ['0', '18446744073709551615'],
};

function readBody(source: string): Node | null {
  return bytes(source) <= MAX_FILTER_DSL_BYTES && validateQueryDsl(source).ok ? boundedParameterJson(source) : null;
}

function familyOf(type: string): Family | null {
  if (['keyword', 'constant_keyword', 'wildcard'].includes(type)) return 'keyword';
  if (['text', 'match_only_text'].includes(type)) return 'text';
  if (Object.hasOwn(INTEGER_BOUNDS, type) || ['half_float', 'float', 'double', 'scaled_float'].includes(type)) return 'number';
  if (type === 'boolean') return 'boolean';
  if (['date', 'date_nanos', 'ip'].includes(type)) return 'existence';
  return null;
}

function runtimeField(root: Node, field: string) {
  const mappings = property(root, 'runtime_mappings');
  return mappings ? parseRuntimeMappings(getNodeValue(mappings))?.find((entry) => entry.field === field) : undefined;
}

function filterRoots(source: Pick<QueryDocument, 'id' | 'connectionId' | 'index' | 'dsl'>, snapshot: ExecutionSnapshot):
  Failure | { readonly ok: true; readonly executed: Node; readonly current: Node } {
  if (source.id !== snapshot.queryId || source.connectionId !== snapshot.connectionId || source.index !== snapshot.index) {
    return { ok: false, code: 'targetChanged' };
  }
  const executed = readBody(snapshot.rawDsl);
  const current = readBody(source.dsl);
  return executed && current ? { ok: true, executed, current } : { ok: false, code: 'invalidDsl' };
}

function fieldEvidence(executed: Node, current: Node, field: string, catalog?: FieldCatalog): FilterFieldEvidence {
  if (!validTimeRangeField(field)) return { ok: false, code: 'invalidField' };
  if (catalog?.fields.some((entry) => entry.types.some((type) => type.type === 'nested')
    && (entry.name === field || field.startsWith(`${entry.name}.`)))) return { ok: false, code: 'fieldNested' };
  // Literal dotted source keys, objects and nested paths need mapping/path evidence beyond field caps.
  if (field.includes('.')) return { ok: false, code: 'fieldPath' };
  const before = runtimeField(executed, field);
  const after = runtimeField(current, field);
  if (before?.type !== after?.type || before?.script?.source !== after?.script?.source) {
    return { ok: false, code: 'runtimeChanged' };
  }
  if (before) {
    const family = familyOf(before.type);
    return family ? { ok: true, family, fieldType: before.type, evidence: 'runtime' } : { ok: false, code: 'fieldUnsupported' };
  }
  if (!catalog) return { ok: false, code: 'fieldUnchecked' };
  const capability = catalog.fields.find((entry) => entry.name === field);
  if (!capability || !capability.types.length) return { ok: false, code: 'fieldMissing' };
  if (capability.conflict || capability.types.length !== 1) return { ok: false, code: 'fieldConflict' };
  const type = capability.types[0]!;
  if (!type.searchable) return { ok: false, code: 'fieldNotSearchable' };
  const family = type.metadata ? null : familyOf(type.type);
  return family ? { ok: true, family, fieldType: type.type, evidence: 'mapped' } : { ok: false, code: 'fieldUnsupported' };
}

/** Field evidence is scoped by the caller to this execution's connection, endpoint and target. */
export function queryFilterFieldEvidence(source: Pick<QueryDocument, 'id' | 'connectionId' | 'index' | 'dsl'>,
  snapshot: ExecutionSnapshot, field: string, catalog?: FieldCatalog): FilterFieldEvidence {
  const roots = filterRoots(source, snapshot);
  return roots.ok ? fieldEvidence(roots.executed, roots.current, field, catalog) : roots;
}

/** Arrays mean a choice of one returned element, never whole-array equality or a terms query. */
export function queryFilterValues(value: ResultColumn['value'] | undefined): FilterValues {
  if (!value || value.kind === 'null') return { ok: false, code: 'noScalarValue' };
  if (bytes(value.text) > MAX_FILTER_CELL_BYTES) return { ok: false, code: 'tooLarge' };
  const raw = value.kind === 'string' ? JSON.stringify(value.text) : value.text;
  const root = parseRawJson(raw);
  if (!root || root.type !== value.kind) return { ok: false, code: 'invalidValue' };
  const array = root.type === 'array';
  const nodes = array ? root.children ?? [] : [root];
  if (nodes.length > MAX_FILTER_VALUES) return { ok: false, code: 'tooMany' };
  const values: string[] = [];
  for (const node of nodes) {
    if (node.type === 'null') continue;
    if (!['string', 'number', 'boolean'].includes(node.type)) return { ok: false, code: 'compoundValue' };
    const token = sliceRaw(raw, node);
    if (bytes(token) > MAX_FILTER_VALUE_BYTES) return { ok: false, code: 'tooLarge' };
    if (!values.includes(token)) values.push(token);
  }
  return values.length ? { ok: true, values, array } : { ok: false, code: 'noScalarValue' };
}

function numericValueValid(raw: string, type: string): boolean {
  const parts = parseDecimalToken(raw);
  if (!parts) return false;
  const bounds = Object.hasOwn(INTEGER_BOUNDS, type) ? INTEGER_BOUNDS[type] : undefined;
  if (bounds) {
    if (compareDecimalText(raw, bounds[0]) < 0 || compareDecimalText(raw, bounds[1]) > 0) return false;
    if (parts.sign === 0 || parts.exponent >= 0n) return true;
    const fraction = -parts.exponent;
    return fraction <= BigInt(parts.digits.length) && /^0+$/.test(parts.digits.slice(-Number(fraction)));
  }
  // This conversion checks only finiteness; the original token is always emitted unchanged.
  return Number.isFinite(Number(raw));
}

export function createQueryFilter(source: QueryDocument, snapshot: ExecutionSnapshot, selection: CellFilterSelection,
  operation: QueryFilterOperation, value: string | null, catalog?: FieldCatalog):
  Failure | { readonly ok: true; readonly filter: Omit<QueryFilter, 'id'> } {
  const field = queryFilterFieldEvidence(source, snapshot, selection.field, catalog);
  if (!field.ok) return field;
  const presence = operation === 'exists' || operation === 'missing';
  if (!presence && operation !== 'include' && operation !== 'exclude') return { ok: false, code: 'invalidValue' };
  if (!presence) {
    if (field.evidence === 'runtime' && selection.origin !== 'fields') return { ok: false, code: 'runtimeValueRequired' };
    const values = queryFilterValues(selection.value);
    if (!values.ok) return values;
    if (value === null || !values.values.includes(value)) return { ok: false, code: 'invalidValue' };
    const problem = checkValue(value, field);
    if (problem) return { ok: false, code: problem };
  }
  return { ok: true, filter: { field: selection.field, fieldType: field.fieldType, evidence: field.evidence,
    operation, value: presence ? null : value, origin: selection.origin } };
}

function checkValue(raw: string, field: Extract<FilterFieldEvidence, { ok: true }>): QueryFilterProblem | null {
  if (bytes(raw) > MAX_FILTER_VALUE_BYTES) return 'tooLarge';
  const value = parseRawJson(raw);
  if (!value || !['string', 'number', 'boolean'].includes(value.type)) return 'invalidValue';
  if (field.family === 'existence') return 'valueUnsupported';
  const kind = field.family === 'keyword' || field.family === 'text' ? 'string' : field.family;
  if (value.type !== kind) return 'valueTypeMismatch';
  if (value.type === 'number' && !numericValueValid(raw, field.fieldType)) return 'valueOutOfRange';
  if (field.family === 'text' && String(value.value).trim() === '') return 'emptyPhrase';
  return null;
}

function sameFilter(a: Omit<QueryFilter, 'id'>, b: Omit<QueryFilter, 'id'>): boolean {
  return a.field === b.field && a.operation === b.operation && a.value === b.value;
}

export function queryFilterDuplicate(filters: readonly QueryFilter[], filter: Omit<QueryFilter, 'id'>): boolean {
  return filters.some((entry) => sameFilter(entry, filter));
}

function clauseText(filter: QueryFilter, field: Extract<FilterFieldEvidence, { ok: true }>): string {
  if (filter.operation === 'exists' || filter.operation === 'missing') return `{"exists":{"field":${JSON.stringify(filter.field)}}}`;
  const kind = field.family === 'text' ? 'match_phrase' : 'term';
  return `{${JSON.stringify(kind)}:{${JSON.stringify(filter.field)}:${filter.value}}}`;
}

/** Append a non-scoring conjunction without altering the original bool/MSM/scoring context. */
export function previewQueryFilters(source: QueryDocument, snapshot: ExecutionSnapshot, filters: readonly QueryFilter[],
  catalog?: FieldCatalog): QueryFilterPreview {
  if (!filters.length) return { ok: false, code: 'empty' };
  if (filters.length > MAX_QUERY_FILTERS) return { ok: false, code: 'tooMany' };
  if (bytes(source.dsl) > MAX_FILTER_DSL_BYTES) return { ok: false, code: 'tooLarge' };
  const roots = filterRoots(source, snapshot);
  if (!roots.ok) return roots;
  const root = roots.current;
  if ((root.children ?? []).some((entry) => !ROOT_KEYS.has(String(entry.children?.[0]?.value)))
    || property(root, 'query') && property(root, 'query')?.type !== 'object') return { ok: false, code: 'unsupportedDsl' };
  const positive: string[] = [];
  const negative: string[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index]!;
    if (ids.has(filter.id) || queryFilterDuplicate(filters.slice(0, index), filter)) return { ok: false, code: 'duplicate' };
    ids.add(filter.id);
    const field = fieldEvidence(roots.executed, root, filter.field, catalog);
    if (!field.ok) return field;
    if (field.fieldType !== filter.fieldType || field.evidence !== filter.evidence) return { ok: false, code: 'fieldChanged' };
    const presence = filter.operation === 'exists' || filter.operation === 'missing';
    if (presence ? filter.value !== null : filter.operation !== 'include' && filter.operation !== 'exclude' || filter.value === null) {
      return { ok: false, code: 'invalidValue' };
    }
    if (!presence) {
      if (field.evidence === 'runtime' && filter.origin !== 'fields') return { ok: false, code: 'runtimeValueRequired' };
      const problem = checkValue(filter.value!, field);
      if (problem) return { ok: false, code: problem };
    }
    (filter.operation === 'exclude' || filter.operation === 'missing' ? negative : positive).push(clauseText(filter, field));
  }
  const time = source.timeRange === undefined ? undefined
    : parseQueryTimeRange(source.timeRange, source.connectionId, source.index, source.dsl);
  if (time === null) return { ok: false, code: 'invalidBinding' };
  const original = time
    ? property(property(property(root, 'query'), 'bool'), 'must')!.children![0]!
    : property(root, 'query');
  const wrapped = `{"bool":{"must":[${original ? sliceRaw(source.dsl, original) : '{"match_all":{}}'}]`
    + `${positive.length ? `,"filter":[${positive.join(',')}]` : ''}`
    + `${negative.length ? `,"must_not":[${negative.join(',')}]` : ''}}}`;
  const last = root.children?.at(-1);
  const dsl = applyEdits(source.dsl, [original ? { offset: original.offset, length: original.length, content: wrapped }
    : { offset: last ? last.offset + last.length : root.offset + 1, length: 0, content: `${last ? ',' : ''}"query":${wrapped}` }]);
  if (bytes(dsl) > MAX_FILTER_DSL_BYTES || !readBody(dsl)) return { ok: false, code: 'tooLarge' };
  // Removing time must now retain the added filters, even if the pre-time body had no query.
  const timeRange = time ? { ...copyQueryTimeRange(time), hadQuery: true } : undefined;
  if (timeRange && !parseQueryTimeRange(timeRange, source.connectionId, source.index, dsl)) return { ok: false, code: 'invalidBinding' };
  return { ok: true, dsl, patch: { dsl, ...(timeRange ? { timeRange } : {}) } };
}

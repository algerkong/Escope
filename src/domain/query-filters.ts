import { applyEdits, getNodeValue, type Node } from 'jsonc-parser';
import type { ExecutionSnapshot, QueryDocument, QueryDocumentPatch } from './query';
import { validateQueryDsl } from './query-dsl';
import {
  nestedMappingFieldEvidence, runtimeOverlapsNestedPath, validNestedFilterSegment,
  type NestedFilterMappingResult, type NestedMappingProblem,
} from './query-filter-mapping';
import { boundedParameterJson } from './query-parameters';
import { parseRawJson, property, sliceRaw, type ResultColumn } from './query-result';
import { copyQueryTimeRange, parseQueryTimeRange, validTimeRangeField } from './query-time-range';
import type { FieldCatalog } from './resource';
import { compareDecimalText, parseDecimalToken } from './result-grid';
import { parseRuntimeMappings } from './runtime-fields';

export const MAX_QUERY_FILTERS = 32;
export const MAX_FILTER_GROUPS = 8;
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
  readonly origin: FilterValueOrigin | 'input' | 'saved';
  /** Explicit Mapping-proven scope, never inferred from a cell's object or array shape. */
  readonly nestedPath?: string;
  /** Omitted means enabled. Disabled definitions retain their membership and still count toward limits. */
  readonly enabled?: boolean;
}

export type QueryFilterJoin = 'all' | 'any';

export interface QueryFilterGroup {
  readonly id: string;
  readonly mode: QueryFilterJoin;
  readonly filterIds: readonly string[];
  readonly nested?: { readonly path: string; readonly match: 'include' | 'exclude' };
}

/** Two levels only; each filter occurs exactly once and every OR requires one match. */
export interface QueryFilterComposition {
  readonly mode: QueryFilterJoin;
  readonly groups: readonly QueryFilterGroup[];
}

/** An explicitly created session binding, never inferred from or restored alongside arbitrary DSL. */
export interface QueryFilterBinding {
  readonly baseline: QueryDocument;
  readonly applied: QueryDocument;
  readonly snapshot: ExecutionSnapshot | null;
  readonly endpoint: string;
  readonly filters: readonly QueryFilter[];
  readonly composition?: QueryFilterComposition;
}

/** Session draft; saved literals have no fabricated execution observation. */
export interface QueryFilterDraft {
  readonly source: QueryDocument;
  readonly snapshot: ExecutionSnapshot | null;
  readonly endpoint: string;
  readonly filters: readonly QueryFilter[];
  readonly composition?: QueryFilterComposition;
  readonly binding?: QueryFilterBinding;
}

export type QueryFilterProblem = NestedMappingProblem
  | 'invalidField' | 'fieldPath' | 'fieldNested' | 'fieldUnchecked' | 'fieldMissing'
  | 'fieldConflict' | 'fieldNotSearchable' | 'fieldUnsupported' | 'fieldChanged'
  | 'runtimeChanged' | 'runtimeValueRequired' | 'noScalarValue' | 'compoundValue'
  | 'valueTypeMismatch' | 'valueOutOfRange' | 'valueUnsupported' | 'invalidValue'
  | 'emptyPhrase' | 'tooLarge' | 'tooMany' | 'empty' | 'duplicate'
  | 'invalidDsl' | 'unsupportedDsl' | 'invalidBinding' | 'targetChanged'
  | 'invalidComposition' | 'tooManyGroups' | 'nestedGroupMismatch' | 'invalidFilterState' | 'filterBindingChanged'
  | 'savedFilterUnsupported';

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

function filterRoots(source: Pick<QueryDocument, 'id' | 'connectionId' | 'index' | 'dsl'>, snapshot: ExecutionSnapshot | null):
  Failure | { readonly ok: true; readonly executed: Node; readonly current: Node } {
  if (snapshot && (source.id !== snapshot.queryId || source.connectionId !== snapshot.connectionId || source.index !== snapshot.index)) {
    return { ok: false, code: 'targetChanged' };
  }
  const current = readBody(source.dsl);
  const executed = snapshot ? readBody(snapshot.rawDsl) : current;
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
  return mappedFieldEvidence(field, catalog);
}

function mappedFieldEvidence(field: string, catalog?: FieldCatalog): FilterFieldEvidence {
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

function nestedFieldEvidence(executed: Node, current: Node, path: string, field: string,
  catalog?: FieldCatalog, mapping?: NestedFilterMappingResult): FilterFieldEvidence {
  const mapped = nestedMappingFieldEvidence(mapping, catalog?.indices ?? [], path, field);
  if (!mapped.ok) return mapped;
  if (runtimeOverlapsNestedPath(executed, 'runtime_mappings', path) || runtimeOverlapsNestedPath(current, 'runtime_mappings', path)) {
    return { ok: false, code: 'nestedRuntime' };
  }
  const capability = mappedFieldEvidence(field, catalog);
  return capability.ok && capability.fieldType !== mapped.fieldType ? { ok: false, code: 'nestedFieldConflict' } : capability;
}

export function nestedQueryFilterFieldEvidence(source: QueryDocument, snapshot: ExecutionSnapshot, path: string, field: string,
  catalog?: FieldCatalog, mapping?: NestedFilterMappingResult): FilterFieldEvidence {
  const roots = filterRoots(source, snapshot);
  return roots.ok ? nestedFieldEvidence(roots.executed, roots.current, path, field, catalog, mapping) : roots;
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

/** Authored values are distinct from returned cell values; no source object is flattened. */
export function createNestedQueryFilter(source: QueryDocument, snapshot: ExecutionSnapshot, path: string, field: string,
  operation: QueryFilterOperation, value: string | null, catalog?: FieldCatalog, mapping?: NestedFilterMappingResult):
  Failure | { readonly ok: true; readonly filter: Omit<QueryFilter, 'id'> } {
  const evidence = nestedQueryFilterFieldEvidence(source, snapshot, path, field, catalog, mapping);
  if (!evidence.ok) return evidence;
  const presence = operation === 'exists' || operation === 'missing';
  if (!presence && operation !== 'include' && operation !== 'exclude' || !presence && value === null) return { ok: false, code: 'invalidValue' };
  if (!presence) {
    const problem = checkValue(value!, evidence);
    if (problem) return { ok: false, code: problem };
  }
  return { ok: true, filter: { field, fieldType: evidence.fieldType, evidence: 'mapped', operation,
    value: presence ? null : value, origin: 'input', nestedPath: path } };
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
  return a.field === b.field && a.operation === b.operation && a.value === b.value && a.nestedPath === b.nestedPath;
}

export function queryFilterDuplicate(filters: readonly QueryFilter[], filter: Omit<QueryFilter, 'id'>): boolean {
  return filters.some((entry) => sameFilter(entry, filter));
}

export function queryFilterEnabled(filter: QueryFilter): boolean {
  return !Object.hasOwn(filter, 'enabled') || filter.enabled !== false;
}

export function filterGroupAccepts(group: QueryFilterGroup, filter: Pick<QueryFilter, 'nestedPath'>): boolean {
  return group.nested?.path === filter.nestedPath;
}

export function queryFilterDefinitionProblem(filter: QueryFilter): QueryFilterProblem | null {
  if (!validTimeRangeField(filter.field)) return 'invalidField';
  if (filter.nestedPath === undefined ? filter.field.includes('.')
    : !validNestedFilterSegment(filter.nestedPath) || !filter.field.startsWith(`${filter.nestedPath}.`)
      || !validNestedFilterSegment(filter.field.slice(filter.nestedPath.length + 1))) return 'fieldPath';
  if (filter.evidence !== 'mapped' && filter.evidence !== 'runtime'
    || filter.origin !== 'source' && filter.origin !== 'fields' && filter.origin !== 'input' && filter.origin !== 'saved') return 'invalidValue';
  if (filter.origin === 'saved' && filter.evidence !== 'mapped') return 'savedFilterUnsupported';
  const family = familyOf(filter.fieldType);
  if (!family) return 'fieldUnsupported';
  const presence = filter.operation === 'exists' || filter.operation === 'missing';
  if (presence) return filter.value === null ? null : 'invalidValue';
  if (filter.operation !== 'include' && filter.operation !== 'exclude' || typeof filter.value !== 'string') return 'invalidValue';
  if (filter.evidence === 'runtime' && filter.origin !== 'fields') return 'runtimeValueRequired';
  return checkValue(filter.value, { ok: true, fieldType: filter.fieldType, evidence: filter.evidence, family });
}

function clauseText(filter: QueryFilter, field: Extract<FilterFieldEvidence, { ok: true }>): string {
  if (filter.operation === 'exists' || filter.operation === 'missing') return `{"exists":{"field":${JSON.stringify(filter.field)}}}`;
  const kind = field.family === 'text' ? 'match_phrase' : 'term';
  return `{${JSON.stringify(kind)}:{${JSON.stringify(filter.field)}:${filter.value}}}`;
}

export function queryFilterCompositionProblem(input: QueryFilterComposition, filters: readonly QueryFilter[]): QueryFilterProblem | null {
  const record = (value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => value !== null
    && typeof value === 'object' && !Array.isArray(value) && keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
  const join = (value: unknown) => value === 'all' || value === 'any';
  if (!record(input, ['mode', 'groups']) || !join(input.mode) || !Array.isArray(input.groups) || !input.groups.length) {
    return 'invalidComposition';
  }
  if (input.groups.length > MAX_FILTER_GROUPS) return 'tooManyGroups';
  const groupIds = new Set<string>();
  const byId = new Map(filters.map((filter) => [filter.id, filter]));
  const remaining = new Set(filters.map((filter) => filter.id));
  for (const group of input.groups) {
    if (!record(group, ['id', 'mode', 'filterIds'], ['nested']) || typeof group.id !== 'string' || !group.id
      || bytes(group.id) > 128 || groupIds.has(group.id) || !join(group.mode)
      || !Array.isArray(group.filterIds) || !group.filterIds.length || group.filterIds.length > MAX_QUERY_FILTERS) {
      return 'invalidComposition';
    }
    if (Object.hasOwn(group, 'nested') && (!record(group.nested, ['path', 'match'])
      || !validNestedFilterSegment(group.nested.path) || group.nested.match !== 'include' && group.nested.match !== 'exclude')) {
      return 'invalidComposition';
    }
    groupIds.add(group.id);
    const members: QueryFilter[] = [];
    for (const id of group.filterIds) {
      if (typeof id !== 'string' || !remaining.delete(id)) return 'invalidComposition';
      const filter = byId.get(id)!;
      if (!filterGroupAccepts(group as unknown as QueryFilterGroup, filter)) return 'nestedGroupMismatch';
      if (group.nested && queryFilterDuplicate(members, filter)) return 'duplicate';
      members.push(filter);
    }
  }
  return remaining.size ? 'invalidComposition' : null;
}

interface FilterClause { readonly text: string; readonly negative: boolean }

function conjunction(clauses: readonly FilterClause[]): string {
  const positive = clauses.filter((clause) => !clause.negative).map((clause) => clause.text);
  const negative = clauses.filter((clause) => clause.negative).map((clause) => clause.text);
  return [
    ...(positive.length ? [`"filter":[${positive.join(',')}]`] : []),
    ...(negative.length ? [`"must_not":[${negative.join(',')}]`] : []),
  ].join(',');
}

function disjunction(clauses: readonly FilterClause[]): string {
  // A negative branch must remain local to this OR, never become a global exclusion.
  const alternatives = clauses.map((clause) => clause.negative ? `{"bool":{"must_not":[${clause.text}]}}` : clause.text);
  return `"should":[${alternatives.join(',')}],"minimum_should_match":1`;
}

function composeClauses(clauses: ReadonlyMap<string, FilterClause>, composition?: QueryFilterComposition): string {
  if (!composition) return conjunction([...clauses.values()]);
  const groups = composition.groups.map((group) => ({
    mode: group.mode, nested: group.nested,
    clauses: group.filterIds.filter((id) => clauses.has(id)).map((id) => clauses.get(id)!),
  })).filter((group) => group.clauses.length);
  if (composition.mode === 'all' && groups.length === 1 && groups[0]!.mode === 'all' && !groups[0]!.nested) {
    return conjunction(groups[0]!.clauses);
  }
  const combined = groups.map((group) => {
    const query = `{"bool":{${group.mode === 'all' ? conjunction(group.clauses) : disjunction(group.clauses)}}}`;
    return group.nested ? {
      text: `{"nested":{"path":${JSON.stringify(group.nested.path)},"query":${query},"score_mode":"none","ignore_unmapped":false}}`,
      negative: group.nested.match === 'exclude',
    } : { text: query, negative: false };
  });
  // Even text/should branches stay in filter context; only the untouched original query scores.
  return composition.mode === 'all' ? conjunction(combined) : `"filter":[{"bool":{${disjunction(combined)}}}]`;
}

/** Append reviewed filter groups without altering the original bool/MSM/scoring context. */
export function previewQueryFilters(source: QueryDocument, snapshot: ExecutionSnapshot | null, filters: readonly QueryFilter[],
  catalog?: FieldCatalog, composition?: QueryFilterComposition, mapping?: NestedFilterMappingResult): QueryFilterPreview {
  if (!filters.length) return { ok: false, code: 'empty' };
  if (filters.length > MAX_QUERY_FILTERS) return { ok: false, code: 'tooMany' };
  if (bytes(source.dsl) > MAX_FILTER_DSL_BYTES) return { ok: false, code: 'tooLarge' };
  const roots = filterRoots(source, snapshot);
  if (!roots.ok) return roots;
  const root = roots.current;
  if ((root.children ?? []).some((entry) => !ROOT_KEYS.has(String(entry.children?.[0]?.value)))
    || property(root, 'query') && property(root, 'query')?.type !== 'object') return { ok: false, code: 'unsupportedDsl' };
  const clauses = new Map<string, FilterClause>();
  const filterIds = new Set<string>();
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index]!;
    if (!snapshot && filter.origin !== 'saved') return { ok: false, code: 'targetChanged' };
    if (filter.origin === 'saved' && filter.evidence !== 'mapped') {
      return { ok: false, code: 'savedFilterUnsupported' };
    }
    if (Object.hasOwn(filter, 'enabled') && typeof filter.enabled !== 'boolean') return { ok: false, code: 'invalidFilterState' };
    if (filterIds.has(filter.id) || filter.nestedPath === undefined && queryFilterDuplicate(filters.slice(0, index), filter)) {
      return { ok: false, code: 'duplicate' };
    }
    filterIds.add(filter.id);
    if (filter.nestedPath !== undefined && (filter.origin !== 'input' && filter.origin !== 'saved' || filter.evidence !== 'mapped')) {
      return { ok: false, code: 'nestedGroupMismatch' };
    }
    if (!queryFilterEnabled(filter)) {
      // Disabled leaves need no current field evidence, but are not a way to hide malformed definitions.
      const problem = queryFilterDefinitionProblem(filter);
      if (problem) return { ok: false, code: problem };
      continue;
    }
    // Saved values are literals, not values observed in the latest execution. Only current mapped
    // evidence may validate them; a runtime declaration shadowing the field is never substituted.
    if (filter.origin === 'saved' && filter.nestedPath === undefined && runtimeField(root, filter.field)) {
      return { ok: false, code: 'savedFilterUnsupported' };
    }
    const field = filter.nestedPath === undefined ? fieldEvidence(filter.origin === 'saved' ? root : roots.executed, root, filter.field, catalog)
      : nestedFieldEvidence(filter.origin === 'saved' ? root : roots.executed, root, filter.nestedPath, filter.field, catalog, mapping);
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
    clauses.set(filter.id, { text: clauseText(filter, field), negative: filter.operation === 'exclude' || filter.operation === 'missing' });
  }
  if (composition === undefined && filters.some((filter) => filter.nestedPath !== undefined)) return { ok: false, code: 'nestedGroupMismatch' };
  const groupingProblem = composition === undefined ? null : queryFilterCompositionProblem(composition, filters);
  if (groupingProblem) return { ok: false, code: groupingProblem };
  const time = source.timeRange === undefined ? undefined
    : parseQueryTimeRange(source.timeRange, source.connectionId, source.index, source.dsl);
  if (time === null) return { ok: false, code: 'invalidBinding' };
  // An inactive group contributes nothing, including under OR or an outer nested exclusion.
  if (!clauses.size) return { ok: true, dsl: source.dsl,
    patch: { dsl: source.dsl, ...(time ? { timeRange: copyQueryTimeRange(time) } : {}) } };
  const original = time
    ? property(property(property(root, 'query'), 'bool'), 'must')!.children![0]!
    : property(root, 'query');
  const wrapped = `{"bool":{"must":[${original ? sliceRaw(source.dsl, original) : '{"match_all":{}}'}]`
    + `,${composeClauses(clauses, composition)}}}`;
  const last = root.children?.at(-1);
  const dsl = applyEdits(source.dsl, [original ? { offset: original.offset, length: original.length, content: wrapped }
    : { offset: last ? last.offset + last.length : root.offset + 1, length: 0, content: `${last ? ',' : ''}"query":${wrapped}` }]);
  if (bytes(dsl) > MAX_FILTER_DSL_BYTES || !readBody(dsl)) return { ok: false, code: 'tooLarge' };
  // Removing time must now retain the added filters, even if the pre-time body had no query.
  const timeRange = time ? { ...copyQueryTimeRange(time), hadQuery: true } : undefined;
  if (timeRange && !parseQueryTimeRange(timeRange, source.connectionId, source.index, dsl)) return { ok: false, code: 'invalidBinding' };
  return { ok: true, dsl, patch: { dsl, ...(timeRange ? { timeRange } : {}) } };
}

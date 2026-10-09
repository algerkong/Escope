import { applyEdits, type Edit, type Node } from 'jsonc-parser';
import type { QueryDocument, QueryDocumentPatch } from './query';
import { validateQueryDsl } from './query-dsl';
import { supportsSnapshotPaging } from './query-pagination';
import { boundedParameterJson } from './query-parameters';
import { property, textOf } from './query-result';
import { copyQueryTimeRange, parseQueryTimeRange, validTimeRangeField } from './query-time-range';
import type { FieldCatalog } from './resource';
import { defaultSortDirection, type VisualSort } from './visual-query';

export const MAX_QUERY_SORT_FIELDS = 8;
export const MAX_SORT_DSL_BYTES = 256 * 1024;
export const BUILT_IN_SORT_FIELDS = ['_score', '_doc', '_shard_doc'] as const;
export const SORT_UNMAPPED_TYPES = [
  'keyword', 'byte', 'short', 'integer', 'long', 'unsigned_long', 'half_float', 'float', 'double',
  'boolean', 'date', 'date_nanos', 'ip',
] as const;
export type SortUnmappedType = typeof SORT_UNMAPPED_TYPES[number];
export type SortMissing = 'default' | '_first' | '_last';

/** Review-only values. The applied sort lives exclusively in the original DSL. */
export interface QuerySortClause extends VisualSort {
  readonly missing: SortMissing;
  readonly unmappedType: SortUnmappedType | null;
}

export type QuerySortProblem =
  | 'invalidDsl' | 'unsupportedDsl' | 'unsupportedSort' | 'tooLarge' | 'tooMany'
  | 'invalidField' | 'fieldPath' | 'fieldNested' | 'fieldUnchecked' | 'fieldMissing'
  | 'fieldUnmapped' | 'fieldConflict' | 'fieldNotSortable' | 'fieldUnsupported'
  | 'invalidOptions' | 'duplicateField' | 'unmappedMismatch' | 'unmappedRequired'
  | 'invalidBinding' | 'pitRequired';
type Failure = { readonly ok: false; readonly code: QuerySortProblem; readonly field?: string };
export type QuerySortParse = Failure | { readonly ok: true; readonly clauses: readonly QuerySortClause[] };
export type SortFieldEvidence = Failure | {
  readonly ok: true;
  readonly fieldType: string;
  readonly origin: 'mapped' | 'runtime' | 'builtin';
  readonly reportedUnmapped: boolean;
};
export type QuerySortPreview = Failure | {
  readonly ok: true;
  readonly dsl: string;
  readonly patch: QueryDocumentPatch;
  readonly changed: boolean;
};

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const ROOT_KEYS = new Set([
  'query', 'post_filter', 'sort', 'size', 'from', '_source', 'fields', 'docvalue_fields',
  'stored_fields', 'track_scores', 'track_total_hits', 'version', 'seq_no_primary_term',
  'min_score', 'highlight', 'explain', 'timeout', 'terminate_after', 'profile',
  'aggs', 'aggregations', 'runtime_mappings',
]);
const SORTABLE_TYPES = new Set<string>([...SORT_UNMAPPED_TYPES, 'constant_keyword', 'scaled_float']);
const builtin = (field: string) => (BUILT_IN_SORT_FIELDS as readonly string[]).includes(field);
const unmappedType = (value: unknown): value is SortUnmappedType =>
  typeof value === 'string' && (SORT_UNMAPPED_TYPES as readonly string[]).includes(value);

function readBody(source: string): Failure | { readonly ok: true; readonly root: Node } {
  if (bytes(source) > MAX_SORT_DSL_BYTES) return { ok: false, code: 'tooLarge' };
  if (!validateQueryDsl(source).ok) return { ok: false, code: 'invalidDsl' };
  const root = boundedParameterJson(source);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidDsl' };
  // Existing cursors, collapse and mixed retrieval need their own sort contracts.
  if ((root.children ?? []).some((entry) => !ROOT_KEYS.has(String(entry.children?.[0]?.value)))
    || property(root, 'query') && property(root, 'query')?.type !== 'object') return { ok: false, code: 'unsupportedDsl' };
  return { ok: true, root };
}

function clauseProblem(clause: QuerySortClause): QuerySortProblem | null {
  if (!builtin(clause.field) && !validTimeRangeField(clause.field)) return 'invalidField';
  if (clause.field.includes('.')) return 'fieldPath';
  if (clause.direction !== 'asc' && clause.direction !== 'desc'
    || !['default', '_first', '_last'].includes(clause.missing)
    || clause.unmappedType !== null && !unmappedType(clause.unmappedType)
    || builtin(clause.field) && (clause.missing !== 'default' || clause.unmappedType !== null)) return 'invalidOptions';
  return null;
}

function readClause(node: Node): QuerySortClause | null {
  let field: string | undefined;
  let direction: unknown;
  let missing: unknown = 'default';
  let unmapped: unknown = null;
  if (node.type === 'string') {
    field = textOf(node);
  } else if (node.type === 'object' && node.children?.length === 1) {
    const entry = node.children[0]!;
    field = textOf(entry.children?.[0]);
    const value = entry.children?.[1];
    if (value?.type === 'string') direction = value.value;
    else if (value?.type === 'object') {
      if ((value.children ?? []).some((option) => !['order', 'missing', 'unmapped_type'].includes(String(option.children?.[0]?.value)))) return null;
      const order = property(value, 'order');
      const absent = property(value, 'missing');
      const type = property(value, 'unmapped_type');
      if (order) direction = order.type === 'string' ? order.value : null;
      if (absent) {
        if (absent.type !== 'string' || absent.value !== '_first' && absent.value !== '_last') return null;
        missing = absent.value;
      }
      if (type) {
        if (!unmappedType(textOf(type))) return null;
        unmapped = type.value;
      }
    } else return null;
  } else return null;
  if (field === undefined) return null;
  const clause = { field, direction: direction === undefined ? defaultSortDirection(field) : direction,
    missing, unmappedType: unmapped } as QuerySortClause;
  return clauseProblem(clause) === null ? clause : null;
}

function readSort(root: Node): QuerySortParse {
  const sort = property(root, 'sort');
  if (!sort) return { ok: true, clauses: [] };
  const nodes = sort.type === 'array' ? sort.children ?? [] : [sort];
  if (nodes.length > MAX_QUERY_SORT_FIELDS) return { ok: false, code: 'tooMany' };
  const clauses: QuerySortClause[] = [];
  for (const node of nodes) {
    const clause = readClause(node);
    if (!clause) return { ok: false, code: 'unsupportedSort' };
    if (clauses.some((item) => item.field === clause.field)) return { ok: false, code: 'duplicateField', field: clause.field };
    clauses.push(clause);
  }
  return { ok: true, clauses };
}

/** Refuse the entire source sort if an option cannot be represented, including on removal. */
export function parseQuerySort(rawDsl: string): QuerySortParse {
  const body = readBody(rawDsl);
  return body.ok ? readSort(body.root) : body;
}

function fieldEvidence(root: Node, field: string, catalog?: FieldCatalog): SortFieldEvidence {
  if (builtin(field)) return { ok: true, fieldType: field, origin: 'builtin', reportedUnmapped: false };
  if (!validTimeRangeField(field)) return { ok: false, code: 'invalidField', field };
  if (catalog?.fields.some((entry) => entry.types.some((type) => type.type === 'nested')
    && (entry.name === field || field.startsWith(`${entry.name}.`)))) return { ok: false, code: 'fieldNested', field };
  if (field.includes('.')) return { ok: false, code: 'fieldPath', field };
  const runtime = property(property(root, 'runtime_mappings'), field);
  if (runtime) {
    const type = textOf(property(runtime, 'type'))!;
    return SORTABLE_TYPES.has(type) ? { ok: true, fieldType: type, origin: 'runtime', reportedUnmapped: false }
      : { ok: false, code: 'fieldUnsupported', field };
  }
  if (!catalog) return { ok: false, code: 'fieldUnchecked', field };
  const capability = catalog.fields.find((entry) => entry.name === field);
  if (!capability || !capability.types.length) return { ok: false, code: 'fieldMissing', field };
  const mapped = capability.types.filter((type) => type.type !== 'unmapped');
  if (!mapped.length) return { ok: false, code: 'fieldUnmapped', field };
  const reportedUnmapped = mapped.length !== capability.types.length;
  if (mapped.length !== 1 || capability.conflict && !reportedUnmapped) return { ok: false, code: 'fieldConflict', field };
  const type = mapped[0]!;
  if (type.metadata || !SORTABLE_TYPES.has(type.type)) return { ok: false, code: 'fieldUnsupported', field };
  if (!type.aggregatable) return { ok: false, code: 'fieldNotSortable', field };
  return { ok: true, fieldType: type.type, origin: 'mapped', reportedUnmapped };
}

/** Caller supplies only the current target's successful field read, never a permission grant. */
export function querySortEvidence(rawDsl: string, fields: readonly string[], catalog?: FieldCatalog): readonly SortFieldEvidence[] {
  const body = readBody(rawDsl);
  return fields.map((field) => body.ok ? fieldEvidence(body.root, field, catalog) : body);
}

function sortEdit(root: Node, clauses: readonly QuerySortClause[]): Edit | null {
  const props = root.children ?? [];
  const index = props.findIndex((entry) => entry.children?.[0]?.value === 'sort');
  const target = props[index];
  if (clauses.length) {
    const content = `[${clauses.map((clause) => `{${JSON.stringify(clause.field)}:{"order":"${clause.direction}"`
      + `${clause.missing === 'default' ? '' : `,"missing":"${clause.missing}"`}`
      + `${clause.unmappedType === null ? '' : `,"unmapped_type":"${clause.unmappedType}"`}}}`).join(',')}]`;
    const value = target?.children?.[1];
    if (value) return { offset: value.offset, length: value.length, content };
    const last = props.at(-1);
    return { offset: last ? last.offset + last.length : root.offset + 1, length: 0, content: `${last ? ',' : ''}"sort":${content}` };
  }
  if (!target) return null;
  if (props.length === 1) return { offset: target.offset, length: target.length, content: '' };
  if (index === 0) return { offset: target.offset, length: props[1]!.offset - target.offset, content: '' };
  const previous = props[index - 1]!;
  const offset = previous.offset + previous.length;
  return { offset, length: target.offset + target.length - offset, content: '' };
}

/** Only the top-level sort is edited; query tokens, scripts and managed time stay intact. */
export function previewQuerySort(source: QueryDocument, clauses: readonly QuerySortClause[], catalog?: FieldCatalog): QuerySortPreview {
  const body = readBody(source.dsl);
  if (!body.ok) return body;
  const original = readSort(body.root);
  if (!original.ok) return original;
  if (clauses.length > MAX_QUERY_SORT_FIELDS) return { ok: false, code: 'tooMany' };
  const seen = new Set<string>();
  for (const clause of clauses) {
    if (Object.keys(clause).length !== 4
      || !['field', 'direction', 'missing', 'unmappedType'].every((key) => Object.hasOwn(clause, key))) return { ok: false, code: 'invalidOptions' };
    const problem = clauseProblem(clause);
    if (problem) return { ok: false, code: problem, field: clause.field };
    if (seen.has(clause.field)) return { ok: false, code: 'duplicateField', field: clause.field };
    seen.add(clause.field);
    const evidence = fieldEvidence(body.root, clause.field, catalog);
    if (!evidence.ok) return evidence;
    if (clause.unmappedType !== null && clause.unmappedType !== evidence.fieldType) return { ok: false, code: 'unmappedMismatch', field: clause.field };
    if (evidence.reportedUnmapped && clause.unmappedType === null) return { ok: false, code: 'unmappedRequired', field: clause.field };
  }
  const time = source.timeRange === undefined ? undefined
    : parseQueryTimeRange(source.timeRange, source.connectionId, source.index, source.dsl);
  if (time === null) return { ok: false, code: 'invalidBinding' };
  const same = clauses.length > 0 && original.clauses.length === clauses.length && clauses.every((clause, index) => {
    const before = original.clauses[index]!;
    return clause.field === before.field && clause.direction === before.direction
      && clause.missing === before.missing && clause.unmappedType === before.unmappedType;
  });
  const edit = same ? null : sortEdit(body.root, clauses);
  const dsl = edit ? applyEdits(source.dsl, [edit]) : source.dsl;
  if (bytes(dsl) > MAX_SORT_DSL_BYTES) return { ok: false, code: 'tooLarge' };
  if (!readBody(dsl).ok) return { ok: false, code: 'invalidDsl' };
  if (clauses.some((clause) => clause.field === '_shard_doc') && !supportsSnapshotPaging(dsl)) return { ok: false, code: 'pitRequired' };
  if (time && !parseQueryTimeRange(time, source.connectionId, source.index, dsl)) return { ok: false, code: 'invalidBinding' };
  return { ok: true, dsl, changed: dsl !== source.dsl, patch: { dsl, ...(time ? { timeRange: copyQueryTimeRange(time) } : {}) } };
}

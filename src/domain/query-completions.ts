import { createScanner, findNodeAtOffset, getNodePath, getNodeValue, type Node } from 'jsonc-parser';
import { boundedParameterJson, parseQueryParameters, type QueryParameters } from './query-parameters';
import { property } from './query-result';
import type { FieldCatalog } from './resource';
import { parseRuntimeMappings } from './runtime-fields';

export const MAX_COMPLETION_DSL_BYTES = 256 * 1024;
export const MAX_COMPLETION_FIELDS = 4096;
export const MAX_COMPLETION_ITEMS = 100;
export const MAX_COMPLETION_NAME_BYTES = 1024;

export interface QueryCompletionTarget {
  readonly connectionId: string;
  readonly endpoint: string;
  readonly index: string;
}

export interface QueryCompletionContext {
  readonly target: QueryCompletionTarget | null;
  readonly fields?: { readonly target: QueryCompletionTarget; readonly catalog: FieldCatalog };
  readonly parameters?: QueryParameters;
}

export interface QueryCompletion {
  readonly name: string;
  readonly type: string;
  readonly origin: 'mapped' | 'runtime' | 'parameter';
  readonly shadows: boolean;
  readonly offset: number;
  readonly length: number;
  readonly text: string;
  readonly filterText: string;
}

interface Slot {
  readonly root: Node;
  readonly node: Node;
  readonly offset: number;
  readonly length: number;
  readonly prefix: string;
  readonly needsColon: boolean;
}

type FieldPosition = 'query' | 'exists' | 'sort' | 'fields' | 'source';
type Candidate = Pick<QueryCompletion, 'name' | 'type' | 'origin' | 'shadows'>;

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const scalarTypes = new Set([
  'keyword', 'constant_keyword', 'wildcard', 'text', 'match_only_text',
  'long', 'integer', 'short', 'byte', 'unsigned_long', 'double', 'float', 'half_float', 'scaled_float',
  'boolean', 'date', 'date_nanos', 'ip', 'version', 'geo_point',
]);
const textTypes = new Set(['text', 'match_only_text']);
const fieldQueries = new Set(['term', 'terms', 'match', 'match_phrase', 'range']);
const booleanClauses = new Set(['must', 'must_not', 'filter', 'should']);
const fieldOptions = new Set(['boost', '_name', '$param']);
// jsonc-parser's ambient const enums cannot be imported with isolatedModules.
const syntax = { openBrace: 1, closeBrace: 2, openBracket: 3, closeBracket: 4, string: 10, eof: 17 } as const;

function sameTarget(left: QueryCompletionTarget, right: QueryCompletionTarget): boolean {
  return left.connectionId === right.connectionId && left.endpoint === right.endpoint && left.index === right.index;
}

function validName(name: string): boolean {
  if (name === '' || name !== name.trim() || name.length > MAX_COMPLETION_NAME_BYTES
    || bytes(name) > MAX_COMPLETION_NAME_BYTES || /[*?\u2028-\u202e\u2066-\u2069]/.test(name)) return false;
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 32 || code >= 127 && code <= 159) return false;
  }
  return true;
}

/**
 * The scanner bounds work before parsing. Only a complete string token or an empty
 * position is editable; malformed text elsewhere is never repaired for suggestions.
 */
function completionSlot(source: string, offset: number): Slot | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length
    || source.length > MAX_COMPLETION_DSL_BYTES || bytes(source) > MAX_COMPLETION_DSL_BYTES) return null;
  const scanner = createScanner(source);
  let token: { offset: number; length: number } | undefined;
  let depth = 0;
  let count = 0;
  for (let kind = scanner.scan(); kind !== syntax.eof; kind = scanner.scan()) {
    if (++count > 100_000 || scanner.getTokenError() !== 0) return null;
    if (kind === syntax.openBrace || kind === syntax.openBracket) {
      if (++depth > 64) return null;
    } else if (kind === syntax.closeBrace || kind === syntax.closeBracket) {
      if (--depth < 0) return null;
    }
    if (kind === syntax.string && offset > scanner.getTokenOffset()
      && offset <= scanner.getTokenOffset() + scanner.getTokenLength()) {
      token = { offset: scanner.getTokenOffset(), length: scanner.getTokenLength() };
    }
  }
  const start = token?.offset ?? offset;
  const length = token?.length ?? 0;
  let prefix = '';
  if (token) {
    const end = Math.min(offset, start + length - 1);
    const prefixToken = source.slice(start, end) + '"';
    if (prefixToken.length > MAX_COMPLETION_NAME_BYTES + 2) return null;
    const reader = createScanner(prefixToken);
    if (reader.scan() !== syntax.string || reader.getTokenError() !== 0) return null;
    prefix = reader.getTokenValue();
  }
  // A temporary key/value only locates an empty slot. It is never written to the draft.
  const marker = token ? source.slice(start, start + length) : '"\\u0000escope-completion"';
  for (const needsColon of [false, true]) {
    const inspected = source.slice(0, start) + marker + (needsColon ? ':null' : '') + source.slice(start + length);
    const root = boundedParameterJson(inspected);
    if (!root || root.type !== 'object') continue;
    const node = findNodeAtOffset(root, start + 1);
    if (node?.type !== 'string' || node.offset !== start) continue;
    const isKey = node.parent?.type === 'property' && node.parent.children?.[0] === node;
    if (needsColon && !isKey) continue;
    return { root, node, offset: start, length, prefix, needsColon };
  }
  return null;
}

/** Recognize query containers, not similarly named keys in scripts or unknown DSL. */
function queryPath(path: readonly (string | number)[]): boolean {
  if (path[0] !== 'query' && path[0] !== 'post_filter') return false;
  let i = 1;
  while (i < path.length) {
    if (path[i] === 'bool' && booleanClauses.has(String(path[i + 1]))) {
      i += 2;
      if (typeof path[i] === 'number') i++;
    } else if (path[i] === 'constant_score' && path[i + 1] === 'filter') i += 2;
    else return false;
  }
  return true;
}

function fieldPosition(slot: Slot): FieldPosition | null {
  const { node } = slot;
  const path = getNodePath(node);
  const isKey = node.parent?.type === 'property' && node.parent.children?.[0] === node;
  if (isKey) {
    const ownerPath = path.slice(0, -1);
    const operator = ownerPath.at(-1);
    if (typeof operator === 'string' && fieldQueries.has(operator) && queryPath(ownerPath.slice(0, -1))) {
      return slot.length && fieldOptions.has(node.value as string) ? null : 'query';
    }
    if (ownerPath[0] === 'sort' && (ownerPath.length === 1
      || ownerPath.length === 2 && typeof ownerPath[1] === 'number')) {
      return slot.length && ['_script', '_geo_distance'].includes(node.value as string) ? null : 'sort';
    }
    return null;
  }
  if (path.at(-1) === 'field' && path.at(-2) === 'exists' && queryPath(path.slice(0, -2))) return 'exists';
  if (path[0] === 'sort' && (path.length === 1 || path.length === 2 && typeof path[1] === 'number')) return 'sort';
  if (path[0] === 'fields' && typeof path[1] === 'number'
    && (path.length === 2 || path.length === 3 && path[2] === 'field')) return 'fields';
  if (path[0] === '_source' && (path.length === 1
    || path.length === 2 && typeof path[1] === 'number'
    || ['includes', 'excludes'].includes(String(path[1]))
      && (path.length === 2 || path.length === 3 && typeof path[2] === 'number'))) return 'source';
  return null;
}

function parameterPosition(slot: Slot): boolean {
  const parent = slot.node.parent;
  return !slot.needsColon && parent?.type === 'property' && parent.children?.[1] === slot.node
    && parent.children[0]?.value === '$param' && parent.parent !== slot.root && parent.parent?.children?.length === 1;
}

function fieldCandidates(slot: Slot, position: FieldPosition, context: QueryCompletionContext): Candidate[] {
  const mappings = property(slot.root, 'runtime_mappings');
  const runtime = mappings ? parseRuntimeMappings(getNodeValue(mappings)) : [];
  if (runtime === null) return [];
  const catalog = context.target && context.fields && sameTarget(context.target, context.fields.target)
    && context.target.connectionId !== '' && context.target.endpoint !== '' && context.target.index !== ''
    && context.fields.catalog.fields.length <= MAX_COMPLETION_FIELDS ? context.fields.catalog : undefined;
  const runtimeNames = new Set(runtime.map(({ field }) => field));
  const nested = new Set(catalog?.fields.filter((field) => field.types.some(({ type }) => type === 'nested')).map(({ name }) => name));
  const mappedNames = new Set(catalog?.fields.map(({ name }) => name));
  const nestedParent = (name: string) => {
    for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
      if (nested.has(name.slice(0, dot))) return true;
    }
    return false;
  };
  const candidates: Candidate[] = [];
  for (const field of catalog?.fields ?? []) {
    const type = field.types[0];
    if (!validName(field.name) || field.conflict || field.types.length !== 1 || !type || !scalarTypes.has(type.type)) continue;
    if (position !== 'source' && runtimeNames.has(field.name)) continue;
    if ((position === 'query' || position === 'exists' || position === 'sort') && nestedParent(field.name)) continue;
    if ((position === 'query' || position === 'exists') && !type.searchable) continue;
    if (position === 'query' && (type.type === 'geo_point' || fieldOptions.has(field.name))) continue;
    if (position === 'sort' && (!type.aggregatable || textTypes.has(type.type) || type.type === 'geo_point')) continue;
    if (position === 'source' && type.metadata) continue;
    candidates.push({ name: field.name, type: type.type, origin: 'mapped', shadows: false });
  }
  if (position !== 'source') for (const field of runtime) {
    if (!validName(field.field) || position === 'query' && (field.type === 'geo_point' || fieldOptions.has(field.field))
      || position === 'sort' && field.type === 'geo_point'
      || (position === 'query' || position === 'exists' || position === 'sort') && nestedParent(field.field)) continue;
    candidates.push({ name: field.field, type: field.type, origin: 'runtime',
      shadows: mappedNames.has(field.field) });
  }
  return candidates;
}

/** Local, bounded token edits only. No service, result body, template value or other model is read. */
export function queryCompletions(source: string, offset: number, context: QueryCompletionContext): readonly QueryCompletion[] {
  const slot = completionSlot(source, offset);
  if (!slot) return [];
  let candidates: Candidate[];
  if (parameterPosition(slot)) {
    const parameters = parseQueryParameters(context.parameters);
    candidates = parameters?.definitions.map(({ name, type }) => ({ name, type, origin: 'parameter', shadows: false })) ?? [];
  } else {
    const position = fieldPosition(slot);
    if (!position) return [];
    candidates = fieldCandidates(slot, position, context);
  }
  const isKey = slot.node.parent?.type === 'property' && slot.node.parent.children?.[0] === slot.node;
  const siblings = new Set(isKey ? slot.node.parent?.parent?.children?.filter((entry) => entry !== slot.node.parent)
    .map((entry) => entry.children?.[0]?.value as string) : []);
  const prefix = slot.prefix.toLowerCase();
  const seen = new Set<string>();
  return candidates.filter(({ name }) => {
    if (!name.toLowerCase().startsWith(prefix) || siblings.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).slice(0, MAX_COMPLETION_ITEMS).map((candidate) => ({
    ...candidate, offset: slot.offset, length: slot.length,
    text: JSON.stringify(candidate.name) + (slot.needsColon ? ': ' : ''),
    filterText: JSON.stringify(candidate.name),
  }));
}

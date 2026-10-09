import { applyEdits, parseTree, type Node, type ParseError } from 'jsonc-parser';
import type { FieldCapability } from './resource';
import { validateQueryDsl, type QueryDslError } from './query-dsl';

/**
 * Lossless, reversible subset of the `_search` request body for the visual query editor.
 *
 * Text is the source of truth: the module reads the draft with `jsonc-parser` node offsets,
 * rewrites only `query`/`size`/`sort` through targeted `applyEdits` spans, and never
 * re-serializes untouched values. Unchanged condition values keep their verbatim source
 * token, so long integers, exponents and escape sequences survive an edit.
 *
 * Reversal is deliberately narrow: anything outside the subset (nested bool, boost,
 * scripts, scoring options, multi-field sort, non-integer size) is reported as unsupported
 * instead of being guessed at, dropped or rewritten.
 */

export type VisualMode = 'all' | 'any';
export type VisualContext = 'filter' | 'must';
export type VisualOperator = 'eq' | 'neq' | 'match' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'missing';
export type VisualValueType = 'string' | 'number' | 'boolean';

/** Value token exactly as it appeared in the draft, reused while the row is unchanged. */
export interface VisualOriginal {
  readonly field: string;
  readonly value: string;
  readonly valueType: VisualValueType;
  readonly raw: string;
}

export interface VisualCondition {
  /** Local row identity, persisted with drafts but never sent in the search DSL. */
  readonly id: string;
  readonly field: string;
  readonly operator: VisualOperator;
  /** `filter` does not score, `must` scores; ignored in `any` (OR) mode, which is scoring. */
  readonly context: VisualContext;
  readonly valueType: VisualValueType;
  /** Current draft text of the value; numbers stay text and are never coerced to JS Number. */
  readonly value: string;
  readonly original?: VisualOriginal;
}

export interface VisualSort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export interface VisualForm {
  readonly mode: VisualMode;
  readonly conditions: readonly VisualCondition[];
  /** Raw size draft; `''` means the property should not exist. */
  readonly size: string;
  /** `null` means no sort property. */
  readonly sort: VisualSort | null;
}

export const VISUAL_SIZE_MAX = 10000;

export type ProblemCode =
  | 'fieldRequired'
  | 'fieldConflict'
  | 'fieldNested'
  | 'fieldNotSearchable'
  | 'operatorNotAllowed'
  | 'valueTypeMismatch'
  | 'negativeInAny'
  | 'valueRequired'
  | 'valueInvalidNumber'
  | 'valueInvalidBoolean'
  | 'sizeInvalid'
  | 'sizeOutOfRange'
  | 'sortDirectionInvalid'
  | 'sortFieldRequired'
  | 'sortFieldInvalid'
  | 'sourceUnsupported';

export interface VisualBuildProblem {
  readonly code: ProblemCode;
  /** Set for row-level problems so the editor can mark the offending row. */
  readonly conditionId?: string;
}

export interface VisualBuildResult {
  readonly problems: readonly VisualBuildProblem[];
  /** Present only when at least one valid part was rewritten to a different text. */
  readonly dsl?: string;
}

export type VisualUnsupportedReason = 'query' | 'size' | 'sort';

export type VisualParse =
  | { readonly ok: true; readonly form: VisualForm }
  | { readonly ok: false; readonly reason: 'invalidDsl'; readonly error: QueryDslError }
  | { readonly ok: false; readonly reason: VisualUnsupportedReason };

export function emptyVisualForm(): VisualForm {
  return { mode: 'all', conditions: [], size: '', sort: null };
}

const STRICT_JSON = { disallowComments: true, allowTrailingComma: false };

const ALL_OPERATORS: readonly VisualOperator[] = ['eq', 'neq', 'match', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'];
const NEGATIVE_OPERATORS: readonly VisualOperator[] = ['neq', 'missing'];
const RANGE_OPERATORS = ['gt', 'gte', 'lt', 'lte'] as const;
const BOOL_KEYS = new Set(['filter', 'must', 'should', 'must_not', 'minimum_should_match']);

type Family = 'boolean' | 'numeric' | 'date' | 'text' | 'keyword' | 'ip' | 'nested' | 'other';

const FAMILY_OPERATORS: Record<Family, readonly VisualOperator[]> = {
  boolean: ['eq', 'neq', 'exists', 'missing'],
  numeric: ['eq', 'neq', 'match', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'],
  text: ['eq', 'neq', 'match', 'exists', 'missing'],
  keyword: ['eq', 'neq', 'match', 'exists', 'missing'],
  ip: ['eq', 'neq', 'match', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'],
  nested: [],
  other: ALL_OPERATORS,
};

const FAMILY_VALUE_TYPES: Partial<Record<Family, readonly VisualValueType[]>> = {
  boolean: ['boolean'],
  numeric: ['number'],
  date: ['string'],
  text: ['string'],
  keyword: ['string'],
  ip: ['string'],
};

const NUMBER_GRAMMAR = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const SIZE_GRAMMAR = /^(0|[1-9]\d*)$/;

/** Pseudo-fields ES sorts without a catalogue entry. */
const BUILT_IN_SORT_FIELDS = new Set(['_score', '_doc', '_shard_doc']);

/** Missing explicit order follows the ES default: `_score` desc, everything else asc. */
function defaultSortDirection(field: string): 'asc' | 'desc' {
  return field === '_score' ? 'desc' : 'asc';
}

function rootNode(source: string): Node | null {
  const errors: ParseError[] = [];
  let root: Node | undefined;
  try {
    root = parseTree(source, errors, STRICT_JSON);
  } catch {
    return null;
  }
  if (errors.length > 0 || root === undefined) return null;
  return root;
}

function properties(node: Node | undefined): Node[] {
  if (node?.type !== 'object') return [];
  return (node.children ?? []).filter((child) => child.type === 'property');
}

function propName(property: Node): string | undefined {
  const [key] = property.children ?? [];
  return typeof key?.value === 'string' ? key.value : undefined;
}

function propValue(property: Node): Node | undefined {
  return (property.children ?? [])[1];
}

function findProperty(node: Node, name: string): Node | undefined {
  return properties(node).find((property) => propName(property) === name);
}

function rawText(source: string, node: Node): string {
  return source.slice(node.offset, node.offset + node.length);
}

/** Untouched part of a form; per-part comparison decides which properties may be rewritten. */
function sameConditions(a: readonly VisualCondition[], b: readonly VisualCondition[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((condition, index) => {
    const other = b[index];
    return other !== undefined && condition.field === other.field && condition.operator === other.operator
      && condition.context === other.context && condition.valueType === other.valueType
      && condition.value === other.value;
  });
}

function sameQuery(a: VisualForm, b: VisualForm): boolean {
  return a.mode === b.mode && sameConditions(a.conditions, b.conditions);
}

function sameSize(a: VisualForm, b: VisualForm): boolean {
  return a.size.trim() === b.size.trim();
}

function sameSort(a: VisualForm, b: VisualForm): boolean {
  if (a.sort === null || b.sort === null) return a.sort === null && b.sort === null;
  return a.sort.field === b.sort.field && a.sort.direction === b.sort.direction;
}

interface Literal {
  readonly valueType: VisualValueType;
  readonly display: string;
  readonly raw: string;
}

function readLiteral(source: string, node: Node): Literal | null {
  const raw = rawText(source, node);
  if (node.type === 'string') return { valueType: 'string', display: String(node.value), raw };
  if (node.type === 'number') return { valueType: 'number', display: raw, raw };
  if (node.type === 'boolean') return { valueType: 'boolean', display: node.value === true ? 'true' : 'false', raw };
  return null;
}

function singleEntry(node: Node): { name: string; value: Node } | null {
  const entries = properties(node);
  if (entries.length !== 1) return null;
  const entry = entries[0];
  const name = entry ? propName(entry) : undefined;
  const value = entry ? propValue(entry) : undefined;
  return name !== undefined && value !== undefined ? { name, value } : null;
}

/** Reverses one leaf clause (`term`/`match`/`range`/`exists`) into a condition without an id. */
function reverseClause(source: string, node: Node): Omit<VisualCondition, 'id'> | null {
  if (node.type !== 'object') return null;
  const query = singleEntry(node);
  if (!query) return null;
  const body = query.value;
  if (body.type !== 'object') return null;
  const field = singleEntry(body);
  if (!field) return null;
  switch (query.name) {
    case 'term': {
      const literal = field.value.type === 'object' ? null : readLiteral(source, field.value);
      const wrapped = field.value.type === 'object' ? wrappedLiteral(source, field.value, 'value') : null;
      const value = literal ?? wrapped;
      if (!value) return null;
      return conditionOf(field.name, 'eq', 'must', value);
    }
    case 'match': {
      const literal = field.value.type === 'object' ? null : readLiteral(source, field.value);
      const wrapped = field.value.type === 'object' ? wrappedLiteral(source, field.value, 'query') : null;
      const value = literal ?? wrapped;
      if (!value) return null;
      return conditionOf(field.name, 'match', 'must', value);
    }
    case 'range': {
      const spec = singleEntry(field.value);
      if (!spec || !(RANGE_OPERATORS as readonly string[]).includes(spec.name)) return null;
      const value = readLiteral(source, spec.value);
      if (!value) return null;
      return conditionOf(field.name, spec.name as VisualOperator, 'must', value);
    }
    case 'exists': {
      if (field.name !== 'field' || field.value.type !== 'string') return null;
      const name = String(field.value.value);
      if (name === '') return null;
      return conditionOf(name, 'exists', 'must', null);
    }
    default:
      return null;
  }
}

/** `{"term":{"f":{"value":...}}}` / `{"match":{"f":{"query":...}}}`; any other key is unsupported. */
function wrappedLiteral(source: string, node: Node, key: string): Literal | null {
  if (node.type !== 'object') return null;
  const entry = singleEntry(node);
  if (!entry || entry.name !== key) return null;
  return readLiteral(source, entry.value);
}

function conditionOf(field: string, operator: VisualOperator, context: VisualContext, literal: Literal | null): Omit<VisualCondition, 'id'> {
  if (!literal) return { field, operator, context, valueType: 'string', value: '' };
  return {
    field, operator, context, valueType: literal.valueType, value: literal.display,
    original: { field, value: literal.display, valueType: literal.valueType, raw: literal.raw },
  };
}

function arrayItems(node: Node): Node[] | null {
  if (node.type !== 'array') return null;
  return node.children ?? [];
}

/** Reverses `bool` in either AND (filter/must + must_not) or OR (should with explicit msm 1) form. */
function reverseBool(source: string, node: Node, nextId: () => string): { mode: VisualMode; conditions: VisualCondition[] } | null {
  const entries = properties(node);
  if (entries.length === 0) return null;
  const named = new Map<string, Node>();
  for (const entry of entries) {
    const name = propName(entry);
    const value = propValue(entry);
    if (name === undefined || value === undefined || !BOOL_KEYS.has(name) || named.has(name)) return null;
    named.set(name, value);
  }
  const should = named.get('should');
  const minimum = named.get('minimum_should_match');
  const filter = named.get('filter');
  const must = named.get('must');
  const mustNot = named.get('must_not');

  if (should) {
    // OR only round-trips when `minimum_should_match` is explicit: the default depends on
    // sibling clauses, so an implicit OR could not be re-emitted without changing semantics.
    if (!minimum || minimum.type !== 'number' || rawText(source, minimum) !== '1') return null;
    if (filter || must || mustNot) return null;
    const items = arrayItems(should);
    // An empty `should` only matches through sibling clauses (here: none), which this form
    // cannot re-emit as an OR; it is not equivalent to match_all either.
    if (!items || items.length === 0) return null;
    const conditions: VisualCondition[] = [];
    for (const item of items) {
      const clause = reverseClause(source, item);
      if (clause) {
        conditions.push({ id: nextId(), ...clause, context: 'must' });
        continue;
      }
      const wrapped = reverseFilterWrapper(source, item);
      if (!wrapped) return null;
      conditions.push({ id: nextId(), ...wrapped, context: 'filter' });
    }
    return { mode: 'any', conditions };
  }
  if (minimum) return null;

  const positives: VisualCondition[] = [];
  const negatives: VisualCondition[] = [];
  const readPositive = (list: Node | undefined, context: VisualContext): boolean => {
    if (!list) return true;
    const items = arrayItems(list);
    if (!items) return false;
    for (const item of items) {
      const clause = reverseClause(source, item);
      if (!clause) return false;
      positives.push({ id: nextId(), ...clause, context });
    }
    return true;
  };
  if (!readPositive(must, 'must')) return null;
  if (!readPositive(filter, 'filter')) return null;
  if (mustNot) {
    const items = arrayItems(mustNot);
    if (!items) return null;
    for (const item of items) {
      const clause = reverseClause(source, item);
      if (!clause || (clause.operator !== 'eq' && clause.operator !== 'exists')) return null;
      const operator: VisualOperator = clause.operator === 'eq' ? 'neq' : 'missing';
      negatives.push({ id: nextId(), ...clause, operator, context: 'must' });
    }
  }
  if (positives.length === 0 && negatives.length === 0) return null;
  return { mode: 'all', conditions: [...positives, ...negatives] };
}

/**
 * `{"bool":{"filter":[<single leaf>]}}` inside `should` keeps a clause non-scoring in OR mode,
 * which is the only shape that preserves a filter-context row across the mode switch.
 */
function reverseFilterWrapper(source: string, node: Node): Omit<VisualCondition, 'id'> | null {
  const query = singleEntry(node);
  if (!query || query.name !== 'bool') return null;
  const body = singleEntry(query.value);
  if (!body || body.name !== 'filter') return null;
  const items = arrayItems(body.value);
  if (!items || items.length !== 1) return null;
  const inner = items[0];
  return inner ? reverseClause(source, inner) : null;
}

function reverseSize(source: string, node: Node): string | null {
  if (node.type !== 'number') return null;
  const raw = rawText(source, node);
  if (!SIZE_GRAMMAR.test(raw)) return null;
  if (raw.length > 5 || Number(raw) > VISUAL_SIZE_MAX) return null;
  return raw;
}

/**
 * Accepts the strict single sort forms: `["f"]`, `"f"`, `[{"f":"asc"}]`, `{"f":"asc"}` and the
 * `{"f":{"order":"asc"}}` value form. A shorthand string uses the ES default direction
 * (`_score` desc, everything else asc); the direction is only made explicit on an edit.
 */
function reverseSort(node: Node): VisualSort | null {
  const item = node.type === 'array' && (node.children ?? []).length === 1 ? node.children?.[0] : node;
  if (!item) return null;
  if (item.type === 'string') {
    const field = String(item.value);
    if (field === '') return null;
    return { field, direction: defaultSortDirection(field) };
  }
  if (item.type !== 'object') return null;
  const entry = singleEntry(item);
  if (!entry) return null;
  const value = entry.value;
  let direction: unknown;
  if (value.type === 'string') {
    direction = value.value;
  } else if (value.type === 'object') {
    const order = singleEntry(value);
    if (!order || order.name !== 'order' || order.value.type !== 'string') return null;
    direction = order.value.value;
  } else {
    return null;
  }
  if (direction !== 'asc' && direction !== 'desc') return null;
  if (entry.name === '') return null;
  return { field: entry.name, direction };
}

/**
 * Reverse a draft into the supported form. Anything outside the subset fails cleanly so the
 * caller can keep the DSL untouched and show an unsupported state.
 */
export function parseVisualForm(rawDsl: string): VisualParse {
  if (rawDsl.trim() === '') return { ok: true, form: emptyVisualForm() };
  const valid = validateQueryDsl(rawDsl);
  if (!valid.ok) return { ok: false, reason: 'invalidDsl', error: valid.error };
  const root = rootNode(rawDsl);
  if (!root) return { ok: false, reason: 'invalidDsl', error: { code: 'dslParseFailed' } };

  const base = emptyVisualForm();
  let size = base.size;
  const sizeProperty = findProperty(root, 'size');
  if (sizeProperty) {
    const reverse = reverseSize(rawDsl, propValue(sizeProperty) ?? root);
    if (reverse === null) return { ok: false, reason: 'size' };
    size = reverse;
  }
  let sort: VisualSort | null = null;
  const sortProperty = findProperty(root, 'sort');
  if (sortProperty) {
    sort = reverseSort(propValue(sortProperty) ?? root);
    if (sort === null) return { ok: false, reason: 'sort' };
  }

  let mode: VisualMode = 'all';
  let conditions: VisualCondition[] = [];
  const queryProperty = findProperty(root, 'query');
  if (queryProperty) {
    const query = propValue(queryProperty);
    if (!query || query.type !== 'object') return { ok: false, reason: 'query' };
    const entry = singleEntry(query);
    let counter = 0;
    const nextId = () => `vq-${counter++}`;
    if (entry?.name === 'bool' && entry.value.type === 'object') {
      const reversed = reverseBool(rawDsl, entry.value, nextId);
      if (!reversed) return { ok: false, reason: 'query' };
      mode = reversed.mode;
      conditions = reversed.conditions;
    } else if (entry?.name === 'match_all' && entry.value.type === 'object' && properties(entry.value).length === 0) {
      // Plain `match_all: {}` is the default query: zero condition rows, and an untouched
      // draft keeps its exact bytes because the form does not change until the user does.
      // Any match_all option (boost, …) stays unsupported.
      mode = 'all';
      conditions = [];
    } else {
      const clause = entry ? reverseClause(rawDsl, query) : null;
      if (!clause) return { ok: false, reason: 'query' };
      conditions = [{ id: nextId(), ...clause }];
    }
  }
  return { ok: true, form: { mode, conditions, size, sort } };
}

function familyOf(type: string): Family {
  switch (type) {
    case 'boolean':
      return 'boolean';
    case 'byte': case 'short': case 'integer': case 'long': case 'unsigned_long':
    case 'float': case 'double': case 'half_float': case 'scaled_float':
      return 'numeric';
    case 'date': case 'date_nanos':
      return 'date';
    case 'text': case 'match_only_text':
      return 'text';
    case 'keyword': case 'constant_keyword': case 'wildcard':
      return 'keyword';
    case 'ip':
      return 'ip';
    case 'nested':
      return 'nested';
    default:
      return 'other';
  }
}

function isNestedCapability(capability: FieldCapability): boolean {
  return capability.types.some((type) => familyOf(type.type) === 'nested');
}

/** A path below a known nested field needs a nested query; a plain leaf clause would be unsafe. */
function hasNestedAncestor(field: string, catalogue: readonly FieldCapability[]): boolean {
  return catalogue.some((entry) => isNestedCapability(entry) && field.startsWith(`${entry.name}.`));
}

function checkField(field: string, catalogue: readonly FieldCapability[]): { ok: true; family: Family } | { ok: false; code: ProblemCode } {
  if (field.trim() === '') return { ok: false, code: 'fieldRequired' };
  if (hasNestedAncestor(field, catalogue)) return { ok: false, code: 'fieldNested' };
  const capability = catalogue.find((entry) => entry.name === field);
  if (!capability) return { ok: true, family: 'other' };
  if (capability.conflict) return { ok: false, code: 'fieldConflict' };
  if (isNestedCapability(capability)) return { ok: false, code: 'fieldNested' };
  if (!capability.types.some((type) => type.searchable)) return { ok: false, code: 'fieldNotSearchable' };
  const families = new Set(capability.types.map((type) => familyOf(type.type)));
  // Multiple families without the conflict flag would still make one value ambiguous.
  const first = families.values().next().value;
  if (first === undefined || families.size > 1) return { ok: false, code: 'fieldConflict' };
  return { ok: true, family: first };
}

/**
 * Sort needs doc values and no nested path: known text, conflicting, nested, nested-descendant
 * and non-aggregatable fields are rejected as drafts. Unknown manual fields and the built-in
 * pseudo-fields stay available, matching what the catalogue may not have loaded yet.
 */
function checkSortField(sort: VisualSort, catalogue: readonly FieldCapability[]): ProblemCode | null {
  if (sort.field.trim() === '') return 'sortFieldRequired';
  if (BUILT_IN_SORT_FIELDS.has(sort.field)) return null;
  if (hasNestedAncestor(sort.field, catalogue)) return 'sortFieldInvalid';
  const capability = catalogue.find((entry) => entry.name === sort.field);
  if (!capability) return null;
  if (capability.conflict) return 'sortFieldInvalid';
  if (isNestedCapability(capability)) return 'sortFieldInvalid';
  if (!capability.types.some((type) => type.aggregatable)) return 'sortFieldInvalid';
  if (capability.types.every((type) => familyOf(type.type) === 'text')) return 'sortFieldInvalid';
  return null;
}

function checkCondition(condition: VisualCondition, catalogue: readonly FieldCapability[], mode: VisualMode): ProblemCode | null {
  if (mode === 'any' && NEGATIVE_OPERATORS.includes(condition.operator)) return 'negativeInAny';
  const field = checkField(condition.field, catalogue);
  if (!field.ok) return field.code;
  if (!FAMILY_OPERATORS[field.family].includes(condition.operator)) return 'operatorNotAllowed';
  if (condition.operator === 'exists' || condition.operator === 'missing') return null;
  const allowedTypes = FAMILY_VALUE_TYPES[field.family];
  if (allowedTypes && !allowedTypes.includes(condition.valueType)) return 'valueTypeMismatch';
  const value = condition.value.trim();
  if (value === '') return 'valueRequired';
  if (condition.valueType === 'number' && !NUMBER_GRAMMAR.test(value)) return 'valueInvalidNumber';
  if (condition.valueType === 'boolean' && value !== 'true' && value !== 'false') return 'valueInvalidBoolean';
  return null;
}

function literalText(condition: VisualCondition): string {
  const original = condition.original;
  if (original && original.field === condition.field && original.valueType === condition.valueType && original.value === condition.value) {
    return original.raw;
  }
  switch (condition.valueType) {
    case 'string':
      return JSON.stringify(condition.value);
    case 'number':
    case 'boolean':
      return condition.value.trim();
  }
}

function clauseText(condition: VisualCondition): string {
  const field = JSON.stringify(condition.field);
  switch (condition.operator) {
    case 'eq':
    case 'neq':
      return `{"term":{${field}:${literalText(condition)}}}`;
    case 'match':
      return `{"match":{${field}:${literalText(condition)}}}`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return `{"range":{${field}:{"${condition.operator}":${literalText(condition)}}}}`;
    case 'exists':
    case 'missing':
      return `{"exists":{"field":${field}}}`;
  }
}

/** Generated text for the whole `query` value; `null` removes the property. */
function queryText(form: VisualForm): string | null {
  const positives = form.conditions.filter((condition) => !NEGATIVE_OPERATORS.includes(condition.operator));
  const negatives = form.conditions.filter((condition) => NEGATIVE_OPERATORS.includes(condition.operator));
  if (form.mode === 'any') {
    if (positives.length === 0) return null;
    // `should` scores; a filter-context row keeps its non-scoring semantics only inside an
    // explicit filter wrapper, so the mode switch never silently promotes it to scoring.
    const should = positives.map((condition) => (condition.context === 'filter'
      ? `{"bool":{"filter":[${clauseText(condition)}]}}`
      : clauseText(condition))).join(',');
    return `{"bool":{"should":[${should}],"minimum_should_match":1}}`;
  }
  if (positives.length === 0 && negatives.length === 0) return null;
  if (positives.length === 1 && negatives.length === 0 && positives[0]?.context === 'must') {
    return positives[0] ? clauseText(positives[0]) : null;
  }
  const parts: string[] = [];
  const must = positives.filter((condition) => condition.context === 'must').map(clauseText);
  const filter = positives.filter((condition) => condition.context === 'filter').map(clauseText);
  if (must.length > 0) parts.push(`"must":[${must.join(',')}]`);
  if (filter.length > 0) parts.push(`"filter":[${filter.join(',')}]`);
  if (negatives.length > 0) parts.push(`"must_not":[${negatives.map(clauseText).join(',')}]`);
  return `{"bool":{${parts.join(',')}}}`;
}

interface Edit { offset: number; length: number; content: string }

function writeProperty(root: Node, source: string, name: string, text: string, edits: Edit[]): void {
  const existing = findProperty(root, name);
  if (existing) {
    const value = propValue(existing);
    if (!value) return;
    if (rawText(source, value) !== text) edits.push({ offset: value.offset, length: value.length, content: text });
    return;
  }
  const props = properties(root);
  const last = props[props.length - 1];
  if (!last) {
    // Empty object: insert directly after `{`, keeping the existing braces valid.
    edits.push({ offset: root.offset + 1, length: 0, content: `\n  "${name}": ${text}\n` });
    return;
  }
  edits.push({ offset: last.offset + last.length, length: 0, content: `,\n  "${name}": ${text}` });
}

function removeProperty(root: Node, name: string, edits: Edit[]): void {
  const props = properties(root);
  const index = props.findIndex((property) => propName(property) === name);
  const target = props[index];
  if (!target) return;
  if (props.length === 1) {
    edits.push({ offset: target.offset, length: target.length, content: '' });
    return;
  }
  if (index === 0) {
    const next = props[1];
    if (!next) return;
    edits.push({ offset: target.offset, length: next.offset - target.offset, content: '' });
    return;
  }
  const previous = props[index - 1];
  if (!previous) return;
  const start = previous.offset + previous.length;
  edits.push({ offset: start, length: target.offset + target.length - start, content: '' });
}

/**
 * Apply the form to the draft with independent, minimal edits.
 *
 * Fails closed: an invalid or out-of-subset source never gets rewritten, baseline or not.
 * `baseline` is the form as reversed from `rawDsl`; parts equal to it are left byte-identical,
 * so editing conditions never rewrites an unrelated `size`/`sort` (or vice versa). Without a
 * baseline every represented part is canonicalized. Row-level problems block only the query
 * edit, size drafts block only the size edit, and so on. The three parts are applied one after
 * another with fresh offsets, so removing adjacent properties cannot produce overlapping spans.
 * `dsl` is omitted when nothing changed.
 */
export function buildVisualDsl(rawDsl: string, form: VisualForm, fields: readonly FieldCapability[], baseline?: VisualForm): VisualBuildResult {
  if (!parseVisualForm(rawDsl).ok) return { problems: [{ code: 'sourceUnsupported' }] };
  const problems: VisualBuildProblem[] = [];
  for (const condition of form.conditions) {
    const code = checkCondition(condition, fields, form.mode);
    if (code) problems.push({ code, conditionId: condition.id });
  }
  const size = form.size.trim();
  let sizeProblem: ProblemCode | null = null;
  if (size !== '') {
    if (!SIZE_GRAMMAR.test(size)) sizeProblem = 'sizeInvalid';
    else if (size.length > 5 || Number(size) > VISUAL_SIZE_MAX) sizeProblem = 'sizeOutOfRange';
  }
  if (sizeProblem) problems.push({ code: sizeProblem });
  let sortProblem: ProblemCode | null = null;
  if (form.sort) {
    sortProblem = form.sort.direction !== 'asc' && form.sort.direction !== 'desc'
      ? 'sortDirectionInvalid'
      : checkSortField(form.sort, fields);
  }
  if (sortProblem) problems.push({ code: sortProblem });

  const base = rawDsl.trim() === '' ? '{}' : rawDsl;
  let text = base;
  const apply = (name: 'query' | 'size' | 'sort', next: string | null): void => {
    const root = rootNode(text);
    if (!root) return;
    const edits: Edit[] = [];
    if (next === null) removeProperty(root, name, edits);
    else writeProperty(root, text, name, next, edits);
    if (edits.length > 0) text = applyEdits(text, edits);
  };

  const queryBlocked = problems.some((problem) => problem.conditionId !== undefined);
  if (!queryBlocked && (baseline === undefined || !sameQuery(baseline, form))) apply('query', queryText(form));
  if (!sizeProblem && (baseline === undefined || !sameSize(baseline, form))) {
    apply('size', size === '' ? null : size);
  }
  if (!sortProblem && (baseline === undefined || !sameSort(baseline, form))) {
    apply('sort', form.sort === null ? null : `[{${JSON.stringify(form.sort.field)}:{"order":"${form.sort.direction}"}}]`);
  }
  return text === base ? { problems } : { problems, dsl: text };
}

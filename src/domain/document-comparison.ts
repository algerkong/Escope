import { createScanner, type Node } from 'jsonc-parser';
import type { ExecutionSnapshot } from './query';
import { parseRawJson, property, sliceRaw, type QuerySummary } from './query-result';
import { compareDecimalText, type ResultGridRow } from './result-grid';
import { runtimeFieldNamesFromDsl } from './runtime-fields-dsl';

export const MAX_COMPARISON_HIT_BYTES = 1024 * 1024;
export const MAX_COMPARISON_DEPTH = 64;
export const MAX_COMPARISON_TOKENS = 100_000;
export const MAX_COMPARISON_FIELDS = 4096;
export const MAX_COMPARISON_NUMBER_LENGTH = 4096;
export const COMPARISON_PAGE_SIZE = 50;

export type ComparisonSection = 'source' | 'fields' | 'metadata';
export type ComparisonKind = Exclude<Node['type'], 'property'> | 'missing';
export type ComparisonStatus = 'equal' | 'changed' | 'typeChanged' | 'leftOnly' | 'rightOnly' | 'unavailable';
export type ComparisonError = 'selection' | 'unavailable' | 'tooLarge' | 'tooDeep' | 'tooComplex' | 'invalidDocument';

export interface ComparisonValue {
  readonly kind: ComparisonKind;
  /** A JSON token or container, never a decoded/re-serialized number or formatted field value. */
  readonly raw: string | null;
}

export interface ComparedDocument {
  readonly pageIndex: number;
  readonly position: number;
  readonly raw: string;
  readonly index: ComparisonValue;
  readonly id: ComparisonValue;
  readonly partial: boolean;
}

export interface ComparisonRow {
  readonly key: string;
  readonly section: ComparisonSection;
  /** Null denotes the container itself, not a guessed or flattened field path. */
  readonly field: string | null;
  readonly runtime: boolean;
  readonly left: ComparisonValue;
  readonly right: ComparisonValue;
  readonly status: ComparisonStatus;
}

export interface DocumentComparison {
  readonly origin: Readonly<Pick<ExecutionSnapshot, 'queryId' | 'requestId' | 'connectionId' | 'index' | 'startedAt'>
    & { endpoint: string | null }>;
  readonly left: ComparedDocument;
  readonly right: ComparedDocument;
  readonly rows: readonly ComparisonRow[];
}

export type DocumentComparisonResult =
  | { readonly ok: true; readonly comparison: DocumentComparison }
  | { readonly ok: false; readonly code: ComparisonError };

interface LoadedPage {
  readonly rawResponse: string;
  readonly summary: QuerySummary;
  readonly partial: boolean;
}

interface ReadDocument {
  readonly document: ComparedDocument;
  readonly root: Node;
}

const MISSING: ComparisonValue = Object.freeze({ kind: 'missing', raw: null });
const encoder = new TextEncoder();
// jsonc-parser publishes ambient const enums, which isolatedModules cannot import as values.
const TOKEN = { objectOpen: 1, objectClose: 2, arrayOpen: 3, arrayClose: 4, number: 11, eof: 17 } as const;

function valueOf(raw: string, node: Node | undefined): ComparisonValue {
  return node === undefined ? MISSING : Object.freeze({
    kind: node.type as Exclude<ComparisonKind, 'missing'>, raw: sliceRaw(raw, node),
  });
}

/** Bound the selected hit before building another syntax tree; the response as a whole is not read again. */
function inspect(raw: string): ComparisonError | Node {
  if (raw.length > MAX_COMPARISON_HIT_BYTES || encoder.encode(raw).length > MAX_COMPARISON_HIT_BYTES) return 'tooLarge';
  const scanner = createScanner(raw, true);
  let depth = 0;
  let count = 0;
  for (let token = scanner.scan(); token !== TOKEN.eof; token = scanner.scan()) {
    if (++count > MAX_COMPARISON_TOKENS) return 'tooComplex';
    if (token === TOKEN.objectOpen || token === TOKEN.arrayOpen) {
      if (++depth > MAX_COMPARISON_DEPTH) return 'tooDeep';
    } else if (token === TOKEN.objectClose || token === TOKEN.arrayClose) depth--;
    if (token === TOKEN.number && scanner.getTokenLength() > MAX_COMPARISON_NUMBER_LENGTH) return 'tooComplex';
  }
  const root = parseRawJson(raw);
  return root?.type === 'object' ? root : 'invalidDocument';
}

function readDocument(pages: readonly LoadedPage[], row: ResultGridRow): ReadDocument | ComparisonError {
  if (!Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0
    || !Number.isSafeInteger(row.position) || row.position < 0) return 'unavailable';
  const page = pages[row.pageIndex];
  if (!page || page.summary.hits[row.position] !== row.hit) return 'unavailable';
  const range = row.hit.raw;
  if (!range || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length)
    || range.offset < 0 || range.length <= 0 || range.offset + range.length > page.rawResponse.length) return 'unavailable';
  if (range.length > MAX_COMPARISON_HIT_BYTES) return 'tooLarge';
  const raw = sliceRaw(page.rawResponse, range);
  const root = inspect(raw);
  if (typeof root === 'string') return root;
  return {
    root,
    document: Object.freeze({
      pageIndex: row.pageIndex, position: row.position, raw, partial: page.partial,
      index: valueOf(raw, property(root, '_index')), id: valueOf(raw, property(root, '_id')),
    }),
  };
}

function properties(node: Node | undefined): Map<string, Node> {
  const result = new Map<string, Node>();
  if (node?.type === 'object') {
    for (const entry of node.children ?? []) {
      const [key, value] = entry.children ?? [];
      if (key?.type === 'string' && value) result.set(String(key.value), value);
    }
  }
  return result;
}

/** JSON object order/whitespace and string escapes are immaterial; array order and exact decimal values are not. */
function equalNodes(left: Node, right: Node, leftRaw: string, rightRaw: string): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'number') return compareDecimalText(sliceRaw(leftRaw, left), sliceRaw(rightRaw, right)) === 0;
  if (left.type === 'string' || left.type === 'boolean' || left.type === 'null') return left.value === right.value;
  if (left.type === 'array') {
    const a = left.children ?? [];
    const b = right.children ?? [];
    return a.length === b.length && a.every((node, index) => equalNodes(node, b[index]!, leftRaw, rightRaw));
  }
  const a = properties(left);
  const b = properties(right);
  if (a.size !== b.size) return false;
  for (const [key, node] of a) {
    const other = b.get(key);
    if (!other || !equalNodes(node, other, leftRaw, rightRaw)) return false;
  }
  return true;
}

function statusOf(left: Node | undefined, right: Node | undefined, leftRaw: string, rightRaw: string): ComparisonStatus {
  if (!left) return right ? 'rightOnly' : 'unavailable';
  if (!right) return 'leftOnly';
  if (left.type !== right.type) return 'typeChanged';
  return equalNodes(left, right, leftRaw, rightRaw) ? 'equal' : 'changed';
}

export function isComparisonDifference(status: ComparisonStatus): boolean {
  return status !== 'equal' && status !== 'unavailable';
}

/** Capture exactly two loaded occurrences. Neither IDs nor current table order are used to look up a document. */
export function compareLoadedDocuments(
  snapshot: ExecutionSnapshot,
  endpoint: string | null,
  pages: readonly LoadedPage[],
  selection: readonly ResultGridRow[],
): DocumentComparisonResult {
  if (selection.length !== 2) return { ok: false, code: 'selection' };
  const [a, b] = selection as readonly [ResultGridRow, ResultGridRow];
  if (a.pageIndex === b.pageIndex && a.position === b.position) return { ok: false, code: 'selection' };
  const left = readDocument(pages, a);
  if (typeof left === 'string') return { ok: false, code: left };
  const right = readDocument(pages, b);
  if (typeof right === 'string') return { ok: false, code: right };
  const rows: ComparisonRow[] = [];
  const runtime = new Set(runtimeFieldNamesFromDsl(snapshot.rawDsl));
  const add = (section: ComparisonSection, field: string | null, a: Node | undefined, b: Node | undefined) => {
    if (rows.length >= MAX_COMPARISON_FIELDS) return false;
    rows.push(Object.freeze({
      key: JSON.stringify([section, field]), section, field,
      runtime: section === 'fields' && field !== null && runtime.has(field),
      left: valueOf(left.document.raw, a), right: valueOf(right.document.raw, b),
      status: statusOf(a, b, left.document.raw, right.document.raw),
    }));
    return true;
  };
  for (const section of ['source', 'fields', 'metadata'] as const) {
    const name = section === 'source' ? '_source' : 'fields';
    const a = section === 'metadata' ? left.root : property(left.root, name);
    const b = section === 'metadata' ? right.root : property(right.root, name);
    // Non-object containers (including null and arrays) stay whole, distinct from absent keys.
    if (a && a.type !== 'object' || b && b.type !== 'object') {
      if (!add(section, null, a, b)) return { ok: false, code: 'tooComplex' };
      continue;
    }
    const leftFields = properties(a);
    const rightFields = properties(b);
    const names = new Set([...leftFields.keys(), ...rightFields.keys(), ...(section === 'fields' ? runtime : [])]);
    if (section === 'metadata') { names.delete('_source'); names.delete('fields'); }
    const emptyContainer = leftFields.size === 0 && rightFields.size === 0 && (a !== undefined || b !== undefined);
    if (section !== 'metadata' && (names.size === 0 || emptyContainer)) {
      if (!add(section, null, a, b)) return { ok: false, code: 'tooComplex' };
    }
    for (const field of names) {
      if (!add(section, field, leftFields.get(field), rightFields.get(field))) return { ok: false, code: 'tooComplex' };
    }
  }
  return {
    ok: true,
    comparison: Object.freeze({
      origin: Object.freeze({
        queryId: snapshot.queryId, requestId: snapshot.requestId, connectionId: snapshot.connectionId,
        index: snapshot.index, startedAt: snapshot.startedAt, endpoint,
      }),
      left: left.document, right: right.document, rows: Object.freeze(rows),
    }),
  };
}

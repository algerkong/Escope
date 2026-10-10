import type { Node } from 'jsonc-parser';
import type { ExecutionSnapshot } from './query';
import { property, sliceRaw } from './query-result';
import { compareDecimalText, type ResultGridRow } from './result-grid';
import { runtimeFieldNamesFromDsl } from './runtime-fields-dsl';
import {
  loadedDocumentOrigin, loadedDocumentValue as valueOf, readLoadedDocument,
  type LoadedDocument, type LoadedDocumentError, type LoadedDocumentKind, type LoadedDocumentOrigin,
  type LoadedDocumentPage, type LoadedDocumentSection, type LoadedDocumentValue,
} from './loaded-document';

export {
  MAX_LOADED_DOCUMENT_BYTES as MAX_COMPARISON_HIT_BYTES,
  MAX_LOADED_DOCUMENT_DEPTH as MAX_COMPARISON_DEPTH,
  MAX_LOADED_DOCUMENT_TOKENS as MAX_COMPARISON_TOKENS,
  MAX_LOADED_DOCUMENT_NUMBER_LENGTH as MAX_COMPARISON_NUMBER_LENGTH,
} from './loaded-document';
export const MAX_COMPARISON_FIELDS = 4096;
export const COMPARISON_PAGE_SIZE = 50;

export type ComparisonSection = LoadedDocumentSection;
export type ComparisonKind = LoadedDocumentKind;
export type ComparisonStatus = 'equal' | 'changed' | 'typeChanged' | 'leftOnly' | 'rightOnly' | 'unavailable';
export type ComparisonError = 'selection' | LoadedDocumentError;
export type ComparisonValue = LoadedDocumentValue;
export type ComparedDocument = LoadedDocument;

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
  readonly origin: LoadedDocumentOrigin;
  readonly left: ComparedDocument;
  readonly right: ComparedDocument;
  readonly rows: readonly ComparisonRow[];
}

export type DocumentComparisonResult =
  | { readonly ok: true; readonly comparison: DocumentComparison }
  | { readonly ok: false; readonly code: ComparisonError };

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
  pages: readonly LoadedDocumentPage[],
  selection: readonly ResultGridRow[],
): DocumentComparisonResult {
  if (selection.length !== 2) return { ok: false, code: 'selection' };
  const [a, b] = selection as readonly [ResultGridRow, ResultGridRow];
  if (a.pageIndex === b.pageIndex && a.position === b.position) return { ok: false, code: 'selection' };
  const left = readLoadedDocument(pages, a);
  if (typeof left === 'string') return { ok: false, code: left };
  const right = readLoadedDocument(pages, b);
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
      origin: loadedDocumentOrigin(snapshot, endpoint),
      left: left.document, right: right.document, rows: Object.freeze(rows),
    }),
  };
}

import { createScanner, type Node } from 'jsonc-parser';
import type { ExecutionSnapshot } from './query';
import { parseRawJson, property, sliceRaw, type QuerySummary } from './query-result';
import type { ResultGridRow } from './result-grid';

export const MAX_LOADED_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_LOADED_DOCUMENT_DEPTH = 64;
export const MAX_LOADED_DOCUMENT_TOKENS = 100_000;
export const MAX_LOADED_DOCUMENT_NUMBER_LENGTH = 4096;

export type LoadedDocumentSection = 'source' | 'fields' | 'metadata';
export type LoadedDocumentKind = Exclude<Node['type'], 'property'> | 'missing';
export type LoadedDocumentError = 'unavailable' | 'tooLarge' | 'tooDeep' | 'tooComplex' | 'invalidDocument';

export interface LoadedDocumentValue {
  readonly kind: LoadedDocumentKind;
  /** A JSON token or container, never a decoded/re-serialized number or formatted field value. */
  readonly raw: string | null;
}

export interface LoadedDocument {
  readonly pageIndex: number;
  readonly position: number;
  readonly raw: string;
  readonly index: LoadedDocumentValue;
  readonly id: LoadedDocumentValue;
  readonly partial: boolean;
}

export type LoadedDocumentOrigin = Readonly<
  Pick<ExecutionSnapshot, 'queryId' | 'requestId' | 'connectionId' | 'index' | 'startedAt'> & { endpoint: string | null }
>;

export interface LoadedDocumentPage {
  readonly rawResponse: string;
  readonly summary: QuerySummary;
  readonly partial: boolean;
}

const MISSING: LoadedDocumentValue = Object.freeze({ kind: 'missing', raw: null });
const encoder = new TextEncoder();
// jsonc-parser publishes ambient const enums, which isolatedModules cannot import as values.
const TOKEN = { objectOpen: 1, objectClose: 2, arrayOpen: 3, arrayClose: 4, number: 11, eof: 17 } as const;

export function loadedDocumentValue(raw: string, node: Node | undefined): LoadedDocumentValue {
  return node === undefined ? MISSING : Object.freeze({
    kind: node.type as Exclude<LoadedDocumentKind, 'missing'>, raw: sliceRaw(raw, node),
  });
}

export function loadedDocumentOrigin(snapshot: ExecutionSnapshot, endpoint: string | null): LoadedDocumentOrigin {
  return Object.freeze({
    queryId: snapshot.queryId, requestId: snapshot.requestId, connectionId: snapshot.connectionId,
    index: snapshot.index, startedAt: snapshot.startedAt, endpoint,
  });
}

/** Bound the selected hit before building another syntax tree; the response as a whole is not read again. */
function inspect(raw: string): LoadedDocumentError | Node {
  if (raw.length > MAX_LOADED_DOCUMENT_BYTES || encoder.encode(raw).length > MAX_LOADED_DOCUMENT_BYTES) return 'tooLarge';
  const scanner = createScanner(raw, true);
  let depth = 0;
  let count = 0;
  for (let token = scanner.scan(); token !== TOKEN.eof; token = scanner.scan()) {
    if (++count > MAX_LOADED_DOCUMENT_TOKENS) return 'tooComplex';
    if (token === TOKEN.objectOpen || token === TOKEN.arrayOpen) {
      if (++depth > MAX_LOADED_DOCUMENT_DEPTH) return 'tooDeep';
    } else if (token === TOKEN.objectClose || token === TOKEN.arrayClose) depth--;
    if (token === TOKEN.number && scanner.getTokenLength() > MAX_LOADED_DOCUMENT_NUMBER_LENGTH) return 'tooComplex';
  }
  const root = parseRawJson(raw);
  return root?.type === 'object' ? root : 'invalidDocument';
}

/** Read an actual received occurrence, never an ID match or a displayed row number. */
export function readLoadedDocument(
  pages: readonly LoadedDocumentPage[],
  row: ResultGridRow,
): { readonly document: LoadedDocument; readonly root: Node } | LoadedDocumentError {
  if (!Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0
    || !Number.isSafeInteger(row.position) || row.position < 0) return 'unavailable';
  const page = pages[row.pageIndex];
  if (!page || page.summary.hits[row.position] !== row.hit) return 'unavailable';
  const range = row.hit.raw;
  if (!range || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length)
    || range.offset < 0 || range.length <= 0 || range.offset + range.length > page.rawResponse.length) return 'unavailable';
  if (range.length > MAX_LOADED_DOCUMENT_BYTES) return 'tooLarge';
  const raw = sliceRaw(page.rawResponse, range);
  const root = inspect(raw);
  if (typeof root === 'string') return root;
  return {
    root,
    document: Object.freeze({
      pageIndex: row.pageIndex, position: row.position, raw, partial: page.partial,
      index: loadedDocumentValue(raw, property(root, '_index')), id: loadedDocumentValue(raw, property(root, '_id')),
    }),
  };
}

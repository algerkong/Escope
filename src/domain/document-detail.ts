import type { Node } from 'jsonc-parser';
import type { ExecutionSnapshot } from './query';
import { property, sliceRaw, type RawRange } from './query-result';
import type { ResultGridRow } from './result-grid';
import { runtimeFieldNamesFromDsl } from './runtime-fields-dsl';
import {
  loadedDocumentOrigin, readLoadedDocument, type LoadedDocument, type LoadedDocumentError,
  type LoadedDocumentKind, type LoadedDocumentOrigin, type LoadedDocumentPage, type LoadedDocumentSection,
} from './loaded-document';

export const MAX_DOCUMENT_DETAIL_NODES = 4096;
export const MAX_DOCUMENT_DETAIL_PATH_BYTES = 1024 * 1024;
export const DOCUMENT_DETAIL_PAGE_SIZE = 50;
export const MAX_DOCUMENT_DETAIL_SEARCH_LENGTH = 1024;

export interface DocumentField {
  /** RFC 6901 JSON Pointer relative to the received hit, not an Elasticsearch field path. */
  readonly path: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly section: LoadedDocumentSection;
  readonly kind: LoadedDocumentKind;
  readonly runtime: boolean;
  readonly range: Readonly<RawRange> | null;
  readonly childCount: number;
}

export interface DocumentDetail {
  readonly origin: LoadedDocumentOrigin;
  readonly document: LoadedDocument;
  /** The original received page, retained only for the existing explicit response-copy command. */
  readonly rawResponse: string;
  readonly rows: readonly DocumentField[];
}

export type DocumentDetailResult =
  | { readonly ok: true; readonly detail: DocumentDetail }
  | { readonly ok: false; readonly code: LoadedDocumentError };

const encoder = new TextEncoder();
const pointerToken = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

/** Capture a bounded directory of ranges. Ancestor containers do not duplicate their descendants' raw values. */
export function inspectLoadedDocument(
  snapshot: ExecutionSnapshot,
  endpoint: string | null,
  pages: readonly LoadedDocumentPage[],
  row: ResultGridRow,
): DocumentDetailResult {
  const read = readLoadedDocument(pages, row);
  if (typeof read === 'string') return { ok: false, code: read };
  const rows: DocumentField[] = [];
  const runtime = new Set(runtimeFieldNamesFromDsl(snapshot.rawDsl));
  let pathBytes = 0;
  const visit = (
    node: Node | undefined, path: string, parent: string | null, depth: number,
    section: LoadedDocumentSection, isRuntime = false,
  ): boolean => {
    if (rows.length >= MAX_DOCUMENT_DETAIL_NODES) return false;
    pathBytes += encoder.encode(path).length;
    if (pathBytes > MAX_DOCUMENT_DETAIL_PATH_BYTES) return false;
    const children = node?.children ?? [];
    rows.push(Object.freeze({
      path, parent, depth, section, runtime: isRuntime,
      kind: (node?.type ?? 'missing') as LoadedDocumentKind,
      range: node ? Object.freeze({ offset: node.offset, length: node.length }) : null,
      childCount: children.length,
    }));
    if (node?.type === 'object') {
      for (const entry of children) {
        const [key, value] = entry.children!;
        const name = String(key!.value);
        if (!visit(value, `${path}/${pointerToken(name)}`, path, depth + 1, section,
          isRuntime || section === 'fields' && depth === 0 && runtime.has(name))) return false;
      }
    } else if (node?.type === 'array') {
      for (let index = 0; index < children.length; index++) {
        if (!visit(children[index], `${path}/${index}`, path, depth + 1, section, isRuntime)) return false;
      }
    }
    return true;
  };
  if (!visit(property(read.root, '_source'), '/_source', null, 0, 'source')
    || !visit(property(read.root, 'fields'), '/fields', null, 0, 'fields')) return { ok: false, code: 'tooComplex' };
  // Missing declarations are independent diagnostic rows, not fabricated children of an absent/empty container.
  const fields = property(read.root, 'fields');
  if (fields === undefined || fields.type === 'object') {
    for (const name of runtime) {
      if (!property(fields, name) && !visit(undefined, `/fields/${pointerToken(name)}`, null, 0, 'fields', true)) {
        return { ok: false, code: 'tooComplex' };
      }
    }
  }
  for (const entry of read.root.children ?? []) {
    const [key, value] = entry.children!;
    const name = String(key!.value);
    if (name === '_source' || name === 'fields') continue;
    if (!visit(value, `/${pointerToken(name)}`, null, 0, 'metadata')) return { ok: false, code: 'tooComplex' };
  }
  for (const name of ['_index', '_id', '_score']) {
    if (!property(read.root, name) && !visit(undefined, `/${name}`, null, 0, 'metadata')) return { ok: false, code: 'tooComplex' };
  }
  return {
    ok: true,
    detail: Object.freeze({
      origin: loadedDocumentOrigin(snapshot, endpoint), document: read.document,
      rawResponse: pages[row.pageIndex]!.rawResponse, rows: Object.freeze(rows),
    }),
  };
}

export function documentFieldValue(detail: DocumentDetail, row: DocumentField): string | null {
  return row.range === null ? null : sliceRaw(detail.document.raw, row.range);
}

/** Search covers all loaded paths, including collapsed descendants; it never searches result values. */
export function visibleDocumentFields(
  rows: readonly DocumentField[],
  section: LoadedDocumentSection | 'all',
  search: string,
  expanded: ReadonlySet<string>,
): readonly DocumentField[] {
  const needle = search.slice(0, MAX_DOCUMENT_DETAIL_SEARCH_LENGTH).toLowerCase();
  if (needle) return rows.filter((row) => (section === 'all' || row.section === section)
    && row.path.toLowerCase().includes(needle));
  const visible = new Set<string>();
  return rows.filter((row) => {
    if (section !== 'all' && row.section !== section) return false;
    if (row.parent !== null && (!visible.has(row.parent) || !expanded.has(row.parent))) return false;
    visible.add(row.path);
    return true;
  });
}

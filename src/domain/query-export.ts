import type { Node } from 'jsonc-parser';
import type { ErrorCode } from '../services/ipc';
import { validateQueryDsl } from './query-dsl';
import { utf8ByteLength, type ExportFormat } from './query-library';
import { parseRawJson, property, rawTextOf } from './query-result';

export const MAX_SNAPSHOT_EXPORT_ROWS = 1_000_000;
export const MAX_SNAPSHOT_EXPORT_BYTES = 1024 * 1024 * 1024;
export const MAX_SNAPSHOT_EXPORT_PAGE_SIZE = 1000;
export const DEFAULT_SNAPSHOT_EXPORT_ROWS = 100_000;
export const DEFAULT_SNAPSHOT_EXPORT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_EXPORT_PAGE_SIZE = 500;
export const MAX_SNAPSHOT_EXPORT_DSL_BYTES = 1024 * 1024;

export interface SnapshotExportSource {
  readonly queryId: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly endpoint: string;
  readonly index: string;
  readonly rawDsl: string;
}

/** The reviewed body already contains the export's page size and stable tie-breaker sort. */
export interface SnapshotExportRequest {
  readonly requestId: string;
  readonly connectionId: string;
  /** Comparison only. The backend builds every URL from the captured database row. */
  readonly expectedEndpoint: string;
  readonly index: string;
  readonly rawDsl: string;
  readonly format: ExportFormat;
  readonly fileName: string;
  readonly maxRows: number;
  readonly maxBytes: number;
}

export type SnapshotExportPhase = 'choosing' | 'opening' | 'writing' | 'closing' | 'committing';

export interface SnapshotExportProgress {
  readonly requestId: string;
  readonly connectionId: string;
  readonly phase: SnapshotExportPhase;
  readonly rows: number;
  readonly bytes: number;
}

export type SnapshotExportReason = ErrorCode | 'rowLimit' | 'byteLimit' | 'deadline' | 'partialResponse';

export interface SnapshotExportOutcome {
  readonly requestId: string;
  readonly connectionId: string;
  readonly status: 'saved' | 'cancelled' | 'limited' | 'partial' | 'failed';
  readonly rows: number;
  readonly bytes: number;
  readonly fileState: 'none' | 'partial' | 'complete' | 'unknown';
  /** Basename selected by the native dialog, or the owned partial file's basename. */
  readonly fileName: string | null;
  readonly reason: SnapshotExportReason | null;
  readonly pitCleanup: 'notOpened' | 'closed' | 'pending';
}

const ROOT_KEYS = new Set([
  'query', 'post_filter', 'sort', 'size', 'from', '_source', 'fields', 'docvalue_fields',
  'stored_fields', 'track_scores', 'track_total_hits', 'version', 'seq_no_primary_term',
  'min_score', 'highlight', 'explain', 'timeout',
]);
const MOVING_TIME = /(^|[^A-Za-z0-9_])now(?=$|[^A-Za-z0-9_])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export type ExportDslProblem = 'invalidDsl' | 'unsupportedDsl' | 'unstableDsl' | 'invalidPageSize';
export type PreparedSnapshotExport =
  | { readonly ok: true; readonly rawDsl: string }
  | { readonly ok: false; readonly code: ExportDslProblem };

function stableBody(root: Node): ExportDslProblem | null {
  const pending = [{ node: root, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    count += 1;
    if (count > 200_000 || depth > 64) return 'invalidDsl';
    if (node.type === 'string' && MOVING_TIME.test(String(node.value))) return 'unstableDsl';
    if (node.type === 'object') {
      for (const field of node.children ?? []) {
        const [key, value] = field.children ?? [];
        const name = String(key?.value);
        if (name === 'script' || name.endsWith('_script') || ['random_score', 'function_score', 'indexed_shape', 'percolate', 'more_like_this'].includes(name)) {
          return 'unstableDsl';
        }
        // A PIT does not freeze documents fetched indirectly by a terms lookup.
        if (name === 'terms' && value?.type === 'object'
          && value.children?.some((entry) => entry.children?.[1]?.type === 'object')) return 'unstableDsl';
        if (value) pending.push({ node: value, depth: depth + 1 });
      }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
    }
  }
  return null;
}

function shardSort(node: Node): boolean {
  return node.type === 'string' && node.value === '_shard_doc'
    || node.type === 'object' && property(node, '_shard_doc') !== undefined;
}

function validTieBreaker(node: Node): boolean {
  if (node.type === 'string') return node.value === '_shard_doc';
  if (node.type !== 'object' || node.children?.length !== 1) return false;
  const direction = property(node, '_shard_doc');
  return direction?.type === 'string' && (direction.value === 'asc' || direction.value === 'desc');
}

function validSort(node: Node): boolean {
  if (node.type === 'string') return String(node.value).trim() !== '';
  if (node.type !== 'object' || node.children?.length !== 1) return false;
  const [key, options] = node.children[0]!.children ?? [];
  if (String(key?.value ?? '').trim() === '' || !options) return false;
  if (options.type === 'string') return options.value === 'asc' || options.value === 'desc';
  if (options.type !== 'object' || property(options, 'format') !== undefined) return false;
  const order = property(options, 'order');
  return order === undefined || order.type === 'string' && (order.value === 'asc' || order.value === 'desc');
}

/**
 * Prepare the body the user reviews, without changing the draft or its result. Only the page
 * size and the stable tie-breaker are replaced; all other values keep their original tokens.
 * Unsupported scan semantics are refused instead of silently discarded.
 */
export function prepareSnapshotExportDsl(source: string, pageSize: number): PreparedSnapshotExport {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_SNAPSHOT_EXPORT_PAGE_SIZE) {
    return { ok: false, code: 'invalidPageSize' };
  }
  if (source.length > MAX_SNAPSHOT_EXPORT_DSL_BYTES || utf8ByteLength(source) > MAX_SNAPSHOT_EXPORT_DSL_BYTES || !validateQueryDsl(source).ok) {
    return { ok: false, code: 'invalidDsl' };
  }
  const root = parseRawJson(source);
  if (root?.type !== 'object') return { ok: false, code: 'invalidDsl' };
  if ((root.children ?? []).some((field) => !ROOT_KEYS.has(String(field.children?.[0]?.value)))) {
    return { ok: false, code: 'unsupportedDsl' };
  }
  const from = property(root, 'from');
  const size = property(root, 'size');
  if (from && rawTextOf(source, from) !== '0'
    || size && (size.type !== 'number' || !/^[1-9][0-9]*$/.test(rawTextOf(source, size) ?? ''))) {
    return { ok: false, code: 'unsupportedDsl' };
  }
  const problem = stableBody(root);
  if (problem) return { ok: false, code: problem };
  const sort = property(root, 'sort');
  if (sort && (sort.type !== 'string' && sort.type !== 'object' && sort.type !== 'array'
    || sort.type === 'string' && String(sort.value).trim() === ''
    || sort.type !== 'string' && (sort.children?.length ?? 0) === 0)) {
    return { ok: false, code: 'unsupportedDsl' };
  }
  const sorts = sort?.type === 'array' ? sort.children ?? [] : sort ? [sort] : [];
  if (!sorts.every(validSort)) return { ok: false, code: 'unsupportedDsl' };
  const last = sorts.at(-1);
  if (sorts.slice(0, -1).some(shardSort) || last && shardSort(last) && !validTieBreaker(last)) {
    return { ok: false, code: 'unsupportedDsl' };
  }
  const sortText = sorts.map((item) => rawTextOf(source, item)!);
  if (!last || !shardSort(last)) sortText.push('"_shard_doc"');
  if (sortText.length > 16) return { ok: false, code: 'unsupportedDsl' };
  const fields = (root.children ?? []).flatMap((field) => {
    const [key, value] = field.children!;
    return key!.value === 'size' || key!.value === 'sort' ? []
      : [`${rawTextOf(source, key!)}: ${rawTextOf(source, value!)}`];
  });
  const rawDsl = `{\n  ${[...fields, `"size": ${pageSize}`, `"sort": [${sortText.join(', ')}]`].join(',\n  ')}\n}`;
  return utf8ByteLength(rawDsl) > MAX_SNAPSHOT_EXPORT_DSL_BYTES
    ? { ok: false, code: 'invalidDsl' } : { ok: true, rawDsl };
}

export function validSnapshotExportFileName(fileName: string, format: ExportFormat): boolean {
  if (fileName !== fileName.trim() || fileName === '' || [...fileName].length > 128) return false;
  if ([...fileName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159 || /[/\\:*?"<>|]/.test(char))) return false;
  const suffix = `.${format}`;
  if (!fileName.toLowerCase().endsWith(suffix)) return false;
  const stem = fileName.slice(0, -suffix.length).replace(/[. ]+$/, '');
  return stem !== '' && !DEVICE_NAME.test(stem.split('.')[0]!);
}

/** The service checks its own envelope; Rust independently enforces all bounds and semantics. */
export function validSnapshotExportRequest(request: SnapshotExportRequest): boolean {
  if (!UUID.test(request.requestId) || !UUID.test(request.connectionId)
    || !Number.isSafeInteger(request.maxRows) || request.maxRows < 1 || request.maxRows > MAX_SNAPSHOT_EXPORT_ROWS
    || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > MAX_SNAPSHOT_EXPORT_BYTES
    || request.rawDsl.length > MAX_SNAPSHOT_EXPORT_DSL_BYTES || utf8ByteLength(request.rawDsl) > MAX_SNAPSHOT_EXPORT_DSL_BYTES
    || request.index.trim() === '' || utf8ByteLength(request.index) > 2048
    || request.expectedEndpoint === '' || utf8ByteLength(request.expectedEndpoint) > 2048
    || !['csv', 'jsonl'].includes(request.format) || !validSnapshotExportFileName(request.fileName, request.format)) return false;
  const root = parseRawJson(request.rawDsl);
  const size = root && property(root, 'size');
  const pageSize = size?.type === 'number' ? Number(rawTextOf(request.rawDsl, size)) : NaN;
  const prepared = prepareSnapshotExportDsl(request.rawDsl, pageSize);
  const sort = root && property(root, 'sort');
  return prepared.ok && sort?.type === 'array' && sort.children?.at(-1) !== undefined && validTieBreaker(sort.children.at(-1)!);
}

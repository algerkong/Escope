import { invoke, isTauri } from '@tauri-apps/api/core';
import { isValidPitId } from '../domain/query-result';

export type ErrorCode = 'invalidInput' | 'invalidName' | 'invalidEndpoint' | 'invalidEnvironment'
  | 'invalidIndex' | 'invalidQuery' | 'duplicateRequest'
  | 'storageUnavailable' | 'workspaceConflict' | 'libraryConflict'
  | 'exchangeInvalid' | 'exchangeVersion' | 'exchangeTooLarge' | 'exchangeSensitive'
  | 'exchangeMappingRequired' | 'exchangeTargetChanged' | 'importFailed'
  | 'notFound' | 'unsupported' | 'permissionDenied' | 'serverForbidden' | 'cancelled'
  | 'busy' | 'networkError' | 'timeout' | 'authenticationFailed' | 'rateLimited'
  | 'credentialNotFound' | 'credentialUnavailable' | 'credentialFailure'
  | 'invalidCertificate' | 'tlsError' | 'exportFailed' | 'exportTargetChanged' | 'exportUnsupportedQuery'
  | 'redirectBlocked' | 'httpError' | 'notElasticsearch' | 'responseTooLarge' | 'invalidResponse';

export interface ConnectionProbe {
  requestId: string;
  connectionId: string;
}

export interface ConnectionIdentity {
  requestId: string;
  connectionId: string;
  endpoint: string;
  clusterName: string;
  clusterUuid: string;
  version: string;
  testedVersion: boolean;
  elapsedMs: number;
}
export interface IpcError {
  code: ErrorCode;
  requestId: string | null;
  retryable: boolean;
}

/** Resource reads are limited to these endpoints; arbitrary paths are never proxied. */
export type ResourceKind = 'indices' | 'mapping' | 'fieldCaps';

export interface ResourceRequest {
  requestId: string;
  connectionId: string;
  resource: ResourceKind;
  /** Index or pattern; required for `mapping` and `fieldCaps`, ignored for `indices`. */
  index?: string;
}

export interface ResourceResponse {
  requestId: string;
  connectionId: string;
  endpoint: string;
  /** Verbatim Elasticsearch response body. */
  rawResponse: string;
}

export interface QueryRequest {
  requestId: string;
  connectionId: string;
  index: string;
  rawDsl: string;
  /** Snapshot opened before the first page; continuations use the newest returned id. */
  pitId?: string;
  /** Continuation state: the previous page's last hit `sort` array as raw JSON text. */
  searchAfter?: string;
}

export interface QueryResponse {
  requestId: string;
  connectionId: string;
  endpoint: string;
  /** Verbatim `_search` response body. */
  rawResponse: string;
  /** Backend-reported partial execution (timed out or lost shards). */
  partial: boolean;
  /** Snapshot id returned with this page; the next continuation must use this value. */
  pitId: string | null;
}

export interface CancelRequest {
  requestId: string;
  connectionId: string;
}

function fail(code: ErrorCode, requestId: string): never {
  throw { code, requestId, retryable: false } satisfies IpcError;
}

/** Every response must echo the request ID and connection it belongs to. */
function boundRecord(value: unknown, requestId: string, connectionId: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return fail('invalidResponse', requestId);
  const record = value as Record<string, unknown>;
  if (record.requestId !== requestId || record.connectionId !== connectionId) return fail('invalidResponse', requestId);
  return record;
}

export async function testConnection(probe: ConnectionProbe): Promise<ConnectionIdentity> {
  const { requestId, connectionId } = probe;
  if (!isTauri()) return fail('unsupported', requestId);
  const identity = await invoke<ConnectionIdentity>('connection_test', { probe: { requestId, connectionId } });
  boundRecord(identity, requestId, connectionId);
  return identity;
}

/**
 * Read-only resource discovery. Browser preview stays unsupported; a failed desktop
 * request is never replaced with fixture metadata.
 */
export async function readResource(request: ResourceRequest): Promise<ResourceResponse> {
  const { requestId, connectionId, resource, index } = request;
  if (!isTauri()) return fail('unsupported', requestId);
  const payload = index === undefined ? { requestId, connectionId, resource } : { requestId, connectionId, resource, index };
  const record = boundRecord(await invoke<unknown>('resource_read', { request: payload }), requestId, connectionId);
  if (typeof record.rawResponse !== 'string' || typeof record.endpoint !== 'string') return fail('invalidResponse', requestId);
  return { requestId, connectionId, endpoint: record.endpoint, rawResponse: record.rawResponse };
}

/** Execute one frozen `_search` snapshot. The verbatim response is kept for lossless display. */
export async function executeQuery(request: QueryRequest): Promise<QueryResponse> {
  const { requestId, connectionId, index, rawDsl, pitId, searchAfter } = request;
  if (!isTauri()) return fail('unsupported', requestId);
  if ((pitId !== undefined && !isValidPitId(pitId)) || (searchAfter !== undefined && pitId === undefined)) {
    return fail('invalidQuery', requestId);
  }
  const payload: Record<string, string> = { requestId, connectionId, index, rawDsl };
  if (pitId !== undefined) payload.pitId = pitId;
  if (searchAfter !== undefined) payload.searchAfter = searchAfter;
  const record = boundRecord(
    await invoke<unknown>('query_execute', { request: payload }),
    requestId, connectionId,
  );
  if (typeof record.rawResponse !== 'string' || typeof record.partial !== 'boolean' || typeof record.endpoint !== 'string'
    || (record.pitId !== null && record.pitId !== undefined && !isValidPitId(record.pitId))) {
    return fail('invalidResponse', requestId);
  }
  return {
    requestId, connectionId, endpoint: record.endpoint, rawResponse: record.rawResponse,
    partial: record.partial, pitId: typeof record.pitId === 'string' ? record.pitId : null,
  };
}

/** Ask the backend to stop a request. `false` means the request had already finished. */
export async function cancelRequest(request: CancelRequest): Promise<boolean> {
  const { requestId, connectionId } = request;
  if (!isTauri()) return fail('unsupported', requestId);
  const cancelled = await invoke<unknown>('request_cancel', { request: { requestId, connectionId } });
  if (typeof cancelled !== 'boolean') return fail('invalidResponse', requestId);
  return cancelled;
}

export interface PitOpenRequest {
  requestId: string;
  connectionId: string;
  index: string;
}

export interface PitOpenResponse {
  requestId: string;
  connectionId: string;
  endpoint: string;
  /** Opaque snapshot id; bounded printable text, never a document. */
  pitId: string;
}

export interface PitCloseRequest {
  requestId: string;
  connectionId: string;
  pitId: string;
}

/** Open one search snapshot before its first page. Returns an id, never a document. */
export async function openPit(request: PitOpenRequest): Promise<PitOpenResponse> {
  const { requestId, connectionId, index } = request;
  if (!isTauri()) return fail('unsupported', requestId);
  const record = boundRecord(
    await invoke<unknown>('pit_open', { request: { requestId, connectionId, index } }),
    requestId, connectionId,
  );
  if (typeof record.endpoint !== 'string' || !isValidPitId(record.pitId)) {
    return fail('invalidResponse', requestId);
  }
  return { requestId, connectionId, endpoint: record.endpoint, pitId: record.pitId };
}

/**
 * Close one snapshot. Best-effort cleanup of a server-side resource the cluster expires on its
 * own; callers swallow failures because closing never invalidates a displayed result.
 */
export async function closePit(request: PitCloseRequest): Promise<void> {
  const { requestId, connectionId, pitId } = request;
  if (!isTauri()) return fail('unsupported', requestId);
  boundRecord(
    await invoke<unknown>('pit_close', { request: { requestId, connectionId, pitId } }),
    requestId, connectionId,
  );
}
/** Injectable seam for component tests; the default implementation is the desktop IPC above. */
export interface QueryBackend {
  /**
   * False in a plain browser: live reads must not be attempted and no retry is offered.
   * The App may override this per workspace through `QueryWorkspace.canQuery`.
   */
  readonly available: boolean;
  readResource(request: ResourceRequest): Promise<ResourceResponse>;
  execute(request: QueryRequest): Promise<QueryResponse>;
  cancel(request: CancelRequest): Promise<boolean>;
  /** Snapshot lifecycle for paginated continuations; both are read-only server calls. */
  openPit(request: PitOpenRequest): Promise<PitOpenResponse>;
  closePit(request: PitCloseRequest): Promise<void>;
}

export const desktopQueryBackend: QueryBackend = {
  available: isTauri(),
  readResource,
  execute: executeQuery,
  cancel: cancelRequest,
  openPit,
  closePit,
};

export function errorCode(error: unknown, fallback = 'storageUnavailable'): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && ['invalidName', 'invalidEndpoint', 'invalidEnvironment', 'notFound'].includes(error.message)) {
    return error.message;
  }
  return fallback;
}

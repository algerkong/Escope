import { invoke, isTauri } from '@tauri-apps/api/core';
import { cancelRequest, type ErrorCode, type IpcError } from './ipc';

/**
 * Read-only cluster, node, shard and index reads for the settings resource pages.
 *
 * The backend exposes one closed `resource_read` command: the caller names a fixed resource
 * kind, never a URL, method, header or arbitrary path. Every kind below maps to one fixed
 * Elasticsearch endpoint on the Rust side, which also validates the optional index target.
 */
export type ClusterResourceKind = 'clusterHealth' | 'nodesStats' | 'shards' | 'indices' | 'mapping' | 'indexSettings';

export interface ClusterReadRequest {
  requestId: string;
  connectionId: string;
  resource: ClusterResourceKind;
  /** Index or pattern; required for `mapping` and `indexSettings`, ignored for the others. */
  index?: string;
}

export interface ClusterReadResponse {
  requestId: string;
  connectionId: string;
  endpoint: string;
  /** Verbatim Elasticsearch response body. */
  rawResponse: string;
}

export interface ClusterCancelRequest {
  requestId: string;
  connectionId: string;
}

/** Injectable seam for component tests; the default implementation is the desktop IPC below. */
export interface ClusterBackend {
  read(request: ClusterReadRequest): Promise<ClusterReadResponse>;
  cancel(request: ClusterCancelRequest): Promise<boolean>;
}

function fail(code: ErrorCode, requestId: string): never {
  throw { code, requestId, retryable: false } satisfies IpcError;
}

/** A response must echo the request ID and connection it belongs to, or it is not applied. */
function bound(value: unknown, requestId: string, connectionId: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return fail('invalidResponse', requestId);
  const record = value as Record<string, unknown>;
  if (record.requestId !== requestId || record.connectionId !== connectionId) return fail('invalidResponse', requestId);
  return record;
}

/**
 * One read-only metadata read. Browser preview stays unsupported; a failed desktop read is
 * never replaced with fixture data.
 */
export async function readCluster(request: ClusterReadRequest): Promise<ClusterReadResponse> {
  const { requestId, connectionId, resource, index } = request;
  if (!isTauri()) return fail('unsupported', requestId);
  const payload = index === undefined ? { requestId, connectionId, resource } : { requestId, connectionId, resource, index };
  const record = bound(await invoke<unknown>('resource_read', { request: payload }), requestId, connectionId);
  if (typeof record.endpoint !== 'string' || typeof record.rawResponse !== 'string') return fail('invalidResponse', requestId);
  return { requestId, connectionId, endpoint: record.endpoint, rawResponse: record.rawResponse };
}

/**
 * `false` means the backend did not have this request in flight any more. It never claims the
 * Elasticsearch-side work was terminated.
 */
export const desktopClusterBackend: ClusterBackend = { read: readCluster, cancel: cancelRequest };

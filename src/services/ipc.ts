import { invoke, isTauri } from '@tauri-apps/api/core';

export type ErrorCode = 'invalidInput' | 'invalidName' | 'invalidEndpoint' | 'invalidEnvironment'
  | 'storageUnavailable' | 'notFound' | 'unsupported' | 'permissionDenied' | 'serverForbidden' | 'cancelled'
  | 'busy' | 'networkError' | 'timeout' | 'authenticationFailed' | 'rateLimited'
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

export interface QueryRequest {
  requestId: string;
  connectionId: string;
  index: string;
  rawDsl: string;
}

export async function testConnection(probe: ConnectionProbe): Promise<ConnectionIdentity> {
  const { requestId, connectionId } = probe;
  if (!isTauri()) {
    throw { code: 'unsupported', requestId, retryable: false } satisfies IpcError;
  }
  const identity = await invoke<ConnectionIdentity>('connection_test', { probe: { requestId, connectionId } });
  if (identity.requestId !== requestId || identity.connectionId !== connectionId) {
    throw { code: 'invalidResponse', requestId, retryable: false } satisfies IpcError;
  }
  return identity;
}

// Query execution is not implemented. Never replace a failed desktop request with fixture data.
export async function executeQuery(_request: QueryRequest): Promise<never> {
  throw { code: 'unsupported', requestId: _request.requestId, retryable: false } satisfies IpcError;
}

export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && ['invalidName', 'invalidEndpoint', 'invalidEnvironment', 'notFound'].includes(error.message)) {
    return error.message;
  }
  return 'storageUnavailable';
}

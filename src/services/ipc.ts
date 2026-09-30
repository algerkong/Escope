export type ErrorCode = 'invalidInput' | 'storageUnavailable' | 'notFound' | 'unsupported' | 'permissionDenied' | 'cancelled';
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

// No network adapter exists yet. Never replace a failed desktop request with fixture data.
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

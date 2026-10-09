import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import {
  validSnapshotExportRequest,
  type SnapshotExportOutcome, type SnapshotExportProgress, type SnapshotExportReason, type SnapshotExportRequest,
} from '../domain/query-export';
import type { CancelRequest, IpcError } from './ipc';

export interface SnapshotExportService {
  readonly available: boolean;
  run(request: SnapshotExportRequest, onProgress: (progress: SnapshotExportProgress) => void): Promise<SnapshotExportOutcome>;
  cancel(request: CancelRequest): Promise<boolean>;
}

const PROGRESS_KEYS = ['requestId', 'connectionId', 'phase', 'rows', 'bytes'];
const OUTCOME_KEYS = ['requestId', 'connectionId', 'status', 'rows', 'bytes', 'fileState', 'fileName', 'reason', 'pitCleanup'];
const PHASES = ['choosing', 'opening', 'writing', 'closing', 'committing'];
const REASONS = new Set<SnapshotExportReason>([
  'rowLimit', 'byteLimit', 'deadline', 'partialResponse', 'invalidInput', 'invalidIndex', 'invalidQuery',
  'invalidEndpoint', 'duplicateRequest', 'storageUnavailable', 'notFound', 'unsupported', 'permissionDenied',
  'serverForbidden', 'cancelled', 'busy', 'networkError', 'timeout', 'authenticationFailed', 'rateLimited',
  'credentialNotFound', 'credentialUnavailable', 'credentialFailure', 'invalidCertificate', 'tlsError',
  'exportFailed', 'exportTargetChanged', 'exportUnsupportedQuery', 'redirectBlocked', 'httpError',
  'notElasticsearch', 'responseTooLarge', 'invalidResponse',
]);

function fail(requestId: string, code: IpcError['code'] = 'invalidResponse'): never {
  throw { code, requestId, retryable: false } satisfies IpcError;
}

function record(value: unknown, keys: readonly string[], request: SnapshotExportRequest): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(request.requestId);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || !keys.every((key) => Object.hasOwn(object, key))
    || object.requestId !== request.requestId || object.connectionId !== request.connectionId
    || !Number.isSafeInteger(object.rows) || Number(object.rows) < 0 || Number(object.rows) > request.maxRows
    || !Number.isSafeInteger(object.bytes) || Number(object.bytes) < 0 || Number(object.bytes) > request.maxBytes) {
    return fail(request.requestId);
  }
  return object;
}

export function parseSnapshotExportProgress(value: unknown, request: SnapshotExportRequest): SnapshotExportProgress {
  const object = record(value, PROGRESS_KEYS, request);
  if (typeof object.phase !== 'string' || !PHASES.includes(object.phase)) return fail(request.requestId);
  return object as unknown as SnapshotExportProgress;
}

export function parseSnapshotExportOutcome(value: unknown, request: SnapshotExportRequest): SnapshotExportOutcome {
  const object = record(value, OUTCOME_KEYS, request);
  if (typeof object.status !== 'string' || !['saved', 'cancelled', 'limited', 'partial', 'failed'].includes(object.status)
    || typeof object.fileState !== 'string' || !['none', 'partial', 'complete', 'unknown'].includes(object.fileState)
    || typeof object.pitCleanup !== 'string' || !['notOpened', 'closed', 'pending'].includes(object.pitCleanup)
    || object.reason !== null && !REASONS.has(object.reason as SnapshotExportReason)) return fail(request.requestId);
  if (object.fileState === 'none') {
    if (object.fileName !== null || object.rows !== 0 || object.bytes !== 0) return fail(request.requestId);
  } else if (typeof object.fileName !== 'string' || object.fileName === '' || object.fileName.length > 1024
    || [...object.fileName].some((char) => /[/\\]/.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return fail(request.requestId);
  }
  if (object.fileState === 'partial' && !String(object.fileName).includes('.partial-')) return fail(request.requestId);
  if (object.status === 'saved') {
    if (object.fileState !== 'complete' || object.reason !== null || object.pitCleanup === 'notOpened') return fail(request.requestId);
  } else if (object.fileState === 'complete' || object.reason === null) return fail(request.requestId);
  if (object.status === 'cancelled' && object.reason !== 'cancelled'
    || object.status === 'limited' && !['rowLimit', 'byteLimit', 'deadline'].includes(String(object.reason))
    || object.status === 'partial' && object.reason !== 'partialResponse') return fail(request.requestId);
  return object as unknown as SnapshotExportOutcome;
}

/** Desktop only. There is deliberately no browser/memory fallback for a full scan. */
export const desktopSnapshotExportService: SnapshotExportService = {
  available: isTauri(),
  run: async (input, onProgress) => {
    if (!isTauri()) return fail(input.requestId, 'unsupported');
    if (!validSnapshotExportRequest(input)) return fail(input.requestId, 'invalidInput');
    const request: SnapshotExportRequest = {
      requestId: input.requestId, connectionId: input.connectionId, expectedEndpoint: input.expectedEndpoint,
      index: input.index, rawDsl: input.rawDsl, format: input.format, fileName: input.fileName,
      maxRows: input.maxRows, maxBytes: input.maxBytes,
    };
    let closed = false;
    let invalidProgress = false;
    let previous: SnapshotExportProgress | null = null;
    const channel = new Channel<unknown>((value) => {
      if (closed || invalidProgress) return;
      let progress: SnapshotExportProgress;
      try {
        progress = parseSnapshotExportProgress(value, request);
        if (previous && (progress.rows < previous.rows || progress.bytes < previous.bytes
          || PHASES.indexOf(progress.phase) < PHASES.indexOf(previous.phase))) fail(request.requestId);
      } catch {
        invalidProgress = true;
        void desktopSnapshotExportService.cancel(request).catch(() => {});
        return;
      }
      previous = progress;
      onProgress(progress);
    });
    try {
      const value = await invoke<unknown>('query_export', { request, onEvent: channel });
      if (invalidProgress) return fail(request.requestId);
      const outcome = parseSnapshotExportOutcome(value, request);
      if (previous !== null) {
        const last: SnapshotExportProgress = previous;
        if (outcome.rows < last.rows || outcome.bytes < last.bytes) return fail(request.requestId);
      }
      return outcome;
    } finally {
      closed = true;
      channel.onmessage = () => {};
    }
  },
  cancel: async ({ requestId, connectionId }) => {
    if (!isTauri()) return fail(requestId, 'unsupported');
    const result = await invoke<unknown>('query_export_cancel', { request: { requestId, connectionId } });
    if (typeof result !== 'boolean') return fail(requestId);
    return result;
  },
};

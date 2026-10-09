import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  createEmptyLibrary, libraryLimitViolation, libraryPayload, parseLibraryPayload, serializeLibrary,
  utf8ByteLength, MAX_EXPORT_CONTENT_BYTES, MAX_LIBRARY_BYTES, QUERY_LIBRARY_VERSION,
  type ExportFormat, type SavedQueryLibrary,
} from '../domain/query-library';
import type { ErrorCode, IpcError } from './ipc';

/**
 * Local query library and loaded-result export over the restricted IPC.
 *
 * Desktop: `saved_queries_load` / `saved_queries_save` speak the versioned library document and
 * `saved_queries_export` opens the native save dialog (file name and bytes only; the target path
 * is chosen by the dialog, never by the caller). Browser preview: an explicit in-memory session
 * adapter — desktop failures are never silently replaced with it — and export is a plain Blob
 * download whose disk outcome stays unverified.
 */

export type ExportOutcome =
  | { readonly status: 'saved' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'downloadRequested' };

export interface ExportFileRequest {
  readonly format: ExportFormat;
  readonly fileName: string;
  readonly content: string;
}

export interface QueryLibraryService {
  readonly kind: 'desktop' | 'session';
  load(): Promise<SavedQueryLibrary>;
  save(library: SavedQueryLibrary): Promise<void>;
  saveExportFile(request: ExportFileRequest): Promise<ExportOutcome>;
}

function fail(code: ErrorCode): never {
  throw { code, requestId: null, retryable: false } satisfies IpcError;
}

function assertWithinLibraryLimits(library: SavedQueryLibrary): void {
  if (libraryLimitViolation(library) !== null) return fail('invalidInput');
  if (utf8ByteLength(serializeLibrary(library)) > MAX_LIBRARY_BYTES) return fail('invalidInput');
}

function assertExportRequest(request: ExportFileRequest): void {
  if (request.content === '' || utf8ByteLength(request.content) > MAX_EXPORT_CONTENT_BYTES) return fail('invalidInput');
}

/** Desktop IPC. A stored document this build cannot explain fails the load as a whole. */
export const desktopQueryLibraryService: QueryLibraryService = {
  kind: 'desktop',
  load: async () => {
    if (!isTauri()) return fail('unsupported');
    const payload = await invoke<unknown>('saved_queries_load');
    const parsed = parseLibraryPayload(payload);
    if (!parsed.ok) return fail('invalidResponse');
    return parsed.library;
  },
  save: async (library) => {
    if (!isTauri()) return fail('unsupported');
    assertWithinLibraryLimits(library);
    await invoke('saved_queries_save', { library: libraryPayload(library) });
  },
  saveExportFile: async (request) => {
    if (!isTauri()) return fail('unsupported');
    assertExportRequest(request);
    const outcome = await invoke<unknown>('saved_queries_export', {
      request: { format: request.format, fileName: request.fileName, content: request.content },
    });
    if (outcome && typeof outcome === 'object') {
      const status = (outcome as { status?: unknown }).status;
      if (status === 'saved' || status === 'cancelled') return { status };
    }
    return fail('invalidResponse');
  },
};

/**
 * Explicit browser-preview adapter: memory only, bounded like the desktop contract, and gone on
 * reload. It is selected by platform, never as a fallback for a failing desktop call.
 */
export function createSessionQueryLibraryService(): QueryLibraryService {
  let stored = createEmptyLibrary();
  const snapshot = (): SavedQueryLibrary => ({
    version: QUERY_LIBRARY_VERSION,
    entries: stored.entries.map((entry) => ({ ...entry })),
  });
  return {
    kind: 'session',
    load: async () => snapshot(),
    save: async (library) => {
      assertWithinLibraryLimits(library);
      stored = {
        version: QUERY_LIBRARY_VERSION,
        entries: library.entries.map((entry) => ({ ...entry })),
      };
    },
    saveExportFile: async (request) => {
      assertExportRequest(request);
      return requestBrowserDownload(request);
    },
  };
}

/** Request a browser download. The request is observable; the disk outcome is not. */
function requestBrowserDownload(request: ExportFileRequest): ExportOutcome {
  if (typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return fail('unsupported');
  const type = request.format === 'csv' ? 'text/csv;charset=utf-8' : 'application/x-ndjson;charset=utf-8';
  const url = URL.createObjectURL(new Blob([request.content], { type }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = request.fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return { status: 'downloadRequested' };
}

/** Platform selection, resolved once at module load like the other desktop services. */
export function createQueryLibraryService(): QueryLibraryService {
  return isTauri() ? desktopQueryLibraryService : createSessionQueryLibraryService();
}

export const defaultQueryLibraryService: QueryLibraryService = createQueryLibraryService();

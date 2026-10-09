import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  MAX_QUERY_EXCHANGE_BYTES, importQueryExchange, parseQueryExchange, parseQueryExchangeText, validateConnectionMappings,
  type ConnectionMapping, type QueryExchange,
} from '../domain/query-exchange';
import { libraryPayload, parseLibraryPayload, serializeLibrary, type SavedQueryLibrary } from '../domain/query-library';
import type { ExportOutcome, QueryLibraryService } from './query-library';

export type ExchangeReadOutcome = { readonly status: 'cancelled' } | { readonly status: 'loaded'; readonly bundle: QueryExchange };
export interface QueryExchangeService {
  readonly kind: 'desktop' | 'session';
  readFile(file?: File): Promise<ExchangeReadOutcome>;
  saveFile(bundle: QueryExchange, reviewed: boolean): Promise<ExportOutcome>;
  importDefinitions(bundle: QueryExchange, mappings: readonly ConnectionMapping[], expected: SavedQueryLibrary): Promise<SavedQueryLibrary>;
}

function fail(code: string): never { throw { code, requestId: null, retryable: false }; }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const desktopQueryExchangeService: QueryExchangeService = {
  kind: 'desktop',
  readFile: async (file) => {
    if (!isTauri() || file !== undefined) fail('unsupported');
    const result = await invoke<unknown>('query_exchange_read');
    if (!record(result)) fail('invalidResponse');
    if (result.status === 'cancelled' && Object.keys(result).length === 1) return { status: 'cancelled' };
    if (result.status === 'loaded' && Object.keys(result).length === 2 && Object.hasOwn(result, 'bundle')) {
      return { status: 'loaded', bundle: parseQueryExchange(result.bundle) };
    }
    return fail('invalidResponse');
  },
  saveFile: async (bundle, reviewed) => {
    if (!isTauri()) fail('unsupported');
    if (!reviewed) fail('exchangeInvalid');
    const checked = parseQueryExchange(bundle);
    const result = await invoke<unknown>('query_exchange_save', { request: { bundle: checked, reviewed: true } });
    if (record(result) && Object.keys(result).length === 1 && (result.status === 'saved' || result.status === 'cancelled')) {
      return { status: result.status };
    }
    return fail('invalidResponse');
  },
  importDefinitions: async (bundle, mappings, expected) => {
    if (!isTauri()) fail('unsupported');
    const checked = parseQueryExchange(bundle);
    validateConnectionMappings(checked, mappings);
    if (!parseLibraryPayload(expected).ok) fail('exchangeInvalid');
    const updatedAt = new Date().toISOString();
    const result = parseLibraryPayload(await invoke<unknown>('query_exchange_import', {
      request: { bundle: checked, mappings, expected: libraryPayload(expected), updatedAt },
    }));
    if (!result.ok || result.library.entries.length !== expected.entries.length + checked.queries.length) fail('invalidResponse');
    // Verify the entire returned append, not just its size or an "ok" flag.
    const added = result.library.entries.slice(expected.entries.length);
    let position = 0;
    const intended = importQueryExchange(checked, mappings, expected, undefined, new Date(updatedAt), () => added[position++]!.id);
    if (serializeLibrary(intended) !== serializeLibrary(result.library)) fail('invalidResponse');
    return result.library;
  },
};

export function createSessionQueryExchangeService(library: QueryLibraryService): QueryExchangeService {
  return {
    kind: 'session',
    readFile: async (file) => {
      if (!file) return { status: 'cancelled' };
      if (file.size > MAX_QUERY_EXCHANGE_BYTES) fail('exchangeTooLarge');
      let bytes: ArrayBuffer;
      try { bytes = await file.arrayBuffer(); } catch { return fail('importFailed'); }
      if (bytes.byteLength > MAX_QUERY_EXCHANGE_BYTES) fail('exchangeTooLarge');
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail('exchangeInvalid'); }
      return { status: 'loaded', bundle: parseQueryExchangeText(raw) };
    },
    saveFile: async (bundle, reviewed) => {
      if (!reviewed) fail('exchangeInvalid');
      const checked = parseQueryExchange(bundle);
      if (typeof URL.createObjectURL !== 'function') fail('unsupported');
      const url = URL.createObjectURL(new Blob([JSON.stringify(checked)], { type: 'application/json;charset=utf-8' }));
      try {
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'escope-queries.json'; anchor.rel = 'noopener';
        document.body.append(anchor); anchor.click(); anchor.remove();
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 0); }
      return { status: 'downloadRequested' };
    },
    importDefinitions: async (bundle, mappings, expected) => {
      const next = importQueryExchange(bundle, mappings, expected);
      await library.save(next, expected);
      return next;
    },
  };
}

export function createQueryExchangeService(library: QueryLibraryService): QueryExchangeService {
  return library.kind === 'desktop' ? desktopQueryExchangeService : createSessionQueryExchangeService(library);
}

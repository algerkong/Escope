import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  MAX_CHART_EXCHANGE_BYTES, importChartDefinitionExchange, parseChartDefinitionExchange,
  parseChartDefinitionExchangeText, validateChartConnectionMappings,
  type ChartConnectionMapping, type ChartDefinitionExchange,
} from '../domain/chart-definition-exchange';
import { parseChartDefinitionRecord, type ChartDefinitionRecord } from '../domain/chart-definitions';
import type { ChartDefinitionService } from './chart-definitions';
import type { ErrorCode, IpcError } from './ipc';
import type { ExportOutcome } from './query-library';

/**
 * Chart-definition exchange transport. Desktop paths go through the constrained IPC commands and a
 * native dialog; the browser preview reads a chosen file and requests a download, which is not a
 * verified disk write. Neither path runs a query, opens a PIT or sends a request, and an unverified
 * desktop outcome asks for an explicit reload instead of pretending the append happened.
 */

export type ChartExchangeReadOutcome =
  | { readonly status: 'cancelled' }
  | { readonly status: 'loaded'; readonly bundle: ChartDefinitionExchange };

export interface ChartDefinitionExchangeService {
  readonly kind: 'desktop' | 'session';
  readFile(file?: File): Promise<ChartExchangeReadOutcome>;
  saveFile(bundle: ChartDefinitionExchange, reviewed: boolean): Promise<ExportOutcome>;
  importDefinitions(bundle: ChartDefinitionExchange, mappings: readonly ChartConnectionMapping[],
    expected: ChartDefinitionRecord): Promise<ChartDefinitionRecord>;
}

function fail(code: ErrorCode): never {
  throw { code, requestId: null, retryable: false } satisfies IpcError;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const desktopChartDefinitionExchangeService: ChartDefinitionExchangeService = {
  kind: 'desktop',
  readFile: async (file) => {
    if (!isTauri() || file !== undefined) fail('unsupported');
    const result = await invoke<unknown>('chart_definition_exchange_read');
    if (!record(result)) fail('invalidResponse');
    if (result.status === 'cancelled' && Object.keys(result).length === 1) return { status: 'cancelled' };
    if (result.status === 'loaded' && Object.keys(result).length === 2 && Object.hasOwn(result, 'bundle')) {
      return { status: 'loaded', bundle: parseChartDefinitionExchange(result.bundle) };
    }
    return fail('invalidResponse');
  },
  saveFile: async (bundle, reviewed) => {
    if (!isTauri()) fail('unsupported');
    if (!reviewed) fail('exchangeInvalid');
    const checked = parseChartDefinitionExchange(bundle);
    const result = await invoke<unknown>('chart_definition_exchange_save', { request: { bundle: checked, reviewed: true } });
    if (record(result) && Object.keys(result).length === 1 && (result.status === 'saved' || result.status === 'cancelled')) {
      return { status: result.status };
    }
    return fail('invalidResponse');
  },
  importDefinitions: async (bundle, mappings, expected) => {
    if (!isTauri()) fail('unsupported');
    const checked = parseChartDefinitionExchange(bundle);
    validateChartConnectionMappings(checked, mappings);
    const base = parseChartDefinitionRecord(expected);
    if (!base) fail('invalidInput');
    const result = parseChartDefinitionRecord(await invoke<unknown>('chart_definition_exchange_import', {
      request: { bundle: checked, mappings, expectedRevision: base.revision },
    }));
    if (!result || result.revision !== base.revision + 1
      || result.library.entries.length !== base.library.entries.length + checked.definitions.length) fail('invalidResponse');
    // Verify the whole returned append, not just its size or an "ok" flag: existing rows must stay
    // byte-identical and every new row must carry the reviewed literals and the mapped connection.
    const added = result.library.entries.slice(base.library.entries.length);
    let position = 0;
    const intended = importChartDefinitionExchange(checked, mappings, base.library, undefined, () => added[position++]!.id);
    if (JSON.stringify(intended) !== JSON.stringify(result.library)) fail('invalidResponse');
    return result;
  },
};

/** Explicit browser preview adapter: the store lives in this page and does not survive a restart. */
export function createSessionChartDefinitionExchangeService(definitions: ChartDefinitionService): ChartDefinitionExchangeService {
  return {
    kind: 'session',
    readFile: async (file) => {
      if (!file) return { status: 'cancelled' };
      if (file.size > MAX_CHART_EXCHANGE_BYTES) fail('exchangeTooLarge');
      let bytes: ArrayBuffer;
      try { bytes = await file.arrayBuffer(); } catch { return fail('importFailed'); }
      if (bytes.byteLength > MAX_CHART_EXCHANGE_BYTES) fail('exchangeTooLarge');
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail('exchangeInvalid'); }
      return { status: 'loaded', bundle: parseChartDefinitionExchangeText(raw) };
    },
    saveFile: async (bundle, reviewed) => {
      if (!reviewed) fail('exchangeInvalid');
      const checked = parseChartDefinitionExchange(bundle);
      if (typeof URL.createObjectURL !== 'function') fail('unsupported');
      const url = URL.createObjectURL(new Blob([JSON.stringify(checked)], { type: 'application/json;charset=utf-8' }));
      try {
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'escope-chart-definitions.json'; anchor.rel = 'noopener';
        document.body.append(anchor); anchor.click(); anchor.remove();
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 0); }
      return { status: 'downloadRequested' };
    },
    importDefinitions: async (bundle, mappings, expected) => {
      const base = parseChartDefinitionRecord(expected);
      if (!base) fail('invalidInput');
      const next = importChartDefinitionExchange(bundle, mappings, base.library);
      const revision = await definitions.save(base.revision, next);
      // The session store answers with the revision it wrote; anything else is an unknown outcome.
      if (revision !== base.revision + 1) fail('invalidResponse');
      return { revision, library: next };
    },
  };
}

export function createChartDefinitionExchangeService(definitions: ChartDefinitionService): ChartDefinitionExchangeService {
  return definitions.kind === 'desktop' ? desktopChartDefinitionExchangeService : createSessionChartDefinitionExchangeService(definitions);
}

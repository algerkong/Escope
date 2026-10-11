import type { ConnectionProfile } from './connection';
import type { AggregationBuildDraft } from './query-aggregation-build';
import {
  CHART_DEFINITION_VERSION, MAX_CHART_DEFINITIONS, MAX_CHART_DEFINITIONS_BYTES,
  parseChartDefinitionBody, parseChartDefinitionLibrary, validChartDefinitionName,
  type ChartDefinition, type ChartDefinitionLibrary,
} from './chart-definitions';
import { SENSITIVE_KEYS, SENSITIVE_TEXT } from './query-exchange';
import { boundedParameterJson } from './query-parameters';

/**
 * Local chart-definition exchange: selected saved definitions become one reviewable JSON document,
 * and such a document becomes new local definitions.
 *
 * The document carries definition bodies only — the saved target pattern, the grouping and metric
 * literals and the plotted measure — plus an opaque per-source connection label. It never carries an
 * endpoint, a real connection ID, authentication, credential references, parsed aggregation values,
 * plotted numbers, field-capability evidence, time boundaries, result bodies, PIT ids or history.
 * Importing appends every definition under a fresh id, once, and never rewrites an existing
 * definition, draft or favorite; it sends no request and opens no PIT. Reuse still needs the exact
 * connection and target plus an explicit aggregation-build preview and apply.
 */

export const CHART_DEFINITION_EXCHANGE_FORMAT = 'escope-chart-definitions';
export const CHART_DEFINITION_EXCHANGE_VERSION = 1;
export const MAX_CHART_EXCHANGE_BYTES = 1024 * 1024;
/** The same bound the query exchange puts on a mapping endpoint hint. */
export const MAX_CHART_EXCHANGE_ENDPOINT_CHARS = 2048;

export interface PortableChartConnection { readonly key: string; readonly label: string }
export interface PortableChartDefinition {
  readonly key: string;
  readonly name: string;
  readonly connectionKey: string;
  readonly index: string;
  readonly draft: AggregationBuildDraft;
  readonly measure: string;
}
export interface ChartDefinitionExchange {
  readonly format: typeof CHART_DEFINITION_EXCHANGE_FORMAT;
  readonly version: number;
  readonly connections: readonly PortableChartConnection[];
  readonly definitions: readonly PortableChartDefinition[];
}

/** A chart definition is bound to a connection by construction, so import needs a real local target. */
export interface ChartExchangeTarget { readonly connectionId: string; readonly endpoint: string }
export interface ChartConnectionMapping { readonly sourceKey: string; readonly target: ChartExchangeTarget }

export type ChartExchangeErrorCode = 'exchangeInvalid' | 'exchangeVersion' | 'exchangeTooLarge' | 'exchangeSensitive'
  | 'exchangeMappingRequired' | 'exchangeTargetChanged' | 'chartDefinitionConflict';

export function chartExchangeFailure(code: ChartExchangeErrorCode): never {
  throw { code, requestId: null, retryable: false };
}

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const sourceLabel = (value: unknown): value is string => typeof value === 'string' && value !== '' && [...value].length <= 120
  && ![...value].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159));

function shape(value: unknown, required: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key));
}

/** Defense in depth for the whole document: known sensitive key names and authentication-like strings. */
function scanLiterals(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) scanLiterals(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, '')) || SENSITIVE_TEXT.test(key)) {
        chartExchangeFailure('exchangeSensitive');
      }
      scanLiterals(item);
    }
    return;
  }
  if (typeof value === 'string' && SENSITIVE_TEXT.test(value)) chartExchangeFailure('exchangeSensitive');
}

export function parseChartDefinitionExchange(value: unknown): ChartDefinitionExchange {
  scanLiterals(value);
  if (!shape(value, ['format', 'version', 'connections', 'definitions']) || value.format !== CHART_DEFINITION_EXCHANGE_FORMAT) {
    chartExchangeFailure('exchangeInvalid');
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 0 || value.version > 0xffff_ffff) {
    chartExchangeFailure('exchangeInvalid');
  }
  if (value.version !== CHART_DEFINITION_EXCHANGE_VERSION) chartExchangeFailure('exchangeVersion');
  if (!Array.isArray(value.connections) || !Array.isArray(value.definitions)) chartExchangeFailure('exchangeInvalid');
  // Every definition carries a source connection, so a document without one explains nothing.
  if (value.definitions.length === 0 || value.connections.length === 0) chartExchangeFailure('exchangeInvalid');
  if (value.connections.length > MAX_CHART_DEFINITIONS || value.definitions.length > MAX_CHART_DEFINITIONS) {
    chartExchangeFailure('exchangeTooLarge');
  }
  const keys = new Set<string>();
  const connections = value.connections.map((connection: unknown) => {
    if (!shape(connection, ['key', 'label']) || !identifier(connection.key) || !sourceLabel(connection.label) || keys.has(connection.key)) {
      chartExchangeFailure('exchangeInvalid');
    }
    keys.add(connection.key);
    return { key: connection.key, label: connection.label };
  });
  const definitions: PortableChartDefinition[] = [];
  const ids = new Set<string>();
  const used = new Set<string>();
  for (const definition of value.definitions) {
    if (!shape(definition, ['key', 'name', 'connectionKey', 'index', 'draft', 'measure'])
      || !identifier(definition.key) || ids.has(definition.key) || !validChartDefinitionName(definition.name)
      || !identifier(definition.connectionKey) || !keys.has(definition.connectionKey)) chartExchangeFailure('exchangeInvalid');
    // The target, rows and measure follow the stored-definition rules exactly, with no local identity.
    const body = parseChartDefinitionBody({ index: definition.index, draft: definition.draft, measure: definition.measure });
    if (!body) chartExchangeFailure('exchangeInvalid');
    ids.add(definition.key);
    used.add(definition.connectionKey);
    definitions.push({ key: definition.key, name: definition.name, connectionKey: definition.connectionKey, ...body });
  }
  if (keys.size !== used.size) chartExchangeFailure('exchangeInvalid');
  const result: ChartDefinitionExchange = {
    format: CHART_DEFINITION_EXCHANGE_FORMAT, version: CHART_DEFINITION_EXCHANGE_VERSION, connections, definitions,
  };
  if (bytes(JSON.stringify(result)) > MAX_CHART_EXCHANGE_BYTES) chartExchangeFailure('exchangeTooLarge');
  return result;
}

/** Parse the wrapper strictly before decoding anything. Text stays text; no coercion is attempted. */
export function parseChartDefinitionExchangeText(raw: string): ChartDefinitionExchange {
  if (bytes(raw) > MAX_CHART_EXCHANGE_BYTES) chartExchangeFailure('exchangeTooLarge');
  if (!boundedParameterJson(raw)) chartExchangeFailure('exchangeInvalid');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return chartExchangeFailure('exchangeInvalid'); }
  return parseChartDefinitionExchange(value);
}

/** Source labels are hints only. Endpoints, real connection IDs and authentication never enter the document. */
export function buildChartDefinitionExchange(library: ChartDefinitionLibrary, selected: readonly string[],
  profiles: readonly Pick<ConnectionProfile, 'id' | 'displayName'>[]): ChartDefinitionExchange {
  const checked = parseChartDefinitionLibrary(library);
  if (!checked || selected.length === 0 || new Set(selected).size !== selected.length) chartExchangeFailure('exchangeInvalid');
  const entries = selected.map((id) => {
    const entry = checked.entries.find((item) => item.id === id);
    // The reviewed library no longer holds that definition: refuse instead of exporting a guess.
    if (!entry) chartExchangeFailure('chartDefinitionConflict');
    return entry;
  });
  const connectionKeys = new Map<string, string>();
  const connections: PortableChartConnection[] = [];
  const definitions = entries.map((entry, index): PortableChartDefinition => {
    let connectionKey = connectionKeys.get(entry.connectionId);
    if (!connectionKey) {
      connectionKey = `connection-${connections.length + 1}`;
      connectionKeys.set(entry.connectionId, connectionKey);
      connections.push({ key: connectionKey, label: profiles.find((profile) => profile.id === entry.connectionId)?.displayName ?? connectionKey });
    }
    return { key: `chart-${index + 1}`, name: entry.name, connectionKey, index: entry.index, draft: entry.draft, measure: entry.measure };
  });
  return parseChartDefinitionExchange({ format: CHART_DEFINITION_EXCHANGE_FORMAT, version: CHART_DEFINITION_EXCHANGE_VERSION, connections, definitions });
}

/** Every source needs an explicit local target. Nothing maps by name, and a changed profile invalidates the review. */
export function validateChartConnectionMappings(bundle: ChartDefinitionExchange,
  mappings: readonly ChartConnectionMapping[], profiles?: readonly Pick<ConnectionProfile, 'id' | 'endpoint'>[]): Map<string, ChartExchangeTarget> {
  if (mappings.length !== bundle.connections.length) chartExchangeFailure('exchangeMappingRequired');
  const result = new Map<string, ChartExchangeTarget>();
  for (const mapping of mappings) {
    if (!shape(mapping, ['sourceKey', 'target']) || !identifier(mapping.sourceKey) || result.has(mapping.sourceKey)
      || !bundle.connections.some((connection) => connection.key === mapping.sourceKey)) chartExchangeFailure('exchangeMappingRequired');
    const target = mapping.target;
    if (!shape(target, ['connectionId', 'endpoint']) || !identifier(target.connectionId)
      || typeof target.endpoint !== 'string' || target.endpoint.length > MAX_CHART_EXCHANGE_ENDPOINT_CHARS) {
      chartExchangeFailure('exchangeMappingRequired');
    }
    if (profiles && !profiles.some((profile) => profile.id === target.connectionId && profile.endpoint === target.endpoint)) {
      chartExchangeFailure('exchangeTargetChanged');
    }
    result.set(mapping.sourceKey, target);
  }
  return result;
}

/** All-or-nothing append with fresh IDs. Existing definitions, their connections and drafts stay untouched. */
export function importChartDefinitionExchange(bundle: ChartDefinitionExchange, mappings: readonly ChartConnectionMapping[],
  base: ChartDefinitionLibrary, profiles?: readonly Pick<ConnectionProfile, 'id' | 'endpoint'>[],
  newId: () => string = () => crypto.randomUUID()): ChartDefinitionLibrary {
  const checked = parseChartDefinitionExchange(bundle);
  const mapped = validateChartConnectionMappings(checked, mappings, profiles);
  const library = parseChartDefinitionLibrary(base);
  if (!library) chartExchangeFailure('chartDefinitionConflict');
  const additions: ChartDefinition[] = checked.definitions.map((definition) => {
    const target = mapped.get(definition.connectionKey);
    if (!target) chartExchangeFailure('exchangeMappingRequired');
    return {
      id: newId(), name: definition.name, connectionId: target.connectionId,
      index: definition.index, draft: definition.draft, measure: definition.measure,
    };
  });
  const next: ChartDefinitionLibrary = { version: CHART_DEFINITION_VERSION, entries: [...library.entries, ...additions] };
  if (next.entries.length > MAX_CHART_DEFINITIONS || bytes(JSON.stringify(next)) > MAX_CHART_DEFINITIONS_BYTES) {
    chartExchangeFailure('exchangeTooLarge');
  }
  const parsed = parseChartDefinitionLibrary(next);
  if (!parsed) chartExchangeFailure('exchangeInvalid');
  return parsed;
}

import type { Node } from 'jsonc-parser';
import type { ConnectionProfile } from './connection';
import {
  MAX_ENTRY_DSL_BYTES, MAX_ENTRY_INDEX_BYTES, MAX_LIBRARY_BYTES, MAX_SAVED_ENTRIES, QUERY_LIBRARY_VERSION,
  libraryPayload, parseLibraryPayload, serializeLibrary, utf8ByteLength, type SavedQueryLibrary,
} from './query-library';
import { boundedParameterJson, parameterSlots, parametersPayload, parseQueryParameters, type QueryParameters } from './query-parameters';

export const QUERY_EXCHANGE_FORMAT = 'escope-query-definitions';
export const QUERY_EXCHANGE_VERSION = 1;
export const MAX_QUERY_EXCHANGE_BYTES = 4 * 1024 * 1024;

export interface PortableQuery {
  readonly key: string;
  readonly name: string;
  readonly connectionKey: string | null;
  readonly index: string;
  readonly dsl: string;
  readonly resultView: 'table' | 'json';
  readonly favorite: boolean;
  readonly parameters?: QueryParameters;
}
export interface QueryExchange {
  readonly format: typeof QUERY_EXCHANGE_FORMAT;
  readonly version: number;
  readonly connections: readonly { readonly key: string; readonly label: string }[];
  readonly queries: readonly PortableQuery[];
}
export interface ConnectionMapping {
  readonly sourceKey: string;
  readonly target: { readonly connectionId: string; readonly endpoint: string } | null;
}
export type ExchangeErrorCode = 'exchangeInvalid' | 'exchangeVersion' | 'exchangeTooLarge' | 'exchangeSensitive'
  | 'exchangeMappingRequired' | 'exchangeTargetChanged' | 'libraryConflict';

export function exchangeFailure(code: ExchangeErrorCode): never {
  throw { code, requestId: null, retryable: false };
}

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && [...value].length <= 120
  && ![...value].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159));

/** Shared by every local definition exchange format: normalized key names that must never appear. */
export const SENSITIVE_KEYS = new Set([
  'authorization', 'proxyauthorization', 'auth', 'authstate', 'authentication', 'headers', 'requestheaders',
  'credential', 'credentials', 'credentialref', 'credentialreference', 'keychainref', 'keyringref',
  'apikey', 'apikeyid', 'apikeysecret', 'password', 'passwd', 'secret', 'clientsecret', 'privatekey',
  'accesstoken', 'refreshtoken', 'token', 'transportsnapshot',
]);
/** Shared by every local definition exchange format: authentication-shaped literals in any string. */
export const SENSITIVE_TEXT = /(?:\b(?:authorization|proxy-authorization)\s*:|\b(?:bearer|basic|apikey)\s+[A-Za-z0-9+/_=-]+|-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----|\b(?:keyring|keychain|credential):)/i;

/** Defense in depth for definition literals. Untagged sensitive literals still require review. */
export function checkExchangeDsl(raw: string, parameters?: QueryParameters): void {
  if (utf8ByteLength(raw) > MAX_ENTRY_DSL_BYTES) exchangeFailure('exchangeTooLarge');
  const root = boundedParameterJson(raw);
  if (!root || root.type !== 'object') exchangeFailure('exchangeInvalid');
  const pending: Node[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'property') {
      const key: string = node.children?.[0]?.value as string;
      if (SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) exchangeFailure('exchangeSensitive');
      if (key === '$param' && parameters === undefined) exchangeFailure('exchangeInvalid');
    }
    if (node.type === 'string' && SENSITIVE_TEXT.test(String(node.value))) exchangeFailure('exchangeSensitive');
    for (const child of node.children ?? []) pending.push(child);
  }
  if (parameters && (raw !== parameters.template || !parameterSlots(parameters).ok)) exchangeFailure('exchangeInvalid');
}

export function parseQueryExchange(value: unknown): QueryExchange {
  if (!shape(value, ['format', 'version', 'connections', 'queries']) || value.format !== QUERY_EXCHANGE_FORMAT) exchangeFailure('exchangeInvalid');
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 0 || value.version > 0xffff_ffff) exchangeFailure('exchangeInvalid');
  if (value.version !== QUERY_EXCHANGE_VERSION) exchangeFailure('exchangeVersion');
  if (!Array.isArray(value.connections) || !Array.isArray(value.queries) || value.queries.length === 0) exchangeFailure('exchangeInvalid');
  if (value.connections.length > MAX_SAVED_ENTRIES || value.queries.length > MAX_SAVED_ENTRIES) exchangeFailure('exchangeTooLarge');
  const keys = new Set<string>();
  const connections = value.connections.map((connection: unknown) => {
    if (!shape(connection, ['key', 'label']) || !identifier(connection.key) || !label(connection.label) || keys.has(connection.key)) exchangeFailure('exchangeInvalid');
    if (SENSITIVE_TEXT.test(connection.label)) exchangeFailure('exchangeSensitive');
    keys.add(connection.key);
    return { key: connection.key, label: connection.label };
  });
  const queries: PortableQuery[] = [];
  const ids = new Set<string>();
  const used = new Set<string>();
  for (const query of value.queries) {
    if (!shape(query, ['key', 'name', 'connectionKey', 'index', 'dsl', 'resultView', 'favorite'], ['parameters'])
      || !identifier(query.key) || ids.has(query.key) || !label(query.name) || typeof query.index !== 'string'
      || typeof query.dsl !== 'string' || typeof query.favorite !== 'boolean'
      || (query.resultView !== 'table' && query.resultView !== 'json')
      || (query.connectionKey !== null && (typeof query.connectionKey !== 'string' || !keys.has(query.connectionKey)))) exchangeFailure('exchangeInvalid');
    if (utf8ByteLength(query.index) > MAX_ENTRY_INDEX_BYTES) exchangeFailure('exchangeTooLarge');
    if (SENSITIVE_TEXT.test(query.name) || SENSITIVE_TEXT.test(query.index)) exchangeFailure('exchangeSensitive');
    const parameters = Object.hasOwn(query, 'parameters') ? parseQueryParameters(query.parameters) : undefined;
    if (parameters === null) exchangeFailure('exchangeInvalid');
    checkExchangeDsl(query.dsl, parameters);
    ids.add(query.key);
    if (query.connectionKey !== null) used.add(query.connectionKey);
    queries.push({
      key: query.key, name: query.name, connectionKey: query.connectionKey, index: query.index,
      dsl: query.dsl, resultView: query.resultView, favorite: query.favorite,
      ...(parameters === undefined ? {} : { parameters }),
    });
  }
  if (keys.size !== used.size) exchangeFailure('exchangeInvalid');
  const result: QueryExchange = { format: QUERY_EXCHANGE_FORMAT, version: QUERY_EXCHANGE_VERSION, connections, queries };
  if (utf8ByteLength(JSON.stringify(result)) > MAX_QUERY_EXCHANGE_BYTES) exchangeFailure('exchangeTooLarge');
  return result;
}

/** Parse the wrapper strictly before decoding metadata. DSL is a string, never a JS number. */
export function parseQueryExchangeText(raw: string): QueryExchange {
  if (utf8ByteLength(raw) > MAX_QUERY_EXCHANGE_BYTES) exchangeFailure('exchangeTooLarge');
  if (!boundedParameterJson(raw)) exchangeFailure('exchangeInvalid');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return exchangeFailure('exchangeInvalid'); }
  return parseQueryExchange(value);
}

/** Connection labels are hints only; no endpoint, real connection ID or authentication is exported. */
export function buildQueryExchange(library: SavedQueryLibrary, selected: readonly string[],
  profiles: readonly Pick<ConnectionProfile, 'id' | 'displayName'>[]): QueryExchange {
  if (!parseLibraryPayload(library).ok || selected.length === 0 || new Set(selected).size !== selected.length) exchangeFailure('exchangeInvalid');
  const entries = selected.map((id) => {
    const entry = library.entries.find((item) => item.id === id);
    if (!entry) exchangeFailure('libraryConflict');
    return entry;
  });
  const connectionKeys = new Map<string, string>();
  const connections: { key: string; label: string }[] = [];
  const queries = entries.map((entry, index): PortableQuery => {
    let connectionKey: string | null = null;
    if (entry.connectionId !== null) {
      connectionKey = connectionKeys.get(entry.connectionId) ?? `connection-${connections.length + 1}`;
      if (!connectionKeys.has(entry.connectionId)) {
        connectionKeys.set(entry.connectionId, connectionKey);
        connections.push({ key: connectionKey, label: profiles.find((profile) => profile.id === entry.connectionId)?.displayName ?? connectionKey });
      }
    }
    return {
      key: `query-${index + 1}`, name: entry.name, connectionKey, index: entry.index,
      // An applied parameter value must not hitch a ride in the stored concrete draft.
      dsl: entry.parameters?.template ?? entry.dsl, resultView: entry.resultView, favorite: entry.favorite,
      ...(entry.parameters === undefined ? {} : { parameters: parametersPayload(entry.parameters) }),
    };
  });
  return parseQueryExchange({ format: QUERY_EXCHANGE_FORMAT, version: QUERY_EXCHANGE_VERSION, connections, queries });
}

export function validateConnectionMappings(bundle: QueryExchange, mappings: readonly ConnectionMapping[],
  profiles?: readonly Pick<ConnectionProfile, 'id' | 'endpoint'>[]): Map<string, ConnectionMapping['target']> {
  if (mappings.length !== bundle.connections.length) exchangeFailure('exchangeMappingRequired');
  const result = new Map<string, ConnectionMapping['target']>();
  for (const mapping of mappings) {
    if (!shape(mapping, ['sourceKey', 'target']) || !identifier(mapping.sourceKey) || result.has(mapping.sourceKey)
      || !bundle.connections.some((connection) => connection.key === mapping.sourceKey)) exchangeFailure('exchangeMappingRequired');
    if (mapping.target !== null) {
      if (!shape(mapping.target, ['connectionId', 'endpoint']) || !identifier(mapping.target.connectionId)
        || typeof mapping.target.endpoint !== 'string' || mapping.target.endpoint.length > 2048) exchangeFailure('exchangeMappingRequired');
      if (profiles && !profiles.some((profile) => profile.id === mapping.target?.connectionId && profile.endpoint === mapping.target.endpoint)) exchangeFailure('exchangeTargetChanged');
    }
    result.set(mapping.sourceKey, mapping.target);
  }
  return result;
}

/** All-or-nothing append. Existing IDs, names, drafts and favorites are never replaced. */
export function importQueryExchange(bundle: QueryExchange, mappings: readonly ConnectionMapping[], base: SavedQueryLibrary,
  profiles?: readonly Pick<ConnectionProfile, 'id' | 'endpoint'>[], now = new Date(), newId: () => string = () => crypto.randomUUID()): SavedQueryLibrary {
  const checked = parseQueryExchange(bundle);
  const mapped = validateConnectionMappings(checked, mappings, profiles);
  const additions = checked.queries.map((query) => ({
    id: newId(), name: query.name, connectionId: query.connectionKey === null ? null : mapped.get(query.connectionKey)?.connectionId ?? null,
    index: query.index, dsl: query.dsl, resultView: query.resultView, favorite: query.favorite,
    updatedAt: now.toISOString(), ...(query.parameters === undefined ? {} : { parameters: parametersPayload(query.parameters) }),
  }));
  const next: SavedQueryLibrary = { version: QUERY_LIBRARY_VERSION, entries: [...base.entries, ...additions] };
  if (next.entries.length > MAX_SAVED_ENTRIES || utf8ByteLength(serializeLibrary(next)) > MAX_LIBRARY_BYTES) exchangeFailure('exchangeTooLarge');
  if (!parseLibraryPayload(next).ok) exchangeFailure('exchangeInvalid');
  return libraryPayload(next);
}

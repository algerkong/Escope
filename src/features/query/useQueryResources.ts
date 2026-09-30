import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  parseFieldCaps, parseIndexCatalog, parseMappingFields,
  type FieldCatalog, type IndexCatalog, type MappingField, type ResourceParse,
} from '../../domain/resource';
import { errorCode, type QueryBackend, type ResourceKind } from '../../services/ipc';

/** One async resource read: idle, in flight, parsed, or failed with a structured code. */
export type Loadable<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly code: string };

export interface MappingState {
  /** Verbatim mapping response, kept for the detail view and copy. */
  readonly raw: string;
  readonly fields: readonly MappingField[];
}

const IDLE = { status: 'idle' } as const;

/**
 * Cache key for one read: connection + endpoint + resource + index scope.
 * The endpoint is part of the identity, so a connection pointed at another cluster never
 * reuses a previous catalog, and renaming a connection does not change the key.
 */
export function resourceKey(connectionId: string, endpoint: string, kind: ResourceKind, index = ''): string {
  return `${connectionId}\u0000${endpoint}\u0000${kind}\u0000${index}`;
}

function parseMappingState(raw: string): ResourceParse<MappingState> {
  const parsed = parseMappingFields(raw);
  return parsed.ok ? { ok: true, value: { raw, fields: parsed.value } } : parsed;
}

function keyOwner(key: string): { connectionId: string; endpoint: string } {
  const first = key.indexOf('\u0000');
  const second = key.indexOf('\u0000', first + 1);
  return { connectionId: key.slice(0, first), endpoint: key.slice(first + 1, second) };
}

type Cache<T> = Record<string, Loadable<T>>;
type InFlight = { readonly requestId: string; readonly connectionId: string; readonly endpoint: string };

/** The cancel contract carries only the request and connection identity. */
function cancelRequestOf(request: InFlight) {
  return { requestId: request.requestId, connectionId: request.connectionId };
}

/**
 * Index, field capability and mapping reads for the live query workspace.
 *
 * Each read is cached per connection + endpoint + index scope, so two scopes never share a
 * slot: a slow response for a previous target cannot overwrite the current one, and going
 * back to a scope already read shows its own result. A read is only applied when its
 * request is still the current one for its key, and it is cancelled on refresh,
 * invalidation (endpoint change or removed connection) and unmount.
 */
export function useQueryResources(backend: QueryBackend) {
  const [indices, setIndices] = useState<Cache<IndexCatalog>>({});
  const [fields, setFields] = useState<Cache<FieldCatalog>>({});
  const [mappings, setMappings] = useState<Cache<MappingState>>({});
  const indicesRef = useRef(indices);
  const fieldsRef = useRef(fields);
  const inFlight = useRef(new Map<string, InFlight>());
  const alive = useRef(true);
  // Kept in a ref so callbacks stay stable even when a caller passes a new backend object.
  const backendRef = useRef(backend);
  useEffect(() => { backendRef.current = backend; }, [backend]);
  useEffect(() => { indicesRef.current = indices; }, [indices]);
  useEffect(() => { fieldsRef.current = fields; }, [fields]);
  useEffect(() => {
    alive.current = true;
    const requests = inFlight.current;
    return () => {
      alive.current = false;
      const pending = [...requests.values()];
      requests.clear();
      for (const request of pending) void backendRef.current.cancel(cancelRequestOf(request)).catch(() => undefined);
    };
  }, []);

  const load = useCallback(async <T,>(
    key: string,
    connectionId: string,
    endpoint: string,
    resource: ResourceKind,
    index: string | undefined,
    parse: (raw: string) => ResourceParse<T>,
    setCache: Dispatch<SetStateAction<Cache<T>>>,
  ): Promise<void> => {
    const previous = inFlight.current.get(key);
    if (previous) void backendRef.current.cancel(cancelRequestOf(previous)).catch(() => undefined);
    const requestId = crypto.randomUUID();
    inFlight.current.set(key, { requestId, connectionId, endpoint });
    setCache((current) => ({ ...current, [key]: { status: 'loading' } }));
    const settle = (state: Loadable<T>) => setCache((current) => ({ ...current, [key]: state }));
    try {
      const response = await backendRef.current.readResource({ requestId, connectionId, resource, index });
      if (!alive.current || inFlight.current.get(key)?.requestId !== requestId) return;
      inFlight.current.delete(key);
      if (response.requestId !== requestId || response.connectionId !== connectionId || response.endpoint !== endpoint) {
        settle({ status: 'error', code: 'invalidResponse' });
        return;
      }
      const parsed = parse(response.rawResponse);
      settle(parsed.ok ? { status: 'ready', data: parsed.value } : { status: 'error', code: 'invalidResponse' });
    } catch (error) {
      if (!alive.current || inFlight.current.get(key)?.requestId !== requestId) return;
      inFlight.current.delete(key);
      settle({ status: 'error', code: errorCode(error, 'networkError') });
    }
  }, []);

  const readIndices = useCallback((connectionId: string, endpoint: string) => {
    return load(resourceKey(connectionId, endpoint, 'indices'), connectionId, endpoint, 'indices', undefined, parseIndexCatalog, setIndices);
  }, [load]);

  const readFields = useCallback((connectionId: string, endpoint: string, index: string) => {
    return load(resourceKey(connectionId, endpoint, 'fieldCaps', index), connectionId, endpoint, 'fieldCaps', index, parseFieldCaps, setFields);
  }, [load]);

  const readMapping = useCallback((connectionId: string, endpoint: string, index: string) => {
    return load(resourceKey(connectionId, endpoint, 'mapping', index), connectionId, endpoint, 'mapping', index, parseMappingState, setMappings);
  }, [load]);

  /** Load the index list once per connection/endpoint; a rename keeps the cache. */
  const ensureIndices = useCallback((connectionId: string, endpoint: string) => {
    const key = resourceKey(connectionId, endpoint, 'indices');
    if (inFlight.current.has(key) || indicesRef.current[key]) return;
    void readIndices(connectionId, endpoint);
  }, [readIndices]);

  const refreshIndices = useCallback((connectionId: string, endpoint: string) => {
    void readIndices(connectionId, endpoint);
  }, [readIndices]);

  /** Load field capabilities once per connection/endpoint/index scope. */
  const ensureFields = useCallback((connectionId: string, endpoint: string, index: string) => {
    if (index === '') return;
    const key = resourceKey(connectionId, endpoint, 'fieldCaps', index);
    if (inFlight.current.has(key) || fieldsRef.current[key]) return;
    void readFields(connectionId, endpoint, index);
  }, [readFields]);

  const refreshFields = useCallback((connectionId: string, endpoint: string, index: string) => {
    if (index === '') return;
    void readFields(connectionId, endpoint, index);
  }, [readFields]);

  /** Mapping is only read on explicit request; the detail view keeps the raw response. */
  const loadMapping = useCallback((connectionId: string, endpoint: string, index: string) => {
    void readMapping(connectionId, endpoint, index);
  }, [readMapping]);

  /**
   * Drop every read that does not belong to the current `connectionId -> endpoint` map and
   * ask the backend to stop those requests. Renames keep their endpoint and stay cached.
   */
  const invalidateConnections = useCallback((valid: ReadonlyMap<string, string>) => {
    for (const [key, request] of [...inFlight.current]) {
      if (valid.get(request.connectionId) === request.endpoint) continue;
      inFlight.current.delete(key);
      void backendRef.current.cancel(cancelRequestOf(request)).catch(() => undefined);
    }
    const prune = <T,>(cache: Cache<T>): Cache<T> => {
      const kept = Object.entries(cache).filter(([key]) => {
        const owner = keyOwner(key);
        return valid.get(owner.connectionId) === owner.endpoint;
      });
      return kept.length === Object.keys(cache).length ? cache : Object.fromEntries(kept);
    };
    setIndices(prune);
    setFields(prune);
    setMappings(prune);
  }, []);

  const indicesFor = useCallback((connectionId: string | null, endpoint: string | null): Loadable<IndexCatalog> => {
    return connectionId !== null && endpoint !== null ? indices[resourceKey(connectionId, endpoint, 'indices')] ?? IDLE : IDLE;
  }, [indices]);

  const fieldsFor = useCallback((connectionId: string | null, endpoint: string | null, index: string): Loadable<FieldCatalog> => {
    return connectionId !== null && endpoint !== null ? fields[resourceKey(connectionId, endpoint, 'fieldCaps', index)] ?? IDLE : IDLE;
  }, [fields]);

  const mappingFor = useCallback((connectionId: string | null, endpoint: string | null, index: string): Loadable<MappingState> => {
    return connectionId !== null && endpoint !== null ? mappings[resourceKey(connectionId, endpoint, 'mapping', index)] ?? IDLE : IDLE;
  }, [mappings]);

  return {
    ensureIndices, refreshIndices, ensureFields, refreshFields, loadMapping, invalidateConnections,
    indicesFor, fieldsFor, mappingFor,
  };
}

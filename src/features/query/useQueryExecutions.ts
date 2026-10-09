import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptResponse, cancelExecution, createValidatedSnapshot,
  type ExecutionState, type QueryDocument, type SnapshotRejection,
} from '../../domain/query';
import {
  isIncomplete, isValidPitId, parseQueryResult, sliceRaw,
  type QueryResultParse, type QuerySummary,
} from '../../domain/query-result';
import { supportsSnapshotPaging } from '../../domain/query-pagination';
import { runtimeFieldNamesFromDsl } from '../../domain/runtime-fields-dsl';
import { finishHistory, historyEntry, type ExecutionHistoryEntry } from '../../domain/workspace-recovery';
import { errorCode, type QueryBackend, type QueryResponse } from '../../services/ipc';

/** One successfully received page: verbatim body, parsed summary and its continuation cursor. */
export interface ExecutionPage {
  readonly rawResponse: string;
  readonly summary: QuerySummary;
  readonly partial: boolean;
  /** Verbatim `sort` array of this page's last hit; `null` when the page cannot continue. */
  readonly cursor: string | null;
}

export interface ExecutionEntry {
  readonly state: ExecutionState;
  /** Parsed summary of the latest page; `null` while idle/running or when parsing failed. */
  readonly parsed: QueryResultParse | null;
  /** Endpoint captured when the request started; compared with the current connection endpoint. */
  readonly endpoint: string | null;
  /** Verbatim body of the latest page, kept even when it could not be parsed. */
  readonly rawResponse: string | null;
  /** Every page received for this execution, oldest first; empty until a page arrives. */
  readonly pages: readonly ExecutionPage[];
  /** Current snapshot id, refreshed from every page the cluster returns. */
  readonly pitId: string | null;
  /** A continuation request is in flight; the rows already shown stay visible. */
  readonly continuing: boolean;
  /** Last continuation failure code, kept beside the rows it could not extend. */
  readonly continuationError: string | null;
}

type InFlight = {
  requestId: string;
  pitId: string | null;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly backend: QueryBackend;
  readonly history: ExecutionHistoryEntry;
};

/** The cancel contract carries only the request and connection identity. */
function cancelRequestOf(request: InFlight) {
  return { requestId: request.requestId, connectionId: request.connectionId };
}

/** Verbatim cursor of the last hit; `null` when the request produced no sort values. */
function cursorOf(raw: string, summary: QuerySummary): string | null {
  const last = summary.hits[summary.hits.length - 1];
  return last?.sort ? sliceRaw(raw, last.sort) : null;
}

const EMPTY_PAGES: readonly ExecutionPage[] = [];

function isBound(response: QueryResponse, operation: InFlight): boolean {
  return response.requestId === operation.requestId && response.connectionId === operation.connectionId
    && response.endpoint === operation.endpoint;
}

/** Per-document execution isolation; a managed PIT starts before page one and is never reopened for an old cursor. */
export function useQueryExecutions(backend: QueryBackend, onHistory?: (entry: ExecutionHistoryEntry) => void) {
  const [entries, renderEntries] = useState<Record<string, ExecutionEntry>>({});
  const inFlight = useRef(new Map<string, InFlight>());
  const alive = useRef(true);
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const entriesRef = useRef<Record<string, ExecutionEntry>>({});
  const historyRef = useRef(onHistory);
  historyRef.current = onHistory;

  // Event handlers need the new state before React commits (cancel -> rerun, duplicate clicks).
  const setEntries = useCallback((change: (current: Record<string, ExecutionEntry>) => Record<string, ExecutionEntry>) => {
    const next = change(entriesRef.current);
    if (next === entriesRef.current) return;
    entriesRef.current = next;
    if (alive.current) renderEntries(next);
  }, []);

  /** Close one snapshot without waiting; the cluster expires it on its own if this fails. */
  const closePit = useCallback((pitId: string, connectionId: string, owner = backendRef.current) => {
    if (!isValidPitId(pitId)) return;
    void owner
      .closePit({ requestId: crypto.randomUUID(), connectionId, pitId })
      .catch(() => undefined);
  }, []);

  /** The snapshot an entry currently holds, if any, with the connection that owns it. */
  const snapshotOf = (entry: ExecutionEntry | undefined) => {
    const snapshot = entry && 'snapshot' in entry.state ? entry.state.snapshot : null;
    return entry?.pitId && snapshot ? { pitId: entry.pitId, connectionId: snapshot.connectionId } : null;
  };

  useEffect(() => {
    alive.current = true;
    const requests = inFlight.current;
    return () => {
      alive.current = false;
      const pending = [...requests.values()];
      requests.clear();
      for (const request of pending) {
        historyRef.current?.(finishHistory(request.history, 'interrupted'));
        void request.backend.cancel(cancelRequestOf(request)).catch(() => undefined);
        if (request.pitId) closePit(request.pitId, request.connectionId, request.backend);
      }
      // Snapshots are server-side resources; closing them on unmount is best effort.
      for (const entry of Object.values(entriesRef.current)) {
        const open = snapshotOf(entry);
        if (open) closePit(open.pitId, open.connectionId);
      }
    };
  }, [closePit]);

  /** Stop the request for a query, release its snapshot and leave it cancelled instead of running forever. */
  const stop = useCallback((queryId: string) => {
    const active = inFlight.current.get(queryId);
    if (active) {
      inFlight.current.delete(queryId);
      historyRef.current?.(finishHistory(active.history, 'cancelled', 'cancelled'));
      void active.backend.cancel(cancelRequestOf(active)).catch(() => undefined);
    }
    const open = snapshotOf(entriesRef.current[queryId]);
    if (active?.pitId) closePit(active.pitId, active.connectionId, active.backend);
    if (open && open.pitId !== active?.pitId) closePit(open.pitId, open.connectionId);
    setEntries((current) => {
      const entry = current[queryId];
      if (!entry) return current;
      const state = cancelExecution(entry.state);
      return {
        ...current,
        [queryId]: { ...entry, state, continuing: false, continuationError: entry.continuing ? 'cancelled' : null, pitId: null },
      };
    });
  }, [closePit, setEntries]);

  /** Freeze and execute one snapshot. Returns a structured rejection when the draft is unusable. */
  const run = useCallback(async (query: QueryDocument, endpoint: string | null,
    kind: 'query' | 'index' = 'query'): Promise<SnapshotRejection | null> => {
    if (inFlight.current.has(query.id) || !alive.current) return null;
    if (kind === 'index' && query.dataView !== undefined) return { code: 'invalidDataView' };
    if (kind === 'index' && query.timeRange !== undefined) return { code: 'invalidTimeRange' };
    const validated = createValidatedSnapshot(query, crypto.randomUUID(), new Date());
    if (!validated.ok) return validated.error;
    const snapshot = validated.snapshot;
    const target = endpoint ?? '';
    // A new execution replaces the old snapshot; release the previous one first.
    const previous = snapshotOf(entriesRef.current[query.id]);
    if (previous) closePit(previous.pitId, previous.connectionId);
    const paging = supportsSnapshotPaging(snapshot.rawDsl);
    const operation: InFlight = {
      requestId: paging ? crypto.randomUUID() : snapshot.requestId,
      connectionId: snapshot.connectionId, endpoint: target, pitId: null, backend: backendRef.current,
      history: historyEntry(snapshot, query.name, kind),
    };
    inFlight.current.set(query.id, operation);
    historyRef.current?.(operation.history);
    const owns = () => alive.current && inFlight.current.get(query.id) === operation;
    setEntries((current) => ({
      ...current,
      [query.id]: {
        state: { status: 'running', snapshot }, parsed: null, endpoint, rawResponse: null,
        pages: EMPTY_PAGES, pitId: null, continuing: false, continuationError: null,
      },
    }));
    const fail = (code: string, rawResponse: string | null) => {
      if (!owns()) return;
      inFlight.current.delete(query.id);
      historyRef.current?.(finishHistory(operation.history, code === 'cancelled' ? 'cancelled' : 'failed', code));
      if (operation.pitId) closePit(operation.pitId, operation.connectionId, operation.backend);
      setEntries((current) => ({
        ...current,
        [query.id]: {
          state: { status: 'failed', snapshot, code }, parsed: null, endpoint, rawResponse,
          pages: EMPTY_PAGES, pitId: null, continuing: false, continuationError: null,
        },
      }));
    };
    try {
      if (paging) {
        const opened = await operation.backend.openPit({
          requestId: operation.requestId, connectionId: snapshot.connectionId, index: snapshot.index,
        });
        const bound = opened.requestId === operation.requestId && opened.connectionId === snapshot.connectionId
          && opened.endpoint === target && isValidPitId(opened.pitId);
        if (!owns()) {
          if (bound) closePit(opened.pitId, snapshot.connectionId, operation.backend);
          return null;
        }
        if (!bound) { fail('invalidResponse', null); return null; }
        operation.pitId = opened.pitId;
        operation.requestId = snapshot.requestId;
      }
      const response = await operation.backend.execute({
        requestId: snapshot.requestId, connectionId: snapshot.connectionId,
        index: snapshot.index, rawDsl: snapshot.rawDsl,
        ...(operation.pitId ? { pitId: operation.pitId } : {}),
      });
      if (!owns()) {
        if (isBound(response, operation) && isValidPitId(response.pitId)) {
          closePit(response.pitId, operation.connectionId, operation.backend);
        }
        return null;
      }
      if (!isBound(response, operation) || (response.pitId !== null && !isValidPitId(response.pitId))) {
        fail('invalidResponse', null);
        return null;
      }
      const parsed = parseQueryResult(response.rawResponse, runtimeFieldNamesFromDsl(snapshot.rawDsl));
      if (!parsed.ok || (response.pitId !== null && parsed.summary.pitId !== null && response.pitId !== parsed.summary.pitId)) {
        fail('invalidResponse', response.rawResponse);
        return null;
      }
      operation.pitId = response.pitId ?? parsed.summary.pitId ?? operation.pitId;
      const partial = isIncomplete(parsed.summary, response.partial);
      const page: ExecutionPage = {
        rawResponse: response.rawResponse, summary: parsed.summary, partial,
        cursor: cursorOf(response.rawResponse, parsed.summary),
      };
      setEntries((current) => {
        const previousState = current[query.id]?.state ?? { status: 'idle' as const };
        const state = acceptResponse(previousState, {
          requestId: snapshot.requestId, connectionId: snapshot.connectionId, rawResponse: response.rawResponse, partial,
        });
        return {
          ...current,
          [query.id]: {
            state, parsed, endpoint, rawResponse: response.rawResponse,
            pages: [page], pitId: operation.pitId, continuing: false, continuationError: null,
          },
        };
      });
      inFlight.current.delete(query.id);
      historyRef.current?.(finishHistory(operation.history, partial ? 'partial' : 'success'));
    } catch (error) {
      fail(errorCode(error, 'unexpected'), null);
    }
    return null;
  }, [closePit, setEntries]);

  const cancel = stop;

  /**
   * Continue only the original snapshot, using its frozen DSL, not the current draft. A failed
   * page keeps the received rows; an expired PIT requires a new run starting from page one.
   */
  const loadMore = useCallback(async (query: QueryDocument) => {
    if (!alive.current) return;
    const entry = entriesRef.current[query.id];
    if (!entry || entry.continuing || !['success', 'partial'].includes(entry.state.status)
      || inFlight.current.has(query.id) || !isValidPitId(entry.pitId)) return;
    const snapshot = 'snapshot' in entry.state ? entry.state.snapshot : null;
    const lastPage = entry.pages[entry.pages.length - 1];
    const cursor = lastPage?.cursor ?? null;
    if (!snapshot || !lastPage || cursor === null) return;
    const { connectionId } = snapshot;
    const endpoint = entry.endpoint ?? '';
    const requestId = crypto.randomUUID();
    const operation: InFlight = {
      requestId, connectionId, endpoint, pitId: entry.pitId, backend: backendRef.current,
      history: historyEntry({ ...snapshot, requestId, startedAt: new Date().toISOString() }, query.name, 'continuation'),
    };
    inFlight.current.set(query.id, operation);
    historyRef.current?.(operation.history);
    const owns = () => alive.current && inFlight.current.get(query.id) === operation;
    setEntries((current) => {
      const existing = current[query.id];
      return existing ? { ...current, [query.id]: { ...existing, continuing: true, continuationError: null } } : current;
    });
    // A continuation that was superseded (re-run, stop, release) must not touch the new entry.
    const settleError = (code: string) => {
      if (!owns()) return;
      inFlight.current.delete(query.id);
      historyRef.current?.(finishHistory(operation.history, code === 'cancelled' ? 'cancelled' : 'failed', code));
      const dead = code === 'notFound' || code === 'invalidResponse' || code === 'cancelled';
      if (dead && operation.pitId) closePit(operation.pitId, connectionId, operation.backend);
      setEntries((current) => {
        const existing = current[query.id];
        if (!existing || existing.pages !== entry.pages) return current;
        return {
          ...current,
          [query.id]: {
            ...existing, continuing: false, continuationError: code,
            pitId: dead ? null : operation.pitId,
          },
        };
      });
    };
    try {
      const response = await operation.backend.execute({
        requestId: operation.requestId, connectionId, index: snapshot.index, rawDsl: snapshot.rawDsl,
        pitId: entry.pitId, searchAfter: cursor,
      });
      if (!owns()) {
        if (isBound(response, operation) && isValidPitId(response.pitId)) {
          closePit(response.pitId, connectionId, operation.backend);
        }
        return;
      }
      if (!isBound(response, operation) || (response.pitId !== null && !isValidPitId(response.pitId))) {
        settleError('invalidResponse');
        return;
      }
      const parsed = parseQueryResult(response.rawResponse, runtimeFieldNamesFromDsl(snapshot.rawDsl));
      if (!parsed.ok || (response.pitId !== null && parsed.summary.pitId !== null && response.pitId !== parsed.summary.pitId)) {
        settleError('invalidResponse');
        return;
      }
      operation.pitId = response.pitId ?? parsed.summary.pitId ?? operation.pitId;
      const page: ExecutionPage = {
        rawResponse: response.rawResponse, summary: parsed.summary,
        partial: isIncomplete(parsed.summary, response.partial),
        cursor: cursorOf(response.rawResponse, parsed.summary),
      };
      if (page.cursor !== null && page.cursor === cursor) {
        settleError('invalidResponse');
        return;
      }
      setEntries((current) => {
        const existing = current[query.id];
        if (!existing || existing.pages !== entry.pages) return current;
        return {
          ...current,
          [query.id]: {
            ...existing,
            state: {
              status: page.partial || existing.pages.some((page) => page.partial) ? 'partial' : 'success',
              snapshot, rawResponse: response.rawResponse,
            },
            parsed, rawResponse: response.rawResponse,
            pages: [...existing.pages, page],
            // Always continue with the newest id the cluster returned.
            pitId: operation.pitId,
            continuing: false,
            continuationError: null,
          },
        };
      });
      inFlight.current.delete(query.id);
      historyRef.current?.(finishHistory(operation.history, page.partial ? 'partial' : 'success'));
    } catch (error) {
      settleError(errorCode(error, 'unexpected'));
    }
  }, [closePit, setEntries]);

  /** Forget queries that no longer exist (closed tab) and release their requests and snapshots. */
  const release = useCallback((liveIds: ReadonlySet<string>) => {
    for (const queryId of new Set([...inFlight.current.keys(), ...Object.keys(entriesRef.current)])) {
      if (!liveIds.has(queryId)) stop(queryId);
    }
    setEntries((current) => {
      const kept = Object.entries(current).filter(([id]) => liveIds.has(id));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [stop, setEntries]);

  /**
   * Stop requests whose connection was removed or now points at a different endpoint, and release
   * the snapshots of entries that no longer have a valid target.
   */
  const reconcile = useCallback((valid: ReadonlyMap<string, string>) => {
    for (const [queryId, active] of [...inFlight.current]) {
      if (valid.get(active.connectionId) === active.endpoint) continue;
      stop(queryId);
    }
    const orphaned = Object.entries(entriesRef.current).filter(([, entry]) => {
      const open = snapshotOf(entry);
      return open !== null && valid.get(open.connectionId) !== entry.endpoint;
    });
    if (orphaned.length === 0) return;
    for (const [, entry] of orphaned) {
      const open = snapshotOf(entry);
      if (open) closePit(open.pitId, open.connectionId);
    }
    const ids = new Set(orphaned.map(([id]) => id));
    setEntries((current) => Object.fromEntries(Object.entries(current).map(([id, entry]) =>
      ids.has(id) ? [id, { ...entry, pitId: null }] : [id, entry])));
  }, [stop, closePit, setEntries]);

  return { entries, run, cancel, release, reconcile, loadMore };
}

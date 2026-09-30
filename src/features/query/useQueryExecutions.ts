import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptResponse, cancelExecution, createValidatedSnapshot,
  type ExecutionState, type QueryDocument, type SnapshotRejection,
} from '../../domain/query';
import { isIncomplete, parseQueryResult, type QueryResultParse } from '../../domain/query-result';
import { errorCode, type QueryBackend } from '../../services/ipc';

export interface ExecutionEntry {
  readonly state: ExecutionState;
  /** Parsed summary of the received body; `null` while idle/running or when parsing failed. */
  readonly parsed: QueryResultParse | null;
  /** Endpoint captured when the request started; compared with the current connection endpoint. */
  readonly endpoint: string | null;
  /** Verbatim body when one was received, kept even when it could not be parsed. */
  readonly rawResponse: string | null;
}

type InFlight = { readonly requestId: string; readonly connectionId: string; readonly endpoint: string };

/** The cancel contract carries only the request and connection identity. */
function cancelRequestOf(request: InFlight) {
  return { requestId: request.requestId, connectionId: request.connectionId };
}

/**
 * Per-query execution state.
 *
 * Each run freezes a validated snapshot, records the connection endpoint it was sent to and
 * applies the response only when the request, connection and endpoint still match. A late or
 * foreign response is never accepted, a body that cannot be parsed becomes a failure instead
 * of a success, and cancelling, closing a tab, removing a connection or changing its endpoint
 * both stops the request and moves the query out of `running`.
 */
export function useQueryExecutions(backend: QueryBackend) {
  const [entries, setEntries] = useState<Record<string, ExecutionEntry>>({});
  const inFlight = useRef(new Map<string, InFlight>());
  const alive = useRef(true);
  const backendRef = useRef(backend);
  useEffect(() => { backendRef.current = backend; }, [backend]);
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

  /** Stop the request for a query and leave it cancelled instead of running forever. */
  const stop = useCallback((queryId: string) => {
    const active = inFlight.current.get(queryId);
    if (active) {
      inFlight.current.delete(queryId);
      void backendRef.current.cancel(cancelRequestOf(active)).catch(() => undefined);
    }
    setEntries((current) => {
      const entry = current[queryId];
      if (!entry) return current;
      const state = cancelExecution(entry.state);
      return state === entry.state ? current : { ...current, [queryId]: { ...entry, state } };
    });
  }, []);

  /** Freeze and execute one snapshot. Returns a structured rejection when the draft is unusable. */
  const run = useCallback(async (query: QueryDocument, endpoint: string | null): Promise<SnapshotRejection | null> => {
    if (inFlight.current.has(query.id) || !alive.current) return null;
    const validated = createValidatedSnapshot(query, crypto.randomUUID(), new Date());
    if (!validated.ok) return validated.error;
    const snapshot = validated.snapshot;
    const target = endpoint ?? '';
    inFlight.current.set(query.id, { requestId: snapshot.requestId, connectionId: snapshot.connectionId, endpoint: target });
    setEntries((current) => ({
      ...current,
      [query.id]: { state: { status: 'running', snapshot }, parsed: null, endpoint, rawResponse: null },
    }));
    const fail = (code: string, rawResponse: string | null) => {
      if (!alive.current) return;
      setEntries((current) => ({
        ...current,
        [query.id]: { state: { status: 'failed', snapshot, code }, parsed: null, endpoint, rawResponse },
      }));
    };
    try {
      const response = await backendRef.current.execute({
        requestId: snapshot.requestId, connectionId: snapshot.connectionId,
        index: snapshot.index, rawDsl: snapshot.rawDsl,
      });
      if (inFlight.current.get(query.id)?.requestId !== snapshot.requestId) return null;
      inFlight.current.delete(query.id);
      if (!alive.current) return null;
      // The backend must echo the frozen request; a mismatched identity is not rewritten here.
      if (response.requestId !== snapshot.requestId || response.connectionId !== snapshot.connectionId
        || response.endpoint !== target) {
        fail('invalidResponse', null);
        return null;
      }
      const parsed = parseQueryResult(response.rawResponse);
      if (!parsed.ok) {
        fail('invalidResponse', response.rawResponse);
        return null;
      }
      const partial = isIncomplete(parsed.summary, response.partial);
      setEntries((current) => {
        const previous = current[query.id]?.state ?? { status: 'idle' as const };
        const state = acceptResponse(previous, {
          requestId: snapshot.requestId, connectionId: snapshot.connectionId, rawResponse: response.rawResponse, partial,
        });
        return { ...current, [query.id]: { state, parsed, endpoint, rawResponse: response.rawResponse } };
      });
    } catch (error) {
      if (inFlight.current.get(query.id)?.requestId !== snapshot.requestId) return null;
      inFlight.current.delete(query.id);
      fail(errorCode(error, 'unexpected'), null);
    }
    return null;
  }, []);

  const cancel = stop;

  /** Forget queries that no longer exist (closed tab) and stop their requests. */
  const release = useCallback((liveIds: ReadonlySet<string>) => {
    for (const queryId of [...inFlight.current.keys()]) if (!liveIds.has(queryId)) stop(queryId);
    setEntries((current) => {
      const kept = Object.entries(current).filter(([id]) => liveIds.has(id));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [stop]);

  /**
   * Stop requests whose connection was removed or now points at a different endpoint, so a
   * response from the previous cluster can never update the workspace.
   */
  const reconcile = useCallback((valid: ReadonlyMap<string, string>) => {
    for (const [queryId, active] of [...inFlight.current]) {
      if (valid.get(active.connectionId) === active.endpoint) continue;
      stop(queryId);
    }
  }, [stop]);

  return { entries, run, cancel, release, reconcile };
}

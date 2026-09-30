import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceParse } from '../../domain/resource';
import { errorCode } from '../../services/ipc';
import { desktopClusterBackend, type ClusterBackend, type ClusterResourceKind } from '../../services/cluster';

/** One metadata read: idle, in flight, parsed with its verbatim body, cancelled, or failed. */
export type ClusterLoad<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T; readonly raw: string }
  | { readonly status: 'cancelled'; readonly confirmed: boolean }
  | { readonly status: 'error'; readonly code: string };

const IDLE: ClusterLoad<never> = { status: 'idle' };

export interface ClusterReadOptions<T> {
  kind: ClusterResourceKind;
  /** Index or pattern for the kinds that need one; part of the identity of this read. */
  index?: string;
  connectionId: string | null;
  /** Saved endpoint. Editing it invalidates and cancels the previous target's read. */
  endpoint: string | null;
  enabled: boolean;
  parse: (raw: string) => ResourceParse<T>;
  backend?: ClusterBackend;
}

export interface ClusterRead<T> {
  readonly state: ClusterLoad<T>;
  readonly refresh: () => void;
  readonly cancel: () => void;
}

/**
 * One read-only metadata read, bound to exactly one connection, endpoint and target.
 *
 * A read starts when the target first becomes available, and again only on an explicit refresh.
 * Nothing polls. Changing the connection, endpoint, resource kind or index — or unmounting —
 * invalidates the in-flight request and asks the backend to cancel it, so a late response for a
 * previous target is dropped instead of being applied to the current one. Failures stay local to
 * this read and never affect another page or an in-flight query.
 */
export function useClusterRead<T>(options: ClusterReadOptions<T>): ClusterRead<T> {
  const { kind, index, connectionId, endpoint, enabled, parse, backend = desktopClusterBackend } = options;
  const [state, setState] = useState<ClusterLoad<T>>(IDLE);
  // In-flight request, and the read that currently owns `state` (used to settle a late cancel).
  const pending = useRef<{ requestId: string; connectionId: string } | null>(null);
  const owner = useRef<string | null>(null);
  const sequence = useRef(0);
  const alive = useRef(true);
  // Refs keep the callbacks stable, so a new backend or parse identity never re-runs a read.
  const backendRef = useRef(backend);
  const parseRef = useRef(parse);
  useEffect(() => { backendRef.current = backend; }, [backend]);
  useEffect(() => { parseRef.current = parse; }, [parse]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  // Latest target, readable from an async callback: a response for a target that is no longer
  // current is refused even if it lands before the effect cleanup has run.
  const target = useRef({ connectionId, endpoint });
  target.current = { connectionId, endpoint };

  /** Drop the current read and ask the backend to stop it; its response is never applied. */
  const invalidate = useCallback(() => {
    const inFlight = pending.current;
    pending.current = null;
    owner.current = null;
    if (!inFlight) return;
    void backendRef.current
      .cancel({ requestId: inFlight.requestId, connectionId: inFlight.connectionId })
      .catch(() => false);
  }, []);

  const run = useCallback(async () => {
    if (!enabled || connectionId === null || endpoint === null) return;
    const requestId = crypto.randomUUID();
    const token = ++sequence.current;
    pending.current = { requestId, connectionId };
    owner.current = requestId;
    setState({ status: 'loading' });
    try {
      const response = await backendRef.current.read({ requestId, connectionId, resource: kind, index });
      if (!alive.current || owner.current !== requestId) return;
      // An injected backend must satisfy the same contract as the IPC layer: the response has to
      // belong to this request, this connection and this endpoint, and that target must still be
      // the current one.
      if (response.requestId !== requestId || response.connectionId !== connectionId || response.endpoint !== endpoint
        || target.current.connectionId !== connectionId || target.current.endpoint !== endpoint) {
        setState({ status: 'error', code: 'invalidResponse' });
        return;
      }
      const parsed = parseRef.current(response.rawResponse);
      setState(parsed.ok
        ? { status: 'ready', data: parsed.value, raw: response.rawResponse }
        : { status: 'error', code: 'invalidResponse' });
    } catch (error) {
      if (!alive.current || owner.current !== requestId) return;
      setState({ status: 'error', code: errorCode(error, 'networkError') });
    } finally {
      if (token === sequence.current && pending.current?.requestId === requestId) {
        pending.current = null;
        owner.current = null;
      }
    }
  }, [enabled, connectionId, endpoint, kind, index]);

  useEffect(() => {
    if (!enabled || connectionId === null || endpoint === null) {
      invalidate();
      setState(IDLE);
      return;
    }
    void run();
    return invalidate;
  }, [enabled, connectionId, endpoint, kind, index, run, invalidate]);

  const refresh = useCallback(() => {
    invalidate();
    void run();
  }, [invalidate, run]);

  const cancel = useCallback(() => {
    const inFlight = pending.current;
    if (!inFlight) return;
    const token = ++sequence.current;
    pending.current = null;
    owner.current = null;
    // The response is discarded at once and the wait ends here; the backend answer only refines
    // the wording. A later read or cancel owns the state, so this ack cannot overwrite it.
    setState({ status: 'cancelled', confirmed: false });
    const settle = (confirmed: boolean) => {
      if (alive.current && token === sequence.current) setState({ status: 'cancelled', confirmed });
    };
    void backendRef.current
      .cancel({ requestId: inFlight.requestId, connectionId: inFlight.connectionId })
      .then(settle, () => {});
  }, []);

  return { state, refresh, cancel };
}

/**
 * Local paging for a filtered row list. The page is clamped on read, so shrinking the filtered
 * list cannot leave the view on a page that no longer exists.
 */
export function usePaging<T>(rows: readonly T[], pageSize: number) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  return {
    page: current,
    setPage,
    pageCount,
    visible: rows.slice(current * pageSize, current * pageSize + pageSize),
  };
}

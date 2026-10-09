import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionProfile } from '../../domain/connection';
import { cancelRequest, errorCode, testConnection, type ConnectionIdentity } from '../../services/ipc';

type Target = { requestId: string; endpoint: string };
export type ConnectionTestState =
  | (Target & { status: 'running' })
  | (Target & { status: 'success'; identity: ConnectionIdentity; completedAt: string })
  | (Target & { status: 'error'; code: string })
  | { status: 'stale' };

export function connectionTestLabel(result?: ConnectionTestState): string {
  if (!result) return 'notTested';
  return {
    running: 'connections:testing', success: 'connections:identityConfirmed',
    error: 'connections:testFailed', stale: 'connections:testStaleShort',
  }[result.status];
}

export function useConnectionTests(probe: typeof testConnection = testConnection, cancel: typeof cancelRequest = cancelRequest) {
  const [results, setResults] = useState<Record<string, ConnectionTestState>>({});
  const pending = useRef(new Map<string, string>());
  useEffect(() => {
    const requests = pending.current;
    return () => {
      for (const [connectionId, requestId] of requests) void cancel({ connectionId, requestId }).catch(() => undefined);
      requests.clear();
    };
  }, [cancel]);

  const invalidate = useCallback((id: string, removed = false) => {
    const requestId = pending.current.get(id);
    pending.current.delete(id);
    if (requestId) void cancel({ connectionId: id, requestId }).catch(() => undefined);
    setResults((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      if (removed) delete next[id];
      else next[id] = { status: 'stale' };
      return next;
    });
  }, [cancel]);

  const run = useCallback(async (profile: ConnectionProfile) => {
    const { id, endpoint } = profile;
    if (pending.current.has(id)) return;
    const requestId = crypto.randomUUID();
    pending.current.set(id, requestId);
    setResults((current) => ({ ...current, [id]: { status: 'running', requestId, endpoint } }));
    try {
      const identity = await probe({ requestId, connectionId: id });
      // The saved endpoint can change while Rust is reading its database snapshot.
      if (identity.requestId !== requestId || identity.connectionId !== id || identity.endpoint !== endpoint) {
        throw { code: 'invalidResponse' };
      }
      if (pending.current.get(id) !== requestId) return;
      const completedAt = new Date().toISOString();
      setResults((current) => ({ ...current, [id]: { status: 'success', requestId, endpoint, identity, completedAt } }));
    } catch (cause) {
      if (pending.current.get(id) !== requestId) return;
      setResults((current) => ({ ...current, [id]: { status: 'error', requestId, endpoint, code: errorCode(cause, 'unexpected') } }));
    } finally {
      if (pending.current.get(id) === requestId) pending.current.delete(id);
    }
  }, [probe]);

  return { results, run, invalidate };
}

export interface QueryDocument {
  readonly id: string;
  readonly connectionId: string | null;
  name: string;
  index: string;
  dsl: string;
  revision: number;
  resultView: 'table' | 'json';
}

export interface ExecutionSnapshot {
  readonly requestId: string;
  readonly queryId: string;
  readonly connectionId: string;
  readonly index: string;
  readonly rawDsl: string;
  readonly revision: number;
  readonly startedAt: string;
}

export type ExecutionState =
  | { status: 'idle' }
  | { status: 'running'; snapshot: ExecutionSnapshot }
  | { status: 'cancelled'; snapshot: ExecutionSnapshot }
  | { status: 'success' | 'partial'; snapshot: ExecutionSnapshot; rawResponse: string }
  | { status: 'failed'; snapshot: ExecutionSnapshot; code: string };

export function createQuery(connectionId: string | null, view: QueryDocument['resultView'] = 'table'): QueryDocument {
  return {
    id: crypto.randomUUID(), connectionId, name: '', index: '',
    dsl: '{\n  "query": {\n    "match_all": {}\n  },\n  "size": 25\n}',
    revision: 0, resultView: view,
  };
}

export function createSnapshot(query: QueryDocument, requestId: string, now: Date): ExecutionSnapshot {
  if (!query.connectionId) throw new Error('noConnection');
  if (!query.index.trim()) throw new Error('invalidIndex');
  return Object.freeze({
    requestId, queryId: query.id, connectionId: query.connectionId, index: query.index,
    rawDsl: query.dsl, revision: query.revision, startedAt: now.toISOString(),
  });
}

export function acceptResponse(state: ExecutionState, response: {
  requestId: string; connectionId: string; rawResponse: string; partial?: boolean;
}): ExecutionState {
  if (state.status !== 'running' ||
    state.snapshot.requestId !== response.requestId ||
    state.snapshot.connectionId !== response.connectionId) return state;
  return {
    status: response.partial ? 'partial' : 'success',
    snapshot: state.snapshot, rawResponse: response.rawResponse,
  };
}

export function cancelExecution(state: ExecutionState): ExecutionState {
  return state.status === 'running' ? { status: 'cancelled', snapshot: state.snapshot } : state;
}

export interface WorkspaceState {
  activeConnectionId: string | null;
  activeQueryId: string;
  queries: QueryDocument[];
}

export function switchConnection(state: WorkspaceState, connectionId: string | null, view: QueryDocument['resultView']): WorkspaceState {
  const existing = state.queries.find((query) => query.connectionId === connectionId);
  const query = existing ?? createQuery(connectionId, view);
  return {
    activeConnectionId: connectionId, activeQueryId: query.id,
    queries: existing ? state.queries : [...state.queries, query],
  };
}

import { validateQueryDsl, type QueryDslErrorCode } from './query-dsl';

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

export type SnapshotRejectionCode = 'noConnection' | 'invalidIndex' | 'invalidTimestamp';

export interface SnapshotRejection {
  readonly code: QueryDslErrorCode | SnapshotRejectionCode;
  readonly line?: number;
  readonly column?: number;
}

/** Contract version of the DSL validation/format rules a validated snapshot was built with. */
export const QUERY_DSL_CONTRACT_VERSION = 2;

export interface ValidatedExecutionSnapshot extends ExecutionSnapshot {
  readonly dslContractVersion: number;
}

export type ValidatedSnapshot =
  | { readonly ok: true; readonly snapshot: ValidatedExecutionSnapshot }
  | { readonly ok: false; readonly error: SnapshotRejection };

type SnapshotGate =
  | { readonly ok: true; readonly connectionId: string }
  | { readonly ok: false; readonly code: SnapshotRejectionCode };

/** Execution preconditions that stay a thrown error for the legacy `createSnapshot` path. */
function gateSnapshot(query: QueryDocument): SnapshotGate {
  if (!query.connectionId) return { ok: false, code: 'noConnection' };
  if (!query.index.trim()) return { ok: false, code: 'invalidIndex' };
  return { ok: true, connectionId: query.connectionId };
}

function snapshotFields(
  query: QueryDocument,
  connectionId: string,
  requestId: string,
  now: Date,
): ExecutionSnapshot {
  return {
    requestId, queryId: query.id, connectionId, index: query.index,
    rawDsl: query.dsl, revision: query.revision, startedAt: now.toISOString(),
  };
}

/**
 * Freeze one execution: verbatim DSL, index scope and connection ownership are captured
 * by value, so later draft edits or a connection switch cannot rebind this snapshot.
 */
export function createSnapshot(query: QueryDocument, requestId: string, now: Date): ExecutionSnapshot {
  const gate = gateSnapshot(query);
  if (!gate.ok) throw new Error(gate.code);
  return Object.freeze(snapshotFields(query, gate.connectionId, requestId, now));
}

/**
 * Versioned execution gate: rejects an unusable DSL draft, an unbound target or an
 * invalid execution timestamp as a structured result instead of throwing, and stamps the
 * DSL contract version used. The draft text itself is never rewritten here.
 */
export function createValidatedSnapshot(query: QueryDocument, requestId: string, now: Date): ValidatedSnapshot {
  const validation = validateQueryDsl(query.dsl);
  if (!validation.ok) return { ok: false, error: validation.error };
  const gate = gateSnapshot(query);
  if (!gate.ok) return { ok: false, error: { code: gate.code } };
  if (Number.isNaN(now.getTime())) return { ok: false, error: { code: 'invalidTimestamp' } };
  return {
    ok: true,
    snapshot: Object.freeze({
      ...snapshotFields(query, gate.connectionId, requestId, now),
      dslContractVersion: QUERY_DSL_CONTRACT_VERSION,
    }),
  };
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

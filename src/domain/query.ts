import { validateQueryDsl, type QueryDslErrorCode } from './query-dsl';
import { DATA_PREVIEW_DSL } from './query-pagination';
import type { QueryParameters } from './query-parameters';

export interface QueryDocument {
  readonly id: string;
  readonly connectionId: string | null;
  name: string;
  index: string;
  dsl: string;
  revision: number;
  resultView: 'table' | 'json';
  parameters?: QueryParameters;
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

export interface WorkspaceTab {
  readonly kind: 'query' | 'index';
  readonly document: QueryDocument;
}

export interface WorkspaceState {
  activeConnectionId: string | null;
  /** Null selects the index opener, which never owns an execution. */
  activeTabId: string | null;
  tabs: WorkspaceTab[];
  lastTabByConnection: Record<string, string | null>;
}

export function createWorkspace(connectionId: string | null, view: QueryDocument['resultView'] = 'table'): WorkspaceState {
  return {
    activeConnectionId: connectionId, activeTabId: null,
    tabs: [{ kind: 'query', document: createQuery(connectionId, view) }],
    lastTabByConnection: {},
  };
}

export function selectWorkspaceTab(state: WorkspaceState, id: string | null): WorkspaceState {
  const tab = state.tabs.find((item) => item.document.id === id);
  if (id !== null && tab === undefined) return state;
  const connectionId = tab ? tab.document.connectionId : state.activeConnectionId;
  return {
    ...state, activeTabId: id, activeConnectionId: tab?.document.connectionId ?? state.activeConnectionId,
    lastTabByConnection: { ...state.lastTabByConnection, [connectionId ?? '']: id },
  };
}

export function addWorkspaceTab(state: WorkspaceState, tab: WorkspaceTab): WorkspaceState {
  // Index identity is the stable connection ID and exact trimmed target, not a display name.
  const existing = tab.kind === 'index' ? state.tabs.find((item) => item.kind === 'index'
    && item.document.connectionId === tab.document.connectionId && item.document.index === tab.document.index) : undefined;
  if (existing) return selectWorkspaceTab(state, existing.document.id);
  return selectWorkspaceTab({ ...state, tabs: [...state.tabs, tab] }, tab.document.id);
}

export function createIndexTab(connectionId: string, index: string, view: QueryDocument['resultView']): WorkspaceTab {
  return {
    kind: 'index',
    document: { ...createQuery(connectionId, view), index: index.trim(), dsl: DATA_PREVIEW_DSL },
  };
}

export function updateWorkspaceDocument(
  state: WorkspaceState, id: string, patch: QueryDocumentPatch,
): WorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.document.id !== id) return tab;
      // An index tab cannot be rebound by a generic editor update.
      const allowed = tab.kind === 'index' ? (patch.resultView ? { resultView: patch.resultView } : {}) : patch;
      const changed = Object.entries(allowed).some(([key, value]) => tab.document[key as keyof QueryDocument] !== value);
      if (!changed) return tab;
      const revised = (allowed.dsl !== undefined && allowed.dsl !== tab.document.dsl)
        || (allowed.index !== undefined && allowed.index !== tab.document.index)
        || (allowed.name !== undefined && allowed.name !== tab.document.name)
        || (allowed.parameters !== undefined && JSON.stringify(allowed.parameters) !== JSON.stringify(tab.document.parameters));
      return { ...tab, document: { ...tab.document, ...allowed, revision: tab.document.revision + (revised ? 1 : 0) } };
    }),
  };
}

export type QueryDocumentPatch = Partial<Pick<QueryDocument, 'name' | 'index' | 'dsl' | 'resultView' | 'parameters'>>;

export function matchesQueryDraft(current: QueryDocument | undefined, expected: QueryDocument): boolean {
  return current !== undefined && current.id === expected.id && current.revision === expected.revision
    && current.connectionId === expected.connectionId && current.index === expected.index && current.dsl === expected.dsl
    && JSON.stringify(current.parameters) === JSON.stringify(expected.parameters);
}

export function closeWorkspaceTab(state: WorkspaceState, id: string): WorkspaceState {
  const position = state.tabs.findIndex((tab) => tab.document.id === id);
  if (position === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.document.id !== id);
  const lastTabByConnection = Object.fromEntries(Object.entries(state.lastTabByConnection).filter(([, value]) => value !== id));
  const remaining = { ...state, tabs, lastTabByConnection };
  return state.activeTabId !== id ? remaining
    : selectWorkspaceTab(remaining, (tabs[position] ?? tabs[position - 1])?.document.id ?? null);
}

export function switchConnection(state: WorkspaceState, connectionId: string | null): WorkspaceState {
  if (state.activeConnectionId === connectionId) return state;
  const remembered = state.lastTabByConnection[connectionId ?? ''];
  const activeTabId = remembered && state.tabs.some((tab) => tab.document.id === remembered
    && tab.document.connectionId === connectionId) ? remembered : null;
  return { ...state, activeConnectionId: connectionId, activeTabId };
}

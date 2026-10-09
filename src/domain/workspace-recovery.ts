import type { ExecutionSnapshot, QueryDocument, WorkspaceState, WorkspaceTab } from './query';
import { INITIAL_RESULT_GRID_STATE, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, ROW_COLUMN_WIDTH, type ResultGridState } from './result-grid';
import { utf8ByteLength, MAX_ENTRY_DSL_BYTES, MAX_ENTRY_INDEX_BYTES } from './query-library';
import type { VisualForm, VisualBuildProblem } from './visual-query';
import { parametersPayload, parseQueryParameters } from './query-parameters';
import { freezeDataViewSelection, parseDataViewSelection, selectDataView } from './data-views';
import { copyQueryTimeRange, freezeExecutionTimeRange, parseExecutionTimeRange, parseQueryTimeRange } from './query-time-range';

export const WORKSPACE_RECOVERY_VERSION = 1;
export const MAX_WORKSPACE_TABS = 50;
export const MAX_EXECUTION_HISTORY = 100;
export const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024;
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_RECOVERY_BYTES = MAX_WORKSPACE_BYTES + MAX_HISTORY_BYTES + 1024;
export const MAX_GRID_COLUMNS = 500;

export type ResultGridLayout = Pick<ResultGridState, 'columnOrder' | 'columnSizing' | 'columnVisibility' | 'sorting'>;

export interface VisualEditorDraft {
  readonly source: string;
  readonly form: VisualForm | null;
  readonly problems: readonly VisualBuildProblem[];
}

export interface RecoveryTab extends WorkspaceTab {
  readonly grid: ResultGridLayout;
  readonly editorMode: 'dsl' | 'visual';
  readonly visualDraft: VisualEditorDraft | null;
}

export interface RecoveryWorkspace extends Omit<WorkspaceState, 'tabs'> {
  tabs: RecoveryTab[];
}

export type HistoryStatus = 'running' | 'success' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export interface ExecutionHistoryEntry {
  readonly snapshot: ExecutionSnapshot;
  readonly name: string;
  readonly kind: 'query' | 'index' | 'continuation';
  readonly status: HistoryStatus;
  /** Unknown after a crash: never synthesize a successful completion time. */
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
}

export interface WorkspaceRecoveryDocument {
  readonly version: number;
  readonly workspace: RecoveryWorkspace | null;
  /** Newest execution first. No result body, cursor, PIT or transport settings. */
  readonly history: readonly ExecutionHistoryEntry[];
}

export interface WorkspaceRecoveryRecord {
  readonly revision: number;
  readonly document: WorkspaceRecoveryDocument;
}

export function emptyRecoveryDocument(): WorkspaceRecoveryDocument {
  return { version: WORKSPACE_RECOVERY_VERSION, workspace: null, history: [] };
}

export function gridLayout(state: ResultGridLayout): ResultGridLayout {
  return {
    columnOrder: [...state.columnOrder], columnSizing: { ...state.columnSizing },
    columnVisibility: { ...state.columnVisibility }, sorting: state.sorting.map(({ id, desc }) => ({ id, desc })),
  };
}

export function recoveryWorkspace(state: WorkspaceState, previous?: RecoveryWorkspace | null): RecoveryWorkspace {
  const prior = new Map(previous?.tabs.map((tab) => [tab.document.id, tab]));
  return {
    activeConnectionId: state.activeConnectionId, activeTabId: state.activeTabId,
    lastTabByConnection: { ...state.lastTabByConnection },
    tabs: state.tabs.map((tab) => {
      const saved = prior.get(tab.document.id);
      const { id, connectionId, name, index, dsl, revision, resultView } = tab.document;
      return {
        kind: tab.kind, document: { id, connectionId, name, index, dsl, revision, resultView,
          ...(tab.document.parameters === undefined ? {} : { parameters: parametersPayload(tab.document.parameters) }),
          ...(tab.document.dataView === undefined ? {} : { dataView: selectDataView(tab.document.dataView.definition) }),
          ...(tab.document.timeRange === undefined ? {} : { timeRange: copyQueryTimeRange(tab.document.timeRange) }) },
        grid: saved?.grid ?? gridLayout(INITIAL_RESULT_GRID_STATE),
        editorMode: saved?.editorMode ?? 'dsl',
        visualDraft: saved?.visualDraft?.source === dsl ? saved.visualDraft : null,
      };
    }),
  };
}

/** Project fields by name so an execution's response or transport object can never hitch a ride. */
export function historyEntry(snapshot: ExecutionSnapshot, name: string, kind: ExecutionHistoryEntry['kind']): ExecutionHistoryEntry {
  const { requestId, queryId, connectionId, index, rawDsl, revision, startedAt } = snapshot;
  return {
    snapshot: Object.freeze({ requestId, queryId, connectionId, index, rawDsl, revision, startedAt,
      ...(snapshot.dataView === undefined ? {} : { dataView: freezeDataViewSelection(snapshot.dataView) }),
      ...(snapshot.timeRange === undefined ? {} : { timeRange: freezeExecutionTimeRange(snapshot.timeRange) }) }),
    name, kind, status: 'running', finishedAt: null, errorCode: null,
  };
}

export function finishHistory(entry: ExecutionHistoryEntry, status: Exclude<HistoryStatus, 'running'>,
  code: string | null = null, now = new Date()): ExecutionHistoryEntry {
  return {
    ...entry, status, finishedAt: status === 'interrupted' ? null : now.toISOString(),
    errorCode: code === null ? null : /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'unexpected',
  };
}

export function restoreHistoryQuery(entry: ExecutionHistoryEntry, id = crypto.randomUUID()): QueryDocument {
  // Historical DSL already has the actual absolute boundaries. Never restore moving-time management.
  return {
    id, connectionId: entry.snapshot.connectionId, index: entry.snapshot.index,
    dsl: entry.snapshot.rawDsl, name: entry.name, revision: 0, resultView: 'table',
    ...(entry.snapshot.dataView === undefined ? {} : { dataView: selectDataView(entry.snapshot.dataView.definition) }),
  };
}

/** A later terminal event cannot rewrite the frozen target, or resurrect a cancelled request. */
export function recordHistory(history: readonly ExecutionHistoryEntry[], entry: ExecutionHistoryEntry): readonly ExecutionHistoryEntry[] {
  const existing = history.find((item) => item.snapshot.requestId === entry.snapshot.requestId);
  if (existing && (existing.status !== 'running' || JSON.stringify(existing.snapshot) !== JSON.stringify(entry.snapshot))) return history;
  const next = existing
    ? history.map((item) => item === existing ? { ...entry, snapshot: existing.snapshot, name: existing.name, kind: existing.kind } : item)
    : [entry, ...history];
  const bounded = next.slice(0, MAX_EXECUTION_HISTORY);
  while (bounded.length > 0 && utf8ByteLength(JSON.stringify(bounded)) > MAX_HISTORY_BYTES) bounded.pop();
  return bounded;
}

export function interruptHistory(history: readonly ExecutionHistoryEntry[]): readonly ExecutionHistoryEntry[] {
  return history.map((entry) => entry.status === 'running' ? finishHistory(entry, 'interrupted') : entry);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return object(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function text(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && utf8ByteLength(value) <= bytes;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
function nullableId(value: unknown): value is string | null { return value === null || id(value); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function noControls(value: string): boolean {
  return ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}
function name(value: unknown): value is string {
  return typeof value === 'string' && [...value].length <= 120 && noControls(value);
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function columnId(value: unknown): value is string {
  return text(value, 1024) && (/^meta:(row|index|id)$/.test(value) || (value.startsWith('field:') && value.length > 6))
    && noControls(value);
}
function columnMap(value: unknown, valid: (value: unknown, key: string) => boolean): boolean {
  return object(value) && Object.keys(value).length <= MAX_GRID_COLUMNS
    && Object.entries(value).every(([key, item]) => columnId(key) && valid(item, key));
}
function validGrid(value: unknown): boolean {
  if (!shape(value, ['columnOrder', 'columnSizing', 'columnVisibility', 'sorting'])) return false;
  const { columnOrder, columnSizing, columnVisibility, sorting } = value;
  return Array.isArray(columnOrder) && columnOrder.length <= MAX_GRID_COLUMNS && columnOrder.every(columnId)
    && new Set(columnOrder).size === columnOrder.length
    && columnMap(columnSizing, (width, key) => typeof width === 'number' && Number.isFinite(width)
      && width >= (key === 'meta:row' ? ROW_COLUMN_WIDTH : MIN_COLUMN_WIDTH) && width <= MAX_COLUMN_WIDTH)
    && columnMap(columnVisibility, (visible, key) => typeof visible === 'boolean' && (key !== 'meta:row' || visible))
    && Array.isArray(sorting) && sorting.length <= 10
    && sorting.every((sort) => shape(sort, ['id', 'desc']) && columnId(sort.id) && typeof sort.desc === 'boolean')
    && new Set(sorting.map((sort: { id: string }) => sort.id)).size === sorting.length;
}

const OPERATORS = ['eq', 'neq', 'match', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'];
const VALUE_TYPES = ['string', 'number', 'boolean'];
const PROBLEMS = ['fieldRequired', 'fieldConflict', 'fieldNested', 'fieldNotSearchable', 'operatorNotAllowed',
  'valueTypeMismatch', 'negativeInAny', 'valueRequired', 'valueInvalidNumber', 'valueInvalidBoolean', 'sizeInvalid',
  'sizeOutOfRange', 'sortDirectionInvalid', 'sortFieldRequired', 'sortFieldInvalid', 'sourceUnsupported'];
function member(value: unknown, values: readonly string[]): boolean { return typeof value === 'string' && values.includes(value); }
function original(value: unknown): boolean {
  return shape(value, ['field', 'value', 'valueType', 'raw']) && text(value.field, 1024)
    && text(value.value, MAX_ENTRY_DSL_BYTES) && member(value.valueType, VALUE_TYPES) && text(value.raw, MAX_ENTRY_DSL_BYTES);
}
function validForm(value: unknown): boolean {
  if (!shape(value, ['mode', 'conditions', 'size', 'sort']) || !member(value.mode, ['all', 'any']) || !text(value.size, 1024)) return false;
  if (value.sort !== null && !(shape(value.sort, ['field', 'direction'])
    && text(value.sort.field, 1024) && member(value.sort.direction, ['asc', 'desc']))) return false;
  if (!Array.isArray(value.conditions) || value.conditions.length > 100) return false;
  const ids = new Set<string>();
  return value.conditions.every((item: unknown) => {
    if (!shape(item, ['id', 'field', 'operator', 'context', 'valueType', 'value'], ['original'])
      || !id(item.id) || ids.has(item.id) || !text(item.field, 1024) || !member(item.operator, OPERATORS)
      || !member(item.context, ['filter', 'must']) || !member(item.valueType, VALUE_TYPES)
      || !text(item.value, MAX_ENTRY_DSL_BYTES) || (item.original !== undefined && !original(item.original))) return false;
    ids.add(item.id);
    return true;
  });
}
function visualDraft(value: unknown, dsl: string): boolean {
  if (value === null) return true;
  return shape(value, ['source', 'form', 'problems']) && value.source === dsl
    && (value.form === null || validForm(value.form)) && Array.isArray(value.problems) && value.problems.length <= 500
    && value.problems.every((problem: unknown) => shape(problem, ['code'], ['conditionId'])
      && member(problem.code, PROBLEMS) && (problem.conditionId === undefined || id(problem.conditionId)));
}
function validDocument(value: unknown): value is unknown & QueryDocument {
  return shape(value, ['id', 'connectionId', 'name', 'index', 'dsl', 'revision', 'resultView'], ['parameters', 'dataView', 'timeRange'])
    && id(value.id) && nullableId(value.connectionId) && name(value.name) && text(value.index, MAX_ENTRY_INDEX_BYTES)
    && text(value.dsl, MAX_ENTRY_DSL_BYTES) && integer(value.revision) && member(value.resultView, ['table', 'json'])
    && (!Object.hasOwn(value, 'parameters') || parseQueryParameters(value.parameters) !== null)
    && (!Object.hasOwn(value, 'dataView') || parseDataViewSelection(value.dataView, value.connectionId, value.index) !== null)
    && (!Object.hasOwn(value, 'timeRange') || parseQueryTimeRange(value.timeRange, value.connectionId, value.index, value.dsl) !== null);
}
function validWorkspace(value: unknown): boolean {
  if (value === null) return true;
  if (!shape(value, ['activeConnectionId', 'activeTabId', 'tabs', 'lastTabByConnection'])
    || !nullableId(value.activeConnectionId) || !nullableId(value.activeTabId)
    || !Array.isArray(value.tabs) || value.tabs.length > MAX_WORKSPACE_TABS || !object(value.lastTabByConnection)) return false;
  const ids = new Map<string, string | null>();
  const targets = new Set<string>();
  for (const tab of value.tabs) {
    if (!shape(tab, ['kind', 'document', 'grid', 'editorMode', 'visualDraft']) || !member(tab.kind, ['query', 'index'])
      || !validDocument(tab.document) || ids.has(tab.document.id) || !validGrid(tab.grid)
      || !member(tab.editorMode, ['dsl', 'visual']) || !visualDraft(tab.visualDraft, tab.document.dsl)) return false;
    ids.set(tab.document.id, tab.document.connectionId);
    if (tab.kind === 'index') {
      const target = JSON.stringify([tab.document.connectionId, tab.document.index]);
      if (tab.document.connectionId === null || tab.document.index.trim() === '' || tab.document.index !== tab.document.index.trim()
        || tab.editorMode !== 'dsl' || tab.visualDraft !== null || tab.document.parameters !== undefined
        || tab.document.dataView !== undefined || tab.document.timeRange !== undefined || targets.has(target)) return false;
      targets.add(target);
    }
  }
  return (value.activeTabId === null || ids.has(value.activeTabId)) && Object.keys(value.lastTabByConnection).length <= 1000
    && Object.entries(value.lastTabByConnection).every(([connection, tabId]) => (connection === '' || id(connection))
      && nullableId(tabId) && (tabId === null || (ids.has(tabId) && (ids.get(tabId) ?? '') === connection)))
    && utf8ByteLength(JSON.stringify(value)) <= MAX_WORKSPACE_BYTES;
}
function validSnapshot(value: unknown): boolean {
  return shape(value, ['requestId', 'queryId', 'connectionId', 'index', 'rawDsl', 'revision', 'startedAt'], ['dataView', 'timeRange'])
    && id(value.requestId) && id(value.queryId) && id(value.connectionId) && text(value.index, MAX_ENTRY_INDEX_BYTES)
    && value.index.trim() !== '' && text(value.rawDsl, MAX_ENTRY_DSL_BYTES) && integer(value.revision) && timestamp(value.startedAt)
    && (!Object.hasOwn(value, 'dataView') || parseDataViewSelection(value.dataView, value.connectionId, value.index) !== null)
    && (!Object.hasOwn(value, 'timeRange') || parseExecutionTimeRange(value.timeRange, value.rawDsl) !== null);
}
function validHistory(value: unknown): value is unknown & ExecutionHistoryEntry {
  if (!shape(value, ['snapshot', 'name', 'kind', 'status', 'finishedAt', 'errorCode'])
    || !validSnapshot(value.snapshot) || !name(value.name) || !member(value.kind, ['query', 'index', 'continuation'])
    || !member(value.status, ['running', 'success', 'partial', 'failed', 'cancelled', 'interrupted'])) return false;
  const pending = value.status === 'running' || value.status === 'interrupted';
  const snapshot = value.snapshot as ExecutionSnapshot;
  return (value.kind !== 'index' || snapshot.dataView === undefined && snapshot.timeRange === undefined)
    && (snapshot.timeRange === undefined || (value.kind === 'continuation'
      ? snapshot.timeRange.bounds.resolvedAt <= snapshot.startedAt : snapshot.timeRange.bounds.resolvedAt === snapshot.startedAt))
    && (pending ? value.finishedAt === null : timestamp(value.finishedAt))
    && (value.errorCode === null || (typeof value.errorCode === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.errorCode)))
    && (value.status === 'failed' ? value.errorCode !== null : value.status === 'cancelled' || value.errorCode === null)
    && (value.finishedAt === null || (typeof value.finishedAt === 'string'
      && value.finishedAt >= (value.snapshot as ExecutionSnapshot).startedAt));
}

/** Unknown versions/fields fail the entire read. Never repair a subset and overwrite the source. */
export function parseRecoveryDocument(value: unknown): WorkspaceRecoveryDocument | null {
  if (!shape(value, ['version', 'workspace', 'history']) || value.version !== WORKSPACE_RECOVERY_VERSION
    || !validWorkspace(value.workspace) || !Array.isArray(value.history) || value.history.length > MAX_EXECUTION_HISTORY) return null;
  const ids = new Set<string>();
  for (const entry of value.history) {
    if (!validHistory(entry) || ids.has(entry.snapshot.requestId)) return null;
    ids.add(entry.snapshot.requestId);
  }
  if (utf8ByteLength(JSON.stringify(value.history)) > MAX_HISTORY_BYTES || utf8ByteLength(JSON.stringify(value)) > MAX_RECOVERY_BYTES) return null;
  return value as unknown as WorkspaceRecoveryDocument;
}

export function parseRecoveryRecord(value: unknown): WorkspaceRecoveryRecord | null {
  if (!shape(value, ['revision', 'document']) || !integer(value.revision)) return null;
  const document = parseRecoveryDocument(value.document);
  return document === null ? null : { revision: value.revision, document };
}

import { Braces, Database, FileCheck2, FileSearch, Layers, PanelRight, Play, Plus, Settings, ShieldCheck, Sparkles, TriangleAlert, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionProfile } from '../../domain/connection';
import type { Preferences } from '../../domain/preferences';
import type { ExecutionState, QueryDocument, SnapshotRejection, WorkspaceState } from '../../domain/query';
import { EmptyState, IconButton, Modal } from '../../components/controls';
import type { SettingsRoute } from '../../app/routes';
import { connectionTestLabel, type ConnectionTestState } from '../connections/useConnectionTests';
import { formatQueryDsl, validateQueryDsl, type QueryDslError } from '../../domain/query-dsl';
import { desktopQueryBackend, type QueryBackend } from '../../services/ipc';
import { QueryResults } from './QueryResults';
import { ResourceSidebar } from './ResourceSidebar';
import { useQueryResources } from './useQueryResources';
import { useQueryExecutions } from './useQueryExecutions';
import '../../styles/query-live.css';

const IDLE: ExecutionState = { status: 'idle' };

/** Handed to the app command palette so its "run query" entry can reflect the real state. */
export interface QueryCommand {
  readonly run: () => void;
  readonly enabled: boolean;
  readonly reason: string;
}

interface Props {
  state: WorkspaceState;
  profiles: ConnectionProfile[];
  preferences: Preferences;
  aiOpen: boolean;
  testResults: Record<string, ConnectionTestState>;
  toggleAI: () => void;
  onSettings: (route: SettingsRoute) => void;
  updateQuery: (id: string, patch: Partial<Pick<QueryDocument, 'name' | 'index' | 'dsl' | 'resultView'>>) => void;
  selectQuery: (id: string) => void;
  addQuery: () => void;
  closeQuery: (id: string) => void;
  /** Injectable seam for tests; the default reads and executes through the desktop IPC. */
  backend?: QueryBackend;
  /** Live reads are only attempted when true; defaults to the backend's own availability. */
  canQuery?: boolean;
  /** False while the query workspace is hidden behind settings: no shortcut may run here. */
  active?: boolean;
  /** Registration seam for the app command palette; the App keeps ownership of the palette. */
  onCommandReady?: (command: QueryCommand | null) => void;
}

export function QueryWorkspace({ state, profiles, preferences, aiOpen, testResults, toggleAI, onSettings, updateQuery, selectQuery, addQuery, closeQuery, backend = desktopQueryBackend, canQuery, active = true, onCommandReady }: Props) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState<QueryDocument | null>(null);
  const [checked, setChecked] = useState<{ id: string; source: string; error: QueryDslError | null } | null>(null);
  const [formatted, setFormatted] = useState<{ id: string; before: string; after: string } | null>(null);
  const [rejection, setRejection] = useState<SnapshotRejection | null>(null);
  const lineNumbers = useRef<HTMLDivElement | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const {
    ensureIndices, refreshIndices, ensureFields, refreshFields, loadMapping, invalidateConnections,
    indicesFor, fieldsFor, mappingFor,
  } = useQueryResources(backend);
  const { entries, run, cancel, release, reconcile } = useQueryExecutions(backend);

  const query = state.queries.find((item) => item.id === state.activeQueryId) ?? state.queries[0];
  const target = query ? profiles.find((profile) => profile.id === query.connectionId) : undefined;
  const available = backend.available && (canQuery ?? true);
  const connectionId = query?.connectionId ?? null;
  const endpoint = target?.endpoint ?? null;
  const indexValue = query?.index ?? '';
  const dsl = query?.dsl ?? '';
  const entry = query ? entries[query.id] : undefined;
  const execution: ExecutionState = entry?.state ?? IDLE;
  const dslValid = useMemo(() => validateQueryDsl(dsl).ok, [dsl]);
  const endpoints = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.endpoint])), [profiles]);
  const canRun = available && target !== undefined && indexValue.trim() !== '' && dslValid && execution.status !== 'running';
  const runTitle = !available ? t('queryLive:runUnavailable')
    : target === undefined ? t('queryLive:runNeedsConnection')
      : indexValue.trim() === '' ? t('queryLive:runNeedsIndex')
        : !dslValid ? t('queryLive:runInvalidDsl')
          : execution.status === 'running' ? t('queryLive:runBusy') : t('query:run');
  const stale = query !== undefined && entry !== undefined && 'snapshot' in execution
    && (execution.snapshot.revision !== query.revision || execution.snapshot.index !== query.index);
  const endpointChanged = entry?.endpoint != null && endpoint !== null && entry.endpoint !== endpoint;

  // Dropping reads for a removed connection or a changed endpoint also stops their requests.
  useEffect(() => { invalidateConnections(endpoints); }, [endpoints, invalidateConnections]);
  // Index metadata loads once per target; settings, language and field edits never query.
  useEffect(() => {
    if (available && connectionId !== null && endpoint !== null) ensureIndices(connectionId, endpoint);
  }, [available, connectionId, endpoint, ensureIndices]);
  // Requests for a removed connection or a replaced endpoint are stopped and left cancelled.
  useEffect(() => { reconcile(endpoints); }, [endpoints, reconcile]);
  // Closed tabs forget their execution and stop the matching request.
  useEffect(() => { release(new Set(state.queries.map((item) => item.id))); }, [state.queries, release]);

  const patchQuery = useCallback((patch: Partial<Pick<QueryDocument, 'name' | 'index' | 'dsl' | 'resultView'>>) => {
    if (!query) return;
    if (patch.dsl !== undefined || patch.index !== undefined) setRejection(null);
    updateQuery(query.id, patch);
  }, [query, updateQuery]);

  const loadFields = useCallback((force: boolean) => {
    const scope = indexValue.trim();
    if (!available || connectionId === null || endpoint === null || scope === '') return;
    if (force) refreshFields(connectionId, endpoint, scope);
    else ensureFields(connectionId, endpoint, scope);
  }, [available, connectionId, endpoint, indexValue, ensureFields, refreshFields]);

  const selectIndex = useCallback((name: string) => {
    if (!query) return;
    updateQuery(query.id, { index: name });
    if (available && connectionId !== null && endpoint !== null) ensureFields(connectionId, endpoint, name);
  }, [query, available, connectionId, endpoint, updateQuery, ensureFields]);

  const runQuery = useCallback(async () => {
    if (!query || !canRun) return;
    setRejection(null);
    const error = await run(query, target?.endpoint ?? null);
    if (error) setRejection(error);
  }, [query, canRun, target, run]);

  const rejectionText = (code: SnapshotRejection['code']) => code.startsWith('dsl') ? t(`query:${code}`)
    : code === 'noConnection' ? t('queryLive:runNeedsConnection')
      : code === 'invalidIndex' ? t('queryLive:runNeedsIndex') : t('errors:unexpected');

  // The palette entry stays owned by the App; only its action and state come from here.
  const runRef = useRef<() => void>(() => {});
  useEffect(() => { runRef.current = () => { void runQuery(); }; });
  const command = useMemo<QueryCommand>(() => ({
    run: () => { if (active) runRef.current(); },
    enabled: active && canRun,
    reason: active ? runTitle : t('queryLive:runNeedsWorkspace'),
  }), [active, canRun, runTitle, t]);
  useEffect(() => {
    if (!onCommandReady) return;
    onCommandReady(command);
    return () => onCommandReady(null);
  }, [onCommandReady, command]);

  if (!query) return null;
  const currentCheck = checked?.id === query.id && checked.source === query.dsl ? checked : null;
  const canUndoFormat = formatted?.id === query.id && formatted.after === query.dsl;
  const checkDsl = () => {
    const result = validateQueryDsl(query.dsl);
    setChecked({ id: query.id, source: query.dsl, error: result.ok ? null : result.error });
  };
  const formatDsl = () => {
    const result = formatQueryDsl(query.dsl);
    if (!result.ok) {
      setChecked({ id: query.id, source: query.dsl, error: result.error });
      return;
    }
    if (result.formatted !== query.dsl) {
      setFormatted({ id: query.id, before: query.dsl, after: result.formatted });
      updateQuery(query.id, { dsl: result.formatted });
    }
    setChecked({ id: query.id, source: result.formatted, error: null });
    editor.current?.focus();
  };
  return <div className={`query-layout ${aiOpen ? 'ai-open' : ''}`}>
    <aside className="resource-sidebar">
      <div className="sidebar-heading"><span>{t('query:resources')}</span><IconButton icon={Plus} label={t('connections:add')} onClick={() => onSettings('connections')} /></div>
      <button className="resource-connection" onClick={() => onSettings('connections')}><Database size={17} />
        <span>{target?.displayName ?? t('noConnection')}</span></button>
      <div className="sidebar-status"><span className="status-dot" />{t(target ? connectionTestLabel(testResults[target.id]) : 'notConnected')}</div>
      <ResourceSidebar key={connectionId ?? 'none'} available={available} connectionId={query.connectionId} index={query.index}
        indices={indicesFor(query.connectionId, endpoint)} fields={fieldsFor(query.connectionId, endpoint, query.index.trim())}
        mappingFor={(name) => mappingFor(query.connectionId, endpoint, name)}
        onSelectIndex={selectIndex}
        onRefreshIndices={() => { if (connectionId !== null && endpoint !== null) refreshIndices(connectionId, endpoint); }}
        onLoadFields={() => loadFields(true)}
        onLoadMapping={(name) => { if (connectionId !== null && endpoint !== null) loadMapping(connectionId, endpoint, name); }} />
      <div className="resource-bottom"><span><ShieldCheck size={15} />{t('readOnly')}</span><IconButton icon={Settings} label={t('settings')} onClick={() => onSettings('general')} /></div>
    </aside>
    <main className="query-main">
      <div className="tabs-toolbar">
        <div className="query-tabs" role="tablist" aria-label={t('workspace')}>
          {state.queries.map((item, position) => <div className="query-tab" data-active={item.id === query.id} key={item.id}>
            <button role="tab" aria-selected={item.id === query.id} aria-controls="query-panel"
              tabIndex={item.id === query.id ? 0 : -1}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.nativeEvent.isComposing) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.queries.length - 1
                  : (position + (event.key === 'ArrowRight' ? 1 : -1) + state.queries.length) % state.queries.length;
                const targetQuery = state.queries[next];
                if (targetQuery) {
                  selectQuery(targetQuery.id);
                  event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }
              }}
              onClick={() => selectQuery(item.id)}><FileSearch size={15} />
              <span>{item.name || `${t('query:title')} ${position + 1}`}</span>{item.revision > 0 ? <span className="draft-dot" /> : null}</button>
            <IconButton icon={X} label={`${t('query:closeQuery')} ${position + 1}`} onClick={() => item.revision > 0 ? setClosing(item) : closeQuery(item.id)} />
          </div>)}
        </div>
        <IconButton icon={Plus} label={t('newQuery')} onClick={addQuery} />
        <IconButton icon={PanelRight} label={t('query:toggleAI')} aria-pressed={aiOpen} onClick={toggleAI} />
      </div>
      <section id="query-panel" className="query-editor-section" role="tabpanel"
        onKeyDown={(event) => {
          if (!active) return;
          if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
          if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
          if (event.currentTarget.closest('[hidden]') !== null) return;
          if (document.querySelector('[role="dialog"]')) return;
          event.preventDefault();
          if (canRun) void runQuery();
        }}>
        <div className="query-heading"><div className="query-title-block">
          <input className="query-name" aria-label={t('query:name')} value={query.name} placeholder={t('query:title')}
            onChange={(event) => patchQuery({ name: event.target.value })} maxLength={120} />
          <div className="query-breadcrumb"><Database size={13} />
            <span title={t('query:targetLocked')}>{target?.displayName ?? t(query.connectionId ? 'removedConnection' : 'noConnection')}</span>
            {target ? <span className={`environment ${target.environment}`}>{t(`connections:${target.environment}`)}</span> : null}
          </div>
        </div><span className="draft-label">{t(query.revision ? 'query:modified' : 'query:draft')}</span></div>
        {!target ? <div className="connection-empty-inline"><Database size={21} /><div><strong>{t(query.connectionId ? 'removedConnection' : 'connections:empty')}</strong>
          <span>{t(query.connectionId ? 'query:targetRemoved' : 'connections:emptyDetail')}</span></div><button className="primary" onClick={() => onSettings('connections')}><Plus size={16} />{t('connections:add')}</button></div> : null}
        <div className="editor-toolbar">
          <div className="segment" role="group" aria-label={t('query:mode')}>
            <button disabled title={t('query:visualPending')}>{t('query:visual')}</button><button aria-pressed="true">DSL</button>
          </div>
          <label className="index-input"><Layers size={15} /><input aria-label={t('query:index')} placeholder={t('query:indexPlaceholder')}
            spellCheck={false} value={query.index} onBlur={() => loadFields(false)}
            onChange={(event) => patchQuery({ index: event.target.value })} /></label>
          <IconButton icon={FileCheck2} label={t('query:validateDsl')} onClick={checkDsl} />
          <IconButton icon={Braces} label={t('query:formatDsl')} onClick={formatDsl} />
          <IconButton icon={Undo2} label={t('query:undoFormat')} disabled={!canUndoFormat} onClick={() => {
            if (!canUndoFormat || !formatted) return;
            updateQuery(query.id, { dsl: formatted.before });
            setFormatted(null); setChecked(null); editor.current?.focus();
          }} />
          <button className="primary run-button" disabled={!canRun} title={runTitle} onClick={() => void runQuery()}><Play size={14} />{t('query:run')}</button>
        </div>
        <div className="dsl-editor">
          <div className="line-numbers" ref={lineNumbers} aria-hidden="true">{query.dsl.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
          <textarea ref={editor} aria-label={t('query:dslLabel')} spellCheck={false} autoCapitalize="off" autoComplete="off"
            aria-invalid={Boolean(currentCheck?.error)} aria-describedby={currentCheck?.error ? 'dsl-diagnostic' : undefined}
            value={query.dsl} onChange={(event) => patchQuery({ dsl: event.target.value })}
            onScroll={(event) => { if (lineNumbers.current) lineNumbers.current.scrollTop = event.currentTarget.scrollTop; }}
            wrap={preferences.wrapJson ? 'soft' : 'off'} />
        </div>
        {currentCheck?.error ? <div id="dsl-diagnostic" className="notice error" role="alert">
          <span>{t(`query:${currentCheck.error.code}`)}
            {currentCheck.error.line !== undefined && currentCheck.error.column !== undefined
              ? ` ${t('query:dslPosition', { line: currentCheck.error.line, column: currentCheck.error.column })}` : null}</span>
        </div> : null}
        {rejection ? <div className="notice error" role="alert"><TriangleAlert size={16} /><span>{rejectionText(rejection.code)}</span></div> : null}
        <div className="editor-status"><span>{t('query:lines', { count: query.dsl.split('\n').length })}</span>
          <span>{t('query:chars', { count: query.dsl.length })}</span>
          {currentCheck && !currentCheck.error ? <span role="status">{t('query:dslValid')}</span> : null}
          <span className="status-spacer" /><span>JSON</span><span>UTF-8</span></div>
      </section>
      <QueryResults query={query} entry={entry} available={available} stale={stale} endpointChanged={endpointChanged}
        onCancel={() => cancel(query.id)} onRun={() => { if (canRun) void runQuery(); }}
        onViewChange={(view) => updateQuery(query.id, { resultView: view })} />
    </main>
    {aiOpen ? <aside className="ai-sidebar" aria-label={t('query:ai')}>
      <div className="sidebar-heading"><span><Sparkles size={16} />{t('query:ai')}</span><IconButton icon={X} label={t('close')} onClick={toggleAI} /></div>
      <EmptyState icon={Sparkles} title={t('query:aiEmpty')} description={t('query:aiDetail')}>
        <button className="secondary" onClick={() => onSettings('models')}><Settings size={15} />{t('query:configureAI')}</button>
      </EmptyState>
    </aside> : null}
    <Modal open={closing !== null} onClose={() => setClosing(null)} title={t('query:closeTitle')}
      description={t('query:closeDetail', { name: closing?.name || t('query:title') })}>
      <div className="dialog-actions"><button className="secondary" onClick={() => setClosing(null)}>{t('cancel')}</button>
        <button className="danger" onClick={() => { if (closing) closeQuery(closing.id); setClosing(null); }}>{t('query:discard')}</button></div>
    </Modal>
  </div>;
}

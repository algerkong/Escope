import { Braces, Database, FileCheck2, Layers, Play, Plus, Settings, ShieldCheck, TriangleAlert, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionProfile } from '../../domain/connection';
import type { AiChatBackend } from '../../domain/ai-chat';
import type { Preferences } from '../../domain/preferences';
import type { ExecutionState, QueryDocument, SnapshotRejection, WorkspaceState } from '../../domain/query';
import { IconButton, Modal } from '../../components/controls';
import { PanelResizeHandle } from '../../components/PanelResizeHandle';
import { PANEL_DEFAULTS } from '../../domain/workspace-panels';
import { DATA_PREVIEW_DSL } from '../../domain/query-pagination';
import type { SettingsRoute } from '../../app/routes';
import { connectionTestLabel, type ConnectionTestState } from '../connections/useConnectionTests';
import { formatQueryDsl, validateQueryDsl, type QueryDslError } from '../../domain/query-dsl';
import { desktopQueryBackend, type QueryBackend } from '../../services/ipc';
import { desktopModelService, type ModelService } from '../../services/models';
import { detectWindowPlatform } from '../../services/window';
import { AiChatPanel } from '../ai/AiChatPanel';
import { QueryResults } from './QueryResults';
import { DataPreview } from './DataPreview';
import { VisualQueryEditor, type VisualEditorDraft } from './VisualQueryEditor';
import { ResourceSidebar } from './ResourceSidebar';
import { useQueryResources } from './useQueryResources';
import { useQueryExecutions } from './useQueryExecutions';
import { useWorkspacePanels } from './useWorkspacePanels';
import { WorkspaceTabs, workspaceTabId } from './WorkspaceTabs';
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
  selectTab: (id: string | null) => void;
  openIndex: (connectionId: string, index: string) => { document: QueryDocument; created: boolean };
  addQuery: (source?: QueryDocument) => void;
  closeTab: (id: string) => void;
  /** Injectable seam for tests; the default reads and executes through the desktop IPC. */
  backend?: QueryBackend;
  modelService?: ModelService;
  aiBackend?: AiChatBackend;
  /** Live reads are only attempted when true; defaults to the backend's own availability. */
  canQuery?: boolean;
  /** False while the query workspace is hidden behind settings: no shortcut may run here. */
  active?: boolean;
  /** Registration seam for the app command palette; the App keeps ownership of the palette. */
  onCommandReady?: (command: QueryCommand | null) => void;
}

export function QueryWorkspace({ state, profiles, preferences, aiOpen, testResults, toggleAI, onSettings, updateQuery, selectTab, openIndex, addQuery, closeTab, backend = desktopQueryBackend, modelService = desktopModelService, aiBackend, canQuery, active = true, onCommandReady }: Props) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState<QueryDocument | null>(null);
  const [checked, setChecked] = useState<Record<string, { source: string; error: QueryDslError | null }>>({});
  const [formatted, setFormatted] = useState<Record<string, { before: string; after: string }>>({});
  const [rejections, setRejections] = useState<Record<string, SnapshotRejection | null>>({});
  const [editorModes, setEditorModes] = useState<Record<string, 'visual' | 'dsl'>>({});
  const [visualValidity, setVisualValidity] = useState<Record<string, boolean>>({});
  const [visualDrafts, setVisualDrafts] = useState<Record<string, VisualEditorDraft>>({});
  const startupView = useRef(preferences.startView);
  const [homeView, setHomeView] = useState(startupView.current);
  const lineNumbers = useRef<HTMLDivElement | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const scroll = useRef(new Map<string, { panel: number; editorTop: number; editorLeft: number }>());
  const {
    ensureIndices, refreshIndices, ensureFields, refreshFields, loadMapping, invalidateConnections,
    indicesFor, fieldsFor, mappingFor,
  } = useQueryResources(backend);
  const { entries, run, cancel, release, reconcile, loadMore } = useQueryExecutions(backend);
  const panels = useWorkspacePanels(aiOpen, active);

  const tab = state.tabs.find((item) => item.document.id === state.activeTabId);
  const home = useMemo<QueryDocument>(() => ({
    id: `home:${state.activeConnectionId ?? ''}`, connectionId: state.activeConnectionId, name: '', index: '',
    dsl: DATA_PREVIEW_DSL, revision: 0, resultView: homeView,
  }), [state.activeConnectionId, homeView]);
  const query = tab?.document ?? home;
  const queryId = query.id;
  const showingQuery = tab?.kind === 'query';
  const editorMode = editorModes[queryId] ?? 'dsl';
  const visualValid = !showingQuery || editorMode !== 'visual' || visualValidity[queryId] !== false;
  const updateVisualValidity = useCallback((valid: boolean) => {
    setVisualValidity((current) => current[queryId] === valid ? current : { ...current, [queryId]: valid });
  }, [queryId]);
  const updateVisualDraft = useCallback((draft: VisualEditorDraft) => {
    setVisualDrafts((current) => ({ ...current, [queryId]: draft }));
  }, [queryId]);
  const dirtyVisualIds = useMemo(() => new Set(Object.entries(visualDrafts)
    .filter(([, draft]) => draft.problems.length > 0).map(([id]) => id)), [visualDrafts]);
  const target = profiles.find((profile) => profile.id === query.connectionId);
  const resourceTarget = profiles.find((profile) => profile.id === state.activeConnectionId);
  const available = backend.available && (canQuery ?? true);
  const connectionId = query.connectionId;
  const endpoint = target?.endpoint ?? null;
  const resourceConnectionId = state.activeConnectionId;
  const resourceEndpoint = resourceTarget?.endpoint ?? null;
  const resourceIndex = query.connectionId === resourceConnectionId ? query.index.trim() : '';
  const indexValue = query.index;
  const dsl = query.dsl;
  const entry = entries[query.id];
  const rejection = rejections[query.id];
  const execution: ExecutionState = entry?.state ?? IDLE;
  const dslValid = useMemo(() => validateQueryDsl(dsl).ok, [dsl]);
  const endpoints = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.endpoint])), [profiles]);
  const canRun = tab !== undefined && available && target !== undefined && indexValue.trim() !== '' && dslValid && visualValid
    && execution.status !== 'running' && !entry?.continuing;
  const runTitle = !available ? t('queryLive:runUnavailable')
    : target === undefined ? t('queryLive:runNeedsConnection')
      : indexValue.trim() === '' ? t('queryLive:runNeedsIndex')
        : !dslValid ? t('queryLive:runInvalidDsl')
          : !visualValid ? t('queryLive:runInvalidVisual')
          : execution.status === 'running' || entry?.continuing ? t('queryLive:runBusy') : t('query:run');
  const stale = showingQuery && entry !== undefined && 'snapshot' in execution
    && (execution.snapshot.revision !== query.revision || execution.snapshot.index !== query.index);
  const endpointChanged = entry?.endpoint != null && endpoint !== null && entry.endpoint !== endpoint;
  const documentIds = useMemo(() => state.tabs.map((item) => item.document.id), [state.tabs]);

  useLayoutEffect(() => {
    const saved = scroll.current.get(queryId);
    if (panel.current) panel.current.scrollTop = saved?.panel ?? 0;
    if (editor.current) {
      editor.current.scrollTop = saved?.editorTop ?? 0;
      editor.current.scrollLeft = saved?.editorLeft ?? 0;
    }
    if (lineNumbers.current) lineNumbers.current.scrollTop = saved?.editorTop ?? 0;
  }, [queryId, editorMode]);

  // Dropping reads for a removed connection or a changed endpoint also stops their requests.
  useEffect(() => { invalidateConnections(endpoints); }, [endpoints, invalidateConnections]);
  // Index metadata loads once per target; settings, language and field edits never query.
  useEffect(() => {
    if (available && resourceConnectionId !== null && resourceEndpoint !== null) ensureIndices(resourceConnectionId, resourceEndpoint);
  }, [available, resourceConnectionId, resourceEndpoint, ensureIndices]);
  // Requests for a removed connection or a replaced endpoint are stopped and left cancelled.
  useEffect(() => { reconcile(endpoints); }, [endpoints, reconcile]);
  // Closed tabs forget their execution and stop the matching request.
  useEffect(() => {
    release(new Set(documentIds));
    for (const id of scroll.current.keys()) if (!documentIds.includes(id)) scroll.current.delete(id);
  }, [documentIds, release]);

  const patchQuery = useCallback((patch: Partial<Pick<QueryDocument, 'name' | 'index' | 'dsl' | 'resultView'>>) => {
    if (!showingQuery) return;
    if (patch.dsl !== undefined || patch.index !== undefined) setRejections((current) => ({ ...current, [query.id]: null }));
    updateQuery(query.id, patch);
  }, [query, showingQuery, updateQuery]);

  const loadFields = useCallback((force: boolean) => {
    const scope = indexValue.trim();
    if (!available || connectionId === null || endpoint === null || scope === '') return;
    if (force) refreshFields(connectionId, endpoint, scope);
    else ensureFields(connectionId, endpoint, scope);
  }, [available, connectionId, endpoint, indexValue, ensureFields, refreshFields]);

  const selectIndex = useCallback((name: string) => {
    if (!active || !available || resourceConnectionId === null || resourceEndpoint === null || name.trim() === '') return;
    const { document, created } = openIndex(resourceConnectionId, name.trim());
    ensureFields(resourceConnectionId, resourceEndpoint, document.index);
    if (created) void run(document, resourceEndpoint);
  }, [active, available, resourceConnectionId, resourceEndpoint, openIndex, ensureFields, run]);

  const runQuery = useCallback(async () => {
    if (!canRun || !active) return;
    setRejections((current) => ({ ...current, [query.id]: null }));
    const error = await run(query, target?.endpoint ?? null);
    if (error) setRejections((current) => ({ ...current, [query.id]: error }));
  }, [query, canRun, active, target, run]);

  const closeDocument = useCallback((id: string) => {
    const previousFocus = document.activeElement;
    cancel(id);
    closeTab(id);
    const prune = <T,>(current: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id));
    setChecked(prune);
    setFormatted(prune);
    setRejections(prune);
    setEditorModes(prune);
    setVisualValidity(prune);
    setVisualDrafts(prune);
    requestAnimationFrame(() => {
      if (previousFocus?.isConnected && previousFocus !== document.body
        && !previousFocus.closest('[role="dialog"]') && document.activeElement === previousFocus) return;
      document.querySelector<HTMLButtonElement>('.query-tab [aria-selected="true"]')?.focus();
    });
  }, [cancel, closeTab]);
  const requestClose = useCallback((id: string) => {
    const closingTab = state.tabs.find((item) => item.document.id === id);
    if (!closingTab) return;
    if (closingTab.kind === 'query' && (closingTab.document.revision > 0 || dirtyVisualIds.has(id))) setClosing(closingTab.document);
    else closeDocument(id);
  }, [state.tabs, closeDocument, dirtyVisualIds]);

  useEffect(() => {
    if (!active) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.shiftKey
        || !(event.ctrlKey || event.metaKey) || document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Enter') {
        if (!(event.target instanceof Element) || !event.target.closest('.query-main')) return;
        event.preventDefault();
        if (canRun) void runQuery();
      } else if (event.key.toLowerCase() === 'w' && available && state.activeTabId !== null) {
        if (!(event.target instanceof Element) || !event.target.closest('.query-main')) return;
        if (detectWindowPlatform() === 'macos' && !event.metaKey) return;
        event.preventDefault();
        requestClose(state.activeTabId);
      }
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [active, available, canRun, runQuery, requestClose, state.activeTabId]);

  const rejectionText = (code: SnapshotRejection['code']) => code.startsWith('dsl') ? t(`query:${code}`)
    : code === 'noConnection' ? t('queryLive:runNeedsConnection')
      : code === 'invalidIndex' ? t('queryLive:runNeedsIndex') : t('errors:unexpected');

  // The palette entry stays owned by the App; only its action and state come from here.
  const runRef = useRef<() => void>(() => {});
  useEffect(() => { runRef.current = () => { void runQuery(); }; });
  const command = useMemo<QueryCommand>(() => ({
    run: () => { if (active) runRef.current(); },
    enabled: active && canRun,
    reason: !active ? t('queryLive:runNeedsWorkspace') : tab === undefined ? t('queryLive:runNeedsTab') : runTitle,
  }), [active, tab, canRun, runTitle, t]);
  useEffect(() => {
    if (!onCommandReady) return;
    onCommandReady(command);
    return () => onCommandReady(null);
  }, [onCommandReady, command]);

  const queryFields = fieldsFor(query.connectionId, endpoint, query.index.trim());
  const currentCheck = checked[query.id]?.source === query.dsl ? checked[query.id] : null;
  const savedFormat = formatted[query.id];
  const canUndoFormat = savedFormat?.after === query.dsl;
  const checkDsl = () => {
    const result = validateQueryDsl(query.dsl);
    setChecked((current) => ({ ...current, [query.id]: { source: query.dsl, error: result.ok ? null : result.error } }));
  };
  const formatDsl = () => {
    const result = formatQueryDsl(query.dsl);
    if (!result.ok) {
      setChecked((current) => ({ ...current, [query.id]: { source: query.dsl, error: result.error } }));
      return;
    }
    if (result.formatted !== query.dsl) {
      setFormatted((current) => ({ ...current, [query.id]: { before: query.dsl, after: result.formatted } }));
      updateQuery(query.id, { dsl: result.formatted });
    }
    setChecked((current) => ({ ...current, [query.id]: { source: result.formatted, error: null } }));
    editor.current?.focus();
  };
  return <div className={`query-layout ${aiOpen ? 'ai-open' : ''}`} ref={panels.containerRef} style={panels.style}>
    <aside className="resource-sidebar" id="workspace-resources">
      <div className="sidebar-heading"><span>{t('query:resources')}</span><IconButton icon={Plus} label={t('connections:add')} onClick={() => onSettings('connections')} /></div>
      <button className="resource-connection" onClick={() => onSettings('connections')}><Database size={17} />
        <span>{resourceTarget?.displayName ?? t('noConnection')}</span></button>
      <div className="sidebar-status"><span className="status-dot" />{t(resourceTarget ? connectionTestLabel(testResults[resourceTarget.id]) : 'notConnected')}</div>
      <ResourceSidebar key={resourceConnectionId ?? 'none'} active={active} available={available} connectionId={resourceConnectionId} index={resourceIndex}
        indices={indicesFor(resourceConnectionId, resourceEndpoint)} fields={fieldsFor(resourceConnectionId, resourceEndpoint, resourceIndex.trim())}
        mappingFor={(name) => mappingFor(resourceConnectionId, resourceEndpoint, name)}
        onSelectIndex={selectIndex}
        onRefreshIndices={() => { if (resourceConnectionId !== null && resourceEndpoint !== null) refreshIndices(resourceConnectionId, resourceEndpoint); }}
        onLoadFields={() => {
          if (resourceConnectionId !== null && resourceEndpoint !== null && resourceIndex !== '') refreshFields(resourceConnectionId, resourceEndpoint, resourceIndex);
        }}
        onLoadMapping={(name) => { if (resourceConnectionId !== null && resourceEndpoint !== null) loadMapping(resourceConnectionId, resourceEndpoint, name); }} />
      <div className="resource-bottom"><span><ShieldCheck size={15} />{t('readOnly')}</span><IconButton icon={Settings} label={t('settings')} onClick={() => onSettings('general')} /></div>
    </aside>
    <PanelResizeHandle side="resources" label={t('query:resizeResources')} controls="workspace-resources"
      {...panels.layout.resources} active={active && panels.layout.resources.visible}
      onResize={(width) => panels.resize('resources', width)}
      onReset={() => panels.resize('resources', PANEL_DEFAULTS.resources)} />
    <main className="query-main">
      <WorkspaceTabs state={state} profiles={profiles} entries={entries} aiOpen={aiOpen}
        dirtyIds={dirtyVisualIds}
        onSelect={selectTab} onClose={requestClose} onAdd={() => addQuery()} onToggleAI={toggleAI} />
      <div ref={panel} id="workspace-panel" role="tabpanel" aria-labelledby={workspaceTabId(state.activeTabId)}
        className="workspace-panel" data-kind={tab?.kind ?? 'home'}
        onScroll={(event) => {
          const saved = scroll.current.get(queryId) ?? { panel: 0, editorTop: 0, editorLeft: 0 };
          scroll.current.set(queryId, { ...saved, panel: event.currentTarget.scrollTop });
        }}>
      {showingQuery ? <section className="query-editor-section">
        <div className="query-heading"><div className="query-title-block">
          <input className="query-name" aria-label={t('query:name')} value={query.name} placeholder={t('query:title')}
            onChange={(event) => patchQuery({ name: event.target.value })} maxLength={120} />
          <div className="query-breadcrumb"><Database size={13} />
            <span title={t('query:targetLocked')}>{target?.displayName ?? t(query.connectionId ? 'removedConnection' : 'noConnection')}</span>
            {target ? <span className={`environment ${target.environment}`}>{t(`connections:${target.environment}`)}</span> : null}
          </div>
        </div><span className="draft-label">{t(query.revision || dirtyVisualIds.has(queryId) ? 'query:modified' : 'query:draft')}</span></div>
        {!target ? <div className="connection-empty-inline"><Database size={21} /><div><strong>{t(query.connectionId ? 'removedConnection' : 'connections:empty')}</strong>
          <span>{t(query.connectionId ? 'query:targetRemoved' : 'connections:emptyDetail')}</span></div><button className="primary" onClick={() => onSettings('connections')}><Plus size={16} />{t('connections:add')}</button></div> : null}
        <div className="editor-toolbar">
          <div className="segment" role="group" aria-label={t('query:mode')}>
            {(['visual', 'dsl'] as const).map((mode) => <button key={mode} type="button"
              aria-pressed={editorMode === mode} onClick={() => {
                setEditorModes((current) => ({ ...current, [query.id]: mode }));
                if (mode === 'visual') loadFields(false);
              }}>{t(`query:${mode}`)}</button>)}
          </div>
          <label className="index-input"><Layers size={15} /><input aria-label={t('query:index')} placeholder={t('query:indexPlaceholder')}
            spellCheck={false} value={query.index} onBlur={() => loadFields(false)}
            onChange={(event) => patchQuery({ index: event.target.value })} /></label>
          <IconButton icon={FileCheck2} label={t('query:validateDsl')} onClick={checkDsl} />
          <IconButton icon={Braces} label={t('query:formatDsl')} onClick={formatDsl} />
          <IconButton icon={Undo2} label={t('query:undoFormat')} disabled={!canUndoFormat} onClick={() => {
            if (!canUndoFormat || !savedFormat) return;
            updateQuery(query.id, { dsl: savedFormat.before });
            setFormatted((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== queryId)));
            setChecked((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== queryId)));
            editor.current?.focus();
          }} />
          <button className="primary run-button" disabled={!canRun} title={runTitle} onClick={() => void runQuery()}><Play size={14} />{t('query:run')}</button>
        </div>
        <div hidden={editorMode !== 'visual'}>
          {editorModes[query.id] !== undefined ? <VisualQueryEditor key={query.id} rawDsl={query.dsl}
            fields={queryFields.status === 'ready' ? queryFields.data.fields : []}
            draft={visualDrafts[queryId]} onDraftChange={updateVisualDraft}
            onChange={(dsl) => patchQuery({ dsl })} onValidityChange={updateVisualValidity} /> : null}
        </div>
        <div className="dsl-editor" hidden={editorMode !== 'dsl'}>
          <div className="line-numbers" ref={lineNumbers} aria-hidden="true">{query.dsl.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
          <textarea ref={editor} aria-label={t('query:dslLabel')} spellCheck={false} autoCapitalize="off" autoComplete="off"
            aria-invalid={Boolean(currentCheck?.error)} aria-describedby={currentCheck?.error ? 'dsl-diagnostic' : undefined}
            value={query.dsl} onChange={(event) => patchQuery({ dsl: event.target.value })}
            onScroll={(event) => {
              const { scrollTop, scrollLeft } = event.currentTarget;
              if (lineNumbers.current) lineNumbers.current.scrollTop = scrollTop;
              const saved = scroll.current.get(queryId) ?? { panel: 0, editorTop: 0, editorLeft: 0 };
              scroll.current.set(queryId, { ...saved, editorTop: scrollTop, editorLeft: scrollLeft });
            }}
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
      </section> : null}
      <QueryResults kind={showingQuery ? 'query' : 'preview'} query={query} entry={entry}
        available={available} stale={stale} endpointChanged={endpointChanged} documentIds={documentIds} active={active} wrapJson={preferences.wrapJson}
        canRun={canRun} grouping={preferences.grouping}
        renderToolbar={showingQuery ? undefined : (summary, controls) => <DataPreview document={query} target={target} available={available}
          locked={tab?.kind === 'index'} busy={execution.status === 'running' || Boolean(entry?.continuing)} summary={summary}
          onOpen={selectIndex} onRefresh={() => { void runQuery(); }} onNewQuery={() => addQuery(query)}
          onConnections={() => onSettings('connections')}>{controls}</DataPreview>}
        onCancel={() => cancel(query.id)} onRun={() => { if (canRun) void runQuery(); }}
        onViewChange={(view) => tab ? updateQuery(query.id, { resultView: view }) : setHomeView(view)}
        onLoadMore={() => { void loadMore(query); }} />
      </div>
    </main>
    <PanelResizeHandle side="ai" label={t('query:resizeAI')} controls="workspace-ai"
      {...panels.layout.ai} active={active && aiOpen}
      onResize={(width) => panels.resize('ai', width)}
      onReset={() => panels.resize('ai', PANEL_DEFAULTS.ai)} />
    <AiChatPanel modelService={modelService} backend={aiBackend} open={aiOpen} active={active} query={showingQuery ? query : null}
      onClose={toggleAI} onSettings={() => onSettings('models')} />
    <Modal open={closing !== null} onClose={() => setClosing(null)} title={t('query:closeTitle')}
      description={t('query:closeDetail', { name: closing?.name || t('query:title') })}>
      <div className="dialog-actions"><button className="secondary" onClick={() => setClosing(null)}>{t('cancel')}</button>
        <button className="danger" onClick={() => { if (closing) closeDocument(closing.id); setClosing(null); }}>{t('query:discard')}</button></div>
    </Modal>
  </div>;
}

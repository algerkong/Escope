import { Bookmark, Braces, ChartColumnBig, Clock3, Database, FileCheck2, FileDown, History, Layers, ListOrdered, ListTree, LoaderCircle, Pin, Play, Plus, Redo2, Save, Search, Settings, ShieldCheck, Sigma, Star, TriangleAlert, Undo2, Variable } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionProfile } from '../../domain/connection';
import type { AiChatBackend } from '../../domain/ai-chat';
import type { Preferences } from '../../domain/preferences';
import { createQuery, matchesQueryDraft, updateWorkspaceDocument, type ExecutionState, type QueryDocument, type QueryDocumentPatch, type SnapshotRejection, type WorkspaceState } from '../../domain/query';
import { selectDataView } from '../../domain/data-views';
import { IconButton, Modal } from '../../components/controls';
import { PanelResizeHandle } from '../../components/PanelResizeHandle';
import { ResultsResizeHandle } from '../../components/ResultsResizeHandle';
import { PANEL_DEFAULTS } from '../../domain/workspace-panels';
import { DATA_PREVIEW_DSL } from '../../domain/query-pagination';
import type { SettingsRoute } from '../../app/routes';
import { connectionTestLabel, type ConnectionTestState } from '../connections/useConnectionTests';
import { formatQueryDsl, validateQueryDsl, type QueryDslError } from '../../domain/query-dsl';
import { documentFromEntry, type SavedQueryEntry } from '../../domain/query-library';
import { desktopQueryBackend, type QueryBackend } from '../../services/ipc';
import { defaultQueryLibraryService, type QueryLibraryService } from '../../services/query-library';
import { desktopSnapshotExportService, type SnapshotExportService } from '../../services/query-export';
import type { SnapshotExportSource } from '../../domain/query-export';
import { desktopModelService, type ModelService } from '../../services/models';
import { detectWindowPlatform } from '../../services/window';
import { AiChatPanel } from '../ai/AiChatPanel';
import { QueryLibraryDialog, SaveDraftDialog, useQueryLibrary, type SaveDraftResult } from './QueryLibrary';
import { QueryParametersDialog } from './QueryParametersDialog';
import { RuntimeFieldsDialog } from './RuntimeFieldsDialog';
import { QueryTimeRangeDialog, TimeRangeSummary } from './QueryTimeRangeDialog';
import { QueryFilterBindingBar, QueryFilterDraftBar, QueryFiltersDialog } from './QueryFiltersDialog';
import { QuerySortDialog } from './QuerySortDialog';
import { QueryAggregationBuildDialog } from './QueryAggregationBuildDialog';
import { ChartDefinitionsDialog } from './ChartDefinitionsDialog';
import { ChartDefinitionExchangeDialog } from './ChartDefinitionExchangeDialog';
import { createChartDefinitionExchangeService, type ChartDefinitionExchangeService } from '../../services/chart-definition-exchange';
import { freezeChartDefinitionSelection, selectChartDefinition } from '../../domain/chart-definitions';
import { queryFilterEnabled, type CellFilterSelection, type QueryFilterBinding, type QueryFilterDraft } from '../../domain/query-filters';
import { bindAppliedQueryFilters, hasPendingQueryFilters, matchesQueryFilterBinding, previewQueryFilterDraft, queryFilterDraftChanged } from '../../domain/query-filter-session';
import { parseNestedFilterMapping } from '../../domain/query-filter-mapping';
import { copyQueryTimeRange, validTimeRangeZone } from '../../domain/query-time-range';
import type { FieldCatalog } from '../../domain/resource';
import { QueryExchangeDialog } from './QueryExchangeDialog';
import { createQueryExchangeService, type QueryExchangeService } from '../../services/query-exchange';
import { QueryResults } from './QueryResults';
import { SnapshotExportDialog, type SnapshotExportTaskState } from './SnapshotExportDialog';
import { DataPreview } from './DataPreview';
import { VisualQueryEditor, type VisualEditorDraft } from './VisualQueryEditor';
import { ResourceSidebar } from './ResourceSidebar';
import { useQueryResources } from './useQueryResources';
import { useQueryExecutions } from './useQueryExecutions';
import { useWorkspacePanels } from './useWorkspacePanels';
import { WorkspaceTabs, workspaceTabId } from './WorkspaceTabs';
import { ExecutionHistoryDialog, WorkspaceRecoveryStatus } from './WorkspaceRecovery';
import type { WorkspaceRecoveryController } from './useWorkspaceRecovery';
import { createDataViewService, type DataViewService } from '../../services/data-views';
import { useDataViews } from './useDataViews';
import { DataViewsDialog, DataViewTarget } from './DataViews';
import { createPinnedFilterService, type PinnedFilterService } from '../../services/pinned-filters';
import { draftFromPinnedFilters, samePinnedFilter } from '../../domain/pinned-filters';
import { usePinnedFilters } from './usePinnedFilters';
import { useChartDefinitions } from './useChartDefinitions';
import { createChartDefinitionService, type ChartDefinitionService } from '../../services/chart-definitions';
import type { ChartDefinitionSelection } from '../../domain/chart-definitions';
import { PinFiltersDialog, PinnedFiltersDialog } from './PinnedFiltersDialog';
import { createSavedChartService, type SavedChartService } from '../../services/saved-charts';
import { useSavedCharts } from './useSavedCharts';
import { SavedChartsDialog } from './SavedChartsDialog';
import { legacyChartDefinition } from '../../domain/chart-definition-sources';
import { QueryDslEditor, type QueryDslEditorHandle, type QueryEditorHistory } from './editor/QueryDslEditor';
import { QueryEditorModels } from './editor/query-editor-models';
import type { QueryCompletionContext } from '../../domain/query-completions';
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
  updateQuery: (id: string, patch: QueryDocumentPatch, expected?: QueryDocument) => boolean | void;
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
  /** Injectable seam for the local query library and loaded-result export. */
  libraryService?: QueryLibraryService;
  snapshotExportService?: SnapshotExportService;
  exchangeService?: QueryExchangeService;
  /** Restore a saved query as a new tab; the App owns tab creation and never auto-executes it. */
  restoreQuery?: (document: QueryDocument) => void;
  recovery?: WorkspaceRecoveryController;
  dataViewService?: DataViewService;
  pinnedFilterService?: PinnedFilterService;
  savedChartService?: SavedChartService;
  chartDefinitionService?: ChartDefinitionService;
  chartExchangeService?: ChartDefinitionExchangeService;
}

export function QueryWorkspace({ state, profiles, preferences, aiOpen, testResults, toggleAI, onSettings, updateQuery, selectTab, openIndex, addQuery, closeTab, backend = desktopQueryBackend, modelService = desktopModelService, aiBackend, canQuery, active = true, onCommandReady, libraryService = defaultQueryLibraryService, snapshotExportService = desktopSnapshotExportService, exchangeService: suppliedExchangeService, restoreQuery, recovery, dataViewService: suppliedDataViewService, pinnedFilterService: suppliedPinnedFilterService,
  savedChartService: suppliedSavedChartService, chartDefinitionService: suppliedChartDefinitionService, chartExchangeService: suppliedChartExchangeService }: Props) {
  const { t } = useTranslation();
  const effectiveSavedChartService = useMemo(() => suppliedSavedChartService ?? createSavedChartService(), [suppliedSavedChartService]);
  const savedCharts = useSavedCharts(effectiveSavedChartService);
  const [chartsOpen, setChartsOpen] = useState(false);
  const [closing, setClosing] = useState<QueryDocument | null>(null);
  const [checked, setChecked] = useState<Record<string, { source: string; error: QueryDslError | null }>>({});
  const [editorHistory, setEditorHistory] = useState<QueryEditorHistory | null>(null);
  const [editorModels] = useState(() => new QueryEditorModels());
  const [rejections, setRejections] = useState<Record<string, SnapshotRejection | null>>({});
  const [editorModes, setEditorModes] = useState<Record<string, 'visual' | 'dsl'>>({});
  const [visualValidity, setVisualValidity] = useState<Record<string, boolean>>({});
  const [visualDrafts, setVisualDrafts] = useState<Record<string, VisualEditorDraft>>({});
  const startupView = useRef(preferences.startView);
  const [homeView, setHomeView] = useState(startupView.current);
  const [resultsMaximized, setResultsMaximized] = useState(false);
  const [resultsHeight, setResultsHeight] = useState<number | null>(null);
  const editor = useRef<QueryDslEditorHandle | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const scroll = useRef(new Map<string, number>());
  const {
    ensureIndices, refreshIndices, ensureFields, refreshFields, loadMapping, invalidateConnections,
    indicesFor, fieldsFor, mappingFor,
  } = useQueryResources(backend);
  const { entries, run, cancel, release, reconcile, loadMore } = useQueryExecutions(backend, recovery?.onHistory);
  const panels = useWorkspacePanels(aiOpen, active);
  const library = useQueryLibrary(libraryService);
  const dataViewService = useMemo(() => suppliedDataViewService ?? createDataViewService(), [suppliedDataViewService]);
  const dataViews = useDataViews(dataViewService);
  const [dataViewsOpen, setDataViewsOpen] = useState(false);
  const chartDefinitionService = useMemo(() => suppliedChartDefinitionService ?? createChartDefinitionService(), [suppliedChartDefinitionService]);
  const chartDefinitions = useChartDefinitions(chartDefinitionService);
  const chartExchangeService = useMemo(() => suppliedChartExchangeService ?? createChartDefinitionExchangeService(chartDefinitionService),
    [suppliedChartExchangeService, chartDefinitionService]);
  const [chartExchangeMode, setChartExchangeMode] = useState<'import' | 'export' | null>(null);
  const pinnedFilterService = useMemo(() => suppliedPinnedFilterService ?? createPinnedFilterService(), [suppliedPinnedFilterService]);
  const pinnedFilters = usePinnedFilters(pinnedFilterService);
  const [pinnedOpen, setPinnedOpen] = useState<{ source: QueryDocument | null; endpoint: string | null } | null>(null);
  const [pinning, setPinning] = useState<QueryFilterDraft | null>(null);
  const exchangeService = useMemo(() => suppliedExchangeService ?? createQueryExchangeService(libraryService), [suppliedExchangeService, libraryService]);
  const [exchangeMode, setExchangeMode] = useState<'import' | 'export' | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveDraftOpen, setSaveDraftOpen] = useState(false);
  const [parameterSource, setParameterSource] = useState<QueryDocument | null>(null);
  const [runtimeSource, setRuntimeSource] = useState<{ query: QueryDocument; endpoint: string; catalog?: FieldCatalog } | null>(null);
  const [timeSource, setTimeSource] = useState<{ query: QueryDocument; endpoint: string; catalog?: FieldCatalog; initialTimeZone: string } | null>(null);
  const [sortSource, setSortSource] = useState<{ query: QueryDocument; endpoint: string } | null>(null);
  const [buildSource, setBuildSource] = useState<{ query: QueryDocument; endpoint: string; seed?: ChartDefinitionSelection } | null>(null);
  const [chartDefinitionsOpen, setChartDefinitionsOpen] = useState(false);
  const [filterDrafts, setFilterDrafts] = useState<Record<string, QueryFilterDraft>>({});
  const [filterBindings, setFilterBindings] = useState<Record<string, QueryFilterBinding>>({});
  const [filterDetach, setFilterDetach] = useState<QueryFilterBinding | null>(null);
  const [filterDialog, setFilterDialog] = useState<{
    queryId: string; instanceId: string; executionId: string | null; selection?: CellFilterSelection; nested?: boolean;
  } | null>(null);
  const [savedEntryIds, setSavedEntryIds] = useState<Record<string, string>>({});
  const [exportSource, setExportSource] = useState<SnapshotExportSource | null>(null);
  const [exportVisible, setExportVisible] = useState(false);
  const [exportTaskState, setExportTaskState] = useState<SnapshotExportTaskState>('idle');

  const tab = state.tabs.find((item) => item.document.id === state.activeTabId);
  const home = useMemo<QueryDocument>(() => ({
    id: `home:${state.activeConnectionId ?? ''}`, connectionId: state.activeConnectionId, name: '', index: '',
    dsl: DATA_PREVIEW_DSL, revision: 0, resultView: homeView,
  }), [state.activeConnectionId, homeView]);
  const query = tab?.document ?? home;
  const queryId = query.id;
  const hasPendingFilters = hasPendingQueryFilters(filterDrafts[queryId]);
  const reviewingSort = sortSource?.query.id === queryId;
  const reviewingBuild = buildSource?.query.id === queryId;
  const showingQuery = tab?.kind === 'query';
  const expandedResults = showingQuery && resultsMaximized;
  const recoveryTab = recovery?.workspace.tabs.find((item) => item.document.id === queryId);
  const editorMode = recoveryTab?.editorMode ?? editorModes[queryId] ?? 'dsl';
  const visualDraft = recoveryTab?.visualDraft ?? visualDrafts[queryId];
  const visualValid = !showingQuery || editorMode !== 'visual'
    || (visualValidity[queryId] !== false && (visualDraft?.problems.length ?? 0) === 0);
  const updateVisualValidity = useCallback((valid: boolean) => {
    setVisualValidity((current) => current[queryId] === valid ? current : { ...current, [queryId]: valid });
  }, [queryId]);
  const updateVisualDraft = useCallback((draft: VisualEditorDraft) => {
    if (recovery) recovery.setVisualDraft(queryId, draft);
    else setVisualDrafts((current) => ({ ...current, [queryId]: draft }));
  }, [queryId, recovery]);
  const dirtyVisualIds = useMemo(() => new Set(recovery
    ? recovery.workspace.tabs.filter((tab) => (tab.visualDraft?.problems.length ?? 0) > 0).map((tab) => tab.document.id)
    : Object.entries(visualDrafts).filter(([, draft]) => draft.problems.length > 0).map(([id]) => id)), [visualDrafts, recovery]);
  const dirtyDraftIds = useMemo(() => new Set([...dirtyVisualIds, ...Object.keys(filterBindings),
    ...Object.entries(filterDrafts).filter(([, draft]) => hasPendingQueryFilters(draft)).map(([id]) => id)]), [dirtyVisualIds, filterDrafts, filterBindings]);
  // In visual mode an invalid/unsupported draft means the displayed DSL is stale behind it; saving
  // then would silently persist the old text, so the draft actions are disabled until it is fixed
  // or the editor is switched back to JSON, where the raw text is the source of truth.
  const saveBlockedByVisual = showingQuery && editorMode === 'visual' && (!visualValid || dirtyVisualIds.has(queryId));
  const canSaveDraft = showingQuery && !saveBlockedByVisual && !hasPendingFilters && !reviewingSort && !reviewingBuild;
  const target = profiles.find((profile) => profile.id === query.connectionId);
  const resourceTarget = profiles.find((profile) => profile.id === state.activeConnectionId);
  const available = backend.available && (canQuery ?? true);
  const restoring = recovery?.status === 'loading';
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
  const canRun = !restoring && tab !== undefined && available && target !== undefined && indexValue.trim() !== '' && dslValid && visualValid
    && execution.status !== 'running' && !entry?.continuing && !hasPendingFilters && !reviewingSort && !reviewingBuild;
  const runTitle = restoring ? t('workspaceRecovery:loading') : !available ? t('queryLive:runUnavailable')
    : target === undefined ? t('queryLive:runNeedsConnection')
      : indexValue.trim() === '' ? t('queryLive:runNeedsIndex')
        : !dslValid ? t('queryLive:runInvalidDsl')
          : !visualValid ? t('queryLive:runInvalidVisual')
          : hasPendingFilters ? t('queryFilters:pendingAction')
          : reviewingSort ? t('querySort:reviewOpen')
          : reviewingBuild ? t('queryAggregationBuild:reviewOpen')
          : execution.status === 'running' || entry?.continuing ? t('queryLive:runBusy') : t('query:run');
  const stale = showingQuery && entry !== undefined && 'snapshot' in execution
    && (execution.snapshot.revision !== query.revision || execution.snapshot.index !== query.index);
  const endpointChanged = entry?.endpoint != null && endpoint !== null && entry.endpoint !== endpoint;
  const documentIds = useMemo(() => state.tabs.map((item) => item.document.id), [state.tabs]);

  useLayoutEffect(() => {
    if (panel.current) panel.current.scrollTop = scroll.current.get(queryId) ?? 0;
  }, [queryId, editorMode]);
  useEffect(() => () => editorModels.dispose(), [editorModels]);
  useEffect(() => {
    editorModels.retain(state.tabs.filter((item) => item.kind === 'query').map((item) => item.document.id));
  }, [editorModels, state.tabs]);

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
    setFilterDrafts((current) => {
      const kept = Object.entries(current).filter(([id]) => documentIds.includes(id));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
    setFilterBindings((current) => {
      const kept = Object.entries(current).filter(([id]) => documentIds.includes(id));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
    setFilterDetach((current) => current && !documentIds.includes(current.applied.id) ? null : current);
    setFilterDialog((current) => current && !documentIds.includes(current.queryId) ? null : current);
    setSortSource((current) => current && !documentIds.includes(current.query.id) ? null : current);
    setBuildSource((current) => current && !documentIds.includes(current.query.id) ? null : current);
  }, [documentIds, release]);

  const patchQuery = useCallback((patch: QueryDocumentPatch) => {
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
    if (!active || !available || restoring || resourceConnectionId === null || resourceEndpoint === null || name.trim() === '') return;
    const { document, created } = openIndex(resourceConnectionId, name.trim());
    ensureFields(resourceConnectionId, resourceEndpoint, document.index);
    if (created) void run(document, resourceEndpoint, 'index');
  }, [active, available, restoring, resourceConnectionId, resourceEndpoint, openIndex, ensureFields, run]);

  const runQuery = useCallback(async () => {
    if (!canRun || !active) return;
    setRejections((current) => ({ ...current, [query.id]: null }));
    const error = await run(query, target?.endpoint ?? null, tab?.kind);
    if (error) setRejections((current) => ({ ...current, [query.id]: error }));
  }, [query, canRun, active, target, tab?.kind, run]);

  const linkedEntryId = savedEntryIds[query.id];
  const linkedEntry = linkedEntryId === undefined ? null
    : library.entries.find((entry) => entry.id === linkedEntryId) ?? null;

  // The App callback opens a new query from the entry (it keeps the freshly minted document.id).
  // Without it there is no safe restore path: copying the entry into the current tab would keep
  // this tab's connection while the draft was saved against another one, so the library disables
  // restore instead. The link is recorded before restoring, so re-saving updates the entry.
  const restoreSaved = useCallback((entry: SavedQueryEntry) => {
    if (!restoreQuery) return;
    const document = documentFromEntry(entry);
    setSavedEntryIds((current) => ({ ...current, [document.id]: entry.id }));
    setLibraryOpen(false);
    restoreQuery(document);
  }, [restoreQuery]);

  const saveDraftValues = useCallback((values: { name: string; favorite: boolean }): SaveDraftResult => {
    const result = library.saveDraft(query, { name: values.name, favorite: values.favorite, entryId: linkedEntryId });
    if (result.ok) setSavedEntryIds((current) => ({ ...current, [query.id]: result.entryId }));
    return result;
  }, [library, query, linkedEntryId]);

  const toggleSavedFavorite = useCallback((entry: SavedQueryEntry) => {
    library.setFavorite(entry.id, !entry.favorite);
  }, [library]);

  const closeDocument = useCallback((id: string) => {
    const previousFocus = document.activeElement;
    cancel(id);
    closeTab(id);
    const prune = <T,>(current: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id));
    setChecked(prune);
    setRejections(prune);
    setEditorModes(prune);
    setVisualValidity(prune);
    setVisualDrafts(prune);
    setSavedEntryIds(prune);
    setFilterDrafts(prune);
    setFilterBindings(prune);
    requestAnimationFrame(() => {
      if (previousFocus?.isConnected && previousFocus !== document.body
        && !previousFocus.closest('[role="dialog"]') && document.activeElement === previousFocus) return;
      document.querySelector<HTMLButtonElement>('.query-tab [aria-selected="true"]')?.focus();
    });
  }, [cancel, closeTab]);
  const requestClose = useCallback((id: string) => {
    const closingTab = state.tabs.find((item) => item.document.id === id);
    if (!closingTab) return;
    if ((closingTab.kind === 'query' && closingTab.document.revision > 0) || dirtyDraftIds.has(id)) {
      setClosing(closingTab.kind === 'index' ? { ...closingTab.document, name: closingTab.document.index } : closingTab.document);
    } else closeDocument(id);
  }, [state.tabs, closeDocument, dirtyDraftIds]);

  useEffect(() => {
    if (!active) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey
        || !(event.ctrlKey || event.metaKey) || document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Enter') {
        if (!(event.target instanceof Element) || !event.target.closest('.query-main')) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && canRun) void runQuery();
      } else if (event.key.toLowerCase() === 'w' && available && state.activeTabId !== null) {
        if (!(event.target instanceof Element) || !event.target.closest('.query-main')) return;
        if (detectWindowPlatform() === 'macos' && !event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) requestClose(state.activeTabId);
      }
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  }, [active, available, canRun, runQuery, requestClose, state.activeTabId]);

  const rejectionText = (code: SnapshotRejection['code']) => code.startsWith('dsl') ? t(`query:${code}`)
    : code === 'noConnection' ? t('queryLive:runNeedsConnection')
      : code === 'invalidIndex' ? t('queryLive:runNeedsIndex')
        : code === 'invalidDataView' ? t('dataViews:invalidSelection')
          : code === 'invalidTimeRange' ? t('timeRange:invalidBinding') : t('errors:unexpected');

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
  const completions = useMemo<QueryCompletionContext>(() => {
    const target = connectionId !== null && endpoint !== null && indexValue.trim() !== ''
      ? { connectionId, endpoint, index: indexValue.trim() } : null;
    return { target, parameters: query.parameters,
      ...(target && queryFields.status === 'ready' && !queryFields.refreshing && !queryFields.refreshError
        ? { fields: { target, catalog: queryFields.data } } : {}) };
  }, [connectionId, endpoint, indexValue, queryFields, query.parameters]);
  const sortTab = sortSource ? state.tabs.find((item) => item.kind === 'query' && item.document.id === sortSource.query.id) : undefined;
  const sortTargetCurrent = sortSource !== null && !restoring && active && !saveBlockedByVisual && !hasPendingFilters
    && state.activeTabId === sortSource.query.id
    && profiles.some((profile) => profile.id === sortSource.query.connectionId && profile.endpoint === sortSource.endpoint);
  const buildTab = buildSource ? state.tabs.find((item) => item.kind === 'query' && item.document.id === buildSource.query.id) : undefined;
  const buildTargetCurrent = buildSource !== null && !restoring && active && !saveBlockedByVisual && !hasPendingFilters
    && state.activeTabId === buildSource.query.id
    && profiles.some((profile) => profile.id === buildSource.query.connectionId && profile.endpoint === buildSource.endpoint);
  const pendingFilters = filterDrafts[query.id];
  const boundFilters = filterBindings[query.id];
  const reviewedFilters = filterDialog ? filterDrafts[filterDialog.queryId] : undefined;
  const filterTab = reviewedFilters ? state.tabs.find((item) => item.document.id === reviewedFilters.source.id) : undefined;
  const filterExecution = reviewedFilters ? entries[reviewedFilters.source.id]?.state : undefined;
  const filterTargetCurrent = reviewedFilters !== undefined && !restoring && active && !saveBlockedByVisual && state.activeTabId === reviewedFilters.source.id
    && profiles.some((profile) => profile.id === reviewedFilters.source.connectionId && profile.endpoint === reviewedFilters.endpoint)
    && (reviewedFilters.binding || reviewedFilters.snapshot === null
      ? filterExecution?.status !== 'running'
        && (filterExecution && 'snapshot' in filterExecution ? filterExecution.snapshot.requestId : null) === filterDialog?.executionId
      : (filterExecution?.status === 'success' || filterExecution?.status === 'partial')
        && filterExecution.snapshot.requestId === reviewedFilters.snapshot?.requestId);
  const pinnedTargetCurrent = pinnedOpen?.source !== null && pinnedOpen?.source !== undefined && !restoring && active
    && !saveBlockedByVisual && !hasPendingFilters && !boundFilters && !reviewingSort && !reviewingBuild
    && state.activeTabId === pinnedOpen.source.id && matchesQueryDraft(query, pinnedOpen.source)
    && profiles.some((profile) => profile.id === pinnedOpen.source?.connectionId && profile.endpoint === pinnedOpen.endpoint)
    && execution.status !== 'running' && !entry?.continuing && (showingQuery || tab?.kind === 'index' && restoreQuery !== undefined);
  const discardFilters = (id: string) => {
    setFilterDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    setFilterDialog((current) => current?.queryId === id ? null : current);
  };
  const canFilterCell = available && active && !restoring && !saveBlockedByVisual && target !== undefined && !endpointChanged
    && Boolean(entry?.endpoint) && (execution.status === 'success' || execution.status === 'partial')
    && (showingQuery || tab?.kind === 'index' && restoreQuery !== undefined);
  const reviewFilters = (selection?: CellFilterSelection, nested = false) => {
    const snapshot = execution.status === 'success' || execution.status === 'partial' ? execution.snapshot : pendingFilters?.snapshot ?? boundFilters?.snapshot ?? null;
    if (!active || restoring || !snapshot && !pendingFilters && !boundFilters) return;
    const draft: QueryFilterDraft = hasPendingQueryFilters(pendingFilters)
      ? pendingFilters!.snapshot === null && snapshot && (selection || nested) && matchesQueryDraft(query, pendingFilters!.source)
        ? { ...pendingFilters!, snapshot } : pendingFilters!
      : boundFilters ? { source: structuredClone(query), snapshot, endpoint: boundFilters.endpoint,
        filters: structuredClone(boundFilters.filters), composition: structuredClone(boundFilters.composition), binding: boundFilters }
        : { source: structuredClone(query), snapshot, endpoint: entry?.endpoint ?? '', filters: [] };
    setFilterDrafts((current) => ({ ...current, [query.id]: draft }));
    setFilterDialog({ queryId: query.id, instanceId: crypto.randomUUID(),
      executionId: 'snapshot' in execution ? execution.snapshot.requestId : null, selection, nested });
  };
  const openCellFilter = (selection?: CellFilterSelection, nested = false) => {
    if (!canFilterCell || !entry?.endpoint || execution.status !== 'success' && execution.status !== 'partial') return;
    reviewFilters(selection, nested);
  };
  const currentCheck = checked[query.id]?.source === query.dsl ? checked[query.id] : null;
  const editorReady = editorHistory?.id === query.id && active && editorMode === 'dsl' && !restoring;
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
      <ResourceSidebar key={JSON.stringify([resourceConnectionId, resourceEndpoint])} active={active} available={available}
        connectionId={resourceConnectionId} endpoint={resourceEndpoint} index={resourceIndex}
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
        dirtyIds={dirtyDraftIds}
        onSelect={selectTab} onClose={requestClose} onAdd={() => addQuery()} onToggleAI={toggleAI} />
      <div className="workspace-recovery-bar">
        {recovery ? <WorkspaceRecoveryStatus recovery={recovery} /> : null}
        <div className="workspace-recovery-actions">
          {exportSource ? <IconButton icon={exportTaskState === 'running' ? LoaderCircle
            : exportTaskState === 'saved' ? FileCheck2 : exportTaskState === 'error' || exportTaskState === 'incomplete' ? TriangleAlert : FileDown}
            label={t('queryExport:task')} className="qexport-task" data-state={exportTaskState}
            title={`${exportSource.index}: ${t(exportTaskState === 'saved' ? 'queryExport:saved'
              : exportTaskState === 'error' || exportTaskState === 'incomplete' ? 'queryExport:incompleteTask' : 'queryExport:task')}`}
            onClick={() => setExportVisible(true)} /> : null}
          <IconButton icon={Layers} label={t('dataViews:manage')} onClick={() => setDataViewsOpen(true)} />
          <IconButton icon={Pin} label={t('pinnedFilters:title')} onClick={() =>
            setPinnedOpen({ source: tab ? structuredClone(query) : null, endpoint })} />
          <IconButton icon={Bookmark} label={t('queryLibrary:open')} onClick={() => setLibraryOpen(true)} />
          {recovery ? <IconButton icon={History} label={t('queryHistory:open')} onClick={() => setHistoryOpen(true)} /> : null}
        </div>
      </div>
      <div ref={panel} id="workspace-panel" role="tabpanel" aria-labelledby={workspaceTabId(state.activeTabId)}
        className="workspace-panel" data-kind={tab?.kind ?? 'home'}
        data-results-maximized={showingQuery && resultsMaximized}
        data-results-resized={showingQuery && !resultsMaximized && resultsHeight !== null}
        style={{
          ...(showingQuery && !resultsMaximized && resultsHeight
            ? ({
                '--results-height': `${resultsHeight}px`,
                '--results-flex': `0 0 ${resultsHeight}px`,
              } as CSSProperties)
            : {}),
        }}
        onScroll={(event) => {
          scroll.current.set(queryId, event.currentTarget.scrollTop);
        }}>
      {showingQuery && !resultsMaximized ? <section className="query-editor-section">
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
                if (recovery) recovery.setEditorMode(query.id, mode);
                else setEditorModes((current) => ({ ...current, [query.id]: mode }));
                if (mode === 'visual') loadFields(false);
              }}>{t(`query:${mode}`)}</button>)}
          </div>
          <label className="index-input"><Layers size={15} /><input aria-label={t('query:index')} placeholder={t('query:indexPlaceholder')}
            spellCheck={false} value={query.index} onBlur={() => loadFields(false)}
            onChange={(event) => patchQuery({ index: event.target.value })} /></label>
          <IconButton icon={FileCheck2} label={t('query:validateDsl')} onClick={checkDsl} />
          <IconButton icon={Braces} label={t('query:formatDsl')} disabled={!editorReady} onClick={formatDsl} />
          <IconButton icon={Undo2} label={t('query:undoDsl')} disabled={!editorReady || !editorHistory?.canUndo} onClick={() => editor.current?.undo()} />
          <IconButton icon={Redo2} label={t('query:redoDsl')} disabled={!editorReady || !editorHistory?.canRedo} onClick={() => editor.current?.redo()} />
          <IconButton icon={Search} label={t('query:findDsl')} disabled={!editorReady} onClick={() => editor.current?.find()} />
          <IconButton icon={ListTree} label={t('query:suggestDsl')} disabled={!editorReady} onClick={() => editor.current?.suggest()} />
          <IconButton icon={Save} label={t('queryLibrary:saveDraft')} disabled={!canSaveDraft}
            title={saveBlockedByVisual ? t('queryLibrary:saveBlockedVisual') : hasPendingFilters ? t('queryFilters:pendingAction')
              : reviewingSort ? t('querySort:reviewOpen') : t('queryLibrary:saveDraft')}
            onClick={() => setSaveDraftOpen(true)} />
          <IconButton icon={Variable} label={t('queryParameters:open')} disabled={saveBlockedByVisual || restoring}
            onClick={() => setParameterSource(query)} />
          <IconButton icon={Clock3} label={t('timeRange:open')} disabled={saveBlockedByVisual || restoring || !target || !active || !query.index.trim()}
            onClick={() => {
              if (!target || !active || restoring || saveBlockedByVisual) return;
              const zone = preferences.timeZone === 'system' ? Intl.DateTimeFormat().resolvedOptions().timeZone : preferences.timeZone;
              setTimeSource({ query: { ...query,
                ...(query.timeRange === undefined ? {} : { timeRange: copyQueryTimeRange(query.timeRange) }),
                ...(query.dataView === undefined ? {} : { dataView: selectDataView(query.dataView.definition) }) },
              endpoint: target.endpoint, initialTimeZone: validTimeRangeZone(zone) ? zone : 'UTC',
              catalog: queryFields.status === 'ready' && !queryFields.refreshing && !queryFields.refreshError ? queryFields.data : undefined });
            }} />
          <IconButton icon={ListOrdered} label={t('querySort:open')}
            disabled={saveBlockedByVisual || hasPendingFilters || restoring || !target || !active || !query.index.trim()}
            title={hasPendingFilters ? t('queryFilters:pendingAction') : t('querySort:open')} onClick={() => {
              if (!target || !active || restoring || saveBlockedByVisual || hasPendingFilters || !query.index.trim()) return;
              setSortSource({ query: structuredClone(query), endpoint: target.endpoint });
            }} />
          <IconButton icon={Sigma} label={t('queryAggregationBuild:open')}
            disabled={saveBlockedByVisual || hasPendingFilters || restoring || !target || !active || !query.index.trim()}
            title={hasPendingFilters ? t('queryFilters:pendingAction') : t('queryAggregationBuild:open')} onClick={() => {
              if (!target || !active || restoring || saveBlockedByVisual || hasPendingFilters || !query.index.trim()) return;
              setBuildSource({ query: structuredClone(query), endpoint: target.endpoint });
            }} />
          <IconButton icon={ChartColumnBig} label={t('chartDefinitions:open')}
            disabled={restoring || !active} title={t('chartDefinitions:open')}
            onClick={() => { if (!active || restoring) return; setChartDefinitionsOpen(true); }} />
          {linkedEntry ? <IconButton className={`qlib-star${linkedEntry.favorite ? ' active' : ''}`} icon={Star}
            aria-pressed={linkedEntry.favorite} label={t(linkedEntry.favorite ? 'queryLibrary:favoriteRemove' : 'queryLibrary:favoriteAdd')}
            onClick={() => library.setFavorite(linkedEntry.id, !linkedEntry.favorite)} /> : null}
          {library.saveStatus.status !== 'idle' ? <span className={`qlib-save-state ${library.saveStatus.status}`} role="status">
            {library.saveStatus.status === 'saving'
              ? <><LoaderCircle className="spin" size={13} aria-hidden="true" />{t('queryLibrary:saving')}</> : null}
            {library.saveStatus.status === 'saved' ? t('queryLibrary:saved') : null}
            {library.saveStatus.status === 'error' ? <><TriangleAlert size={13} aria-hidden="true" />{t('queryLibrary:saveFailed')}
              <button type="button" className="secondary compact-button" onClick={library.retrySave}>{t('retry')}</button></> : null}
          </span> : null}
          <button className="primary run-button" disabled={!canRun} title={runTitle} onClick={() => void runQuery()}><Play size={14} />{t('query:run')}</button>
        </div>
        <DataViewTarget query={query} library={dataViews} fields={queryFields} disabled={restoring}
          runtimeDisabled={!target || !active || saveBlockedByVisual}
          onReviewRuntime={() => {
            if (!target || !active || restoring || saveBlockedByVisual || !query.dataView) return;
            setRuntimeSource({ query: { ...query, dataView: selectDataView(query.dataView.definition) }, endpoint: target.endpoint,
              catalog: queryFields.status === 'ready' && !queryFields.refreshing && !queryFields.refreshError ? queryFields.data : undefined });
          }}
          canInspect={available && target !== undefined && query.index.trim() !== ''}
          onInspect={() => loadFields(true)} onSelect={(definition) => {
            if (restoring || !active) return;
            if (definition && (definition.connectionId !== query.connectionId || !target)) return;
            updateQuery(query.id, definition ? { index: definition.index, dataView: selectDataView(definition) } : { dataView: null }, query);
          }} />
        {query.timeRange ? <TimeRangeSummary time={query.timeRange} managed /> : null}
        <div hidden={editorMode !== 'visual'} className="query-editor-body">
          {editorMode === 'visual' || editorModes[query.id] !== undefined ? <VisualQueryEditor key={query.id} rawDsl={query.dsl}
            fields={queryFields.status === 'ready' ? queryFields.data.fields : []}
            draft={visualDraft ?? undefined} onDraftChange={updateVisualDraft}
            onChange={(dsl) => patchQuery({ dsl })} onValidityChange={updateVisualValidity} /> : null}
        </div>
        <div hidden={editorMode !== 'dsl'} className="query-editor-body">
          <QueryDslEditor ref={editor} models={editorModels} queryId={queryId} value={query.dsl} preferences={preferences}
            active={active && editorMode === 'dsl'} readOnly={Boolean(restoring)} diagnostic={currentCheck?.error ?? null}
            completions={completions}
            onChange={(dsl) => patchQuery({ dsl })} onHistory={setEditorHistory} />
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
      {!expandedResults && hasPendingFilters && pendingFilters ? <QueryFilterDraftBar count={pendingFilters.filters.length}
        enabled={pendingFilters.filters.filter(queryFilterEnabled).length}
        onReview={() => reviewFilters()}
        onDiscard={() => discardFilters(query.id)} />
        : !expandedResults && boundFilters ? <QueryFilterBindingBar count={boundFilters.filters.length} enabled={boundFilters.filters.filter(queryFilterEnabled).length}
          conflict={!matchesQueryFilterBinding(boundFilters, query, endpoint)}
          onReview={() => reviewFilters()} onDetach={() => setFilterDetach(boundFilters)} /> : null}
      {!expandedResults && 'snapshot' in execution && execution.snapshot.timeRange ? <TimeRangeSummary time={execution.snapshot.timeRange} /> : null}
      {showingQuery && !resultsMaximized ? (
        <ResultsResizeHandle
          label={t('queryLive:resizeResults')}
          height={resultsHeight}
          minHeight={200}
          maxHeight={Math.max(200, (panel.current?.clientHeight ?? 600) - 160)}
          active={active && showingQuery}
          onResize={(h) => setResultsHeight(h)}
          onReset={() => setResultsHeight(null)}
        />
      ) : null}
      <QueryResults kind={showingQuery ? 'query' : 'preview'} query={query} entry={entry}
        available={available} stale={stale} endpointChanged={endpointChanged} documentIds={documentIds} active={active} wrapJson={preferences.wrapJson}
        onFilterCell={canFilterCell ? openCellFilter : undefined}
        onNestedFilters={canFilterCell ? () => openCellFilter(undefined, true) : undefined}
        canRun={canRun} grouping={preferences.grouping} exportService={libraryService}
        onSnapshotExport={available && snapshotExportService.available && target !== undefined && !endpointChanged
          && entry?.endpoint && (execution.status === 'success' || execution.status === 'partial')
          ? () => {
            if (!exportSource) setExportSource({
              queryId: execution.snapshot.queryId, connectionId: execution.snapshot.connectionId,
              connectionName: target.displayName, endpoint: entry.endpoint!, index: execution.snapshot.index,
              rawDsl: execution.snapshot.rawDsl,
            });
            setExportVisible(true);
          } : undefined}
        layout={recoveryTab?.grid} onLayoutChange={recoveryTab ? (layout) => recovery?.setGridLayout(queryId, layout) : undefined}
        renderToolbar={showingQuery ? undefined : (summary, controls) => <DataPreview document={query} target={target} available={available}
          locked={tab?.kind === 'index'} busy={execution.status === 'running' || Boolean(entry?.continuing)} summary={summary}
          refreshBlockedReason={hasPendingFilters ? t('queryFilters:pendingAction') : undefined}
          onOpen={selectIndex} onRefresh={() => { void runQuery(); }} onNewQuery={() => addQuery(query)}
          onConnections={() => onSettings('connections')}>{controls}</DataPreview>}
        onCancel={() => cancel(query.id)} onRun={() => { if (canRun) void runQuery(); }}
        onViewChange={(view) => tab ? updateQuery(query.id, { resultView: view }) : setHomeView(view)}
        onLoadMore={() => { void loadMore(query); }}
        chartDefinitionsController={target ? chartDefinitions : undefined}
        maximized={showingQuery ? resultsMaximized : undefined}
        onToggleMaximize={showingQuery ? () => setResultsMaximized((v) => !v) : undefined} />
      </div>
    </main>
    <PanelResizeHandle side="ai" label={t('query:resizeAI')} controls="workspace-ai"
      {...panels.layout.ai} active={active && aiOpen}
      onResize={(width) => panels.resize('ai', width)}
      onReset={() => panels.resize('ai', PANEL_DEFAULTS.ai)} />
    <AiChatPanel modelService={modelService} backend={aiBackend} open={aiOpen} active={active} query={showingQuery ? query : null}
      onClose={toggleAI} onSettings={() => onSettings('models')} />
    <SaveDraftDialog open={saveDraftOpen} entry={linkedEntry} initialName={query.name} status={library.status}
      loadError={library.loadError} saveStatus={library.saveStatus} onClose={() => setSaveDraftOpen(false)}
      onSave={saveDraftValues} onRetrySave={library.retrySave} />
    <QueryLibraryDialog open={libraryOpen} kind={libraryService.kind} status={library.status} loadError={library.loadError}
      entries={library.entries} saveStatus={library.saveStatus} profiles={profiles} onClose={() => setLibraryOpen(false)}
      onRestore={restoreQuery ? restoreSaved : undefined} onDelete={library.deleteEntry} onToggleFavorite={toggleSavedFavorite}
      onRetrySave={library.retrySave} onReload={library.reload}
      onExchange={(mode) => { setLibraryOpen(false); setExchangeMode(mode); }} />
    {exchangeMode ? <QueryExchangeDialog mode={exchangeMode} library={library} profiles={profiles} service={exchangeService}
      onClose={() => { setExchangeMode(null); setLibraryOpen(true); }} /> : null}
    {parameterSource ? <QueryParametersDialog source={parameterSource}
      current={state.tabs.find((item) => item.document.id === parameterSource.id)?.document}
      onClose={() => setParameterSource(null)} onCommit={(source, patch) => {
        if (!matchesQueryDraft(state.tabs.find((item) => item.document.id === source.id)?.document, source)) return false;
        if (updateQuery(source.id, patch, source) === false) return false;
        if (patch.dsl !== undefined) {
          if (recovery) recovery.setEditorMode(source.id, 'dsl');
          else setEditorModes((current) => ({ ...current, [source.id]: 'dsl' }));
        }
        return true;
      }} /> : null}
    {runtimeSource && active ? <RuntimeFieldsDialog source={runtimeSource.query}
      current={state.tabs.find((item) => item.kind === 'query' && item.document.id === runtimeSource.query.id)?.document}
      catalog={runtimeSource.catalog}
      targetCurrent={!restoring && profiles.some((profile) => profile.id === runtimeSource.query.connectionId && profile.endpoint === runtimeSource.endpoint)}
      onClose={() => setRuntimeSource(null)} onCommit={(source, dsl) => {
        if (!active || restoring || !profiles.some((profile) => profile.id === source.connectionId && profile.endpoint === runtimeSource.endpoint)
          || !matchesQueryDraft(state.tabs.find((item) => item.kind === 'query' && item.document.id === source.id)?.document, source)) return false;
        if (updateQuery(source.id, { dsl }, source) === false) return false;
        if (recovery) recovery.setEditorMode(source.id, 'dsl');
        else setEditorModes((current) => ({ ...current, [source.id]: 'dsl' }));
        return true;
      }} /> : null}
    {timeSource && active ? <QueryTimeRangeDialog source={timeSource.query}
      current={state.tabs.find((item) => item.kind === 'query' && item.document.id === timeSource.query.id)?.document}
      catalog={timeSource.catalog} initialTimeZone={timeSource.initialTimeZone}
      targetCurrent={!restoring && profiles.some((profile) => profile.id === timeSource.query.connectionId && profile.endpoint === timeSource.endpoint)}
      onClose={() => setTimeSource(null)} onCommit={(source, patch) => {
        if (!active || restoring || !profiles.some((profile) => profile.id === source.connectionId && profile.endpoint === timeSource.endpoint)
          || !matchesQueryDraft(state.tabs.find((item) => item.kind === 'query' && item.document.id === source.id)?.document, source)) return false;
        if (updateQuery(source.id, patch, source) === false) return false;
        if (recovery) recovery.setEditorMode(source.id, 'dsl');
        else setEditorModes((current) => ({ ...current, [source.id]: 'dsl' }));
        return true;
      }} /> : null}
    {sortSource && active && state.activeTabId === sortSource.query.id ? <QuerySortDialog source={sortSource.query}
      endpoint={sortSource.endpoint} current={sortTab?.document}
      fields={fieldsFor(sortSource.query.connectionId, sortSource.endpoint, sortSource.query.index.trim())}
      targetCurrent={sortTargetCurrent} canInspect={available && sortTargetCurrent}
      onInspect={() => {
        if (available && sortTargetCurrent && sortSource.query.connectionId) {
          refreshFields(sortSource.query.connectionId, sortSource.endpoint, sortSource.query.index.trim());
        }
      }}
      onClose={() => setSortSource(null)} onCommit={(source, patch) => {
        if (!sortTargetCurrent || !matchesQueryDraft(sortTab?.document, source) || patch.dsl === undefined) return false;
        if (updateQuery(source.id, patch, source) === false) return false;
        if (recovery) recovery.setEditorMode(source.id, 'dsl');
        else setEditorModes((current) => ({ ...current, [source.id]: 'dsl' }));
        return true;
      }} /> : null}
    {buildSource && active && state.activeTabId === buildSource.query.id ? <QueryAggregationBuildDialog source={buildSource.query}
      endpoint={buildSource.endpoint} current={buildTab?.document} seed={buildSource.seed} definitions={chartDefinitions}
      onSaveDefinition={(definition) => chartDefinitions.save(definition)}
      fields={fieldsFor(buildSource.query.connectionId, buildSource.endpoint, buildSource.query.index.trim())}
      targetCurrent={buildTargetCurrent} canInspect={available && buildTargetCurrent}
      onInspect={() => {
        if (available && buildTargetCurrent && buildSource.query.connectionId) {
          refreshFields(buildSource.query.connectionId, buildSource.endpoint, buildSource.query.index.trim());
        }
      }}
      onClose={() => setBuildSource(null)} onCommit={(source, patch) => {
        if (!buildTargetCurrent || !matchesQueryDraft(buildTab?.document, source) || patch.dsl === undefined) return false;
        if (updateQuery(source.id, patch, source) === false) return false;
        if (recovery) recovery.setEditorMode(source.id, 'dsl');
        else setEditorModes((current) => ({ ...current, [source.id]: 'dsl' }));
        return true;
      }} /> : null}
    {reviewedFilters && filterDialog && !pinning && active && state.activeTabId === reviewedFilters.source.id ? <QueryFiltersDialog key={filterDialog.instanceId}
      draft={reviewedFilters} current={filterTab?.document} initialSelection={filterDialog.selection} initialNested={filterDialog.nested}
      fields={fieldsFor(reviewedFilters.source.connectionId, reviewedFilters.endpoint, reviewedFilters.source.index.trim())}
      mapping={mappingFor(reviewedFilters.source.connectionId, reviewedFilters.endpoint, reviewedFilters.source.index.trim())}
      targetCurrent={filterTargetCurrent} canInspect={available && filterTargetCurrent} newQuery={filterTab?.kind === 'index'}
      onInspect={() => {
        if (available && filterTargetCurrent && reviewedFilters.source.connectionId) refreshFields(reviewedFilters.source.connectionId, reviewedFilters.endpoint, reviewedFilters.source.index.trim());
      }}
      onInspectNested={() => {
        if (!available || !filterTargetCurrent) return;
        const { connectionId, index } = reviewedFilters.source;
        if (!connectionId) return;
        loadMapping(connectionId, reviewedFilters.endpoint, index.trim());
        refreshFields(connectionId, reviewedFilters.endpoint, index.trim());
      }}
      onFiltersChange={(filters, composition) => setFilterDrafts((current) => current[reviewedFilters.source.id] === reviewedFilters
        ? { ...current, [reviewedFilters.source.id]: { ...reviewedFilters, filters, composition } } : current)}
      onDiscard={() => discardFilters(reviewedFilters.source.id)}
      onPin={() => {
        if (filterTargetCurrent && matchesQueryDraft(filterTab?.document, reviewedFilters.source)) setPinning(reviewedFilters);
      }}
      onClose={() => {
        if (reviewedFilters.binding && !queryFilterDraftChanged(reviewedFilters)) discardFilters(reviewedFilters.source.id);
        else setFilterDialog(null);
      }}
      onCommit={(source, patch) => {
        if (!filterTargetCurrent || !matchesQueryDraft(filterTab?.document, source) || patch.dsl === undefined
          || filterBindings[source.id] !== reviewedFilters.binding || !queryFilterDraftChanged(reviewedFilters)) return false;
        const fields = fieldsFor(reviewedFilters.source.connectionId, reviewedFilters.endpoint, reviewedFilters.source.index.trim());
        const mapping = mappingFor(reviewedFilters.source.connectionId, reviewedFilters.endpoint, reviewedFilters.source.index.trim());
        const catalog = fields.status === 'ready' && !fields.refreshing && !fields.refreshError ? fields.data : undefined;
        const evidence = mapping.status === 'ready' && !mapping.refreshing && !mapping.refreshError ? parseNestedFilterMapping(mapping.data.raw) : undefined;
        const verified = previewQueryFilterDraft(reviewedFilters, catalog, evidence);
        if (!verified.ok || verified.dsl !== patch.dsl || JSON.stringify(verified.patch.timeRange) !== JSON.stringify(patch.timeRange)) return false;
        const applied = filterTab?.kind === 'index'
          ? { ...createQuery(source.connectionId, source.resultView), name: source.index, index: source.index, dsl: verified.dsl }
          : updateWorkspaceDocument(state, source.id, verified.patch).tabs.find((tab) => tab.document.id === source.id)?.document;
        if (!applied) return false;
        const binding = reviewedFilters.filters.length ? bindAppliedQueryFilters(reviewedFilters, applied, catalog, evidence) : null;
        if (reviewedFilters.filters.length && !binding) return false;
        if (filterTab?.kind === 'index') {
          if (!restoreQuery) return false;
          restoreQuery(applied);
        } else {
          if (updateQuery(source.id, verified.patch, source) === false) return false;
          if (recovery) recovery.setEditorMode(source.id, 'dsl');
          else setEditorModes((current) => ({ ...current, [source.id]: 'dsl' }));
        }
        setFilterBindings((current) => binding ? { ...current, [applied.id]: binding }
          : Object.fromEntries(Object.entries(current).filter(([id]) => id !== applied.id)));
        discardFilters(source.id);
        return true;
      }} /> : null}
    {pinning && active ? <PinFiltersDialog draft={pinning} library={pinnedFilters} kind={pinnedFilterService.kind}
      currentTarget={filterTargetCurrent && pinning === reviewedFilters && matchesQueryDraft(filterTab?.document, pinning.source)}
      onClose={() => setPinning(null)} /> : null}
    {pinnedOpen && active ? <PinnedFiltersDialog library={pinnedFilters} kind={pinnedFilterService.kind} profiles={profiles}
      source={pinnedOpen.source} endpoint={pinnedOpen.endpoint} canLoad={pinnedTargetCurrent}
      onClose={() => setPinnedOpen(null)} onLoad={(definition) => {
        if (!pinnedTargetCurrent || !pinnedOpen.source || !pinnedOpen.endpoint || pinnedFilters.status !== 'ready' || pinnedFilters.error
          || !pinnedFilters.entries.some((entry) => entry.id === definition.id && samePinnedFilter(entry, definition))) return false;
        const draft = draftFromPinnedFilters(definition, pinnedOpen.source, pinnedOpen.endpoint);
        if (!draft) return false;
        setFilterDrafts((current) => ({ ...current, [draft.source.id]: draft }));
        setFilterDialog({ queryId: draft.source.id, instanceId: crypto.randomUUID(),
          executionId: 'snapshot' in execution ? execution.snapshot.requestId : null });
        setPinnedOpen(null);
        return true;
      }} /> : null}
    <Modal open={filterDetach !== null} onClose={() => setFilterDetach(null)} title={t('queryFilters:detachTitle')}
      description={t('queryFilters:detachDetail', { count: filterDetach?.filters.length ?? 0 })}>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => setFilterDetach(null)}>{t('cancel')}</button>
        <button type="button" className="danger" disabled={!filterDetach || filterBindings[filterDetach.applied.id] !== filterDetach}
          onClick={() => {
            if (!filterDetach || filterBindings[filterDetach.applied.id] !== filterDetach) return;
            setFilterBindings((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== filterDetach.applied.id)));
            discardFilters(filterDetach.applied.id);
            setFilterDetach(null);
          }}>{t('queryFilters:detach')}</button>
      </div>
    </Modal>
    {exportSource ? <SnapshotExportDialog open={exportVisible && active} source={exportSource} service={snapshotExportService}
      targetAvailable={state.tabs.some((item) => item.document.id === exportSource.queryId)
        && profiles.some((profile) => profile.id === exportSource.connectionId && profile.endpoint === exportSource.endpoint)}
      onHide={() => setExportVisible(false)} onTaskState={setExportTaskState}
      onClose={() => { setExportSource(null); setExportVisible(false); }} /> : null}
    {recovery ? <ExecutionHistoryDialog open={historyOpen} recovery={recovery} profiles={profiles}
      onClose={() => setHistoryOpen(false)} onRestore={restoreQuery} /> : null}
    {chartDefinitionsOpen ? <ChartDefinitionsDialog library={chartDefinitions} kind={chartDefinitionService.kind}
      profiles={profiles} activeTarget={active && showingQuery ? { connectionId: query.connectionId, index: query.index } : null}
      onLegacyLibrary={() => { setChartDefinitionsOpen(false); setChartsOpen(true); }}
      onReuse={(definition) => {
        if (!target || !active || restoring || tab?.kind !== 'query') return;
        if (definition.connectionId !== query.connectionId || definition.index !== query.index.trim()) return;
        setBuildSource({ query: structuredClone(query), endpoint: target.endpoint,
          seed: freezeChartDefinitionSelection(selectChartDefinition(definition)) });
      }}
      onExchange={(mode) => { setChartDefinitionsOpen(false); setChartExchangeMode(mode); }}
      onClose={() => setChartDefinitionsOpen(false)} /> : null}
    {chartExchangeMode ? <ChartDefinitionExchangeDialog mode={chartExchangeMode} library={chartDefinitions}
      kind={chartDefinitionService.kind} profiles={profiles} service={chartExchangeService}
      record={chartDefinitions.record}
      onClose={() => { setChartExchangeMode(null); setChartDefinitionsOpen(true); }} /> : null}
    {dataViewsOpen ? <DataViewsDialog library={dataViews} kind={dataViewService.kind} profiles={profiles}
      initialConnectionId={state.activeConnectionId} available={available && active}
      fieldsFor={fieldsFor} inspectFields={refreshFields} onClose={() => setDataViewsOpen(false)}
      onOpenQuery={!restoring && restoreQuery ? (definition) => {
        if (!active || !profiles.some((profile) => profile.id === definition.connectionId)) return;
        restoreQuery({ ...createQuery(definition.connectionId, preferences.startView), name: definition.name,
          index: definition.index, dataView: selectDataView(definition) });
      } : undefined} /> : null}
    <Modal open={closing !== null} onClose={() => setClosing(null)} title={t('query:closeTitle')}
      description={t('query:closeDetail', { name: closing?.name || t('query:title') })}>
      <div className="dialog-actions"><button className="secondary" onClick={() => setClosing(null)}>{t('cancel')}</button>
        <button className="danger" onClick={() => { if (closing) closeDocument(closing.id); setClosing(null); }}>{t('query:discard')}</button></div>
    </Modal>
    {chartsOpen && active ? (
      <SavedChartsDialog
        open={chartsOpen}
        onClose={() => setChartsOpen(false)}
        currentIndex={query.index}
        controller={savedCharts}
        legacy
        canApplyChart={(chart) => Boolean(active && showingQuery && target && !restoring && !saveBlockedByVisual
          && !hasPendingFilters && chart.connectionId === query.connectionId && chart.index === query.index.trim()
          && legacyChartDefinition(chart))}
        onApplyChart={(chart) => {
          if (!target || !active || restoring || !showingQuery || hasPendingFilters || saveBlockedByVisual
            || chart.connectionId !== query.connectionId || chart.index !== query.index.trim()) return;
          const definition = legacyChartDefinition(chart);
          if (!definition) return;
          setChartsOpen(false);
          setBuildSource({ query: structuredClone(query), endpoint: target.endpoint,
            seed: freezeChartDefinitionSelection(selectChartDefinition(definition)) });
        }}
      />
    ) : null}
  </div>;
}

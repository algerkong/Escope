import { useCallback, useEffect, useRef, useState } from 'react';
import { Command as CommandIcon, Database, LoaderCircle, ScanLine, Search, Settings, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  addWorkspaceTab, closeWorkspaceTab, createIndexTab, createQuery, createWorkspace,
  selectWorkspaceTab, switchConnection, updateWorkspaceDocument, type QueryDocument, type WorkspaceState,
} from '../domain/query';
import { selectConnection, type ConnectionInput, type ConnectionSecurityChange } from '../domain/connection';
import { parsePreferences, resolveLocale, type Preferences } from '../domain/preferences';
import type { AiChatBackend } from '../domain/ai-chat';
import type { StorageService, StoredState } from '../services/storage';
import { errorCode, testConnection, type QueryBackend } from '../services/ipc';
import { createModelService, type ModelService } from '../services/models';
import { createQueryLibraryService, type QueryLibraryService } from '../services/query-library';
import { createWorkspaceRecoveryService, type WorkspaceRecoveryService } from '../services/workspace-recovery';
import { connectionTestLabel, useConnectionTests } from '../features/connections/useConnectionTests';
import { IconButton, SelectControl } from '../components/controls';
import { WindowTitleBar } from '../components/window/WindowTitleBar';
import { QueryWorkspace, type QueryCommand } from '../features/query/QueryWorkspace';
import { useWorkspaceRecovery } from '../features/query/useWorkspaceRecovery';
import { SettingsView } from './SettingsView';
import { PreferencesSaveError } from '../features/settings/PreferencesSaveError';
import { settingsRoutes, type SettingsRoute } from './routes';
import { CommandPalette, type Command } from './CommandPalette';
import { i18n } from '../locales';

export function applyPreferences(p: Preferences) {
  const root = document.documentElement;
  root.dataset.theme = p.mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p.mode;
  root.dataset.accent = p.accent;
  root.dataset.density = p.density;
  root.dataset.uiFont = p.uiFont;
  root.dataset.codeFont = p.codeFont;
  root.dataset.reduceMotion = String(p.reduceMotion);
  root.style.setProperty('--ui-size', `${p.uiSize}px`);
  root.style.setProperty('--code-size', `${p.codeSize}px`);
  root.style.setProperty('--table-size', `${p.tableSize}px`);
  const locale = resolveLocale(p, navigator.language);
  root.lang = locale;
  if (i18n.language !== locale) void i18n.changeLanguage(locale);
}

export function App({ service, initial, connectionProbe = testConnection, queryBackend, aiBackend, modelService: suppliedModelService,
  queryLibraryService: suppliedQueryLibraryService, workspaceRecoveryService: suppliedRecoveryService }:
  { service: StorageService; initial: StoredState; connectionProbe?: typeof testConnection; queryBackend?: QueryBackend;
    aiBackend?: AiChatBackend; modelService?: ModelService; queryLibraryService?: QueryLibraryService;
    workspaceRecoveryService?: WorkspaceRecoveryService }) {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(initial.preferences);
  const preferencesRef = useRef(preferences);
  const startupView = useRef(initial.preferences.startView);
  const preferenceQueue = useRef(Promise.resolve());
  const [profiles, setProfiles] = useState(initial.connections);
  const connectionTests = useConnectionTests(connectionProbe);
  const [initialWorkspace] = useState<WorkspaceState>(() => {
    const activeConnectionId = selectConnection(initial.connections, initial.activeConnectionId);
    return createWorkspace(activeConnectionId, initial.preferences.startView);
  });
  const [recoveryService] = useState(() => suppliedRecoveryService ?? createWorkspaceRecoveryService());
  const recovery = useWorkspaceRecovery(recoveryService, initialWorkspace, profiles);
  // The recovery controller reserves mutations synchronously, including repeated index clicks.
  const { workspace: state, workspaceRef, updateWorkspace: setState } = recovery;
  const [view, setView] = useState<'query' | 'settings'>('query');
  const [route, setRoute] = useState<SettingsRoute>('general');
  const [aiOpen, setAI] = useState(initial.preferences.startAI);
  const [palette, setPalette] = useState<'jump' | 'command' | null>(null);
  const [queryCommand, setQueryCommand] = useState<QueryCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(initial.credentialCleanupPending ?? false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const mutationLock = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<{ id: string; code: string } | null>(null);
  const selectionQueue = useRef(Promise.resolve());
  const selectionVersion = useRef(0);
  const selectionPending = useRef(0);
  const [savingPreferences, setSavingPreferences] = useState(false);
  // Created once: the desktop adapter uses typed IPC, the browser preview keeps an explicit
  // session store. A failed desktop call is never answered from memory.
  const [modelService] = useState(() => suppliedModelService ?? createModelService());
  const [queryLibraryService] = useState(() => suppliedQueryLibraryService ?? createQueryLibraryService());
  const preferenceVersion = useRef(0);

  useEffect(() => {
    applyPreferences(preferences);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (preferences.mode === 'system') applyPreferences(preferences); };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences]);

  const persistPreferences = useCallback(() => {
    const version = ++preferenceVersion.current;
    setSavingPreferences(true);
    preferenceQueue.current = preferenceQueue.current
      // The draft is read when the queue reaches this write, so rapid edits persist the newest
      // value instead of a stale snapshot, and retry re-sends whatever the user has now.
      .then(() => service.savePreferences(preferencesRef.current))
      .then(() => { if (version === preferenceVersion.current) setSaveError(null); })
      .catch((error: unknown) => { if (version === preferenceVersion.current) setSaveError(errorCode(error)); })
      .finally(() => { if (version === preferenceVersion.current) setSavingPreferences(false); });
  }, [service]);

  const updatePreferences = useCallback((patch: Partial<Preferences>) => {
    const next = parsePreferences({ ...preferencesRef.current, ...patch });
    preferencesRef.current = next;
    setPreferences(next);
    applyPreferences(next);
    persistPreferences();
  }, [persistPreferences]);

  const openSettings = useCallback((next: SettingsRoute) => {
    setRoute(next); setView('settings');
    requestAnimationFrame(() => document.getElementById('settings-title')?.focus());
  }, []);
  const backToQuery = useCallback(() => {
    setView('query');
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.query-tab button[aria-selected="true"]')?.focus());
  }, []);
  const queueSelection = useCallback((id: string) => {
    const version = ++selectionVersion.current;
    selectionPending.current++;
    const write = selectionQueue.current.then(() => service.selectConnection(id))
      .finally(() => { selectionPending.current--; });
    selectionQueue.current = write.catch(() => undefined);
    return { version, write };
  }, [service]);
  const navigateWorkspace = useCallback((change: (current: WorkspaceState) => WorkspaceState) => {
    const previous = workspaceRef.current;
    let next = change(previous);
    // Historical tabs may outlive a deleted connection; never select that deleted ID in the explorer.
    if (!profiles.some((profile) => profile.id === next.activeConnectionId)) {
      next = { ...next, activeConnectionId: selectConnection(profiles, previous.activeConnectionId) };
    }
    setState(() => next);
    const id = next.activeConnectionId;
    if (id !== null && (id !== previous.activeConnectionId || selectionPending.current > 0)) {
      const { version, write } = queueSelection(id);
      void write.then(() => {
        if (version === selectionVersion.current) setSelectionError(null);
      }).catch((error: unknown) => {
        if (version === selectionVersion.current) setSelectionError({ id, code: errorCode(error) });
      });
    } else selectionVersion.current++;
  }, [profiles, queueSelection, setState, workspaceRef]);
  const addQuery = useCallback((source?: QueryDocument) => {
    navigateWorkspace((current) => {
      const query = createQuery(source ? source.connectionId : current.activeConnectionId, startupView.current);
      if (source) query.index = source.index;
      return addWorkspaceTab(current, { kind: 'query', document: query });
    });
    setView('query');
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.query-editor-section textarea')?.focus());
  }, [navigateWorkspace]);
  const restoreQuery = useCallback((source: QueryDocument) => {
    const document: QueryDocument = { ...source, revision: 0 };
    navigateWorkspace((current) => addWorkspaceTab(current, { kind: 'query', document }));
    setView('query');
  }, [navigateWorkspace]);
  const selectTab = useCallback((id: string | null) => {
    navigateWorkspace((current) => selectWorkspaceTab(current, id));
  }, [navigateWorkspace]);
  const openIndex = useCallback((connectionId: string, index: string) => {
    const existing = workspaceRef.current.tabs.find((tab) => tab.kind === 'index'
      && tab.document.connectionId === connectionId && tab.document.index === index.trim());
    const tab = existing ?? createIndexTab(connectionId, index, startupView.current);
    navigateWorkspace((current) => addWorkspaceTab(current, tab));
    return { document: tab.document, created: existing === undefined };
  }, [navigateWorkspace, workspaceRef]);
  const mutate = async (action: () => Promise<void>) => {
    if (mutationLock.current) throw { code: 'busy' };
    mutationLock.current = true; setBusy(true);
    try { await action(); } finally { mutationLock.current = false; setBusy(false); }
  };
  const chooseConnection = (id: string) => mutate(async () => {
    const { version, write } = queueSelection(id);
    try { await write; } catch (error) {
      if (version === selectionVersion.current) throw error;
      return;
    }
    if (version !== selectionVersion.current) return;
    setState((current) => switchConnection(current, id));
    setSelectionError(null);
  });
  const saveConnection = (input: ConnectionInput, id?: string, security?: ConnectionSecurityChange) => mutate(async () => {
    if (!service.saveConnectionSecure && security
      && (security.credential.kind !== 'keep' || security.ca.kind !== 'keep')) throw { code: 'unsupported' };
    const outcome = service.saveConnectionSecure ? await service.saveConnectionSecure(input, id, security) : null;
    const saved = outcome?.profile ?? await service.saveConnection(input, id);
    if (outcome) setCleanupPending(outcome.cleanup.status !== 'complete');
    if (id && (profiles.find((profile) => profile.id === id)?.endpoint !== saved.endpoint
      || (security !== undefined && (security.credential.kind !== 'keep' || security.ca.kind !== 'keep')))) connectionTests.invalidate(id);
    const next = id ? profiles.map((profile) => profile.id === saved.id ? saved : profile) : [...profiles, saved];
    setProfiles(next);
    setState((current) => {
      const active = selectConnection(next, current.activeConnectionId);
      return active === current.activeConnectionId ? current : switchConnection(current, active);
    });
  });
  const removeConnection = (id: string) => mutate(async () => {
    selectionVersion.current++;
    if (service.deleteConnectionSecure) {
      const outcome = await service.deleteConnectionSecure(id);
      setCleanupPending(outcome.cleanup.status !== 'complete');
    } else await service.deleteConnection(id);
    connectionTests.invalidate(id, true);
    const next = profiles.filter((profile) => profile.id !== id);
    setProfiles(next);
    setState((current) => {
      const active = selectConnection(next, current.activeConnectionId);
      return active === current.activeConnectionId ? current : switchConnection(current, active);
    });
  });
  const cleanupCredentials = () => mutate(async () => {
    if (!service.cleanupCredentials) throw { code: 'unsupported' };
    setCleanupBusy(true);
    try {
      const result = await service.cleanupCredentials();
      setCleanupPending(result.status !== 'complete');
    } finally { setCleanupBusy(false); }
  });
  const updateQuery = (id: string, patch: Partial<Pick<QueryDocument, 'name' | 'index' | 'dsl' | 'resultView'>>) =>
    setState((current) => updateWorkspaceDocument(current, id, patch));
  const closeTab = (id: string) => navigateWorkspace((current) => closeWorkspaceTab(current, id));
  const reloadWorkspace = () => {
    // An explicit restore is newer than a connection-selection write still in flight.
    selectionVersion.current++;
    setSelectionError(null);
    recovery.reload();
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p') { event.preventDefault(); setPalette(event.shiftKey ? 'command' : 'jump'); }
      if (key === ',') { event.preventDefault(); openSettings('general'); }
      if (key === 'n') { event.preventDefault(); addQuery(); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [openSettings, addQuery]);

  const active = profiles.find((profile) => profile.id === state.activeConnectionId);
  const commands: Command[] = palette === 'jump'
    ? [
      ...state.tabs.map((tab, position) => ({
        id: tab.document.id,
        title: tab.kind === 'index'
          ? `${tab.document.index} (${profiles.find((profile) => profile.id === tab.document.connectionId)?.displayName ?? t('removedConnection')})`
          : tab.document.name || `${t('query:title')} ${state.tabs.slice(0, position + 1).filter((item) => item.kind === 'query').length}`,
        keywords: tab.kind === 'index' ? 'index data 索引 数据' : 'query 查询',
        run: () => { selectTab(tab.document.id); backToQuery(); },
      })),
      ...settingsRoutes.map((item) => ({
        id: item, title: t(`settings:${item}`), keywords: `settings 设置 ${item}`,
        run: () => openSettings(item),
      })),
    ]
    : [
      { id: 'new', title: t('newQuery'), keywords: 'new query 新建查询', run: addQuery },
      { id: 'settings', title: t('settings'), keywords: 'settings 设置', run: () => openSettings('general') },
      { id: 'ai', title: t('query:toggleAI'), keywords: 'assistant AI 助手', run: () => { setAI((value) => !value); backToQuery(); } },
      { id: 'execute', title: t('query:run'), keywords: 'execute query 执行查询',
        run: () => queryCommand?.run(),
        disabledReason: queryCommand?.enabled ? undefined : queryCommand?.reason ?? t('queryLive:runUnavailable') },
    ];

  return <div className="app-shell">
    <WindowTitleBar>
      <div className="brand"><span className="brand-symbol"><ScanLine size={20} /></span><strong>EScope</strong><span className="brand-divider" />
        <span className="workspace-title">{t('workspace')}</span></div>
      <div className="header-actions">
        <div className="active-connection"><Database size={15} />
          {profiles.length > 1 ? <SelectControl aria-label={t('connections:target')} value={state.activeConnectionId ?? ''} disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              void chooseConnection(id).catch((error: unknown) => setSelectionError({ id, code: errorCode(error) }));
            }}>
            {profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.displayName}</option>)}
          </SelectControl> : <span>{active?.displayName ?? t('noConnection')}</span>}
        </div>
        <IconButton icon={Search} label={t('jump')} onClick={() => setPalette('jump')} />
        <IconButton icon={CommandIcon} label={t('command')} onClick={() => setPalette('command')} />
        <IconButton icon={Settings} label={t('settings')} aria-pressed={view === 'settings'} onClick={() => view === 'settings' ? backToQuery() : openSettings('general')} />
      </div>
    </WindowTitleBar>
    {service.kind === 'session' ? <div className="session-banner" role="status"><span className="status-dot" />{t('session')}
      <span>{t('sessionDetail')}</span></div> : null}
    {selectionError ? <div className="notice error global-error" role="alert"><TriangleAlert size={16} /><span>{t(`errors:${selectionError.code}`)}</span>
      <button disabled={busy} onClick={() => {
        void chooseConnection(selectionError.id).catch((error: unknown) => setSelectionError({ id: selectionError.id, code: errorCode(error) }));
      }}>{t('retry')}</button></div> : null}
    <PreferencesSaveError code={saveError} saving={savingPreferences} onRetry={persistPreferences}
      onClose={() => setSaveError(null)} />
    <div className="view-container" hidden={view !== 'query'}>
      <QueryWorkspace key={recovery.restoreVersion} state={state} profiles={profiles} preferences={preferences} aiOpen={aiOpen} testResults={connectionTests.results}
        backend={queryBackend} canQuery={service.kind === 'desktop'} active={view === 'query'} onCommandReady={setQueryCommand}
        modelService={modelService} aiBackend={aiBackend}
        libraryService={queryLibraryService}
        recovery={{ ...recovery, reload: reloadWorkspace }}
        toggleAI={() => setAI((value) => !value)} onSettings={openSettings} updateQuery={updateQuery}
        selectTab={selectTab} openIndex={openIndex} addQuery={addQuery} restoreQuery={restoreQuery} closeTab={closeTab} />
    </div>
    {view === 'settings' ? <SettingsView route={route} navigate={openSettings} back={backToQuery} preferences={preferences}
      modelService={modelService} aiBackend={aiBackend}
      updatePreferences={updatePreferences} connections={profiles} activeId={state.activeConnectionId} busy={busy}
      cleanupPending={cleanupPending} cleanupBusy={cleanupBusy} cleanupCredentials={cleanupCredentials}
      canTest={service.kind === 'desktop'} testResults={connectionTests.results}
      testConnection={(id) => {
        const profile = profiles.find((item) => item.id === id);
        if (service.kind === 'desktop' && profile && !mutationLock.current) void connectionTests.run(profile);
      }}
      selectConnection={chooseConnection} saveConnection={saveConnection} deleteConnection={removeConnection} /> : null}
    <footer className="app-footer">
      <span className="app-footer-mode" role="img" aria-label={t('readOnly')} title={t('readOnly')}><ShieldCheck size={14} aria-hidden="true" /></span>
      {!active || connectionTests.results[active.id] ? <span className="app-footer-connection" title={active?.displayName} role="status">
        <span className="status-dot" />
        {t(active ? connectionTestLabel(connectionTests.results[active.id]) : 'notConnected')}</span> : null}
      <span className="footer-spacer" /><span>{savingPreferences ? <LoaderCircle size={13} className="spin" /> : null}
        {t(service.kind === 'desktop' ? 'desktop' : 'session')}</span><span>v0.1.0</span></footer>
    {palette ? <CommandPalette key={palette} kind={palette} commands={commands} onClose={() => setPalette(null)} /> : null}
  </div>;
}

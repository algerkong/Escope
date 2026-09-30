import { useCallback, useEffect, useRef, useState } from 'react';
import { Command as CommandIcon, Database, LoaderCircle, ScanLine, Search, Settings, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createQuery, switchConnection, type QueryDocument, type WorkspaceState } from '../domain/query';
import { selectConnection, type ConnectionInput } from '../domain/connection';
import { parsePreferences, resolveLocale, type Preferences } from '../domain/preferences';
import type { StorageService, StoredState } from '../services/storage';
import { errorCode } from '../services/ipc';
import { IconButton } from '../components/controls';
import { QueryWorkspace } from '../features/query/QueryWorkspace';
import { SettingsView } from './SettingsView';
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

export function App({ service, initial }: { service: StorageService; initial: StoredState }) {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(initial.preferences);
  const preferencesRef = useRef(preferences);
  const startupView = useRef(initial.preferences.startView);
  const preferenceQueue = useRef(Promise.resolve());
  const [profiles, setProfiles] = useState(initial.connections);
  const [state, setState] = useState<WorkspaceState>(() => {
    const activeConnectionId = selectConnection(initial.connections, initial.activeConnectionId);
    const query = createQuery(activeConnectionId, initial.preferences.startView);
    return { activeConnectionId, activeQueryId: query.id, queries: [query] };
  });
  const [view, setView] = useState<'query' | 'settings'>('query');
  const [route, setRoute] = useState<SettingsRoute>('general');
  const [aiOpen, setAI] = useState(initial.preferences.startAI);
  const [palette, setPalette] = useState<'jump' | 'command' | null>(null);
  const [busy, setBusy] = useState(false);
  const mutationLock = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<{ id: string; code: string } | null>(null);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const preferenceVersion = useRef(0);

  useEffect(() => {
    applyPreferences(preferences);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (preferences.mode === 'system') applyPreferences(preferences); };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences]);

  const updatePreferences = useCallback((patch: Partial<Preferences>) => {
    const next = parsePreferences({ ...preferencesRef.current, ...patch });
    preferencesRef.current = next;
    setPreferences(next);
    applyPreferences(next);
    const version = ++preferenceVersion.current;
    setSavingPreferences(true);
    preferenceQueue.current = preferenceQueue.current
      .then(() => service.savePreferences(next))
      .then(() => { if (version === preferenceVersion.current) setSaveError(null); })
      .catch((error: unknown) => { if (version === preferenceVersion.current) setSaveError(errorCode(error)); })
      .finally(() => { if (version === preferenceVersion.current) setSavingPreferences(false); });
  }, [service]);

  const openSettings = useCallback((next: SettingsRoute) => {
    setRoute(next); setView('settings');
    requestAnimationFrame(() => document.getElementById('settings-title')?.focus());
  }, []);
  const backToQuery = useCallback(() => {
    setView('query');
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.dsl-editor textarea')?.focus());
  }, []);
  const addQuery = useCallback(() => {
    setState((current) => {
      const query = createQuery(current.activeConnectionId, startupView.current);
      return { ...current, activeQueryId: query.id, queries: [...current.queries, query] };
    });
    setView('query');
  }, []);
  const mutate = async (action: () => Promise<void>) => {
    if (mutationLock.current) throw { code: 'busy' };
    mutationLock.current = true; setBusy(true);
    try { await action(); } finally { mutationLock.current = false; setBusy(false); }
  };
  const chooseConnection = (id: string) => mutate(async () => {
    await service.selectConnection(id);
    setState((current) => switchConnection(current, id, startupView.current));
    setSelectionError(null);
  });
  const saveConnection = (input: ConnectionInput, id?: string) => mutate(async () => {
    const saved = await service.saveConnection(input, id);
    const next = id ? profiles.map((profile) => profile.id === saved.id ? saved : profile) : [...profiles, saved];
    setProfiles(next);
    setState((current) => {
      const active = selectConnection(next, current.activeConnectionId);
      return active === current.activeConnectionId ? current : switchConnection(current, active, startupView.current);
    });
  });
  const removeConnection = (id: string) => mutate(async () => {
    await service.deleteConnection(id);
    const next = profiles.filter((profile) => profile.id !== id);
    setProfiles(next);
    setState((current) => {
      const active = selectConnection(next, current.activeConnectionId);
      return active === current.activeConnectionId ? current : switchConnection(current, active, startupView.current);
    });
  });
  const updateQuery = (id: string, patch: Partial<Pick<QueryDocument, 'name' | 'index' | 'dsl' | 'resultView'>>) =>
    setState((current) => ({
      ...current, queries: current.queries.map((query) => query.id === id
        ? { ...query, ...patch, revision: patch.resultView ? query.revision : query.revision + 1 }
        : query),
    }));
  const closeQuery = (id: string) => setState((current) => {
    const remaining = current.queries.filter((query) => query.id !== id);
    if (!remaining.length) remaining.push(createQuery(current.activeConnectionId, startupView.current));
    return { ...current, queries: remaining, activeQueryId: current.activeQueryId === id ? remaining[0]!.id : current.activeQueryId };
  });

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
      ...state.queries.map((query, position) => ({
        id: query.id, title: query.name || `${t('query:title')} ${position + 1}`, keywords: 'query 查询',
        run: () => { setState((current) => ({ ...current, activeQueryId: query.id })); backToQuery(); },
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
      { id: 'execute', title: t('query:run'), keywords: 'execute query 执行查询', run: () => {}, disabledReason: t('query:executionPending') },
    ];

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-symbol"><ScanLine size={20} /></span><strong>EScope</strong><span className="brand-divider" />
        <span className="workspace-title">{t('workspace')}</span></div>
      <div className="header-actions">
        <div className="active-connection"><Database size={15} />
          {profiles.length > 1 ? <select aria-label={t('connections:target')} value={state.activeConnectionId ?? ''} disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              void chooseConnection(id).catch((error: unknown) => setSelectionError({ id, code: errorCode(error) }));
            }}>
            {profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.displayName}</option>)}
          </select> : <span>{active?.displayName ?? t('noConnection')}</span>}
        </div>
        <IconButton icon={Search} label={t('jump')} onClick={() => setPalette('jump')} />
        <IconButton icon={CommandIcon} label={t('command')} onClick={() => setPalette('command')} />
        <IconButton icon={Settings} label={t('settings')} aria-pressed={view === 'settings'} onClick={() => view === 'settings' ? backToQuery() : openSettings('general')} />
      </div>
    </header>
    {service.kind === 'session' ? <div className="session-banner" role="status"><span className="status-dot" />{t('session')}
      <span>{t('sessionDetail')}</span></div> : null}
    {saveError ? <div className="notice error global-error" role="alert"><TriangleAlert size={16} /><span>{t('errors:saveFailed')} {t(`errors:${saveError}`)}</span>
      <button onClick={() => updatePreferences({})}>{t('retry')}</button></div> : null}
    {selectionError ? <div className="notice error global-error" role="alert"><TriangleAlert size={16} /><span>{t(`errors:${selectionError.code}`)}</span>
      <button disabled={busy} onClick={() => {
        void chooseConnection(selectionError.id).catch((error: unknown) => setSelectionError({ id: selectionError.id, code: errorCode(error) }));
      }}>{t('retry')}</button></div> : null}
    <div className="view-container" hidden={view !== 'query'}>
      <QueryWorkspace state={state} profiles={profiles} preferences={preferences} aiOpen={aiOpen}
        toggleAI={() => setAI((value) => !value)} onSettings={openSettings} updateQuery={updateQuery}
        selectQuery={(id) => setState((current) => ({ ...current, activeQueryId: id }))} addQuery={addQuery} closeQuery={closeQuery} />
    </div>
    {view === 'settings' ? <SettingsView route={route} navigate={openSettings} back={backToQuery} preferences={preferences}
      updatePreferences={updatePreferences} connections={profiles} activeId={state.activeConnectionId} busy={busy}
      selectConnection={chooseConnection} saveConnection={saveConnection} deleteConnection={removeConnection} /> : null}
    <footer className="app-footer"><span><ShieldCheck size={13} />{t('readOnly')}</span><span><span className="status-dot" />{t('notConnected')}</span>
      <span className="footer-spacer" /><span>{savingPreferences ? <LoaderCircle size={13} className="spin" /> : null}
        {t(service.kind === 'desktop' ? 'desktop' : 'session')}</span><span>v0.1.0</span></footer>
    {palette ? <CommandPalette key={palette} kind={palette} commands={commands} onClose={() => setPalette(null)} /> : null}
  </div>;
}

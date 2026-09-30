import { Database, FileSearch, Layers, PanelRight, Play, Plus, Search, Settings, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionProfile } from '../../domain/connection';
import type { Preferences } from '../../domain/preferences';
import type { QueryDocument, WorkspaceState } from '../../domain/query';
import { EmptyState, IconButton, Modal } from '../../components/controls';
import type { SettingsRoute } from '../../app/routes';

interface Props {
  state: WorkspaceState;
  profiles: ConnectionProfile[];
  preferences: Preferences;
  aiOpen: boolean;
  toggleAI: () => void;
  onSettings: (route: SettingsRoute) => void;
  updateQuery: (id: string, patch: Partial<Pick<QueryDocument, 'name' | 'index' | 'dsl' | 'resultView'>>) => void;
  selectQuery: (id: string) => void;
  addQuery: () => void;
  closeQuery: (id: string) => void;
}

export function QueryWorkspace({ state, profiles, preferences, aiOpen, toggleAI, onSettings, updateQuery, selectQuery, addQuery, closeQuery }: Props) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState<QueryDocument | null>(null);
  const lineNumbers = useRef<HTMLDivElement | null>(null);
  const query = state.queries.find((item) => item.id === state.activeQueryId) ?? state.queries[0];
  if (!query) return null;
  const target = profiles.find((profile) => profile.id === query.connectionId);
  return <div className={`query-layout ${aiOpen ? 'ai-open' : ''}`}>
    <aside className="resource-sidebar">
      <div className="sidebar-heading"><span>{t('query:resources')}</span><IconButton icon={Plus} label={t('connections:add')} onClick={() => onSettings('connections')} /></div>
      <button className="resource-connection" onClick={() => onSettings('connections')}><Database size={17} />
        <span>{target?.displayName ?? t('noConnection')}</span></button>
      <div className="sidebar-status"><span className="status-dot" />{t(target ? 'notTested' : 'notConnected')}</div>
      <div className="resource-section"><h2>{t('query:indices')}</h2><div className="muted resource-empty"><Layers size={15} />{t('query:noIndices')}</div></div>
      <div className="resource-section"><h2>{t('query:fields')}</h2><div className="muted resource-empty">{t('query:noFields')}</div></div>
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
      <section id="query-panel" className="query-editor-section" role="tabpanel">
        <div className="query-heading"><div className="query-title-block">
          <input className="query-name" aria-label={t('query:name')} value={query.name} placeholder={t('query:title')}
            onChange={(event) => updateQuery(query.id, { name: event.target.value })} maxLength={120} />
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
            spellCheck={false} value={query.index} onChange={(event) => updateQuery(query.id, { index: event.target.value })} /></label>
          <button className="primary run-button" disabled title={t('query:executionPending')}><Play size={14} />{t('query:run')}</button>
        </div>
        <div className="dsl-editor">
          <div className="line-numbers" ref={lineNumbers} aria-hidden="true">{query.dsl.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
          <textarea aria-label={t('query:dslLabel')} spellCheck={false} autoCapitalize="off" autoComplete="off"
            value={query.dsl} onChange={(event) => updateQuery(query.id, { dsl: event.target.value })}
            onScroll={(event) => { if (lineNumbers.current) lineNumbers.current.scrollTop = event.currentTarget.scrollTop; }}
            wrap={preferences.wrapJson ? 'soft' : 'off'} />
        </div>
        <div className="editor-status"><span>{t('query:lines', { count: query.dsl.split('\n').length })}</span>
          <span>{t('query:chars', { count: query.dsl.length })}</span><span className="status-spacer" /><span>JSON</span><span>UTF-8</span></div>
      </section>
      <section className="results-section" aria-label={t('query:results')}>
        <div className="results-toolbar"><h2>{t('query:results')}</h2><span className="muted">{t('query:noDocuments')}</span>
          <div className="segment" role="group" aria-label={t('query:resultView')}>
            {(['table', 'json'] as const).map((view) => <button key={view} aria-pressed={query.resultView === view}
              onClick={() => updateQuery(query.id, { resultView: view })}>{t(`query:${view}`)}</button>)}
          </div>
        </div>
        <EmptyState icon={Search} title={t('query:noResults')} description={t('query:noResultsDetail')} />
      </section>
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

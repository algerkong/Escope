import { ArrowLeft, Boxes, Cable, Database, Globe, Keyboard, Layers, Monitor, Search, Server, Settings2, Sparkles, Type } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { settingsGroups, type SettingsRoute } from './routes';
import type { ConnectionInput, ConnectionProfile } from '../domain/connection';
import type { Preferences } from '../domain/preferences';
import { EmptyState } from '../components/controls';
import { ConnectionPanel } from '../features/connections/ConnectionPanel';
import { PreferencesPanel } from '../features/settings/PreferencesPanel';

const icons = { general: Globe, appearance: Monitor, typography: Type, shortcuts: Keyboard,
  connections: Cable, models: Sparkles, cluster: Database, nodes: Server, shards: Boxes, indices: Layers };

interface Props {
  route: SettingsRoute;
  navigate: (route: SettingsRoute) => void;
  back: () => void;
  preferences: Preferences;
  updatePreferences: (patch: Partial<Preferences>) => void;
  connections: ConnectionProfile[];
  activeId: string | null;
  busy: boolean;
  selectConnection: (id: string) => Promise<void>;
  saveConnection: (input: ConnectionInput, id?: string) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
}

export function SettingsView(props: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const { route } = props;
  const isManagement = ['connections', 'cluster', 'nodes', 'shards', 'indices'].includes(route);
  const Icon = icons[route];
  return <div className="settings-layout">
    <aside className="settings-sidebar">
      <button className="back-button" onClick={props.back}><ArrowLeft size={17} />{t('back')}</button>
      <label className="search-input settings-search"><Search size={16} /><input aria-label={t('settings:search')}
        placeholder={t('settings:search')} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <nav aria-label={t('settings')}>
        {settingsGroups.map((group) => {
          const routes = group.routes.filter((item) => `${t(`settings:${item}`)} ${item}`.toLowerCase().includes(search.toLowerCase()));
          return routes.length ? <div className="settings-nav-group" key={group.id}>
            <h2>{t(`settings:${group.id}`)}</h2>
            {routes.map((item) => {
              const ItemIcon = icons[item];
              return <button key={item} className="settings-nav-item" aria-current={route === item ? 'page' : undefined}
                onClick={() => props.navigate(item)}><ItemIcon size={17} /><span>{t(`settings:${item}`)}</span></button>;
            })}
          </div> : null;
        })}
        {!settingsGroups.some((group) => group.routes.some((item) => `${t(`settings:${item}`)} ${item}`.toLowerCase().includes(search.toLowerCase()))) ?
          <p className="muted settings-no-matches">{t('noMatches')}</p> : null}
      </nav>
      <div className="settings-version"><Settings2 size={15} />{t('settings:about')}</div>
    </aside>
    <main className="settings-main"><div className={`settings-content ${isManagement ? 'wide' : ''}`}>
      <h1 tabIndex={-1} id="settings-title"><Icon size={21} />{t(`settings:${route}`)}</h1>
      {['general', 'appearance', 'typography', 'shortcuts'].includes(route) ?
        <PreferencesPanel route={route} preferences={props.preferences} update={props.updatePreferences} /> :
        route === 'connections' ? <ConnectionPanel connections={props.connections} activeId={props.activeId} busy={props.busy}
          onSelect={props.selectConnection} onSave={props.saveConnection} onDelete={props.deleteConnection} /> :
          <div className="resource-placeholder">
            <div className="resource-target muted"><Database size={16} />{props.connections.find((item) => item.id === props.activeId)?.displayName ?? t('noConnection')}
              <span>{t('notConnected')}</span></div>
            <EmptyState icon={Icon} title={t(route === 'models' ? 'settings:noModel' : 'settings:noMetrics')}
              description={t(route === 'models' ? 'settings:modelPending' : 'settings:resourcePending')}>
              {route !== 'models' && !props.activeId ? <button className="secondary" onClick={() => props.navigate('connections')}>
                <Cable size={15} />{t('connections:add')}</button> : null}
            </EmptyState>
          </div>}
    </div></main>
  </div>;
}

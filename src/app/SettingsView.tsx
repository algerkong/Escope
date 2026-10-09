import { ArrowLeft, Boxes, Cable, Database, Globe, Keyboard, Layers, Monitor, Search, Server, Settings2, Sparkles, Type } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { settingsGroups, type SettingsRoute } from './routes';
import type { ConnectionInput, ConnectionProfile } from '../domain/connection';
import type { Preferences } from '../domain/preferences';
import type { AiChatBackend } from '../domain/ai-chat';
import { ConnectionPanel } from '../features/connections/ConnectionPanel';
import { connectionTestLabel, type ConnectionTestState } from '../features/connections/useConnectionTests';
import { ClusterResource } from '../features/cluster/ClusterResource';
import { ModelPanel } from '../features/models/ModelPanel';
import { PreferencesPanel } from '../features/settings/PreferencesPanel';
import type { ClusterBackend } from '../services/cluster';
import type { ModelService } from '../services/models';

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
  canTest: boolean;
  testResults: Record<string, ConnectionTestState>;
  testConnection: (id: string) => void;
  selectConnection: (id: string) => Promise<void>;
  saveConnection: (input: ConnectionInput, id?: string) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  /** Injectable read-only metadata backend; component tests pass a fake, the app uses the IPC. */
  clusterBackend?: ClusterBackend;
  /** Model profile persistence; the app passes the desktop/session service created once at startup. */
  modelService?: ModelService;
  aiBackend?: AiChatBackend;
}

export function SettingsView(props: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const { route } = props;
  const isManagement = ['connections', 'models', 'cluster', 'nodes', 'shards', 'indices'].includes(route);
  const activeProfile = props.connections.find((item) => item.id === props.activeId) ?? null;
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
      {route === 'general' || route === 'appearance' || route === 'typography' || route === 'shortcuts' ?
        <PreferencesPanel route={route} preferences={props.preferences} update={props.updatePreferences} /> :
        route === 'connections' ? <ConnectionPanel connections={props.connections} activeId={props.activeId} busy={props.busy}
          canTest={props.canTest} testResults={props.testResults} timeZone={props.preferences.timeZone} onTest={props.testConnection}
          onSelect={props.selectConnection} onSave={props.saveConnection} onDelete={props.deleteConnection} /> :
        route === 'models' ? <ModelPanel service={props.modelService} backend={props.aiBackend} /> :
        <ClusterResource route={route} profile={activeProfile} desktop={props.canTest}
          testLabel={t(props.activeId ? connectionTestLabel(props.testResults[props.activeId]) : 'notConnected')}
          backend={props.clusterBackend} onAddConnection={() => props.navigate('connections')} />}
    </div></main>
  </div>;
}

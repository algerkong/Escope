import { Cable, Database, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import type { ClusterBackend } from '../../services/cluster';
import { ClusterOverview } from './ClusterOverview';
import { IndicesPanel } from './IndicesPanel';
import { NodesPanel } from './NodesPanel';
import { ShardsPanel } from './ShardsPanel';
import { ClusterTarget } from './parts';
import '../../styles/cluster.css';

export type ClusterRoute = 'cluster' | 'nodes' | 'shards' | 'indices';

interface Props {
  route: ClusterRoute;
  profile: ConnectionProfile | null;
  /** Desktop builds can read live metadata; the browser preview must not pretend to. */
  desktop: boolean;
  /** Already localized connection test state for the target line. */
  testLabel: string;
  backend?: ClusterBackend;
  onAddConnection: () => void;
}

/**
 * Read-only cluster resource pages inside the settings container.
 *
 * The fixed settings sidebar stays; only the right-hand area changes. Without a connection the
 * page offers the connection entry, and in the browser preview it states that live metadata needs
 * the desktop app instead of showing fixture data.
 */
export function ClusterResource({ route, profile, desktop, testLabel, backend, onAddConnection }: Props) {
  const { t } = useTranslation();
  if (profile === null) {
    return <div className="resource-placeholder">
      <EmptyState icon={Database} title={t('common:noConnection')} description={t('settings:connectionRequired')}>
        <button type="button" className="secondary" onClick={onAddConnection}>
          <Cable size={15} />{t('connections:add')}</button>
      </EmptyState>
    </div>;
  }
  // A new connection or endpoint is a new target: the panel is remounted so no filter, paging or
  // detail view from the previous target survives, and the in-flight read is cancelled on unmount.
  const targetKey = `${profile.id}|${profile.endpoint}`;
  return <div className="cluster-page">
    <ClusterTarget name={profile.displayName} endpoint={profile.endpoint} status={testLabel} />
    {desktop ? (route === 'cluster'
      ? <ClusterOverview key={targetKey} connectionId={profile.id} endpoint={profile.endpoint} backend={backend} />
      : route === 'nodes'
        ? <NodesPanel key={targetKey} connectionId={profile.id} endpoint={profile.endpoint} backend={backend} />
        : route === 'shards'
          ? <ShardsPanel key={targetKey} connectionId={profile.id} endpoint={profile.endpoint} backend={backend} />
          : <IndicesPanel key={targetKey} connectionId={profile.id} endpoint={profile.endpoint} backend={backend} />)
      : <div className="notice warning cluster-notice" role="status">
        <Monitor size={16} /><span>{t('cluster:desktopOnly')}</span></div>}
  </div>;
}

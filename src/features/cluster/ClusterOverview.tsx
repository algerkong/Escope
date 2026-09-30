import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { healthMeaning, parseClusterHealth, type ClusterHealth, type HealthMeaning, type HealthStatus } from '../../domain/cluster';
import type { ClusterBackend } from '../../services/cluster';
import { ClusterState, ClusterToolbar, RawJsonModal } from './parts';
import { useClusterRead } from './useClusterResources';

const STATUS_KEY: Record<HealthStatus, string> = {
  green: 'cluster:statusGreen', yellow: 'cluster:statusYellow', red: 'cluster:statusRed',
};

const MEANING_KEY: Record<HealthMeaning, string> = {
  healthy: 'cluster:meaningHealthy', replicasUnassigned: 'cluster:meaningReplicas',
  primariesUnassigned: 'cluster:meaningPrimaries', unassignedReported: 'cluster:meaningUnassigned',
  unknown: 'cluster:meaningUnknown',
};

interface Props {
  connectionId: string;
  endpoint: string;
  backend?: ClusterBackend;
}

/**
 * Cluster health overview. Counters are printed as the exact tokens the cluster returned, and a
 * metric the server did not report stays unknown rather than reading as `0`. The allocation
 * meaning of green/yellow/red is spelled out, because health never describes latency or load.
 */
export function ClusterOverview({ connectionId, endpoint, backend }: Props) {
  const { t } = useTranslation();
  const [rawOpen, setRawOpen] = useState(false);
  const { state, refresh, cancel } = useClusterRead({
    kind: 'clusterHealth', connectionId, endpoint, enabled: true, parse: parseClusterHealth, backend,
  });
  const health: ClusterHealth | null = state.status === 'ready' ? state.data : null;
  const unknown = <span className="muted">{t('cluster:unknown')}</span>;
  const rows: { label: string; value: string | null }[] = health ? [
    { label: t('cluster:clusterName'), value: health.clusterName },
    { label: t('cluster:nodes'), value: health.numberOfNodes?.text ?? null },
    { label: t('cluster:dataNodes'), value: health.numberOfDataNodes?.text ?? null },
    { label: t('cluster:activePrimaryShards'), value: health.activePrimaryShards?.text ?? null },
    { label: t('cluster:activeShards'), value: health.activeShards?.text ?? null },
    { label: t('cluster:relocatingShards'), value: health.relocatingShards?.text ?? null },
    { label: t('cluster:initializingShards'), value: health.initializingShards?.text ?? null },
    { label: t('cluster:unassignedShards'), value: health.unassignedShards?.text ?? null },
    { label: t('cluster:delayedUnassignedShards'), value: health.delayedUnassignedShards?.text ?? null },
    { label: t('cluster:activeShardsPercent'), value: health.activeShardsPercent === null ? null : `${health.activeShardsPercent}%` },
    { label: t('cluster:pendingTasks'), value: health.numberOfPendingTasks?.text ?? null },
    { label: t('cluster:inFlightFetch'), value: health.numberOfInFlightFetch?.text ?? null },
    {
      label: t('cluster:maxQueueWait'),
      value: health.taskMaxWaitingTimeInQueue === null ? null : t('cluster:milliseconds', { value: health.taskMaxWaitingTimeInQueue }),
    },
  ] : [];

  return <section className="cluster-section" aria-label={t('cluster:health')}>
    <ClusterToolbar title={t('cluster:health')} onRefresh={refresh}>
      <button type="button" className="secondary compact-button" disabled={health === null}
        onClick={() => setRawOpen(true)}>{t('cluster:viewRaw')}</button>
    </ClusterToolbar>
    <ClusterState state={state} onRetry={refresh} onCancel={cancel} />
    {health ? <>
      <div className="cluster-health">
        <span className={`cluster-health-badge ${health.status ?? 'unknown'}`}>
          {t(health.status === null ? 'cluster:statusUnknown' : STATUS_KEY[health.status])}</span>
        <p className="cluster-meaning">{t(MEANING_KEY[healthMeaning(health)])}</p>
      </div>
      {health.timedOut ? <div className="notice warning cluster-notice" role="status">
        <TriangleAlert size={16} /><span>{t('cluster:healthTimedOut')}</span></div> : null}
      <dl className="cluster-metrics">{rows.map((row) => <div className="cluster-metric" key={row.label}>
        <dt>{row.label}</dt>
        <dd>{row.value ?? unknown}</dd>
      </div>)}</dl>
      <p className="muted small">{t('cluster:healthNote')}</p>
    </> : null}
    <RawJsonModal open={rawOpen} onClose={() => setRawOpen(false)} title={t('cluster:rawTitle')}
      text={state.status === 'ready' ? state.raw : ''} />
  </section>;
}

import { Server, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/controls';
import { parseNodesStats, type NodeStats, type NodesStats } from '../../domain/cluster';
import { sliceRaw } from '../../domain/query-result';
import type { ClusterBackend } from '../../services/cluster';
import { CLUSTER_PAGE_SIZE, ClusterBadge, ClusterPaging, ClusterState, ClusterToolbar, RawJsonModal } from './parts';
import { useClusterRead, usePaging } from './useClusterResources';

interface Props {
  connectionId: string;
  endpoint: string;
  backend?: ClusterBackend;
}

/** A detail view keeps the response it was opened from, never an offset into a later body. */
interface NodeDetail {
  readonly node: NodeStats;
  readonly raw: string;
}

/**
 * Node statistics from `_nodes/stats`. Heap, CPU, file system and load values are the node's own
 * reported values, and a value that is missing or not a plausible measurement stays unknown.
 * Thread-pool rejections are the cumulative `rejected` counters since the node started, never a
 * rate, and the exact sum is shown as text so a large counter is never rounded. A partial
 * `_nodes` answer is stated as partial while the nodes that did answer stay visible.
 */
export function NodesPanel({ connectionId, endpoint, backend }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const { state, refresh, cancel } = useClusterRead({
    kind: 'nodesStats', connectionId, endpoint, enabled: true, parse: parseNodesStats, backend,
  });
  const stats: NodesStats | null = state.status === 'ready' ? state.data : null;
  const raw = state.status === 'ready' ? state.raw : '';
  // The detail view belongs to one response: refreshing, or switching target, closes it so a
  // stale range can never be sliced out of a newer body.
  useEffect(() => { setDetail(null); }, [raw, connectionId, endpoint]);
  const nodes = useMemo(() => stats?.nodes ?? [], [stats]);
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle === '' ? nodes : nodes.filter((node) =>
      (node.name ?? '').toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle));
  }, [nodes, filter]);
  const paging = usePaging(filtered, CLUSTER_PAGE_SIZE);
  const unknown = <span className="muted">{t('cluster:unknown')}</span>;
  const unknownText = t('cluster:unknown');
  const completeness = stats === null || stats.completeness === 'complete' ? null
    : stats.completeness === 'partial'
      ? t('cluster:nodesPartial', {
        successful: stats.successful?.text ?? unknownText,
        total: stats.total?.text ?? unknownText,
        failed: stats.failed?.text ?? unknownText,
      })
      : t('cluster:nodesCompletenessUnknown');

  return <section className="cluster-section" aria-label={t('cluster:nodesTitle')}>
    <ClusterToolbar title={t('cluster:nodesTitle')} onRefresh={refresh}>
      <label className="cluster-filter"><span className="sr-only">{t('cluster:filterNodes')}</span>
        <input type="search" value={filter} placeholder={t('cluster:filterNodes')}
          onChange={(event) => { setFilter(event.target.value); paging.setPage(0); }} /></label>
    </ClusterToolbar>
    <ClusterState state={state} onRetry={refresh} onCancel={cancel} />
    {completeness === null ? null : <div className="notice warning cluster-notice" role="status">
      <TriangleAlert size={16} /><span>{completeness}</span></div>}
    {state.status === 'ready' ? (nodes.length === 0
      ? <EmptyState icon={Server} title={t('cluster:noNodes')} description={t('cluster:noNodesDetail')} />
      : <>
        <div className="cluster-table-wrap"><table className="cluster-table">
          <thead><tr>
            <th>{t('cluster:nodeName')}</th><th>{t('cluster:nodeId')}</th><th>{t('cluster:roles')}</th>
            <th>{t('cluster:heap')}</th><th>{t('cluster:cpu')}</th><th>{t('cluster:load')}</th>
            <th>{t('cluster:fsTotal')}</th><th>{t('cluster:fsAvailable')}</th>
            <th>{t('cluster:rejections')}</th><th><span className="sr-only">{t('cluster:viewRaw')}</span></th>
          </tr></thead>
          <tbody>{paging.visible.map((node) => <tr key={node.id}>
            <td className="cluster-strong">{node.name ?? unknown}</td>
            <td className="cluster-mono">{node.id}</td>
            <td>{node.roles.length === 0 ? unknown
              : <span className="cluster-badges">{node.roles.map((role) => <ClusterBadge key={role}>{role}</ClusterBadge>)}</span>}</td>
            <td>{node.heapPercent === null ? unknown : <>
              <span>{node.heapPercent}%</span>
              {node.heapUsed !== null && node.heapMax !== null
                ? <span className="muted small cluster-sub">{node.heapUsed} / {node.heapMax} B</span> : null}
            </>}</td>
            <td>{node.cpuPercent === null ? unknown : `${node.cpuPercent}%`}</td>
            <td className="cluster-mono">{node.loadAverage ?? unknown}</td>
            <td className="cluster-mono">{node.fsTotal ?? unknown}</td>
            <td className="cluster-mono">{node.fsAvailable ?? unknown}</td>
            <td>{node.threadPoolRejections === null ? unknown : <>
              <span className="cluster-mono">{node.threadPoolRejections}</span>
              {node.rejectingPools.length > 0 ? <span className="muted small cluster-sub">
                {node.rejectingPools.map((pool) => `${pool.pool} ${pool.rejected}`).join(' · ')}</span> : null}
            </>}</td>
            <td><button type="button" className="secondary compact-button"
              onClick={() => setDetail({ node, raw })}>{t('cluster:viewRaw')}</button></td>
          </tr>)}</tbody>
        </table></div>
        {filtered.length === 0
          ? <p className="muted small cluster-note">{t('cluster:noNodeMatches')}</p>
          : filtered.length > CLUSTER_PAGE_SIZE ? <ClusterPaging page={paging.page} pageCount={paging.pageCount}
            shown={paging.visible.length} total={filtered.length} onPage={paging.setPage} /> : null}
        <p className="muted small cluster-note">{t('cluster:rejectionsHint')}</p>
      </>) : null}
    <RawJsonModal open={detail !== null} onClose={() => setDetail(null)}
      title={t('cluster:nodeDetail', { name: detail?.node.name ?? detail?.node.id ?? '' })}
      text={detail?.node.range ? sliceRaw(detail.raw, detail.node.range) : ''} />
  </section>;
}

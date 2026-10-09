import { Boxes } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, SelectControl } from '../../components/controls';
import { TableSelectionStatus } from '../../components/TableSelectionStatus';
import { useTableRowSelection } from '../../components/useTableRowSelection';
import { parseShards, shardStateCounts, type ShardRow } from '../../domain/cluster';
import type { ClusterBackend } from '../../services/cluster';
import { CLUSTER_PAGE_SIZE, ClusterPaging, ClusterState, ClusterToolbar } from './parts';
import { useClusterRead, usePaging } from './useClusterResources';

interface Props {
  connectionId: string;
  endpoint: string;
  backend?: ClusterBackend;
}

/**
 * Shard list from `_cat/shards` (JSON projection). The table is filtered and locally paged, so a
 * cluster with many shards never renders every row at once. Primary and replica are labelled
 * explicitly, and an unassigned shard keeps the reason the cluster reported. This is not the full
 * cluster state and does not diagnose recovery.
 */
export function ShardsPanel({ connectionId, endpoint, backend }: Props) {
  const { t } = useTranslation();
  const [indexFilter, setIndexFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const { state, refresh, cancel } = useClusterRead({
    kind: 'shards', connectionId, endpoint, enabled: true, parse: parseShards, backend,
  });
  const rows = useMemo<readonly ShardRow[]>(
    () => state.status === 'ready' ? state.data : [],
    [state],
  );
  const states = useMemo(() => shardStateCounts(rows), [rows]);
  const ready = state.status === 'ready';
  useEffect(() => {
    if (ready) setStateFilter((current) => states.some((item) => item.state === current) ? current : '');
  }, [ready, states]);
  const filtered = useMemo(() => {
    const needle = indexFilter.trim().toLowerCase();
    return rows.filter((row) => (needle === '' || row.index.toLowerCase().includes(needle))
      && (stateFilter === '' || row.state === stateFilter));
  }, [rows, indexFilter, stateFilter]);
  const paging = usePaging(filtered, CLUSTER_PAGE_SIZE);
  const rowKeys = useMemo(() => new Map(rows.map((row, index) => [row, `shard:${index}`])), [rows]);
  const rowIds = useMemo(() => filtered.map((row) => rowKeys.get(row)!), [filtered, rowKeys]);
  const visibleRowIds = paging.visible.map((row) => rowKeys.get(row)!);
  const rowSelection = useTableRowSelection({ rowIds, visibleRowIds, scope: rows });

  return <section className="cluster-section" aria-label={t('cluster:shardsTitle')}>
    <ClusterToolbar title={t('cluster:shardsTitle')} onRefresh={refresh}>
      <label className="cluster-filter"><span className="sr-only">{t('cluster:filterIndex')}</span>
        <input type="search" value={indexFilter} placeholder={t('cluster:filterIndex')}
          onChange={(event) => { setIndexFilter(event.target.value); paging.setPage(0); }} /></label>
      <label className="cluster-filter"><span className="sr-only">{t('cluster:filterState')}</span>
        <SelectControl value={stateFilter} aria-label={t('cluster:filterState')}
          onChange={(event) => { setStateFilter(event.target.value); paging.setPage(0); }}>
          <option value="">{t('cluster:allStates')}</option>
          {states.map((item) => <option key={item.state} value={item.state}>{item.state}</option>)}
        </SelectControl></label>
      <TableSelectionStatus count={rowSelection.selectedCount} onClear={rowSelection.clear} />
    </ClusterToolbar>
    <ClusterState state={state} onRetry={refresh} onCancel={cancel} />
    {state.status === 'ready' ? (rows.length === 0
      ? <EmptyState icon={Boxes} title={t('cluster:noShards')} description={t('cluster:noShardsDetail')} />
      : <>
        <div className="cluster-chips" aria-label={t('cluster:states')}>
          <span className="muted small">{t('cluster:shardCount', { count: rows.length })}</span>
          {states.map((item) => <span className={`cluster-badge${item.state === 'UNASSIGNED' ? ' warn' : ''}`} key={item.state}>
            {item.state} {item.count}</span>)}
        </div>
        <div className="cluster-table-wrap"><table className="cluster-table">
          <thead><tr>
            <th>{t('cluster:indexColumn')}</th><th>{t('cluster:shardColumn')}</th><th>{t('cluster:roleColumn')}</th>
            <th>{t('cluster:stateColumn')}</th><th>{t('cluster:docsColumn')}</th><th>{t('cluster:storeColumn')}</th>
            <th>{t('cluster:ipColumn')}</th><th>{t('cluster:nodeColumn')}</th><th>{t('cluster:reasonColumn')}</th>
          </tr></thead>
          <tbody ref={rowSelection.bodyRef} {...rowSelection.bodyProps}>
            {paging.visible.map((row) => <tr key={rowKeys.get(row)} {...rowSelection.rowProps(rowKeys.get(row)!)}>
            <td className="cluster-mono cluster-strong">{row.index}</td>
            <td className="cluster-mono">{row.shard}</td>
            <td><span className="cluster-role" data-role={row.primary === null ? 'unknown' : row.primary ? 'primary' : 'replica'}>
              {t(row.primary === null ? 'cluster:unknown' : row.primary ? 'cluster:primary' : 'cluster:replica')}</span></td>
            <td className="cluster-mono">{row.state ?? <span className="muted">{t('cluster:unknown')}</span>}</td>
            <td className="cluster-mono">{row.docs ?? <span className="muted">{t('cluster:unknown')}</span>}</td>
            <td className="cluster-mono">{row.store ?? <span className="muted">{t('cluster:unknown')}</span>}</td>
            <td className="cluster-mono">{row.ip ?? <span className="muted">{t('cluster:unknown')}</span>}</td>
            <td className="cluster-mono">{row.node ?? <span className="muted">{t('cluster:unknown')}</span>}</td>
            <td>{row.unassignedReason ?? <span className="muted">—</span>}</td>
          </tr>)}</tbody>
        </table></div>
        {filtered.length === 0
          ? <p className="muted small cluster-note">{t('cluster:noShardMatches')}</p>
          : filtered.length > CLUSTER_PAGE_SIZE ? <ClusterPaging page={paging.page} pageCount={paging.pageCount}
            shown={paging.visible.length} total={filtered.length} onPage={paging.setPage} /> : null}
        <p className="muted small cluster-note">{t('cluster:shardsSource')}</p>
      </>) : null}
  </section>;
}

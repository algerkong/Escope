import { Layers } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, Modal } from '../../components/controls';
import { isValidIndexTarget, parseIndexSettings } from '../../domain/cluster';
import { parseIndexCatalog, parseMappingFields } from '../../domain/resource';
import { sliceRaw } from '../../domain/query-result';
import type { ClusterBackend } from '../../services/cluster';
import { useCopyText } from '../query/useCopyText';
import { CLUSTER_PAGE_SIZE, ClusterBadge, ClusterPaging, ClusterState, ClusterToolbar } from './parts';
import { useClusterRead, usePaging } from './useClusterResources';

interface Props {
  connectionId: string;
  endpoint: string;
  backend?: ClusterBackend;
}

/** Bounded detail rendering: a huge mapping or settings body is never fully rendered at once. */
const MAX_FIELDS = 400;
const MAX_SETTINGS_INDICES = 20;

type CatalogType = 'index' | 'alias' | 'dataStream';

interface CatalogRow {
  readonly name: string;
  readonly type: CatalogType;
  readonly badges: readonly { label: string; warn: boolean }[];
  readonly info: string | null;
}

const TYPE_KEY: Record<CatalogType, string> = {
  index: 'cluster:typeIndex', alias: 'cluster:typeAlias', dataStream: 'cluster:typeDataStream',
};

/**
 * Read-only index, alias and data-stream catalog with mapping and settings detail.
 *
 * Listing a target needs no monitoring privilege: a user who knows an index can type it and load
 * its mapping and settings even when discovery is denied. Both detail reads are independent, so a
 * mapping failure still leaves the settings readable, and neither is started by opening the page.
 */
export function IndicesPanel({ connectionId, endpoint, backend }: Props) {
  const { t } = useTranslation();
  const copy = useCopyText();
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState('');
  const [detailTarget, setDetailTarget] = useState<string | null>(null);
  const catalogRead = useClusterRead({
    kind: 'indices', connectionId, endpoint, enabled: true, parse: parseIndexCatalog, backend,
  });
  const detail = detailTarget !== null;
  const mapping = useClusterRead({
    kind: 'mapping', index: detailTarget ?? undefined, connectionId, endpoint, enabled: detail,
    parse: parseMappingFields, backend,
  });
  const settings = useClusterRead({
    kind: 'indexSettings', index: detailTarget ?? undefined, connectionId, endpoint, enabled: detail,
    parse: parseIndexSettings, backend,
  });
  const catalog = catalogRead.state.status === 'ready' ? catalogRead.state.data : null;
  const rows = useMemo((): CatalogRow[] => {
    if (catalog === null) return [];
    return [
      ...catalog.indices.map((index): CatalogRow => ({
        name: index.name,
        type: 'index',
        badges: [
          ...(index.hidden ? [{ label: t('cluster:badgeHidden'), warn: true }] : []),
          ...(index.system ? [{ label: t('cluster:badgeSystem'), warn: true }] : []),
          ...(index.closed ? [{ label: t('cluster:badgeClosed'), warn: true }] : []),
          ...(index.dataStream === null ? [] : [{ label: `${t('cluster:typeDataStream')}: ${index.dataStream}`, warn: false }]),
        ],
        info: index.aliases.length === 0 ? null : index.aliases.join(', '),
      })),
      ...catalog.aliases.map((alias): CatalogRow => ({
        name: alias.name, type: 'alias', badges: [],
        info: alias.indices.length === 0 ? null : alias.indices.join(', '),
      })),
      ...catalog.dataStreams.map((stream): CatalogRow => ({
        name: stream.name, type: 'dataStream', badges: [],
        info: [
          t('cluster:backingIndices', { count: stream.backingIndices.length }),
          stream.timestampField === null ? null : `${t('cluster:timestampField')}: ${stream.timestampField}`,
        ].filter(Boolean).join(' · '),
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog, t]);
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(needle));
  }, [rows, filter]);
  const paging = usePaging(filtered, CLUSTER_PAGE_SIZE);
  const fields = mapping.state.status === 'ready' ? mapping.state.data : null;
  const mappingRaw = mapping.state.status === 'ready' ? mapping.state.raw : '';
  const settingsEntries = settings.state.status === 'ready' ? settings.state.data : null;
  const settingsRaw = settings.state.status === 'ready' ? settings.state.raw : '';
  const manualValid = isValidIndexTarget(manual);
  const copyNote = copy.status === 'idle' ? null
    : <span className={`cluster-copy-note ${copy.status}`} role="status">
      {copy.status === 'failed' ? t('cluster:copyFailed') : t('cluster:copied')}</span>;

  return <section className="cluster-section" aria-label={t('cluster:indicesTitle')}>
    <ClusterToolbar title={t('cluster:indicesTitle')} onRefresh={catalogRead.refresh}>
      <label className="cluster-filter"><span className="sr-only">{t('cluster:filterIndices')}</span>
        <input type="search" value={filter} placeholder={t('cluster:filterIndices')}
          onChange={(event) => { setFilter(event.target.value); paging.setPage(0); }} /></label>
    </ClusterToolbar>
    <ClusterState state={catalogRead.state} onRetry={catalogRead.refresh} onCancel={catalogRead.cancel} />
    <div className="cluster-manual">
      <label className="cluster-filter"><span className="sr-only">{t('cluster:manualTarget')}</span>
        <input value={manual} placeholder={t('cluster:manualTarget')} aria-invalid={manual !== '' && !manualValid}
          aria-label={t('cluster:manualTarget')} onChange={(event) => setManual(event.target.value)} /></label>
      <button type="button" className="secondary compact-button" disabled={!manualValid}
        onClick={() => setDetailTarget(manual.trim())}>{t('cluster:loadDetails')}</button>
      {manual !== '' && !manualValid
        ? <span className="cluster-hint error" role="alert">{t('cluster:invalidTarget')}</span> : null}
    </div>
    <p className="muted small cluster-note">{t('cluster:manualHint')}</p>
    {catalogRead.state.status === 'ready' ? (rows.length === 0
      ? <EmptyState icon={Layers} title={t('cluster:noIndices')} description={t('cluster:noIndicesDetail')} />
      : <>
        <div className="cluster-table-wrap"><table className="cluster-table">
          <thead><tr>
            <th>{t('cluster:nameColumn')}</th><th>{t('cluster:typeColumn')}</th><th>{t('cluster:flagsColumn')}</th>
            <th>{t('cluster:infoColumn')}</th><th><span className="sr-only">{t('cluster:details')}</span></th>
          </tr></thead>
          <tbody>{paging.visible.map((row) => <tr key={`${row.type}|${row.name}`}>
            <td className="cluster-mono cluster-strong">{row.name}</td>
            <td>{t(TYPE_KEY[row.type])}</td>
            <td>{row.badges.length === 0 ? <span className="muted">—</span>
              : <span className="cluster-badges">{row.badges.map((badge) => <ClusterBadge key={badge.label}
                tone={badge.warn ? 'warn' : undefined}>{badge.label}</ClusterBadge>)}</span>}</td>
            <td className="muted small">{row.info ?? '—'}</td>
            <td><button type="button" className="secondary compact-button"
              onClick={() => setDetailTarget(row.name)}>{t('cluster:details')}</button></td>
          </tr>)}</tbody>
        </table></div>
        {filtered.length === 0
          ? <p className="muted small cluster-note">{t('cluster:noIndexMatches')}</p>
          : filtered.length > CLUSTER_PAGE_SIZE ? <ClusterPaging page={paging.page} pageCount={paging.pageCount}
            shown={paging.visible.length} total={filtered.length} onPage={paging.setPage} /> : null}
      </>) : null}
    <Modal open={detail} onClose={() => setDetailTarget(null)}
      title={t('cluster:detailTitle', { index: detailTarget ?? '' })} description={t('cluster:detailHint')}>
      <section className="cluster-detail-section">
        <h3 className="subheading">{t('cluster:mapping')}</h3>
        <ClusterState state={mapping.state} onRetry={mapping.refresh} onCancel={mapping.cancel} />
        {fields === null ? null : fields.length === 0
          ? <p className="muted small">{t('cluster:mappingEmpty')}</p>
          : <>
            <div className="cluster-table-wrap cluster-detail-table"><table className="cluster-table">
              <thead><tr><th>{t('cluster:indexColumn')}</th><th>{t('cluster:mappingField')}</th>
                <th>{t('cluster:mappingType')}</th></tr></thead>
              <tbody>{fields.slice(0, MAX_FIELDS).map((field, position) => <tr key={`${field.index}|${field.path}|${position}`}>
                <td className="cluster-mono">{field.index}</td>
                <td className="cluster-mono">{field.path}</td>
                <td>{field.type}</td>
              </tr>)}</tbody>
            </table></div>
            {fields.length > MAX_FIELDS ? <p className="muted small cluster-note">
              {t('cluster:rowsCapped', { shown: MAX_FIELDS, total: fields.length })}</p> : null}
          </>}
        <div className="cluster-actions">
          <button type="button" className="secondary compact-button" disabled={mappingRaw === ''}
            onClick={() => copy.copy(mappingRaw)}>{t('cluster:copyRaw')}</button>
        </div>
      </section>
      <section className="cluster-detail-section">
        <h3 className="subheading">{t('cluster:settings')}</h3>
        <ClusterState state={settings.state} onRetry={settings.refresh} onCancel={settings.cancel} />
        {settingsEntries === null ? null : settingsEntries.length === 0
          ? <p className="muted small">{t('cluster:settingsEmpty')}</p>
          : <>
            {settingsEntries.slice(0, MAX_SETTINGS_INDICES).map((entry) => <div key={entry.index}>
              <div className="cluster-settings-index cluster-mono">{entry.index}</div>
              <pre className="cluster-pre">{sliceRaw(settingsRaw, entry.range)}</pre>
            </div>)}
            {settingsEntries.length > MAX_SETTINGS_INDICES ? <p className="muted small cluster-note">
              {t('cluster:rowsCapped', { shown: MAX_SETTINGS_INDICES, total: settingsEntries.length })}</p> : null}
          </>}
        <div className="cluster-actions">
          <button type="button" className="secondary compact-button" disabled={settingsRaw === ''}
            onClick={() => copy.copy(settingsRaw)}>{t('cluster:copyRaw')}</button>
        </div>
      </section>
      {copyNote ? <div className="cluster-actions">{copyNote}</div> : null}
    </Modal>
  </section>;
}

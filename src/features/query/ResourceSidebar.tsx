import { ChevronRight, Layers, LoaderCircle, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import type { FieldCapability, FieldCatalog, IndexCatalog } from '../../domain/resource';
import type { Loadable, MappingState } from './useQueryResources';
import { resourceErrorKey } from './error-message';
import { useCopyText } from './useCopyText';

/** Bound the rendered lists: the filters narrow a large cluster without unbounded DOM. */
const MAX_VISIBLE_INDICES = 200;
const MAX_VISIBLE_FIELDS = 150;
const MAX_MAPPING_ROWS = 300;

interface Props {
  active?: boolean;
  available: boolean;
  connectionId: string | null;
  index: string;
  indices: Loadable<IndexCatalog>;
  fields: Loadable<FieldCatalog>;
  mappingFor: (index: string) => Loadable<MappingState>;
  onSelectIndex: (name: string) => void;
  onRefreshIndices: () => void;
  onLoadFields: () => void;
  onLoadMapping: (index: string) => void;
}

/**
 * Read-only resource sidebar: discovered indices (with hidden/system/data-stream markers),
 * field capabilities for the current target, and the mapping detail.
 *
 * An explicit index click delegates a read-only data preview to the workspace, never a draft
 * edit. Capability details are on demand and metadata fields start collapsed.
 * When live reads are unavailable nothing is requested and no retry is offered.
 */
export function ResourceSidebar({ active = true, available, connectionId, index, indices, fields, mappingFor, onSelectIndex, onRefreshIndices, onLoadFields, onLoadMapping }: Props) {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState('');
  const [fieldFilters, setFieldFilters] = useState<Record<string, string>>({});
  const fieldFilter = fieldFilters[index] ?? '';
  const [mappingIndex, setMappingIndex] = useState<string | null>(null);
  const copy = useCopyText(`${connectionId}:${mappingIndex}`);
  useEffect(() => { if (!active) setMappingIndex(null); }, [active]);
  const errorKey = (code: string) => resourceErrorKey(code, (key) => i18n.exists(key));

  const catalog = indices.status === 'ready' ? indices.data : null;
  const needle = filter.trim().toLowerCase();
  const matchedIndices = catalog
    ? catalog.indices.filter((entry) => needle === ''
      || entry.name.toLowerCase().includes(needle)
      || entry.aliases.some((alias) => alias.toLowerCase().includes(needle)))
    : [];
  const visibleIndices = matchedIndices.slice(0, MAX_VISIBLE_INDICES);
  const allFields = fields.status === 'ready' ? fields.data.fields : [];
  const fieldNeedle = fieldFilter.trim().toLowerCase();
  const matchedFields = fieldNeedle === '' ? allFields : allFields.filter((field) => field.name.toLowerCase().includes(fieldNeedle));
  const visibleFields = matchedFields.slice(0, MAX_VISIBLE_FIELDS);
  const isMetadata = (field: FieldCapability) => field.types.length > 0 && field.types.every((type) => type.metadata);
  const documentFields = visibleFields.filter((field) => !isMetadata(field));
  const metadataFields = visibleFields.filter(isMetadata);
  const scope = index.trim();
  const mappingState = mappingIndex !== null ? mappingFor(mappingIndex) : null;
  const mappingRows = mappingState?.status === 'ready' ? mappingState.data.fields.slice(0, MAX_MAPPING_ROWS) : [];
  const mappingTotal = mappingState?.status === 'ready' ? mappingState.data.fields.length : 0;
  const refreshingIndices = indices.status === 'ready' && indices.refreshing;
  const refreshingFields = fields.status === 'ready' && fields.refreshing;
  const refreshNotice = <T,>(state: Loadable<T>) => state.status === 'ready' && state.refreshError
    ? <div className="ql-refresh-warning" role="status"><TriangleAlert size={14} aria-hidden="true" />
      <span>{t('queryLive:refreshFailed')} {t(errorKey(state.refreshError))}</span></div> : null;

  const openMapping = (name: string) => {
    setMappingIndex(name);
    onLoadMapping(name);
  };

  const fieldRow = (field: FieldCapability) => {
    const typeText = field.types.map((type) => type.type).join(' / ');
    return <li key={field.name}>
      <details className="ql-field">
        <summary aria-label={t('queryLive:fieldDetails', { name: field.name })}>
          <span className="ql-field-name" title={field.name}>{field.name}</span>
          <span className="ql-field-type" title={typeText}>{typeText}</span>
          {field.conflict ? <TriangleAlert size={12} className="ql-field-conflict" aria-label={t('queryLive:fieldConflict')} /> : null}
          <ChevronRight size={12} className="ql-field-toggle" aria-hidden="true" />
        </summary>
        <div className="ql-field-details">
          {field.types.map((type) => <div key={type.type}>
            <span className="ql-field-type">{type.type}</span>
            <span className="ql-cap" data-on={String(type.searchable)}>{t(type.searchable ? 'queryLive:searchable' : 'queryLive:notSearchable')}</span>
            <span className="ql-cap" data-on={String(type.aggregatable)}>{t(type.aggregatable ? 'queryLive:aggregatable' : 'queryLive:notAggregatable')}</span>
            {type.metadata ? <span className="ql-cap">{t('queryLive:metadataField')}</span> : null}
          </div>)}
        </div>
      </details>
    </li>;
  };

  if (!available) return <div className="resource-section">
    <div className="ql-state muted">{t('queryLive:desktopOnly')}</div>
    <p className="muted small">{t('queryLive:desktopOnlyDetail')}</p>
  </div>;

  return <>
    <div className="resource-section">
      <div className="ql-section-head">
        <h2>{t('query:indices')}</h2>
        <IconButton icon={refreshingIndices ? LoaderCircle : RefreshCw} className={refreshingIndices ? 'spin' : ''}
          label={t('queryLive:refreshIndices')}
          disabled={connectionId === null || indices.status === 'loading' || refreshingIndices} onClick={onRefreshIndices} />
      </div>
      {indices.status === 'loading' ? <div className="ql-state muted" role="status"><LoaderCircle size={14} className="spin" />{t('queryLive:loading')}</div> : null}
      {indices.status === 'error' ? <div className="ql-state error" role="status"><span>{t(errorKey(indices.code))}</span>
        <button type="button" className="secondary compact-button" onClick={onRefreshIndices}>{t('queryLive:reload')}</button></div> : null}
      {indices.status === 'idle' ? <div className="muted resource-empty"><Layers size={15} />{t('queryLive:noIndices')}</div> : null}
      {refreshNotice(indices)}
      {catalog ? (catalog.indices.length === 0
        ? <div className="ql-state muted">{t('queryLive:noIndicesDetail')}</div>
        : <>
          <label className="ql-filter"><Search size={13} />
            <input aria-label={t('queryLive:indexFilter')} placeholder={t('queryLive:indexFilter')} spellCheck={false}
              value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
          <ul className="ql-list">{visibleIndices.map((entry) => <li key={entry.name}>
            <button type="button" className="ql-index" aria-pressed={entry.name === index} onClick={() => onSelectIndex(entry.name)}>
              <span className="ql-index-name">{entry.name}</span>
              <span className="ql-badges">
                {entry.system ? <span className="ql-badge">{t('queryLive:system')}</span> : null}
                {entry.hidden && !entry.system ? <span className="ql-badge">{t('queryLive:hidden')}</span> : null}
                {entry.closed ? <span className="ql-badge">{t('queryLive:closed')}</span> : null}
                {entry.attributes.includes('frozen') ? <span className="ql-badge">{t('queryLive:frozen')}</span> : null}
              </span>
            </button>
            {entry.aliases.length > 0 || entry.dataStream !== null ? <span className="ql-index-meta">
              {entry.aliases.join(', ')}
              {entry.dataStream !== null ? `${entry.aliases.length > 0 ? ' · ' : ''}${t('queryLive:dataStream')}: ${entry.dataStream}` : ''}
            </span> : null}
          </li>)}</ul>
          {matchedIndices.length === 0 ? <p className="muted small">{t('common:noMatches')}</p> : null}
          {matchedIndices.length > visibleIndices.length
            ? <p className="muted small">{t('queryLive:indexListCapped', { shown: visibleIndices.length, total: matchedIndices.length })}</p> : null}
        </>) : null}
    </div>
    <div className="resource-section">
      <div className="ql-section-head">
        <h2>{scope === '' ? t('query:fields') : t('queryLive:fieldsFor', { index: scope })}</h2>
        <IconButton icon={refreshingFields ? LoaderCircle : RefreshCw} className={refreshingFields ? 'spin' : ''}
          label={t('queryLive:refreshFields')}
          disabled={connectionId === null || scope === '' || fields.status === 'loading' || refreshingFields} onClick={onLoadFields} />
      </div>
      {fields.status === 'loading' ? <div className="ql-state muted" role="status"><LoaderCircle size={14} className="spin" />{t('queryLive:loading')}</div> : null}
      {fields.status === 'error' ? <div className="ql-state error" role="status"><span>{t(errorKey(fields.code))}</span>
        <button type="button" className="secondary compact-button" onClick={onLoadFields}>{t('queryLive:reload')}</button></div> : null}
      {fields.status === 'idle' ? <div className="muted resource-empty">{t('queryLive:noFields')}</div> : null}
      {refreshNotice(fields)}
      {fields.status === 'ready' ? (allFields.length === 0
        ? <div className="ql-state muted">{t('queryLive:noFieldsDetail')}</div>
        : <>
          <label className="ql-filter"><Search size={13} />
            <input aria-label={t('queryLive:fieldFilter')} placeholder={t('queryLive:fieldFilter')} spellCheck={false}
              value={fieldFilter} onChange={(event) => setFieldFilters((current) => ({ ...current, [index]: event.target.value }))} /></label>
          {matchedFields.length === 0 ? <p className="muted small">{t('common:noMatches')}</p> : null}
          <ul className="ql-fields">{documentFields.map(fieldRow)}</ul>
          {metadataFields.length > 0 ? <details className="ql-metadata-fields" open={fieldNeedle !== '' ? true : undefined}>
            <summary><ChevronRight size={12} aria-hidden="true" />{t('queryLive:metadataFields', { count: metadataFields.length })}</summary>
            <ul className="ql-fields">{metadataFields.map(fieldRow)}</ul>
          </details> : null}
          {matchedFields.length > visibleFields.length
            ? <p className="muted small">{t('queryLive:fieldListCapped', { shown: visibleFields.length, total: matchedFields.length })}</p> : null}
          {scope !== '' ? <button type="button" className="secondary compact-button" onClick={() => openMapping(scope)}>{t('queryLive:viewMapping')}</button> : null}
        </>) : null}
    </div>
    <Modal open={active && mappingIndex !== null} onClose={() => setMappingIndex(null)}
      title={t('queryLive:mappingTitle', { index: mappingIndex ?? '' })} description={t('queryLive:mappingHint')}>
      {mappingState?.status === 'loading' ? <div className="ql-state muted" role="status"><LoaderCircle size={14} className="spin" />{t('queryLive:loading')}</div> : null}
      {mappingState?.status === 'error' ? <div className="ql-state error" role="status"><span>{t(errorKey(mappingState.code))}</span>
        <button type="button" className="secondary compact-button" onClick={() => { if (mappingIndex !== null) onLoadMapping(mappingIndex); }}>{t('queryLive:reload')}</button></div> : null}
      {mappingState ? refreshNotice(mappingState) : null}
      {mappingState?.status === 'ready' ? (mappingTotal === 0
        ? <p className="muted small">{t('queryLive:mappingEmpty')}</p>
        : <div className="ql-mapping-fields"><table className="ql-table">
          <thead><tr><th>{t('queryLive:mappingPath')}</th><th>{t('queryLive:mappingType')}</th></tr></thead>
          <tbody>{mappingRows.map((field) => <tr key={`${field.index}:${field.path}`}>
            <td>{field.path}</td><td className="muted">{field.type}</td></tr>)}</tbody>
        </table>
        {mappingTotal > mappingRows.length
          ? <p className="muted small">{t('queryLive:fieldListCapped', { shown: mappingRows.length, total: mappingTotal })}</p> : null}
        </div>) : null}
      <div className="ql-detail-actions">
        <button type="button" className="secondary compact-button" disabled={mappingState?.status !== 'ready'}
          onClick={() => { if (mappingState?.status === 'ready') copy.copy(mappingState.data.raw); }}>{t('queryLive:copyRaw')}</button>
        {copy.status !== 'idle' ? <span className={`ql-copy-note ${copy.status === 'failed' ? 'failed' : 'done'}`} role="status">
          {copy.status === 'failed' ? t('queryLive:copyFailed') : t('queryLive:copied')}</span> : null}
      </div>
    </Modal>
  </>;
}

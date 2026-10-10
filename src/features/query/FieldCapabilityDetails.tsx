import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../../components/controls';
import { fieldCapabilityStatus, type FieldCapability, type FieldCatalog, type FieldIndexEvidence } from '../../domain/resource';
import type { ResourceReadSource } from './useQueryResources';

const INDEX_PAGE_SIZE = 20;

export function FieldCapabilitySource({ source, catalog }: { source: ResourceReadSource; catalog: FieldCatalog }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <details className="ql-evidence-source" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><ChevronRight size={12} aria-hidden="true" />{t('queryLive:fieldEvidenceSource')}</summary>
    {open ? <>
      <dl>
        <dt>{t('queryLive:fieldEvidenceConnection')}</dt><dd>{source.connectionId}</dd>
        <dt>{t('queryLive:fieldEvidenceEndpoint')}</dt><dd>{source.endpoint}</dd>
        <dt>{t('queryLive:fieldEvidenceTarget')}</dt><dd>{source.index}</dd>
        <dt>{t('queryLive:fieldEvidenceRequest')}</dt><dd>{source.requestId}</dd>
      </dl>
      <FieldEvidenceIndices label={t('queryLive:fieldResponseIndices')} evidence={catalog.indexEvidence} />
      <p className="muted small">{t('queryLive:fieldEvidenceBoundary')}</p>
    </> : null}
  </details>;
}

export function FieldEvidenceIndices({ label, evidence }: { label: string; evidence: FieldIndexEvidence | undefined }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  if (!evidence || evidence.status !== 'reported') return <div className="ql-evidence-line">
    <span>{label}</span><span className="muted">{t(evidence?.status === 'invalid'
      ? 'queryLive:fieldIndicesInvalid' : 'queryLive:fieldIndicesNotReported')}</span>
  </div>;
  const pages = Math.max(1, Math.ceil(evidence.indices.length / INDEX_PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  if (evidence.indices.length === 0) return <div className="ql-evidence-line">
    <span>{label}</span><span className="muted">{t('queryLive:fieldIndicesEmpty')}</span>
  </div>;
  return <details className="ql-evidence-indices" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><ChevronRight size={12} aria-hidden="true" />
      {t('queryLive:fieldIndicesCount', { label, count: evidence.indices.length })}</summary>
    {open ? <>
      <ul aria-label={label}>{evidence.indices.slice(currentPage * INDEX_PAGE_SIZE, (currentPage + 1) * INDEX_PAGE_SIZE)
        .map((name) => <li key={name}>{name}</li>)}</ul>
      {pages > 1 ? <div className="ql-evidence-pages">
        <IconButton icon={ChevronLeft} label={t('queryLive:fieldIndicesPrevious', { label })}
          disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} />
        <span role="status">{t('queryLive:pageLabel', { page: currentPage + 1, total: pages })}</span>
        <IconButton icon={ChevronRight} label={t('queryLive:fieldIndicesNext', { label })}
          disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)} />
      </div> : null}
    </> : null}
  </details>;
}

const statusKeys = {
  searchable: {
    supported: 'queryLive:searchable', unsupported: 'queryLive:notSearchable',
    restricted: 'queryLive:searchRestricted', unknown: 'queryLive:searchUnknown',
  },
  aggregatable: {
    supported: 'queryLive:aggregatable', unsupported: 'queryLive:notAggregatable',
    restricted: 'queryLive:aggregationRestricted', unknown: 'queryLive:aggregationUnknown',
  },
} as const;

export function FieldCapabilityDetails({ field }: { field: FieldCapability }) {
  const { t } = useTranslation();
  return <div className="ql-field-details">
    {field.conflict ? <p className="ql-evidence-warning">{t('queryLive:fieldConflictDetail')}</p> : null}
    {field.types.length === 0 ? <p className="muted">{t('queryLive:fieldTypesUnknown')}</p> : null}
    {field.types.map((type) => <div className="ql-field-type-evidence" key={type.type}>
      <div className="ql-evidence-type">{type.type}</div>
      <div className="ql-evidence-capabilities">
        {(['searchable', 'aggregatable'] as const).map((capability) => {
          const status = fieldCapabilityStatus(type.report, capability);
          return <span className="ql-cap" data-state={status} key={capability}>{t(statusKeys[capability][status])}</span>;
        })}
        {type.report?.metadata === true ? <span className="ql-cap">{t('queryLive:metadataField')}</span> : null}
      </div>
      {type.report?.metadata == null ? <p className="muted small">{t('queryLive:fieldMetadataUnknown')}</p> : null}
      <FieldEvidenceIndices label={t('queryLive:fieldTypeIndices')} evidence={type.report?.indices} />
      <FieldEvidenceIndices label={t('queryLive:fieldNonSearchableIndices')} evidence={type.report?.nonSearchableIndices} />
      <FieldEvidenceIndices label={t('queryLive:fieldNonAggregatableIndices')} evidence={type.report?.nonAggregatableIndices} />
    </div>)}
  </div>;
}

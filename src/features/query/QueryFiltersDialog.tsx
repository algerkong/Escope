import { Check, Eye, ListFilter, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import { matchesQueryDraft, type QueryDocument, type QueryDocumentPatch } from '../../domain/query';
import { formatQueryDsl } from '../../domain/query-dsl';
import {
  MAX_FILTER_DSL_BYTES, MAX_QUERY_FILTERS, createQueryFilter, previewQueryFilters, queryFilterDuplicate, queryFilterFieldEvidence, queryFilterValues,
  type CellFilterSelection, type QueryFilter, type QueryFilterDraft, type QueryFilterOperation, type QueryFilterPreview,
} from '../../domain/query-filters';
import type { FieldCatalog } from '../../domain/resource';
import type { Loadable } from './useQueryResources';
import '../../styles/query-filters.css';

export function QueryFilterDraftBar({ count, onReview, onDiscard }: { count: number; onReview: () => void; onDiscard: () => void }) {
  const { t } = useTranslation();
  return <div className="qfilter-draft-bar" role="group" aria-label={t('queryFilters:pending', { count })}>
    <IconButton icon={ListFilter} label={t('queryFilters:review')} onClick={onReview} />
    <span>{t('queryFilters:pending', { count })}</span>
    <span className="muted">{t('queryFilters:sessionDraft')}</span>
    <IconButton icon={Trash2} label={t('queryFilters:discard')} onClick={onDiscard} />
  </div>;
}

interface Props {
  draft: QueryFilterDraft;
  current: QueryDocument | undefined;
  initialSelection?: CellFilterSelection;
  fields: Loadable<FieldCatalog>;
  targetCurrent: boolean;
  canInspect: boolean;
  newQuery: boolean;
  onInspect: () => void;
  onFiltersChange: (filters: readonly QueryFilter[]) => void;
  onCommit: (source: QueryDocument, patch: QueryDocumentPatch) => boolean;
  onDiscard: () => void;
  onClose: () => void;
}

export function QueryFiltersDialog({ draft, current, initialSelection, fields, targetCurrent, canInspect, newQuery,
  onInspect, onFiltersChange, onCommit, onDiscard, onClose }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [selection, setSelection] = useState(initialSelection);
  const [operation, setOperation] = useState<QueryFilterOperation>('include');
  const [valueIndex, setValueIndex] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [review, setReview] = useState<{
    result: QueryFilterPreview; filters: readonly QueryFilter[]; fields: Loadable<FieldCatalog>;
  } | null>(null);
  const catalog = fields.status === 'ready' && !fields.refreshing && !fields.refreshError ? fields.data : undefined;
  const busy = fields.status === 'loading' || fields.status === 'ready' && Boolean(fields.refreshing);
  const currentTarget = targetCurrent && matchesQueryDraft(current, draft.source) && !conflict;
  const field = useMemo(() => selection
    ? queryFilterFieldEvidence(draft.source, draft.snapshot, selection.field, catalog) : null, [draft.source, draft.snapshot, selection, catalog]);
  const values = useMemo(() => selection ? queryFilterValues(selection.value) : null, [selection]);
  const token = values?.ok ? values.values[valueIndex] ?? null : null;
  const presence = operation === 'exists' || operation === 'missing';
  const proposal = useMemo(() => selection
    ? createQueryFilter(draft.source, draft.snapshot, selection, operation, token, catalog) : null,
  [draft.source, draft.snapshot, selection, operation, token, catalog]);
  const candidateProblem = proposal && !proposal.ok ? proposal.code
    : draft.filters.length >= MAX_QUERY_FILTERS ? 'tooMany'
      : proposal?.ok && queryFilterDuplicate(draft.filters, proposal.filter) ? 'duplicate' : null;
  const reviewed = review?.filters === draft.filters && review.fields === fields ? review.result : null;
  const preview = reviewed?.ok ? reviewed : null;
  const formatted = useMemo(() => preview ? formatQueryDsl(preview.dsl) : null, [preview]);
  const finalDsl = formatted?.ok && new TextEncoder().encode(formatted.formatted).length <= MAX_FILTER_DSL_BYTES
    ? formatted.formatted : preview?.dsl ?? '';
  const applyAllowed = currentTarget && !busy && preview !== null;
  const problem = !currentTarget ? 'draftChanged' : reviewed && !reviewed.ok ? reviewed.code : null;
  const operationLabel = (item: { operation: QueryFilterOperation; fieldType: string }) =>
    t(`queryFilters:${item.operation}${['text', 'match_only_text'].includes(item.fieldType)
      && (item.operation === 'include' || item.operation === 'exclude') ? 'Phrase' : ''}`);
  const updateOperation = (value: QueryFilterOperation) => { setOperation(value); setReview(null); };

  return <Modal open onClose={onClose} title={t('queryFilters:title')}>
    <div className="qfilter-review">
      <div className="qfilter-origin">
        <code>{draft.endpoint}</code><code>{draft.snapshot.index}</code>
        <span>{t(newQuery ? 'queryFilters:newQuery' : 'queryFilters:sessionDraft')}</span>
      </div>
      <div className="qfilter-evidence">
        <span className="muted" title={t('queryFilters:evidenceBoundary')}>
          {fields.status === 'error' || fields.status === 'ready' && fields.refreshError ? t('queryFilters:inspectionFailed')
            : busy ? t('queryFilters:inspecting') : t('queryFilters:fieldEvidence')}
        </span>
        <IconButton icon={RefreshCw} label={t('queryFilters:inspect')} disabled={!canInspect || !currentTarget || busy} onClick={onInspect} />
      </div>
      {selection ? <div className="qfilter-candidate">
        <div className="qfilter-field">
          <strong>{selection.field}</strong>
          {field?.ok ? <span title={t('queryFilters:evidenceBoundary')}>{field.fieldType} ({t(`queryFilters:${field.evidence}`)})</span> : null}
          <code>{selection.origin === 'fields' ? 'fields' : '_source'}</code>
        </div>
        <label>{t('queryFilters:condition')}
          <SelectControl value={operation} onChange={(event) => updateOperation(event.target.value as QueryFilterOperation)}>
            {(['include', 'exclude', 'exists', 'missing'] as const).map((op) => <option key={op} value={op}>
              {operationLabel({ operation: op, fieldType: field?.ok ? field.fieldType : '' })}
            </option>)}
          </SelectControl>
        </label>
        {!presence && values?.ok ? <>
          {values.array ? <label>{t('queryFilters:element')}
            <SelectControl value={valueIndex} onChange={(event) => { setValueIndex(Number(event.target.value)); setReview(null); }}>
              {values.values.map((value, index) => <option key={index} value={index}>{`${index + 1}: ${value.length > 100 ? `${value.slice(0, 100)}...` : value}`}</option>)}
            </SelectControl>
          </label> : null}
          <label htmlFor={`${id}-value`}>{t('queryFilters:original')}</label>
          <textarea id={`${id}-value`} className="qfilter-value" readOnly value={token ?? ''} spellCheck={false} />
        </> : null}
        {presence ? <span className="qfilter-note">{t('queryFilters:presenceBoundary')}</span> : null}
        {operation === 'exclude' ? <span className="qfilter-note">{t('queryFilters:excludeBoundary')}</span> : null}
        {!presence && field?.ok && field.family === 'text' ? <span className="qfilter-note">{t('queryFilters:phraseBoundary')}</span> : null}
        {field?.ok && field.evidence === 'runtime' ? <span className="qfilter-note">{t('queryFilters:runtimeBoundary')}</span> : null}
        {candidateProblem ? <span className="qfilter-warning" role="status">{t(`queryFilters:${candidateProblem}`)}</span> : null}
        <button type="button" className="secondary compact-button qfilter-add" disabled={!currentTarget || busy || !proposal?.ok || candidateProblem !== null}
          onClick={() => {
            if (!currentTarget || busy || !proposal?.ok || candidateProblem !== null) return;
            onFiltersChange([...draft.filters, { ...proposal.filter, id: crypto.randomUUID() }]);
            setSelection(undefined);
            setReview(null);
          }}><Plus size={14} aria-hidden="true" />{t('queryFilters:add')}</button>
      </div> : null}
      {draft.filters.length ? <ul className="qfilter-list" aria-label={t('queryFilters:pending', { count: draft.filters.length })}>
        {draft.filters.map((item) => <li key={item.id}>
          <div className="qfilter-item">
            <strong>{item.field}</strong><span>{item.fieldType}</span>
            <span title={item.operation === 'exclude' ? t('queryFilters:excludeBoundary') : undefined}>{operationLabel(item)}</span>
            {item.evidence === 'runtime' ? <span title={t('queryFilters:runtimeBoundary')}>{t('queryFilters:runtime')}</span> : null}
            {item.value !== null ? <code title={item.value}>{item.value}</code> : null}
          </div>
          <IconButton icon={Trash2} label={t('queryFilters:remove', { field: item.field })} onClick={() => {
            onFiltersChange(draft.filters.filter((entry) => entry.id !== item.id));
            setReview(null);
          }} />
        </li>)}
      </ul> : null}
      <div className="qfilter-actions">
        <button type="button" className="secondary compact-button" disabled={!currentTarget || busy || !draft.filters.length}
          onClick={() => setReview({ result: previewQueryFilters(draft.source, draft.snapshot, draft.filters, catalog), filters: draft.filters, fields })}>
          <Eye size={14} aria-hidden="true" />{t('queryFilters:preview')}
        </button>
        <IconButton icon={Trash2} label={t('queryFilters:discard')} onClick={onDiscard} />
      </div>
      {preview ? <>
        <details><summary>{t('queryFilters:currentDsl')}</summary><pre className="qfilter-current">{draft.source.dsl}</pre></details>
        <label htmlFor={`${id}-dsl`}>{t('queryFilters:finalDsl')}</label>
        <textarea id={`${id}-dsl`} className="qfilter-code" value={finalDsl} readOnly spellCheck={false} />
      </> : null}
      {problem ? <div className="notice error" role="alert">{t(`queryFilters:${problem}`)}</div> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>{t('close')}</button>
        <button type="button" className="primary" disabled={!applyAllowed} onClick={() => {
          if (!applyAllowed || !preview) return;
          if (onCommit(draft.source, { ...preview.patch, dsl: finalDsl })) onClose();
          else setConflict(true);
        }}><Check size={14} aria-hidden="true" />{t(newQuery ? 'queryFilters:openQuery' : 'queryFilters:apply')}</button>
      </div>
    </div>
  </Modal>;
}

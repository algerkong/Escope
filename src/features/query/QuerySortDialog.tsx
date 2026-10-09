import { ArrowDown, ArrowUp, Check, Eye, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import { matchesQueryDraft, type QueryDocument, type QueryDocumentPatch } from '../../domain/query';
import { formatQueryDsl } from '../../domain/query-dsl';
import {
  BUILT_IN_SORT_FIELDS, MAX_QUERY_SORT_FIELDS, MAX_SORT_DSL_BYTES, SORT_UNMAPPED_TYPES,
  parseQuerySort, previewQuerySort, querySortEvidence,
  type QuerySortClause, type QuerySortPreview, type SortMissing, type SortUnmappedType,
} from '../../domain/query-sort';
import type { FieldCatalog } from '../../domain/resource';
import { runtimeFieldNamesFromDsl } from '../../domain/runtime-fields-dsl';
import { defaultSortDirection } from '../../domain/visual-query';
import type { Loadable } from './useQueryResources';
import '../../styles/query-sort.css';

interface Props {
  source: QueryDocument;
  endpoint: string;
  current: QueryDocument | undefined;
  fields: Loadable<FieldCatalog>;
  targetCurrent: boolean;
  canInspect: boolean;
  onInspect: () => void;
  onCommit: (source: QueryDocument, patch: QueryDocumentPatch) => boolean;
  onClose: () => void;
}
interface SortRow extends QuerySortClause { readonly id: string }

export function QuerySortDialog({ source, endpoint, current, fields, targetCurrent, canInspect, onInspect, onCommit, onClose }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const parsed = useMemo(() => parseQuerySort(source.dsl), [source.dsl]);
  const [rows, setRows] = useState<readonly SortRow[]>(() => parsed.ok
    ? parsed.clauses.map((clause) => ({ ...clause, id: crypto.randomUUID() })) : []);
  const [conflict, setConflict] = useState(false);
  const [review, setReview] = useState<{
    result: QuerySortPreview; rows: readonly SortRow[]; fields: Loadable<FieldCatalog>;
  } | null>(null);
  const catalog = fields.status === 'ready' && !fields.refreshing && !fields.refreshError ? fields.data : undefined;
  const busy = fields.status === 'loading' || fields.status === 'ready' && Boolean(fields.refreshing);
  const currentTarget = targetCurrent && matchesQueryDraft(current, source) && !conflict;
  const evidence = useMemo(() => querySortEvidence(source.dsl, rows.map((row) => row.field), catalog), [source.dsl, rows, catalog]);
  const suggestions = useMemo(() => parsed.ok ? [...new Set([
    ...BUILT_IN_SORT_FIELDS, ...runtimeFieldNamesFromDsl(source.dsl),
    ...(catalog?.fields.slice(0, 200).map((field) => field.name) ?? []),
  ])] : [], [parsed.ok, source.dsl, catalog]);
  const reviewed = review?.rows === rows && review.fields === fields ? review.result : null;
  const preview = reviewed?.ok ? reviewed : null;
  const formatted = useMemo(() => preview ? formatQueryDsl(preview.dsl) : null, [preview]);
  const finalDsl = formatted?.ok && new TextEncoder().encode(formatted.formatted).length <= MAX_SORT_DSL_BYTES
    ? formatted.formatted : preview?.dsl ?? '';
  const applyAllowed = currentTarget && !busy && Boolean(preview?.changed);
  const problem = !currentTarget ? 'draftChanged' : !parsed.ok ? parsed.code : reviewed && !reviewed.ok ? reviewed.code : null;
  const changeRows = (next: readonly SortRow[]) => { setRows(next); setReview(null); };
  const updateRow = (row: SortRow, patch: Partial<QuerySortClause>) =>
    changeRows(rows.map((item) => item.id === row.id ? { ...item, ...patch } : item));
  const moveRow = (index: number, delta: number) => {
    const destination = index + delta;
    if (destination < 0 || destination >= rows.length) return;
    const next = [...rows];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    changeRows(next);
  };

  return <Modal open onClose={onClose} title={t('querySort:title')}>
    <div className="qsort-review">
      <div className="qsort-origin"><code>{endpoint}</code><code>{source.index}</code>
        <span title={t('querySort:scopeBoundary')}>{t('querySort:scope')}</span></div>
      <div className="qsort-actions">
        <span className="muted" title={t('querySort:evidenceBoundary')}>
          {fields.status === 'error' || fields.status === 'ready' && fields.refreshError ? t('querySort:inspectionFailed')
            : busy ? t('querySort:inspecting') : t('querySort:fieldEvidence')}
        </span>
        <IconButton icon={RefreshCw} label={t('querySort:inspect')} disabled={!canInspect || !currentTarget || busy} onClick={() => {
          setReview(null);
          onInspect();
        }} />
      </div>
      <datalist id={`${id}-fields`}>{suggestions.map((field) => <option key={field} value={field} />)}</datalist>
      {parsed.ok ? <>
        <ol className="qsort-list" aria-label={t('querySort:priority')}>
          {rows.map((row, index) => {
            const field = evidence[index]!;
            const isBuiltin = (BUILT_IN_SORT_FIELDS as readonly string[]).includes(row.field);
            const candidateType = field.ok && (SORT_UNMAPPED_TYPES as readonly string[]).includes(field.fieldType)
              ? field.fieldType as SortUnmappedType : null;
            return <li key={row.id}>
              <div className="qsort-row-heading">
                <span className="qsort-rank" aria-hidden="true">{index + 1}</span>
                <label className="qsort-field">{t('querySort:field')}
                  <input aria-label={t('querySort:fieldAt', { position: index + 1 })} value={row.field} list={`${id}-fields`}
                    spellCheck={false} autoComplete="off" maxLength={1024} disabled={!currentTarget}
                    aria-invalid={row.field !== '' && !field.ok}
                    onChange={(event) => updateRow(row, { field: event.target.value,
                      direction: defaultSortDirection(event.target.value), missing: 'default', unmappedType: null })} />
                </label>
                <div className="qsort-row-actions">
                  <IconButton icon={ArrowUp} label={t('querySort:moveUp', { position: index + 1 })}
                    disabled={!currentTarget || index === 0} onClick={() => moveRow(index, -1)} />
                  <IconButton icon={ArrowDown} label={t('querySort:moveDown', { position: index + 1 })}
                    disabled={!currentTarget || index === rows.length - 1} onClick={() => moveRow(index, 1)} />
                  <IconButton icon={Trash2} label={t('querySort:remove', { position: index + 1 })} disabled={!currentTarget}
                    onClick={() => changeRows(rows.filter((item) => item.id !== row.id))} />
                </div>
              </div>
              <div className="qsort-options">
                <label>{t('querySort:direction')}
                  <SelectControl aria-label={t('querySort:directionAt', { position: index + 1 })} value={row.direction} disabled={!currentTarget}
                    onChange={(event) => updateRow(row, { direction: event.target.value as QuerySortClause['direction'] })}>
                    <option value="asc">{t('querySort:asc')}</option><option value="desc">{t('querySort:desc')}</option>
                  </SelectControl>
                </label>
                <label>{t('querySort:missing')}
                  <SelectControl aria-label={t('querySort:missingAt', { position: index + 1 })} value={row.missing}
                    title={t('querySort:missingBoundary')} disabled={!currentTarget || isBuiltin}
                    onChange={(event) => updateRow(row, { missing: event.target.value as SortMissing })}>
                    <option value="default">{t(isBuiltin ? 'querySort:notApplicable' : 'querySort:missingDefault')}</option>
                    <option value="_first">{t('querySort:missingFirst')}</option><option value="_last">{t('querySort:missingLast')}</option>
                  </SelectControl>
                </label>
                <label>{t('querySort:unmapped')}
                  <SelectControl aria-label={t('querySort:unmappedAt', { position: index + 1 })} value={row.unmappedType ?? ''}
                    title={t('querySort:unmappedBoundary')} disabled={!currentTarget || isBuiltin}
                    onChange={(event) => updateRow(row, { unmappedType: event.target.value ? event.target.value as SortUnmappedType : null })}>
                    <option value="">{t(isBuiltin ? 'querySort:notApplicable' : 'querySort:unmappedFail')}</option>
                    {candidateType ? <option value={candidateType}>{t('querySort:unmappedAs', { type: candidateType })}</option> : null}
                    {row.unmappedType && row.unmappedType !== candidateType
                      ? <option value={row.unmappedType}>{t('querySort:unmappedAs', { type: row.unmappedType })}</option> : null}
                  </SelectControl>
                </label>
              </div>
              <div className={`qsort-evidence ${field.ok ? 'muted' : 'qsort-warning'}`} role="status">
                {field.ok ? <>
                  <span title={t(field.origin === 'runtime' ? 'querySort:runtimeBoundary' : 'querySort:evidenceBoundary')}>
                    {field.fieldType} ({t(`querySort:${field.origin}`)})
                  </span>
                  {field.reportedUnmapped ? <span>{t('querySort:reportedUnmapped')}</span> : null}
                  {field.origin !== 'builtin' ? <span title={t('querySort:modeBoundary')}>{t(row.direction === 'asc' ? 'querySort:modeMin' : 'querySort:modeMax')}</span> : null}
                </> : row.field ? t(`querySort:${field.code}`) : t('querySort:fieldRequired')}
              </div>
            </li>;
          })}
        </ol>
        {!rows.length ? <span className="muted">{t('querySort:noSort')}</span> : null}
        <div className="qsort-actions">
          <button type="button" className="secondary compact-button" disabled={!currentTarget || rows.length >= MAX_QUERY_SORT_FIELDS}
            title={t('querySort:limit', { count: MAX_QUERY_SORT_FIELDS })}
            onClick={() => changeRows([...rows, { id: crypto.randomUUID(), field: '', direction: 'asc', missing: 'default', unmappedType: null }])}>
            <Plus size={14} aria-hidden="true" />{t('querySort:add')}
          </button>
          <IconButton icon={Trash2} label={t('querySort:clear')} disabled={!currentTarget || !rows.length} onClick={() => changeRows([])} />
        </div>
        <button type="button" className="secondary compact-button qsort-preview" disabled={!currentTarget || busy}
          onClick={() => setReview({ result: previewQuerySort(source,
            rows.map(({ field, direction, missing, unmappedType }) => ({ field, direction, missing, unmappedType })), catalog), rows, fields })}>
          <Eye size={14} aria-hidden="true" />{t('querySort:preview')}
        </button>
      </> : null}
      <details><summary>{t('querySort:currentDsl')}</summary><pre className="qsort-current">{source.dsl}</pre></details>
      {preview ? <>
        <label htmlFor={`${id}-dsl`}>{t('querySort:finalDsl')}</label>
        <textarea id={`${id}-dsl`} className="qsort-code" value={finalDsl} readOnly spellCheck={false} />
        {!preview.changed ? <span role="status" className="muted">{t('querySort:unchanged')}</span> : null}
      </> : null}
      {problem ? <div className="notice error" role="alert">{t(`querySort:${problem}`)}</div> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={!applyAllowed} onClick={() => {
          if (!applyAllowed || !preview) return;
          if (onCommit(source, { ...preview.patch, dsl: finalDsl })) onClose();
          else setConflict(true);
        }}><Check size={14} aria-hidden="true" />{t('querySort:apply')}</button>
      </div>
    </div>
  </Modal>;
}

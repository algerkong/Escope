import { Check, Eye, ListFilter, ListTree, Plus, RefreshCw, Trash2, Unlink } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import { matchesQueryDraft, type QueryDocument, type QueryDocumentPatch } from '../../domain/query';
import { parseNestedFilterMapping } from '../../domain/query-filter-mapping';
import {
  MAX_FILTER_GROUPS, MAX_QUERY_FILTERS, createQueryFilter, filterGroupAccepts, queryFilterDuplicate, queryFilterEnabled, queryFilterFieldEvidence, queryFilterValues,
  type CellFilterSelection, type QueryFilter, type QueryFilterComposition, type QueryFilterDraft, type QueryFilterGroup, type QueryFilterJoin, type QueryFilterOperation, type QueryFilterPreview,
} from '../../domain/query-filters';
import { matchesQueryFilterBinding, previewQueryFilterDraft, queryFilterDraftChanged, queryFilterEvidenceSource } from '../../domain/query-filter-session';
import type { FieldCatalog } from '../../domain/resource';
import { NestedFilterEditor } from './NestedFilterEditor';
import type { Loadable, MappingState } from './useQueryResources';
import '../../styles/query-filters.css';

export function QueryFilterDraftBar({ count, enabled, onReview, onDiscard }: { count: number; enabled: number; onReview: () => void; onDiscard: () => void }) {
  const { t } = useTranslation();
  return <div className="qfilter-draft-bar" role="group" aria-label={t('queryFilters:pending', { count })}>
    <IconButton icon={ListFilter} label={t('queryFilters:review')} onClick={onReview} />
    <span>{t('queryFilters:pending', { count })}</span>
    {enabled < count ? <span className="muted">{t('queryFilters:enabledCount', { enabled, total: count })}</span> : null}
    <span className="muted">{t('queryFilters:sessionDraft')}</span>
    <IconButton icon={Trash2} label={t('queryFilters:discard')} onClick={onDiscard} />
  </div>;
}

export function QueryFilterBindingBar({ count, enabled, conflict, onReview, onDetach }: {
  count: number; enabled: number; conflict: boolean; onReview: () => void; onDetach: () => void;
}) {
  const { t } = useTranslation();
  return <div className="qfilter-draft-bar" role="group" aria-label={t('queryFilters:bound', { count })}>
    <IconButton icon={ListFilter} label={t('queryFilters:editBound')} onClick={onReview} />
    <span>{t('queryFilters:bound', { count })}</span>
    <span className="muted">{t('queryFilters:enabledCount', { enabled, total: count })}</span>
    <span className={conflict ? 'qfilter-warning' : 'muted'} role="status" title={t('queryFilters:sessionOnly')}>
      {t(conflict ? 'queryFilters:filterBindingChanged' : 'queryFilters:boundApplied')}
    </span>
    <IconButton icon={Unlink} label={t('queryFilters:detach')} onClick={onDetach} />
  </div>;
}

interface Props {
  draft: QueryFilterDraft;
  current: QueryDocument | undefined;
  initialSelection?: CellFilterSelection;
  initialNested?: boolean;
  fields: Loadable<FieldCatalog>;
  mapping: Loadable<MappingState>;
  targetCurrent: boolean;
  canInspect: boolean;
  newQuery: boolean;
  onInspect: () => void;
  onInspectNested: () => void;
  onFiltersChange: (filters: readonly QueryFilter[], composition: QueryFilterComposition) => void;
  onCommit: (source: QueryDocument, patch: QueryDocumentPatch) => boolean;
  onDiscard: () => void;
  onClose: () => void;
}

export function QueryFiltersDialog({ draft, current, initialSelection, initialNested = false, fields, mapping, targetCurrent, canInspect, newQuery,
  onInspect, onInspectNested, onFiltersChange, onCommit, onDiscard, onClose }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [selection, setSelection] = useState(initialSelection);
  const [nestedOpen, setNestedOpen] = useState(initialNested);
  const [operation, setOperation] = useState<QueryFilterOperation>('include');
  const [valueIndex, setValueIndex] = useState(0);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [conflict, setConflict] = useState(false);
  const [review, setReview] = useState<{
    result: QueryFilterPreview; filters: readonly QueryFilter[]; composition: QueryFilterComposition | undefined;
    fields: Loadable<FieldCatalog>; mapping: Loadable<MappingState>;
    draft: QueryFilterDraft;
  } | null>(null);
  const composition = useMemo<QueryFilterComposition>(() => draft.composition ?? {
    mode: 'all', groups: draft.filters.length ? [{ id: 'default', mode: 'all', filterIds: draft.filters.map((filter) => filter.id) }] : [],
  }, [draft.composition, draft.filters]);
  const enabledIds = useMemo(() => new Set(draft.filters.filter(queryFilterEnabled).map((filter) => filter.id)), [draft.filters]);
  const candidateGroup = selectedGroup === 'new' || composition.groups.some((group) => group.id === selectedGroup && !group.nested)
    ? selectedGroup : composition.groups.find((group) => !group.nested)?.id ?? 'new';
  const catalog = fields.status === 'ready' && !fields.refreshing && !fields.refreshError ? fields.data : undefined;
  const mappingEvidence = useMemo(() => mapping.status === 'ready' && !mapping.refreshing && !mapping.refreshError
    ? parseNestedFilterMapping(mapping.data.raw) : undefined, [mapping]);
  const nestedActive = nestedOpen || composition.groups.some((group) => group.nested);
  const mappingBusy = mapping.status === 'loading' || mapping.status === 'ready' && Boolean(mapping.refreshing);
  const fieldsBusy = fields.status === 'loading' || fields.status === 'ready' && Boolean(fields.refreshing);
  const busy = fieldsBusy || nestedActive && mappingBusy;
  const bindingCurrent = !draft.binding || matchesQueryFilterBinding(draft.binding, current, draft.endpoint);
  const currentTarget = targetCurrent && matchesQueryDraft(current, draft.source) && bindingCurrent && !conflict;
  const evidenceSource = queryFilterEvidenceSource(draft);
  const field = useMemo(() => selection
    ? queryFilterFieldEvidence(evidenceSource, draft.snapshot, selection.field, catalog) : null, [evidenceSource, draft.snapshot, selection, catalog]);
  const values = useMemo(() => selection ? queryFilterValues(selection.value) : null, [selection]);
  const token = values?.ok ? values.values[valueIndex] ?? null : null;
  const presence = operation === 'exists' || operation === 'missing';
  const proposal = useMemo(() => selection
    ? createQueryFilter(evidenceSource, draft.snapshot, selection, operation, token, catalog) : null,
  [evidenceSource, draft.snapshot, selection, operation, token, catalog]);
  const candidateProblem = proposal && !proposal.ok ? proposal.code
    : draft.filters.length >= MAX_QUERY_FILTERS ? 'tooMany'
      : candidateGroup === 'new' && composition.groups.length >= MAX_FILTER_GROUPS ? 'tooManyGroups'
        : proposal?.ok && queryFilterDuplicate(draft.filters, proposal.filter) ? 'duplicate' : null;
  const reviewed = review?.draft === draft && review.filters === draft.filters && review.composition === draft.composition && review.fields === fields
    && review.mapping === mapping ? review.result : null;
  const preview = reviewed?.ok ? reviewed : null;
  const finalDsl = preview?.dsl ?? '';
  const applyAllowed = currentTarget && !busy && preview !== null && queryFilterDraftChanged(draft);
  const problem = !bindingCurrent ? 'filterBindingChanged' : !currentTarget ? 'draftChanged' : reviewed && !reviewed.ok ? reviewed.code : null;
  const operationLabel = (item: { operation: QueryFilterOperation; fieldType: string }) =>
    t(`queryFilters:${item.operation}${['text', 'match_only_text'].includes(item.fieldType)
      && (item.operation === 'include' || item.operation === 'exclude') ? 'Phrase' : ''}`);
  const updateOperation = (value: QueryFilterOperation) => { setOperation(value); setReview(null); };
  const changeFilters = (filters: readonly QueryFilter[], next: QueryFilterComposition) => {
    onFiltersChange(filters, next);
    setReview(null);
  };
  const newGroup = (filter: QueryFilter): QueryFilterGroup => ({ id: crypto.randomUUID(), mode: 'all', filterIds: [filter.id],
    ...(filter.nestedPath === undefined ? {} : { nested: { path: filter.nestedPath, match: 'include' } }) });
  const moveFilter = (filterId: string, targetGroup: string) => {
    const filter = draft.filters.find((item) => item.id === filterId);
    const target = composition.groups.find((group) => group.id === targetGroup);
    if (!currentTarget || targetGroup === 'new' && composition.groups.length >= MAX_FILTER_GROUPS
      || !filter || targetGroup !== 'new' && (!target || !filterGroupAccepts(target, filter)
        || filter.nestedPath !== undefined && queryFilterDuplicate(draft.filters.filter((item) => item.id !== filterId && target.filterIds.includes(item.id)), filter))) return;
    const groups = composition.groups.map((group) => ({
      ...group, filterIds: group.id === targetGroup
        ? [...group.filterIds.filter((id) => id !== filterId), filterId] : group.filterIds.filter((id) => id !== filterId),
    })).filter((group) => group.filterIds.length);
    changeFilters(draft.filters, { ...composition, groups: targetGroup === 'new'
      ? [...groups, newGroup(filter)] : groups });
  };

  return <Modal open onClose={onClose} title={t('queryFilters:title')}>
    <div className="qfilter-review">
      <div className="qfilter-origin">
        <code>{draft.endpoint}</code><code>{draft.snapshot.index}</code>
        <span title={t('queryFilters:sessionOnly')}>{t(newQuery ? 'queryFilters:newQuery' : draft.binding ? 'queryFilters:boundApplied' : 'queryFilters:sessionDraft')}</span>
      </div>
      <div className="qfilter-evidence">
        <span className="muted" title={t('queryFilters:evidenceBoundary')}>
          {fields.status === 'error' || fields.status === 'ready' && fields.refreshError ? t('queryFilters:inspectionFailed')
            : fieldsBusy ? t('queryFilters:inspecting') : t('queryFilters:fieldEvidence')}
        </span>
        <IconButton icon={RefreshCw} label={t('queryFilters:inspect')} disabled={!canInspect || !currentTarget || busy} onClick={onInspect} />
        <IconButton icon={ListTree} label={t('queryFilters:nestedEditor')} aria-expanded={nestedOpen}
          disabled={!currentTarget} onClick={() => { setNestedOpen(!nestedOpen); setSelection(undefined); setReview(null); }} />
      </div>
      {nestedActive ? <div className="qfilter-evidence">
        <span className="muted" title={t('queryFilters:nestedEvidenceBoundary')}>
          {mapping.status === 'error' || mapping.status === 'ready' && mapping.refreshError ? t('queryFilters:mappingFailed')
            : mappingBusy ? t('queryFilters:mappingLoading') : t('queryFilters:mappingEvidence')}
        </span>
        <IconButton icon={RefreshCw} label={t('queryFilters:inspectNested')} disabled={!canInspect || !currentTarget || busy} onClick={onInspectNested} />
      </div> : null}
      {nestedOpen ? <NestedFilterEditor draft={evidenceSource === draft.source ? draft : { ...draft, source: evidenceSource }}
        composition={composition} catalog={catalog} mapping={mappingEvidence}
        disabled={!currentTarget || busy} onEdit={() => setReview(null)} onAdd={(proposal, targetGroup) => {
          if (!currentTarget || busy || draft.filters.length >= MAX_QUERY_FILTERS
            || targetGroup === 'new' && composition.groups.length >= MAX_FILTER_GROUPS) return null;
          const filter = { ...proposal, id: crypto.randomUUID() };
          const target = targetGroup === 'new' ? newGroup(filter) : composition.groups.find((group) => group.id === targetGroup);
          if (!target || !filterGroupAccepts(target, filter)
            || queryFilterDuplicate(draft.filters.filter((item) => target.filterIds.includes(item.id)), filter)) return null;
          const groups = targetGroup === 'new' ? [...composition.groups, target]
            : composition.groups.map((group) => group.id === targetGroup ? { ...group, filterIds: [...group.filterIds, filter.id] } : group);
          changeFilters([...draft.filters, filter], { ...composition, groups });
          return target.id;
        }} /> : null}
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
        {composition.groups.length ? <label>{t('queryFilters:addGroup')}
          <SelectControl value={candidateGroup} disabled={!currentTarget}
            onChange={(event) => { setSelectedGroup(event.target.value); setReview(null); }}>
            {composition.groups.map((group, index) => <option key={group.id} value={group.id} disabled={Boolean(group.nested)}>
              {t('queryFilters:group', { position: index + 1 })}{group.nested ? ` (${group.nested.path})` : ''}
            </option>)}
            <option value="new" disabled={composition.groups.length >= MAX_FILTER_GROUPS}>{t('queryFilters:newGroup')}</option>
          </SelectControl>
        </label> : null}
        {candidateProblem ? <span className="qfilter-warning" role="status">{t(`queryFilters:${candidateProblem}`)}</span> : null}
        <button type="button" className="secondary compact-button qfilter-add" disabled={!currentTarget || busy || !proposal?.ok || candidateProblem !== null}
          onClick={() => {
            if (!currentTarget || busy || !proposal?.ok || candidateProblem !== null) return;
            const filter = { ...proposal.filter, id: crypto.randomUUID() };
            const groups = candidateGroup === 'new'
              ? [...composition.groups, { id: crypto.randomUUID(), mode: 'all' as const, filterIds: [filter.id] }]
              : composition.groups.map((group) => group.id === candidateGroup ? { ...group, filterIds: [...group.filterIds, filter.id] } : group);
            changeFilters([...draft.filters, filter], { ...composition, groups });
            setSelection(undefined);
          }}><Plus size={14} aria-hidden="true" />{t('queryFilters:add')}</button>
      </div> : null}
      {draft.filters.length ? <div className="qfilter-composition">
        <div className="qfilter-context" title={t('queryFilters:scoringBoundary')}>{t('queryFilters:filterContext')}</div>
        <div className="qfilter-state-summary" role="status">
          {t('queryFilters:enabledCount', { enabled: enabledIds.size, total: draft.filters.length })}
          {enabledIds.size === 0 ? <span>{t(draft.binding ? 'queryFilters:boundDisabled' : 'queryFilters:allDisabled')}</span> : null}
        </div>
        <FilterJoinControl label={t('queryFilters:groupMatch')} mode={composition.mode} disabled={!currentTarget || composition.groups.length < 2}
          onChange={(mode) => changeFilters(draft.filters, { ...composition, mode })} />
        <div className="qfilter-group-modes">
          {composition.groups.map((group, index) => <div key={group.id} className="qfilter-group-mode">
            <span className="qfilter-group-state" title={t('queryFilters:inactiveGroupBoundary')}>
              {t('queryFilters:groupEnabledCount', { position: index + 1,
                enabled: group.filterIds.filter((id) => enabledIds.has(id)).length, total: group.filterIds.length })}
            </span>
            <FilterJoinControl label={t('queryFilters:groupJoin', { position: index + 1 })} mode={group.mode} disabled={!currentTarget}
              onChange={(mode) => changeFilters(draft.filters, { ...composition,
                groups: composition.groups.map((entry) => entry.id === group.id ? { ...entry, mode } : entry) })} />
            {group.nested ? <div className="qfilter-nested-scope">
              <code title={t('queryFilters:nestedSameObject')}>{group.nested.path}</code>
              <SelectControl aria-label={t('queryFilters:nestedMatch', { position: index + 1 })} value={group.nested.match} disabled={!currentTarget}
                title={t(group.nested.match === 'exclude' ? 'queryFilters:nestedOuterBoundary' : 'queryFilters:nestedSameObject')}
                onChange={(event) => changeFilters(draft.filters, { ...composition,
                  groups: composition.groups.map((entry) => entry.id === group.id && entry.nested
                    ? { ...entry, nested: { ...entry.nested, match: event.target.value as 'include' | 'exclude' } } : entry) })}>
                <option value="include">{t('queryFilters:nestedIncludeParent')}</option>
                <option value="exclude">{t('queryFilters:nestedExcludeParent')}</option>
              </SelectControl>
            </div> : null}
          </div>)}
        </div>
      </div> : null}
      {draft.filters.length ? <ul className="qfilter-list" aria-label={t('queryFilters:pending', { count: draft.filters.length })}>
        {draft.filters.map((item, position) => <li key={item.id} data-filter-disabled={!queryFilterEnabled(item)}>
          <input type="checkbox" role="switch" className="toggle qfilter-enabled"
            aria-label={t('queryFilters:filterEnabled', { field: item.field })}
            aria-describedby={`${id}-condition-${position}${item.value === null ? '' : ` ${id}-token-${position}`}`}
            title={t(queryFilterEnabled(item) ? 'queryFilters:disable' : 'queryFilters:enable')}
            checked={queryFilterEnabled(item)} disabled={!currentTarget}
            onChange={(event) => {
              if (!currentTarget) return;
              changeFilters(draft.filters.map((filter) => filter.id === item.id ? { ...filter, enabled: event.target.checked } : filter), composition);
            }} />
          <div className="qfilter-item">
            <strong>{item.field}</strong><span>{item.fieldType}</span>
            {!queryFilterEnabled(item) ? <span className="qfilter-disabled-label">{t('queryFilters:disabled')}</span> : null}
            <span id={`${id}-condition-${position}`} title={item.nestedPath ? t(item.operation === 'exclude' || item.operation === 'missing'
              ? 'queryFilters:nestedInnerBoundary' : 'queryFilters:nestedSameObject')
              : item.operation === 'exclude' ? t('queryFilters:excludeBoundary') : undefined}>{operationLabel(item)}</span>
            {item.nestedPath ? <code className="qfilter-path" title={t('queryFilters:nestedSameObject')}>{item.nestedPath}</code> : null}
            {item.evidence === 'runtime' ? <span title={t('queryFilters:runtimeBoundary')}>{t('queryFilters:runtime')}</span> : null}
            {item.value !== null ? <code id={`${id}-token-${position}`} title={item.value}>{item.value}</code> : null}
            <SelectControl aria-label={t('queryFilters:filterGroup', { field: item.field })} disabled={!currentTarget}
              value={composition.groups.find((group) => group.filterIds.includes(item.id))?.id ?? ''}
              onChange={(event) => moveFilter(item.id, event.target.value)}>
              {composition.groups.map((group, index) => <option key={group.id} value={group.id} disabled={!filterGroupAccepts(group, item)
                || item.nestedPath !== undefined && queryFilterDuplicate(draft.filters.filter((filter) => filter.id !== item.id && group.filterIds.includes(filter.id)), item)}>
                {t('queryFilters:group', { position: index + 1 })}{group.nested ? ` (${group.nested.path})` : ''}
              </option>)}
              <option value="new" disabled={composition.groups.length >= MAX_FILTER_GROUPS
                || composition.groups.find((group) => group.filterIds.includes(item.id))?.filterIds.length === 1}>
                {t('queryFilters:newGroup')}
              </option>
            </SelectControl>
          </div>
          <IconButton icon={Trash2} label={t('queryFilters:remove', { field: item.field })} disabled={!currentTarget} onClick={() => {
            if (!currentTarget) return;
            changeFilters(draft.filters.filter((entry) => entry.id !== item.id), { ...composition,
              groups: composition.groups.map((group) => ({ ...group, filterIds: group.filterIds.filter((id) => id !== item.id) }))
                .filter((group) => group.filterIds.length) });
          }} />
        </li>)}
      </ul> : null}
      {draft.binding && draft.filters.length === 0 ? <span className="qfilter-note" role="status">{t('queryFilters:boundRemoved')}</span> : null}
      <div className="qfilter-actions">
        <button type="button" className="secondary compact-button" disabled={!currentTarget || busy || !draft.filters.length && !draft.binding}
          onClick={() => setReview({ result: previewQueryFilterDraft(draft, catalog, mappingEvidence),
            filters: draft.filters, composition: draft.composition, fields, mapping, draft })}>
          <Eye size={14} aria-hidden="true" />{t('queryFilters:preview')}
        </button>
        <IconButton icon={Trash2} label={t('queryFilters:discard')} onClick={onDiscard} />
      </div>
      {preview ? <>
        <details><summary>{t('queryFilters:currentDsl')}</summary><pre className="qfilter-current">{draft.source.dsl}</pre></details>
        {draft.binding ? <details><summary>{t('queryFilters:baselineDsl')}</summary><pre className="qfilter-current">{draft.binding.baseline.dsl}</pre></details> : null}
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

function FilterJoinControl({ label, mode, disabled, onChange }: {
  label: string; mode: QueryFilterJoin; disabled: boolean; onChange: (mode: QueryFilterJoin) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="qfilter-join" role="radiogroup" aria-label={label}>
    <span className="qfilter-join-label">{label}</span>
    <div className="qfilter-segments">
      {(['all', 'any'] as const).map((value) => <label key={value}>
        <input type="radio" name={id} value={value} checked={mode === value} disabled={disabled} onChange={() => onChange(value)} />
        <span>{t(`queryFilters:${value}`)}</span>
      </label>)}
    </div>
    {mode === 'any' ? <code className="qfilter-minimum" title={t('queryFilters:orBoundary')}>minimum_should_match: 1</code> : null}
  </div>;
}

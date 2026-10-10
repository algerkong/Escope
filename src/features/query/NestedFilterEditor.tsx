import { Plus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectControl } from '../../components/controls';
import type { NestedFilterMappingResult } from '../../domain/query-filter-mapping';
import {
  MAX_FILTER_GROUPS, MAX_QUERY_FILTERS, createNestedQueryFilter, nestedQueryFilterFieldEvidence, queryFilterDuplicate,
  type QueryFilter, type QueryFilterComposition, type QueryFilterDraft, type QueryFilterOperation,
} from '../../domain/query-filters';
import type { FieldCatalog } from '../../domain/resource';

interface Props {
  draft: QueryFilterDraft;
  composition: QueryFilterComposition;
  catalog: FieldCatalog | undefined;
  mapping: NestedFilterMappingResult | undefined;
  disabled: boolean;
  onEdit: () => void;
  onAdd: (filter: Omit<QueryFilter, 'id'>, groupId: string) => string | null;
}

export function NestedFilterEditor({ draft, composition, catalog, mapping, disabled, onEdit, onAdd }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [path, setPath] = useState('');
  const [fieldName, setFieldName] = useState('');
  const [operation, setOperation] = useState<QueryFilterOperation>('include');
  const [value, setValue] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('new');
  const paths = mapping?.ok ? mapping.value.paths : [];
  const fields = paths.find((entry) => entry.path === path)?.fields ?? [];
  const groupId = selectedGroup !== 'new' && composition.groups.some((group) => group.id === selectedGroup && group.nested?.path === path)
    ? selectedGroup : 'new';
  const field = useMemo(() => fieldName ? nestedQueryFilterFieldEvidence(draft.source, draft.snapshot, path, fieldName, catalog, mapping) : null,
    [draft.source, draft.snapshot, path, fieldName, catalog, mapping]);
  const presence = operation === 'exists' || operation === 'missing';
  const stringValue = field?.ok && (field.family === 'keyword' || field.family === 'text');
  const token = presence ? null : stringValue ? JSON.stringify(value) : value.trim();
  const proposal = useMemo(() => fieldName ? createNestedQueryFilter(draft.source, draft.snapshot, path, fieldName,
    operation, token, catalog, mapping) : null, [draft.source, draft.snapshot, path, fieldName, operation, token, catalog, mapping]);
  const groupMembers = composition.groups.find((group) => group.id === groupId)?.filterIds ?? [];
  const problem = proposal && !proposal.ok ? proposal.code
    : draft.filters.length >= MAX_QUERY_FILTERS ? 'tooMany'
      : groupId === 'new' && composition.groups.length >= MAX_FILTER_GROUPS ? 'tooManyGroups'
        : proposal?.ok && queryFilterDuplicate(draft.filters.filter((item) => groupMembers.includes(item.id)), proposal.filter) ? 'duplicate' : null;
  const selectField = (name: string) => { setFieldName(name); setValue(''); setOperation('include'); onEdit(); };

  return <div className="qfilter-candidate qfilter-nested-editor" role="group" aria-label={t('queryFilters:nestedEditor')}>
    <div className="qfilter-nested-fields">
      <label>{t('queryFilters:nestedPath')}
        <SelectControl value={path} disabled={disabled || !paths.length} onChange={(event) => {
          setPath(event.target.value); selectField(''); setSelectedGroup('new');
        }}>
          <option value="">{t('queryFilters:choosePath')}</option>
          {paths.map((entry) => <option key={entry.path} value={entry.path}>{entry.path}</option>)}
        </SelectControl>
      </label>
      <label>{t('queryFilters:nestedField')}
        <SelectControl value={fieldName} disabled={disabled || !fields.length} onChange={(event) => selectField(event.target.value)}>
          <option value="">{t('queryFilters:chooseField')}</option>
          {fields.map((name) => <option key={name} value={name}>{name}</option>)}
        </SelectControl>
      </label>
    </div>
    {!mapping ? <span className="qfilter-warning" role="status">{t('queryFilters:mappingUnchecked')}</span>
      : !mapping.ok ? <span className="qfilter-warning" role="status">{t(`queryFilters:${mapping.code}`)}</span>
        : !paths.length ? <span className="qfilter-note" role="status">{t('queryFilters:nestedPathsEmpty')}</span> : null}
    {fieldName ? <>
      <div className="qfilter-field"><strong>{fieldName}</strong>
        {field?.ok ? <span>{field.fieldType}</span> : null}
        <span title={t('queryFilters:nestedEvidenceBoundary')}>Mapping</span>
      </div>
      <label>{t('queryFilters:nestedCondition')}
        <SelectControl value={operation} disabled={disabled} onChange={(event) => {
          setOperation(event.target.value as QueryFilterOperation); onEdit();
        }}>
          {(['include', 'exclude', 'exists', 'missing'] as const).map((op) => <option key={op} value={op}>
            {t(`queryFilters:${op}${field?.ok && field.family === 'text' && (op === 'include' || op === 'exclude') ? 'Phrase' : ''}`)}
          </option>)}
        </SelectControl>
      </label>
      {!presence ? <label htmlFor={`${id}-value`}>{t('queryFilters:enteredValue')}
        {field?.ok && field.family === 'boolean' ? <SelectControl id={`${id}-value`} value={value} disabled={disabled}
          onChange={(event) => { setValue(event.target.value); onEdit(); }}>
          <option value="">{t('queryFilters:chooseValue')}</option><option value="true">true</option><option value="false">false</option>
        </SelectControl> : <input id={`${id}-value`} value={value} disabled={disabled} spellCheck={false}
          inputMode={field?.ok && field.family === 'number' ? 'decimal' : 'text'}
          onChange={(event) => { setValue(event.target.value); onEdit(); }} />}
      </label> : null}
      {operation === 'exclude' || operation === 'missing'
        ? <span className="qfilter-note">{t('queryFilters:nestedInnerBoundary')}</span> : null}
      {presence ? <span className="qfilter-note">{t('queryFilters:presenceBoundary')}</span> : null}
      {!presence && field?.ok && field.family === 'text' ? <span className="qfilter-note">{t('queryFilters:phraseBoundary')}</span> : null}
      <label>{t('queryFilters:nestedAddGroup')}
        <SelectControl value={groupId} disabled={disabled} onChange={(event) => { setSelectedGroup(event.target.value); onEdit(); }}>
          <option value="new" disabled={composition.groups.length >= MAX_FILTER_GROUPS}>{t('queryFilters:newGroup')}</option>
          {composition.groups.map((group, index) => group.nested?.path === path
            ? <option key={group.id} value={group.id}>{t('queryFilters:group', { position: index + 1 })} ({path})</option> : null)}
        </SelectControl>
      </label>
    </> : null}
    {problem ? <span className="qfilter-warning" role="status">{t(`queryFilters:${problem}`)}</span> : null}
    <button type="button" className="secondary compact-button qfilter-add" disabled={disabled || !proposal?.ok || problem !== null} onClick={() => {
      if (disabled || !proposal?.ok || problem !== null) return;
      const added = onAdd(proposal.filter, groupId);
      if (added) { setSelectedGroup(added); selectField(''); }
    }}><Plus size={14} aria-hidden="true" />{t('queryFilters:addNested')}</button>
  </div>;
}

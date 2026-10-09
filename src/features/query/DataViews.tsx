import { ALargeSmall, Clock3, Database, FilePlus2, LoaderCircle, Pencil, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import {
  dataViewTimeFields, dataViewTimeFieldStatus, MAX_DATA_VIEWS, MAX_DATA_VIEW_NAME_CHARS, parseDataViewDefinition,
  sameDataView, validDataViewIndex, validDataViewTimeField, type DataViewDefinition,
} from '../../domain/data-views';
import type { QueryDocument } from '../../domain/query';
import type { FieldCatalog } from '../../domain/resource';
import type { DataViewsController } from './useDataViews';
import type { Loadable } from './useQueryResources';
import { resourceErrorKey } from './error-message';
import { EMPTY_FIELD_FORMATS, FieldFormatsEditor } from './FieldFormatsEditor';
import '../../styles/data-views.css';

function currentCatalog(fields: Loadable<FieldCatalog>): FieldCatalog | undefined {
  return fields.status === 'ready' && !fields.refreshing && !fields.refreshError ? fields.data : undefined;
}

export function DataViewTarget({ query, library, fields, disabled, onSelect, onInspect, canInspect }:
  { query: QueryDocument; library: DataViewsController; fields: Loadable<FieldCatalog>; disabled: boolean;
    onSelect: (definition: DataViewDefinition | null) => void; onInspect: () => void; canInspect: boolean }) {
  const { t } = useTranslation();
  const selectId = useId();
  const selected = query.dataView?.definition;
  const stored = library.entries.find((entry) => entry.id === selected?.id);
  const ready = library.status === 'ready' && !library.error;
  const changed = selected && (!ready || !stored || !sameDataView(selected, stored));
  const fieldStatus = dataViewTimeFieldStatus(selected?.defaultTimeField ?? null, currentCatalog(fields));
  return <div className="data-view-target">
    <label htmlFor={selectId}><Database size={14} aria-hidden="true" />{t('dataViews:singular')}</label>
    <SelectControl id={selectId} value={changed ? ':snapshot' : selected?.id ?? ''} disabled={disabled}
      onChange={(event) => {
        if (event.target.value === '') onSelect(null);
        else {
          const definition = library.entries.find((entry) => entry.id === event.target.value && entry.connectionId === query.connectionId);
          if (ready && definition) onSelect(definition);
        }
      }}>
      <option value="">{t('dataViews:customTarget')}</option>
      {changed ? <option value=":snapshot" disabled>{selected.name} ({t('dataViews:savedCopy')})</option> : null}
      {ready ? library.entries.filter((entry) => entry.connectionId === query.connectionId)
        .map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>) : null}
    </SelectControl>
    {selected ? <>
      <span className="data-view-time"><Clock3 size={14} aria-hidden="true" />
        <span>{selected.defaultTimeField ?? t('dataViews:noTimeField')}</span>
        <span className={['none', 'unchecked', 'valid'].includes(fieldStatus) ? 'muted' : 'data-view-warning'} role="status">
          {t(`dataViews:time_${fieldStatus}`)}</span></span>
      <IconButton icon={RefreshCw} label={t('dataViews:inspectFields')} disabled={!canInspect}
        onClick={onInspect} />
      {selected.fieldFormats?.entries.length ? <span className="data-view-time">
        <ALargeSmall size={14} aria-hidden="true" />{t('dataViews:formatCount', { count: selected.fieldFormats.entries.length })}
      </span> : null}
      {changed && ready ? <span className="data-view-warning" role="status">
        {t(stored ? 'dataViews:definitionChanged' : 'dataViews:definitionRemoved')}</span> : null}
    </> : null}
    {library.status === 'loading' ? <span className="muted" role="status">{t('dataViews:loading')}</span> : null}
    {library.error ? <span className="data-view-warning" role="status">{t('dataViews:unavailable')}</span> : null}
  </div>;
}

interface DialogProps {
  library: DataViewsController;
  kind: 'desktop' | 'session';
  profiles: readonly ConnectionProfile[];
  initialConnectionId: string | null;
  available: boolean;
  fieldsFor: (connectionId: string | null, endpoint: string | null, index: string) => Loadable<FieldCatalog>;
  inspectFields: (connectionId: string, endpoint: string, index: string) => void;
  onOpenQuery?: (definition: DataViewDefinition) => void;
  onClose: () => void;
}

type Panel = { kind: 'list' } | { kind: 'edit'; source?: DataViewDefinition } | { kind: 'delete'; source: DataViewDefinition };

export function DataViewsDialog({ library, kind, profiles, initialConnectionId, available, fieldsFor, inspectFields, onOpenQuery, onClose }: DialogProps) {
  const { t, i18n } = useTranslation();
  const [panel, setPanel] = useState<Panel>({ kind: 'list' });
  const [filter, setFilter] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const showList = () => {
    setPanel({ kind: 'list' });
    requestAnimationFrame(() => list.current?.focus());
  };
  const canEdit = library.status === 'ready' && !library.error && !library.saving;
  const title = panel.kind === 'edit' ? t(panel.source ? 'dataViews:edit' : 'dataViews:create')
    : panel.kind === 'delete' ? t('dataViews:deleteTitle') : t('dataViews:title');
  const entries = library.entries.filter((entry) => `${entry.name} ${entry.index}`.toLowerCase().includes(filter.toLowerCase()));
  return <Modal open onClose={onClose} title={title}>
    <div className="data-views-panel">
      {kind === 'session' ? <span className="muted">{t('dataViews:session')}</span> : null}
      {library.status === 'loading' || library.saving ? <div className="data-view-status" role="status">
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
        {t(library.saving ? 'dataViews:saving' : 'dataViews:loading')}
      </div> : null}
      {library.error ? <div className="notice error" role="alert">
        <span>{library.error === 'invalidResponse' ? t('dataViews:invalidStorage') : library.error === 'invalidInput'
          ? t('dataViews:invalidDefinition') : t(i18n.exists(`errors:${library.error}`) ? `errors:${library.error}` : 'errors:unexpected')}</span>
        <button className="secondary compact-button" disabled={library.saving} onClick={() => {
          showList();
          library.reload();
        }}>
          <RefreshCw size={14} />{t(panel.kind === 'edit' ? 'dataViews:discardAndReload' : 'dataViews:reload')}</button>
      </div> : null}
      {panel.kind === 'list' ? <>
        <div className="data-views-actions">
          <input type="search" aria-label={t('dataViews:filter')} value={filter} onChange={(event) => setFilter(event.target.value)} />
          <IconButton icon={RefreshCw} label={t('dataViews:reload')} disabled={library.saving} onClick={library.reload} />
          <button className="primary compact-button" disabled={!canEdit || profiles.length === 0 || library.entries.length >= MAX_DATA_VIEWS}
            onClick={() => setPanel({ kind: 'edit' })}><Plus size={14} />{t('dataViews:create')}</button>
        </div>
        {library.entries.length >= MAX_DATA_VIEWS ? <span className="data-view-warning" role="status">{t('dataViews:limit', { count: MAX_DATA_VIEWS })}</span> : null}
        {profiles.length === 0 ? <span className="muted">{t('dataViews:noConnections')}</span> : null}
        {library.status === 'ready' && entries.length === 0 ? <p className="muted">{t(filter ? 'dataViews:noMatches' : 'dataViews:empty')}</p> : null}
        <ul ref={list} className="data-views-list" tabIndex={-1} aria-label={t('dataViews:title')}>
          {entries.map((entry) => {
            const connection = profiles.find((profile) => profile.id === entry.connectionId);
            return <li key={entry.id}>
              <div className="data-view-entry">
                <strong>{entry.name}</strong>
                <span>{connection?.displayName ?? t('removedConnection')}: {entry.index}</span>
                <span><Clock3 size={12} aria-hidden="true" />{entry.defaultTimeField ?? t('dataViews:noTimeField')}</span>
                {entry.fieldFormats?.entries.length ? <span>{t('dataViews:formatCount', { count: entry.fieldFormats.entries.length })}</span> : null}
              </div>
              <IconButton icon={FilePlus2} label={t('dataViews:openQuery')} disabled={!canEdit || !connection || !onOpenQuery}
                onClick={() => { onOpenQuery?.(entry); onClose(); }} />
              <IconButton icon={Pencil} label={t('dataViews:edit')} disabled={!canEdit}
                onClick={() => setPanel({ kind: 'edit', source: entry })} />
              <IconButton icon={Trash2} label={t('dataViews:delete')} disabled={!canEdit}
                onClick={() => setPanel({ kind: 'delete', source: entry })} />
            </li>;
          })}
        </ul>
      </> : null}
      {panel.kind === 'edit' ? <DataViewEditor key={panel.source?.id ?? 'new'} source={panel.source}
        profiles={profiles} initialConnectionId={initialConnectionId} available={available} disabled={!canEdit}
        fieldsFor={fieldsFor} inspectFields={inspectFields} onCancel={showList}
        onSave={async (entry) => { if (await library.save(entry, panel.source)) showList(); }} /> : null}
      {panel.kind === 'delete' ? <>
        <p className="data-view-delete">{t('dataViews:deleteDetail', { name: panel.source.name })}</p>
        <div className="dialog-actions">
          <button className="secondary" onClick={showList}>{t('cancel')}</button>
          <button className="danger" disabled={!canEdit} onClick={() => {
            void library.remove(panel.source).then((saved) => { if (saved) showList(); });
          }}><Trash2 size={14} />{t('dataViews:delete')}</button>
        </div>
      </> : null}
    </div>
  </Modal>;
}

function DataViewEditor({ source, profiles, initialConnectionId, available, disabled, fieldsFor, inspectFields, onCancel, onSave }:
  Pick<DialogProps, 'profiles' | 'initialConnectionId' | 'available' | 'fieldsFor' | 'inspectFields'>
  & { source?: DataViewDefinition; disabled: boolean; onCancel: () => void; onSave: (entry: DataViewDefinition) => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const formId = useId();
  const [draft, setDraft] = useState<DataViewDefinition>(() => source ? { ...source } : {
    id: crypto.randomUUID(), name: '', connectionId: initialConnectionId ?? '', index: '', defaultTimeField: null,
  });
  const profile = profiles.find((item) => item.id === draft.connectionId);
  const index = draft.index.trim();
  const fields = fieldsFor(draft.connectionId, profile?.endpoint ?? null, index);
  const catalog = currentCatalog(fields);
  const fieldStatus = dataViewTimeFieldStatus(draft.defaultTimeField, catalog);
  const invalidFieldName = !validDataViewTimeField(draft.defaultTimeField);
  const invalidField = invalidFieldName || !['none', 'unchecked', 'valid'].includes(fieldStatus);
  const entry = parseDataViewDefinition({ ...draft, name: draft.name.trim(), index });
  const saveDisabled = disabled || !entry || !profile || invalidField;
  const validIndex = validDataViewIndex(index);
  const readError = fields.status === 'error' ? fields.code : fields.status === 'ready' ? fields.refreshError : undefined;
  return <form className="data-view-form" onSubmit={(event) => { event.preventDefault(); if (!saveDisabled && entry) void onSave(entry); }}>
    <label htmlFor={`${formId}-name`}>{t('dataViews:name')}</label>
    <input id={`${formId}-name`} value={draft.name} maxLength={MAX_DATA_VIEW_NAME_CHARS} autoFocus disabled={disabled}
      onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
    <label htmlFor={`${formId}-connection`}>{t('dataViews:connection')}</label>
    <SelectControl id={`${formId}-connection`} value={draft.connectionId} disabled={disabled || source !== undefined}
      onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}>
      <option value="">{t('dataViews:chooseConnection')}</option>
      {!profile && draft.connectionId ? <option value={draft.connectionId}>{t('removedConnection')}</option> : null}
      {profiles.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName}</option>)}
    </SelectControl>
    <span className="data-view-identity">{profile?.endpoint ?? t(draft.connectionId ? 'removedConnection' : 'dataViews:chooseConnection')}
      {draft.connectionId ? <><br />{draft.connectionId}</> : null}</span>
    <label htmlFor={`${formId}-index`}>{t('dataViews:target')}</label>
    <div className="data-view-field-row">
      <input id={`${formId}-index`} value={draft.index} spellCheck={false} disabled={disabled} aria-invalid={draft.index !== '' && !validIndex}
        onChange={(event) => setDraft({ ...draft, index: event.target.value })} />
      <IconButton icon={RefreshCw} label={t('dataViews:inspectFields')}
        disabled={!available || !profile || !validIndex || fields.status === 'loading' || (fields.status === 'ready' && fields.refreshing)}
        onClick={() => { if (profile && validIndex) inspectFields(profile.id, profile.endpoint, index); }} />
    </div>
    {draft.index !== '' && !validIndex ? <span className="data-view-warning" role="status">{t('dataViews:invalidTarget')}</span> : null}
    <label htmlFor={`${formId}-time`}>{t('dataViews:defaultTimeField')}</label>
    <input id={`${formId}-time`} value={draft.defaultTimeField ?? ''} list={`${formId}-fields`} spellCheck={false} disabled={disabled}
      aria-invalid={invalidField} placeholder={t('dataViews:noTimeField')}
      onChange={(event) => setDraft({ ...draft, defaultTimeField: event.target.value || null })} />
    <datalist id={`${formId}-fields`}>
      {catalog ? dataViewTimeFields(catalog)
        .map((field) => <option key={field.name} value={field.name} />) : null}
    </datalist>
    <span className={invalidField ? 'data-view-warning' : 'muted'} role="status">
      {t(invalidFieldName ? 'dataViews:invalidTimeField' : `dataViews:time_${fieldStatus}`)}</span>
    {fields.status === 'loading' || (fields.status === 'ready' && fields.refreshing)
      ? <span className="muted" role="status">{t('dataViews:checkingFields')}</span> : null}
    {readError ? <span className="data-view-warning" role="alert">{t(resourceErrorKey(readError, i18n.exists.bind(i18n)))}</span> : null}
    {catalog ? <span className="muted">{catalog.fields.length === 0 ? t('dataViews:emptyFields')
      : t('dataViews:fieldCount', { count: catalog.fields.length })}</span> : null}
    <FieldFormatsEditor value={draft.fieldFormats ?? EMPTY_FIELD_FORMATS} catalog={catalog} disabled={disabled}
      onChange={(fieldFormats) => setDraft({ ...draft, fieldFormats })} />
    <div className="dialog-actions">
      <button type="button" className="secondary" onClick={onCancel}>{t('cancel')}</button>
      <button type="submit" className="primary" disabled={saveDisabled}><Save size={14} />{t('save')}</button>
    </div>
  </form>;
}

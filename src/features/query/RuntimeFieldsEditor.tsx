import { Plus, Trash2 } from 'lucide-react';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, SelectControl } from '../../components/controls';
import type { FieldCatalog } from '../../domain/resource';
import {
  MAX_RUNTIME_FIELDS, RUNTIME_FIELD_TYPES, parseRuntimeFields, runtimeFieldEvidence, validRuntimeFieldName, validRuntimeScript,
  type DataViewRuntimeFields, type RuntimeField, type RuntimeFieldType,
} from '../../domain/runtime-fields';
import '../../styles/runtime-fields.css';

export const EMPTY_RUNTIME_FIELDS: DataViewRuntimeFields = { version: 1, entries: [] };

export function RuntimeFieldsEditor({ value, catalog, disabled, onChange }: {
  value: DataViewRuntimeFields; catalog?: FieldCatalog; disabled: boolean;
  onChange: (value: DataViewRuntimeFields) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const replace = (index: number, next: RuntimeField) =>
    onChange({ version: 1, entries: value.entries.map((entry, position) => position === index ? next : entry) });
  return <section className="runtime-editor" aria-labelledby={`${id}-heading`}>
    <div className="runtime-heading">
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>{t('runtimeFields:title')}</h3>
      <IconButton icon={Plus} label={t('runtimeFields:add')} disabled={disabled || value.entries.length >= MAX_RUNTIME_FIELDS}
        onClick={() => {
          onChange({ version: 1, entries: [...value.entries, { field: '', type: 'keyword' }] });
          requestAnimationFrame(() => document.getElementById(`${id}-${value.entries.length}-name`)?.focus());
        }} />
    </div>
    {value.entries.length === 0 ? <span className="muted">{t('runtimeFields:empty')}</span> : null}
    <ol className="runtime-editor-list">
      {value.entries.map((entry, index) => {
        const prefix = `${id}-${index}`;
        const invalid = !validRuntimeFieldName(entry.field)
          || value.entries.some((other, position) => position !== index && other.field === entry.field);
        const evidence = runtimeFieldEvidence(entry, catalog);
        return <li key={index}>
          <div className="runtime-row">
            <label className="runtime-name" htmlFor={`${prefix}-name`}>
              {t('runtimeFields:field', { position: index + 1 })}
              <input id={`${prefix}-name`} value={entry.field} spellCheck={false} disabled={disabled} aria-invalid={invalid}
                onChange={(event) => replace(index, { ...entry, field: event.target.value })} />
            </label>
            <label className="runtime-type" htmlFor={`${prefix}-type`}>{t('runtimeFields:type')}
              <SelectControl id={`${prefix}-type`} value={entry.type} disabled={disabled}
                onChange={(event) => replace(index, { ...entry, type: event.target.value as RuntimeFieldType })}>
                {RUNTIME_FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </SelectControl>
            </label>
            <IconButton icon={Trash2} label={t('runtimeFields:remove', { position: index + 1 })} disabled={disabled}
              onClick={() => {
                onChange({ version: 1, entries: value.entries.filter((_, position) => position !== index) });
                requestAnimationFrame(() => heading.current?.focus());
              }} />
          </div>
          <label className="runtime-checkbox">
            <input type="checkbox" checked={entry.script !== undefined} disabled={disabled}
              aria-label={t('runtimeFields:inlineFor', { position: index + 1 })}
              onChange={(event) => replace(index, event.target.checked ? { ...entry, script: { lang: 'painless', source: '' } }
                : { field: entry.field, type: entry.type })} />
            {t('runtimeFields:inline')}
          </label>
          {entry.script ? <label className="runtime-script">
            {t('runtimeFields:source', { position: index + 1 })}
            <textarea className="runtime-code" rows={4} spellCheck={false} autoComplete="off" disabled={disabled}
              value={entry.script.source} aria-invalid={!validRuntimeScript(entry.script.source)}
              onChange={(event) => replace(index, { ...entry, script: { lang: 'painless', source: event.target.value } })} />
          </label> : <span className="muted">{t('runtimeFields:sourceBacked')}</span>}
          <span className={invalid || ['shadow', 'typeChange', 'conflict'].includes(evidence) ? 'data-view-warning' : 'muted'} role="status">
            {t(invalid ? 'runtimeFields:invalidName' : `runtimeFields:evidence_${evidence}`)}
          </span>
        </li>;
      })}
    </ol>
    {value.entries.some((entry) => entry.script) ? <span className="data-view-warning">{t('runtimeFields:scriptBoundary')}</span> : null}
    {parseRuntimeFields(value) === null ? <span className="data-view-warning" role="status">{t('runtimeFields:invalidDefinition')}</span> : null}
    {value.entries.length >= MAX_RUNTIME_FIELDS ? <span className="muted">{t('runtimeFields:limit', { count: MAX_RUNTIME_FIELDS })}</span> : null}
  </section>;
}

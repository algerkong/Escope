import { Plus, Trash2 } from 'lucide-react';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, SelectControl } from '../../components/controls';
import {
  fieldFormatEvidence, MAX_FIELD_FORMATS, parseFieldFormats, validFormatField,
  type DataViewFieldFormats, type FieldFormat, type FieldFormatEntry,
} from '../../domain/field-formats';
import type { FieldCatalog } from '../../domain/resource';

interface Props {
  value: DataViewFieldFormats;
  catalog?: FieldCatalog;
  disabled: boolean;
  onChange: (formats: DataViewFieldFormats) => void;
}

export const EMPTY_FIELD_FORMATS: DataViewFieldFormats = { version: 1, entries: [] };

export function FieldFormatsEditor({ value, catalog, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const replace = (index: number, entry: FieldFormatEntry) => {
    onChange({ version: 1, entries: value.entries.map((current, position) => position === index ? entry : current) });
  };
  return <section className="field-formats-editor" aria-labelledby={`${id}-heading`}>
    <div className="field-formats-heading">
      <h3 ref={heading} id={`${id}-heading`} tabIndex={-1}>{t('dataViews:formats')}</h3>
      <IconButton icon={Plus} label={t('dataViews:addFormat')} disabled={disabled || value.entries.length >= MAX_FIELD_FORMATS}
        onClick={() => {
          onChange({ version: 1, entries: [...value.entries, { field: '', format: { kind: 'number', grouping: true } }] });
          requestAnimationFrame(() => document.getElementById(`${id}-field-${value.entries.length}`)?.focus());
        }} />
    </div>
    {value.entries.length === 0 ? <span className="muted">{t('dataViews:noFormats')}</span> : null}
    <ol className="field-formats-list">
      {value.entries.map((entry, index) => {
        const evidence = fieldFormatEvidence(entry, catalog);
        const invalid = !validFormatField(entry.field) || value.entries.some((other, position) => position !== index && other.field === entry.field);
        const prefix = `${id}-${index}`;
        return <li key={index}>
          <div className="field-format-controls">
            <div className="field-format-name">
              <label htmlFor={`${id}-field-${index}`}>{t('dataViews:formatField', { position: index + 1 })}</label>
              <input id={`${id}-field-${index}`} value={entry.field} list={`${id}-fields`} spellCheck={false}
                disabled={disabled} aria-invalid={invalid} onChange={(event) => replace(index, { ...entry, field: event.target.value })} />
            </div>
            <div className="field-format-kind">
              <label htmlFor={`${prefix}-kind`}>{t('dataViews:formatKind')}</label>
              <SelectControl id={`${prefix}-kind`} value={entry.format.kind} disabled={disabled}
                onChange={(event) => {
                  const kind = event.target.value as FieldFormat['kind'];
                  replace(index, { ...entry, format: kind === 'date' ? { kind, input: 'iso' }
                    : { kind, grouping: entry.format.kind === 'date' ? true : entry.format.grouping } });
                }}>
                {(['number', 'percent', 'bytes', 'date'] as const).map((kind) =>
                  <option key={kind} value={kind}>{t(`dataViews:format_${kind}`)}</option>)}
              </SelectControl>
            </div>
            <IconButton icon={Trash2} label={t('dataViews:removeFormat', { position: index + 1 })} disabled={disabled}
              onClick={() => {
                onChange({ version: 1, entries: value.entries.filter((_, position) => position !== index) });
                requestAnimationFrame(() => heading.current?.focus());
              }} />
          </div>
          {entry.format.kind === 'date' ? <div className="field-format-date">
            <label htmlFor={`${prefix}-input`}>{t('dataViews:dateInput')}</label>
            <SelectControl id={`${prefix}-input`} value={entry.format.input} disabled={disabled}
              onChange={(event) => replace(index, { ...entry, format: { kind: 'date', input: event.target.value as 'iso' | 'epoch_millis' } })}>
              <option value="iso">{t('dataViews:dateIso')}</option>
              <option value="epoch_millis">{t('dataViews:dateMillis')}</option>
            </SelectControl>
          </div> : <label className="field-format-grouping">
            <input type="checkbox" checked={entry.format.grouping} disabled={disabled}
              onChange={(event) => {
                if (entry.format.kind !== 'date') replace(index, { ...entry, format: { ...entry.format, grouping: event.target.checked } });
              }} />
            {t('dataViews:formatGrouping')}
          </label>}
          <span className={invalid || !['valid', 'unchecked'].includes(evidence) ? 'data-view-warning' : 'muted'} role="status">
            {t(invalid ? 'dataViews:invalidFormatField' : `dataViews:formatEvidence_${evidence}`)}
          </span>
        </li>;
      })}
    </ol>
    <datalist id={`${id}-fields`}>
      {catalog?.fields.map((field) => <option key={field.name} value={field.name} />)}
    </datalist>
    {parseFieldFormats(value) === null ? <span className="data-view-warning" role="status">{t('dataViews:invalidFormats')}</span> : null}
    {value.entries.length >= MAX_FIELD_FORMATS ? <span className="muted">{t('dataViews:formatLimit', { count: MAX_FIELD_FORMATS })}</span> : null}
  </section>;
}

import { Braces, Eye, Plus, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import { matchesQueryDraft, type QueryDocument, type QueryDocumentPatch } from '../../domain/query';
import {
  MAX_PARAMETERS, PARAMETER_TYPES, QUERY_PARAMETERS_VERSION, parseQueryParameters, resolveQueryParameters,
  type ParameterResult, type ParameterType, type QueryParameters,
} from '../../domain/query-parameters';
import '../../styles/query-parameters.css';

interface Row { id: string; name: string; type: ParameterType; input: string }
interface Props {
  source: QueryDocument;
  current: QueryDocument | undefined;
  onClose: () => void;
  onCommit: (source: QueryDocument, patch: QueryDocumentPatch) => boolean;
}

/** Mounted once per explicit opening. No effect can reset edits or rebase a reviewed preview. */
export function QueryParametersDialog({ source, current, onClose, onCommit }: Props) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState(source.parameters?.template ?? source.dsl);
  const [rows, setRows] = useState<Row[]>(() => (source.parameters?.definitions ?? []).map(({ name, type }) => ({
    id: crypto.randomUUID(), name, type, input: type === 'boolean' ? 'false' : type === 'null' ? 'null' : '',
  })));
  const [preview, setPreview] = useState<ParameterResult | null>(null);
  const [failure, setFailure] = useState<'invalidDefinition' | 'conflict' | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const validTarget = matchesQueryDraft(current, source);
  const definition = (): QueryParameters => ({
    version: QUERY_PARAMETERS_VERSION, template, definitions: rows.map(({ name, type }) => ({ name, type })),
  });
  const resetPreview = () => { setPreview(null); setFailure(null); };
  const updateRow = (id: string, patch: Partial<Row>) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    resetPreview();
  };
  const commit = (apply: boolean) => {
    const parameters = parseQueryParameters(definition());
    if (!parameters) { setFailure('invalidDefinition'); return; }
    if (!validTarget || !onCommit(source, { parameters, ...(apply && preview?.ok ? { dsl: preview.dsl } : {}) })) {
      setFailure('conflict');
      return;
    }
    onClose();
  };
  const insertPlaceholder = (name: string) => {
    const start = editor.current?.selectionStart ?? template.length;
    const end = editor.current?.selectionEnd ?? start;
    const token = JSON.stringify({ $param: name });
    setTemplate(template.slice(0, start) + token + template.slice(end));
    resetPreview();
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(start, start + token.length);
    });
  };
  const code = !validTarget ? 'conflict' : failure ?? (preview && !preview.ok ? preview.code : null);
  return <Modal open onClose={onClose} title={t('queryParameters:title')}>
    <div className="qparams-form">
      <label className="qparams-label" htmlFor="qparams-template" title={t('queryParameters:templateSyntax')}>
        {t('queryParameters:template')} <code>{'{"$param":"name"}'}</code>
      </label>
      <textarea id="qparams-template" ref={editor} className="qparams-code" spellCheck={false} autoComplete="off" aria-label={t('queryParameters:template')}
        value={template} onChange={(event) => { setTemplate(event.target.value); resetPreview(); }} />
      <div className="qparams-heading">
        <span>{t('queryParameters:definitions')}</span>
        <IconButton icon={Plus} label={t('queryParameters:add')} disabled={rows.length >= MAX_PARAMETERS}
          onClick={() => {
            let number = rows.length + 1;
            while (rows.some((row) => row.name === `param${number}`)) number++;
            setRows((current) => [...current, { id: crypto.randomUUID(), name: `param${number}`, type: 'string', input: '' }]);
            resetPreview();
          }} />
      </div>
      <div className="qparams-rows">
        {rows.map((row, number) => <div key={row.id} className="qparams-row">
          <label><span>{t('queryParameters:name')}</span><input aria-label={`${t('queryParameters:name')} ${number + 1}`}
            value={row.name} maxLength={64} spellCheck={false} onChange={(event) => updateRow(row.id, { name: event.target.value })} /></label>
          <label><span>{t('queryParameters:type')}</span><SelectControl aria-label={`${t('queryParameters:type')} ${number + 1}`}
            value={row.type} onChange={(event) => {
              const type = event.target.value as ParameterType;
              updateRow(row.id, { type, input: type === 'boolean' ? 'false' : type === 'null' ? 'null' : '' });
            }}>
            {PARAMETER_TYPES.map((type) => <option key={type} value={type}>{t(`queryParameters:${type}`)}</option>)}
          </SelectControl></label>
          <label className="qparams-value"><span>{t('queryParameters:value')}</span>
            {row.type === 'boolean' ? <input type="checkbox" aria-label={`${t('queryParameters:value')} ${number + 1}`}
              checked={row.input === 'true'} onChange={(event) => updateRow(row.id, { input: String(event.target.checked) })} />
              : row.type === 'null' ? <output>null</output>
                : row.type === 'array' || row.type === 'object' ? <textarea aria-label={`${t('queryParameters:value')} ${number + 1}`}
                  value={row.input} rows={2} spellCheck={false} onChange={(event) => updateRow(row.id, { input: event.target.value })} />
                  : <input aria-label={`${t('queryParameters:value')} ${number + 1}`} value={row.input} spellCheck={false}
                    autoComplete="off" onChange={(event) => updateRow(row.id, { input: event.target.value })} />}
          </label>
          <div className="qparams-row-actions">
            <IconButton icon={Braces} label={t('queryParameters:insert', { name: row.name })} onClick={() => insertPlaceholder(row.name)} />
            <IconButton icon={Trash2} label={t('queryParameters:remove', { number: number + 1 })}
              onClick={() => { setRows((current) => current.filter((item) => item.id !== row.id)); resetPreview(); }} />
          </div>
        </div>)}
      </div>
      <span className="muted small">{t('queryParameters:valuesTransient')}</span>
      <div className="qparams-heading">
        <button type="button" className="secondary compact-button" disabled={!validTarget} onClick={() => {
          setFailure(null);
          setPreview(resolveQueryParameters(definition(), Object.fromEntries(rows.map(({ name, input }) => [name, input]))));
        }}><Eye size={14} aria-hidden="true" />{t('queryParameters:preview')}</button>
      </div>
      {preview?.ok ? <>
        <details><summary>{t('queryParameters:currentDsl')}</summary><pre className="qparams-review">{source.dsl}</pre></details>
        <label className="qparams-label" htmlFor="qparams-final">{t('queryParameters:finalDsl')}</label>
        <textarea id="qparams-final" className="qparams-code" value={preview.dsl} readOnly spellCheck={false} />
      </> : null}
      {code ? <div className="notice error" role="alert">{t(`queryParameters:${code}`, {
        parameter: preview && !preview.ok ? preview.parameter ?? '' : '',
      })}</div> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={!validTarget} onClick={() => commit(false)}>
          <Save size={14} aria-hidden="true" />{t('queryParameters:saveDefinition')}</button>
        <button type="button" className="primary" disabled={!validTarget || !preview?.ok} onClick={() => commit(true)}>
          {t('queryParameters:apply')}</button>
      </div>
    </div>
  </Modal>;
}

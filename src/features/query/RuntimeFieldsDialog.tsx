import { Check, Eye } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/controls';
import { matchesQueryDraft, type QueryDocument } from '../../domain/query';
import type { FieldCatalog } from '../../domain/resource';
import { runtimeFieldEvidence } from '../../domain/runtime-fields';
import { previewRuntimeFields, type RuntimeDslPreview } from '../../domain/runtime-fields-dsl';
import '../../styles/runtime-fields.css';

export function RuntimeFieldsDialog({ source, current, catalog, targetCurrent, onCommit, onClose }: {
  source: QueryDocument; current: QueryDocument | undefined; catalog?: FieldCatalog; targetCurrent: boolean;
  onCommit: (source: QueryDocument, dsl: string) => boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [returnFields, setReturnFields] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [preview, setPreview] = useState<RuntimeDslPreview | null>(null);
  const [conflict, setConflict] = useState(false);
  const definition = source.dataView?.definition;
  const runtime = definition?.runtimeFields;
  const entries = runtime?.entries ?? [];
  const validTarget = targetCurrent && matchesQueryDraft(current, source);
  const needsAcknowledgment = entries.some((entry) => runtimeFieldEvidence(entry, catalog) !== 'absent');
  const code = !validTarget || conflict ? 'draftChanged' : preview && !preview.ok ? preview.code : null;
  return <Modal open onClose={onClose} title={t('runtimeFields:review')}>
    <div className="runtime-review">
      <div className="runtime-target"><strong>{definition?.name}</strong><code>{source.index}</code></div>
      <ul className="runtime-evidence" aria-label={t('runtimeFields:title')}>
        {entries.map((entry) => <li key={entry.field}>
          <code>{entry.field}</code><span>{entry.type}</span>
          <span className="muted">{t(`runtimeFields:evidence_${runtimeFieldEvidence(entry, catalog)}`)}</span>
        </li>)}
      </ul>
      {entries.some((entry) => entry.script) ? <span className="data-view-warning">{t('runtimeFields:scriptBoundary')}</span> : null}
      <label className="runtime-checkbox"><input type="checkbox" checked={returnFields}
        onChange={(event) => { setReturnFields(event.target.checked); setPreview(null); }} />{t('runtimeFields:returnFields')}</label>
      {needsAcknowledgment ? <label className="runtime-checkbox">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        {t('runtimeFields:acknowledgeShadow')}
      </label> : null}
      <div className="runtime-heading">
        <button type="button" className="secondary compact-button" disabled={conflict || !validTarget || !entries.length} onClick={() => {
          if (runtime) setPreview(previewRuntimeFields(source.dsl, runtime, returnFields));
        }}><Eye size={14} aria-hidden="true" />{t('runtimeFields:preview')}</button>
      </div>
      {preview?.ok ? <>
        <details><summary>{t('runtimeFields:currentDsl')}</summary><pre className="runtime-current">{source.dsl}</pre></details>
        <label htmlFor={`${id}-final`}>{t('runtimeFields:finalDsl')}</label>
        <textarea id={`${id}-final`} className="runtime-code runtime-final" value={preview.dsl} readOnly spellCheck={false} />
      </> : null}
      {code ? <div className="notice error" role="alert">{t(`runtimeFields:${code}`, {
        field: preview && !preview.ok ? preview.field ?? '' : '',
      })}</div> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={conflict || !validTarget || !preview?.ok || needsAcknowledgment && !acknowledged}
          onClick={() => {
            if (conflict || !validTarget || !preview?.ok || needsAcknowledgment && !acknowledged) return;
            if (onCommit(source, preview.dsl)) onClose();
            else setConflict(true);
          }}><Check size={14} aria-hidden="true" />{t('runtimeFields:apply')}</button>
      </div>
    </div>
  </Modal>;
}

import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/controls';
import { modelProtocols, type ModelInput, type ModelProfile } from '../../domain/models';
import { errorCode } from '../../services/ipc';

interface Props {
  /** The profile being edited, `'new'` for a new one, or `null` when the dialog is closed. */
  value: ModelProfile | 'new' | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: ModelInput, id?: string) => Promise<void>;
}

const empty: ModelInput = { displayName: '', protocol: 'openaiCompatible', endpoint: '', modelId: '' };

/**
 * Add or edit one model profile. The form is configuration only — there is no field for a key,
 * token or header — and a rejected save keeps every entered value so the user can correct it and
 * retry without retyping.
 */
export function ModelEditor({ value, busy, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const existing = value && value !== 'new' ? value : null;
  const [input, setInput] = useState<ModelInput>(() => existing
    ? { displayName: existing.displayName, protocol: existing.protocol, endpoint: existing.endpoint, modelId: existing.modelId }
    : empty);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<ModelInput>) => setInput((current) => ({ ...current, ...patch }));

  const submit = async () => {
    setError(null);
    try {
      await onSave(input, existing?.id);
      onClose();
    } catch (failure) {
      // The draft stays in the form: the rejected values are still the user's input.
      setError(errorCode(failure));
    }
  };

  return <Modal open={value !== null} onClose={() => { if (!busy) onClose(); }}
    title={t(existing ? 'models:edit' : 'models:add')}>
    <form className="model-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {error ? <p className="notice error" role="alert"><TriangleAlert size={16} />
        <span>{t('models:saveFailed')} {t(`errors:${error}`)}</span></p> : null}
      <label htmlFor="model-name">{t('models:name')}</label>
      <input id="model-name" value={input.displayName} maxLength={80} disabled={busy}
        onChange={(event) => update({ displayName: event.target.value })} />
      <p className="muted small model-hint">{t('models:nameHint')}</p>

      <label htmlFor="model-protocol">{t('models:protocol')}</label>
      <select id="model-protocol" value={input.protocol} disabled={busy}
        onChange={(event) => update({ protocol: event.target.value as ModelInput['protocol'] })}>
        {modelProtocols.map((protocol) => <option key={protocol} value={protocol}>
          {t(protocol === 'ollama' ? 'models:protocolOllama' : 'models:protocolOpenaiCompatible')}</option>)}
      </select>

      <label htmlFor="model-endpoint">{t('models:endpoint')}</label>
      <input id="model-endpoint" className="model-endpoint-input" value={input.endpoint} maxLength={2048} disabled={busy}
        spellCheck={false} placeholder="http://127.0.0.1:11434"
        onChange={(event) => update({ endpoint: event.target.value })} />
      <p className="muted small model-hint">{t('models:endpointHint')}</p>

      <label htmlFor="model-id">{t('models:modelId')}</label>
      <input id="model-id" className="model-id-input" value={input.modelId} maxLength={200} disabled={busy}
        spellCheck={false} onChange={(event) => update({ modelId: event.target.value })} />
      <p className="muted small model-hint">{t('models:modelIdHint')}</p>

      <p className="muted small model-hint">{t('models:callsDisabled')}</p>
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>{t('cancel')}</button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? <LoaderCircle size={14} className="spin" /> : null}
          {t(error ? 'retry' : 'save')}
        </button>
      </div>
    </form>
  </Modal>;
}

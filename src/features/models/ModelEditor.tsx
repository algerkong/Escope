import { Download, Eye, EyeOff, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import type { ModelCredentialChange, ModelDiscoveryCredential } from '../../domain/model-access';
import {
  modelProtocols, normalizeModelEndpoint, validateModelInput,
  type ModelInput, type ModelProfile,
} from '../../domain/models';
import { isPrintableApiKey } from '../../services/ai-chat';
import { modelErrorCode, type ModelService } from '../../services/models';
import { modelFailureText } from './error-text';

interface Props {
  /** The profile being edited, `'new'` for a new one, or `null` when the dialog is closed. */
  value: ModelProfile | 'new' | null;
  /** Persistence and discovery adapter; the same instance the settings page uses. */
  service: ModelService;
  busy: boolean;
  onClose: () => void;
  onSave: (input: ModelInput, id: string | undefined, credential: ModelCredentialChange) => Promise<void>;
}

const empty: ModelInput = { displayName: '', protocol: 'openaiCompatible', endpoint: '', modelId: '' };

type Discovery =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly modelIds: readonly string[]; readonly truncated: boolean }
  | { readonly status: 'error'; readonly code: string };

/**
 * Add or edit one model profile: metadata plus an optional credential.
 *
 * The key lives only in its own DOM node (never in component state), is bound to the endpoint and
 * protocol of this profile, and is sent to the service together with the metadata on save —
 * `keep`, `clear` or `replace` is always explicit. Editing the endpoint or protocol drops the old
 * reference unless a replacement is typed, and a rejected save keeps both the draft and the typed
 * key so the retry is deliberate. Fetching model IDs is optional and never required for a manual
 * model id; the list is invalidated (and an in-flight fetch cancelled) as soon as the target or
 * the key input changes, so a late answer cannot belong to the wrong request.
 */
export function ModelEditor({ value, service, busy, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const existing = value && value !== 'new' ? value : null;
  const [input, setInput] = useState<ModelInput>(() => existing
    ? { displayName: existing.displayName, protocol: existing.protocol, endpoint: existing.endpoint, modelId: existing.modelId }
    : empty);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clearKey, setClearKey] = useState(false);
  /** Whether the key input shows its value; only the boolean is kept in React state. */
  const [keyVisible, setKeyVisible] = useState(false);
  /** Whether the (uncontrolled) key field currently holds typed text; never the value itself. */
  const [keyTyped, setKeyTyped] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery>({ status: 'idle' });

  const keyRef = useRef<HTMLInputElement | null>(null);
  const submitting = useRef(false);
  const discoveryToken = useRef(0);
  const discoveryRequest = useRef<string | null>(null);
  const fetchInFlight = useRef(false);
  /** The fetch lock is released at the end of the stack, so a synchronous throw or resolution
      cannot let a second click of the same stack start another request. */
  const releaseFetchLock = () => { queueMicrotask(() => { fetchInFlight.current = false; }); };
  const mounted = useRef(true);
  const serviceRef = useRef(service);
  serviceRef.current = service;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const requestId = discoveryRequest.current;
      discoveryRequest.current = null;
      if (requestId !== null) void serviceRef.current.cancelDiscovery(requestId).catch(() => undefined);
    };
  }, []);

  /** Drop the fetched list and stop its request: a late answer can never belong to the new target. */
  const invalidateDiscovery = () => {
    discoveryToken.current += 1;
    releaseFetchLock();
    const requestId = discoveryRequest.current;
    discoveryRequest.current = null;
    if (requestId !== null) void serviceRef.current.cancelDiscovery(requestId).catch(() => undefined);
    setDiscovery({ status: 'idle' });
  };
  const invalidateRef = useRef(invalidateDiscovery);
  invalidateRef.current = invalidateDiscovery;
  // Closing the dialog drops the list even when the parent keeps this component mounted.
  useEffect(() => {
    if (value !== null) return;
    invalidateRef.current();
  }, [value]);

  const update = (patch: Partial<ModelInput>) => {
    if (patch.endpoint !== undefined || patch.protocol !== undefined) invalidateDiscovery();
    setFieldError(null);
    setInput((current) => ({ ...current, ...patch }));
  };

  const normalizedEndpoint = useMemo(() => {
    try {
      return normalizeModelEndpoint(input.endpoint);
    } catch {
      return null;
    }
  }, [input.endpoint]);
  /** The saved key belongs to the stored endpoint and protocol; any other target must not reuse it. */
  const targetChanged = existing !== null && (
    input.protocol !== existing.protocol
    || (normalizedEndpoint ?? input.endpoint.trim()) !== existing.endpoint
  );
  const keyStatus = service.kind === 'session' ? 'session'
    : clearKey ? 'clear'
      : existing?.hasApiKey ? (targetChanged ? 'reenter' : 'keep') : 'new';
  const displayedKeyStatus = keyTyped && keyStatus === 'reenter' ? 'new' : keyStatus;

  const discoveryCredential = (): ModelDiscoveryCredential => {
    const typed = keyRef.current?.value ?? '';
    if (typed !== '') return { kind: 'provided', apiKey: typed };
    if (existing && existing.hasApiKey && !clearKey && !targetChanged) {
      return { kind: 'stored', modelProfileId: existing.id };
    }
    return { kind: 'none' };
  };

  /** Fetch the model list for the typed endpoint; independent of a saved profile or a model id. */
  const fetchModels = async () => {
    // A synchronous lock: two clicks in the same frame start one fetch, not two.
    if (service.kind === 'session' || busy || fetchInFlight.current) return;
    let endpoint: string;
    try {
      endpoint = normalizeModelEndpoint(input.endpoint);
    } catch {
      setFieldError('invalidEndpoint');
      return;
    }
    const typed = keyRef.current?.value ?? '';
    if (typed !== '' && !isPrintableApiKey(typed)) {
      setFieldError('apiKeyInvalid');
      return;
    }
    setFieldError(null);
    const requestId = crypto.randomUUID();
    discoveryRequest.current = requestId;
    const token = ++discoveryToken.current;
    fetchInFlight.current = true;
    setDiscovery({ status: 'loading' });
    try {
      const response = await serviceRef.current.discover({
        requestId, protocol: input.protocol, endpoint, credential: discoveryCredential(),
      });
      if (!mounted.current || token !== discoveryToken.current) return;
      discoveryRequest.current = null;
      releaseFetchLock();
      setDiscovery({ status: 'ready', modelIds: response.modelIds, truncated: response.truncated });
    } catch (failure) {
      if (!mounted.current || token !== discoveryToken.current) return;
      discoveryRequest.current = null;
      releaseFetchLock();
      setDiscovery({ status: 'error', code: modelErrorCode(failure) });
    }
  };

  /** Explicit credential decision: replace, clear, or keep — the metadata input never carries it. */
  const credentialForSave = (): ModelCredentialChange | null => {
    if (service.kind === 'session') return { kind: 'keep' };
    const typed = keyRef.current?.value ?? '';
    if (typed !== '') {
      if (!isPrintableApiKey(typed)) {
        setFieldError('apiKeyInvalid');
        return null;
      }
      return { kind: 'replace', apiKey: typed };
    }
    if (clearKey || (existing !== null && targetChanged)) return { kind: 'clear' };
    return { kind: 'keep' };
  };

  const submit = async () => {
    if (submitting.current || busy) return;
    submitting.current = true;
    setFieldError(null);
    setSaveError(null);
    try {
      const clean = (() => {
        try {
          return validateModelInput(input);
        } catch (failure) {
          setFieldError(modelErrorCode(failure));
          return null;
        }
      })();
      if (clean === null) return;
      const credential = credentialForSave();
      if (credential === null) return;
      await onSave(clean, existing?.id, credential);
      if (keyRef.current) keyRef.current.value = '';
      onClose();
    } catch (failure) {
      // The draft and the typed key stay in the form for a deliberate retry.
      setSaveError(modelErrorCode(failure));
    } finally {
      submitting.current = false;
    }
  };

  const keyHint = t(displayedKeyStatus === 'session' ? 'models:apiKeySession'
    : displayedKeyStatus === 'clear' ? 'models:clearKey'
      : displayedKeyStatus === 'reenter' ? 'models:apiKeyReenter'
        : displayedKeyStatus === 'keep' ? 'models:apiKeyKeep' : 'models:apiKeyNew');

  const discoveryIds = discovery.status === 'ready' ? discovery.modelIds : [];

  return <Modal open={value !== null} onClose={() => { if (!busy) onClose(); }}
    title={t(existing ? 'models:edit' : 'models:add')}>
    <form className="model-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {saveError ? <p className="notice error" role="alert"><TriangleAlert size={16} />
        <span>{t('models:saveFailed')} {modelFailureText(t, saveError)}</span></p> : null}
      {fieldError ? <p className="notice error" role="alert"><TriangleAlert size={16} />
        <span>{modelFailureText(t, fieldError)}</span></p> : null}

      <div className="model-grid">
        <div className="model-field">
          <label htmlFor="model-name">{t('models:name')}</label>
          <input id="model-name" value={input.displayName} maxLength={160} disabled={busy}
            onChange={(event) => update({ displayName: event.target.value })} />
        </div>
        <div className="model-field">
          <label htmlFor="model-protocol">{t('models:protocol')}</label>
          <SelectControl id="model-protocol" value={input.protocol} disabled={busy}
            onChange={(event) => update({ protocol: event.target.value as ModelInput['protocol'] })}>
            {modelProtocols.map((protocol) => <option key={protocol} value={protocol}>
              {t(protocol === 'ollama' ? 'models:protocolOllama' : 'models:protocolOpenaiCompatible')}</option>)}
          </SelectControl>
        </div>
      </div>

      <label htmlFor="model-endpoint">{t('models:endpoint')}</label>
      <input id="model-endpoint" className="model-endpoint-input" value={input.endpoint} maxLength={2048}
        disabled={busy} spellCheck={false}
        placeholder={input.protocol === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8000/v1'}
        onChange={(event) => update({ endpoint: event.target.value })} />
      <p className="muted small model-hint">{t(input.protocol === 'ollama'
        ? 'models:endpointHintOllama' : 'models:endpointHintCompatible')}</p>
      {normalizedEndpoint !== null && normalizedEndpoint.startsWith('http:') ? <p className="notice warning models-state" role="status">
        <TriangleAlert size={14} /><span>{t('models:httpWarning')}</span></p> : null}

      <label htmlFor="model-key">{t('models:apiKey')}</label>
      <div className="model-key-row">
        <input id="model-key" className="model-key-input" ref={keyRef} type={keyVisible ? 'text' : 'password'}
          autoComplete="off" spellCheck={false} maxLength={2048} disabled={busy || service.kind === 'session' || clearKey}
          onChange={(event) => {
            setKeyTyped(event.currentTarget.value !== '');
            setFieldError(null);
            invalidateDiscovery();
          }} />
        <IconButton icon={keyVisible ? EyeOff : Eye} label={t(keyVisible ? 'models:hideKey' : 'models:showKey')}
          disabled={busy || service.kind === 'session' || clearKey} onClick={() => setKeyVisible((visible) => !visible)} />
      </div>
      <p className="muted small model-hint">{keyHint}</p>
      {existing?.hasApiKey ? <label className="model-clear-key">
        <input type="checkbox" checked={clearKey} disabled={busy || service.kind === 'session'}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            setClearKey(checked);
            if (checked && keyRef.current) {
              keyRef.current.value = '';
              setKeyTyped(false);
            }
            invalidateDiscovery();
          }} />
        <span>{t('models:clearKey')}</span></label> : null}

      <div className="model-id-head">
        <label htmlFor="model-id">{t('models:modelId')}</label>
        <button type="button" className="secondary compact-button"
          disabled={busy || service.kind === 'session' || discovery.status === 'loading'}
          onClick={() => void fetchModels()}>
          {discovery.status === 'loading'
            ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
          {t('models:fetchModels')}</button>
      </div>
      <div className="model-id-row">
        <input id="model-id" className="model-id-input" value={input.modelId} maxLength={400} disabled={busy}
          spellCheck={false} onChange={(event) => update({ modelId: event.target.value })} />
        {discoveryIds.length > 0 ? <SelectControl className="model-id-select" aria-label={t('models:discoveredModels')}
          disabled={busy} value={discoveryIds.includes(input.modelId) ? input.modelId : ''}
          onChange={(event) => { if (event.target.value !== '') update({ modelId: event.target.value }); }}>
          <option value="">{t('models:manualModelId')}</option>
          {discoveryIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </SelectControl> : null}
      </div>

      {discovery.status === 'loading' ? <p className="models-state" role="status">
        <LoaderCircle size={15} className="spin" />{t('models:fetching')}
        <IconButton icon={X} label={t('cancel')} onClick={invalidateDiscovery} /></p> : null}
      {discovery.status === 'error' ? <p className="notice error models-state" role="alert">
        <TriangleAlert size={16} /><span>{t('models:fetchFailed')} {modelFailureText(t, discovery.code)}</span>
        <button type="button" className="secondary compact-button" disabled={busy}
          onClick={() => void fetchModels()}>{t('retry')}</button></p> : null}
      {discovery.status === 'ready' && discovery.modelIds.length === 0
        ? <p className="muted small model-hint" role="status">{t('models:fetchEmpty')}</p> : null}
      {discovery.status === 'ready' && discovery.truncated && discovery.modelIds.length > 0
        ? <p className="muted small model-hint" role="status">
          {t('models:fetchTruncated', { count: discovery.modelIds.length })}</p> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>{t('cancel')}</button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? <LoaderCircle size={14} className="spin" /> : null}
          {t(saveError || fieldError ? 'retry' : 'save')}
        </button>
      </div>
    </form>
  </Modal>;
}

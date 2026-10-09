import { Eye, EyeOff, LoaderCircle, Monitor, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import type {
  ConnectionCaChange, ConnectionCredentialChange, ConnectionInput, ConnectionProfile, ConnectionSecurityChange,
} from '../../domain/connection';
import { validateConnection } from '../../domain/connection';
import { errorCode } from '../../services/ipc';

/** The panel's save seam: connection metadata plus one explicit credential/CA decision. */
export type ConnectionSave = (input: ConnectionInput, id?: string, security?: ConnectionSecurityChange) => Promise<void>;

/** Authentication choices; the stored profile decides what `keep` means. */
type AuthKind = 'none' | 'basic' | 'apiKey' | 'bearer';
type CaChoice = 'keep' | 'default' | 'replace';
type SecretField = 'username' | 'password' | 'apiId' | 'key' | 'token';
type Failure = { scope: 'connectionSettings' | 'errors'; key: string };

/** Mirrors `validateConnection`'s endpoint normalization so a change is detected before saving. */
function normalizeEndpoint(raw: string): string | null {
  try {
    return new URL(raw.trim()).href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Add or edit one connection: metadata, an explicit credential decision and the custom CA.
 *
 * Secret values live only in their own DOM nodes (never in component state, storage, logs or
 * error text) and are cleared on close, on a successful save and whenever the authentication type
 * changes. The stored credential is never filled into the form: leaving the fields blank keeps it,
 * typing new values replaces it, and switching to None unbinds it. An endpoint change detaches the
 * saved credential and CA unless new material is typed, and the form states that before saving.
 * Nothing is submitted twice, and the dialog cannot be closed while a save is in flight.
 */
export function ConnectionEditor({ value, busy, canTest, onClose, onSave }: {
  /** The profile being edited, `'new'` for a new one, or `null` when the dialog is closed. */
  value: ConnectionProfile | 'new' | null;
  busy: boolean;
  /** Desktop capability: the browser session cannot persist credentials or a custom CA. */
  canTest: boolean;
  onClose: () => void;
  onSave: ConnectionSave;
}) {
  const { t } = useTranslation();
  const existing = value && value !== 'new' ? value : null;
  const storedAuth: AuthKind = existing?.auth ?? 'none';
  const [input, setInput] = useState<ConnectionInput>(() => ({
    displayName: existing?.displayName ?? '', endpoint: existing?.endpoint ?? 'https://',
    environment: existing?.environment ?? 'development',
  }));
  const [authKind, setAuthKind] = useState<AuthKind>(storedAuth);
  const [caChoice, setCaChoice] = useState<CaChoice>(() => existing?.hasCustomCa === true ? 'keep' : 'default');
  /** Secret values are read from the refs; only which fields are visible is React state. */
  const [visible, setVisible] = useState({ password: false, key: false, token: false });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const apiIdRef = useRef<HTMLInputElement | null>(null);
  const keyRef = useRef<HTMLInputElement | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const caPemRef = useRef<HTMLTextAreaElement | null>(null);
  const submitting = useRef(false);

  const locked = busy || pending;
  const secretRefs: Record<SecretField, RefObject<HTMLInputElement | null>> = {
    username: usernameRef, password: passwordRef, apiId: apiIdRef, key: keyRef, token: tokenRef,
  };
  const secretValue = (field: SecretField) => secretRefs[field].current?.value ?? '';
  const clearSecrets = () => {
    for (const ref of Object.values(secretRefs)) if (ref.current) ref.current.value = '';
    if (caPemRef.current) caPemRef.current.value = '';
  };

  const normalizedEndpoint = useMemo(() => normalizeEndpoint(input.endpoint), [input.endpoint]);
  const endpointChanged = existing !== null && normalizedEndpoint !== null && normalizedEndpoint !== existing.endpoint;
  /** A changed endpoint must not reuse the stored credential or custom CA of the old target. */
  const securityAtRisk = existing !== null && endpointChanged
    && (existing.auth !== 'none' || existing.hasCustomCa === true);

  const changeAuthKind = (kind: AuthKind) => {
    setAuthKind(kind);
    setFieldError(null);
    setFailure(null);
    setVisible({ password: false, key: false, token: false });
    // Switching type discards any typed material instead of carrying it to another credential kind.
    clearSecrets();
  };
  const changeCaChoice = (choice: CaChoice) => {
    setCaChoice(choice);
    setFieldError(null);
    setFailure(null);
    if (choice !== 'replace' && caPemRef.current) caPemRef.current.value = '';
  };
  const edit = (patch: Partial<ConnectionInput>) => {
    setFieldError(null);
    setFailure(null);
    setInput((current) => ({ ...current, ...patch }));
  };

  /** The explicit credential decision; a blank field never becomes a blank replacement secret. */
  const credentialChange = (): ConnectionCredentialChange | null => {
    const username = secretValue('username');
    const password = secretValue('password');
    const apiId = secretValue('apiId');
    const key = secretValue('key');
    const token = secretValue('token');
    switch (authKind) {
      case 'basic': {
        if (username !== '' || password !== '') {
          if (username === '' || password === '') { setFieldError('credentialIncompleteBasic'); return null; }
          return { kind: 'basic', username, password };
        }
        if (storedAuth === 'basic') return endpointChanged ? { kind: 'clear' } : { kind: 'keep' };
        setFieldError('credentialRequiredBasic');
        return null;
      }
      case 'apiKey': {
        if (apiId !== '' || key !== '') {
          if (apiId === '' || key === '') { setFieldError('credentialIncompleteApiKey'); return null; }
          return { kind: 'apiKey', id: apiId, key };
        }
        if (storedAuth === 'apiKey') return endpointChanged ? { kind: 'clear' } : { kind: 'keep' };
        setFieldError('credentialRequiredApiKey');
        return null;
      }
      case 'bearer': {
        if (token !== '') return { kind: 'bearer', token };
        if (storedAuth === 'bearer') return endpointChanged ? { kind: 'clear' } : { kind: 'keep' };
        setFieldError('credentialRequiredBearer');
        return null;
      }
      default:
        return storedAuth !== 'none' ? { kind: 'clear' } : { kind: 'keep' };
    }
  };

  /**
   * The CA decision. `default` only clears a stored custom CA; without one it is a keep, so a
   * metadata-only save never reports a removal. Certificate validation itself is never disabled.
   */
  const caChange = (): ConnectionCaChange | null => {
    if (caChoice === 'replace') {
      const pem = caPemRef.current?.value.trim() ?? '';
      if (pem === '') { setFieldError('caPemRequired'); return null; }
      return { kind: 'replace', pem };
    }
    const storedHasCa = existing?.hasCustomCa === true;
    if (caChoice === 'keep') return storedHasCa && !endpointChanged ? { kind: 'keep' } : { kind: 'clear' };
    return storedHasCa ? { kind: 'clear' } : { kind: 'keep' };
  };

  const submit = async () => {
    if (submitting.current || busy) return;
    submitting.current = true;
    setPending(true);
    setFieldError(null);
    setFailure(null);
    try {
      let clean: ConnectionInput;
      try {
        clean = validateConnection(input);
      } catch (cause) {
        setFailure({ scope: 'errors', key: errorCode(cause) });
        return;
      }
      // The browser session cannot store any secret or CA material; metadata-only saves stay open.
      const introducingCredential = authKind !== 'none' && authKind !== storedAuth;
      if (!canTest && (introducingCredential || caChoice === 'replace')) {
        setFailure({ scope: 'connectionSettings', key: 'browserSaveBlocked' });
        return;
      }
      const credential = credentialChange();
      if (credential === null) return;
      if (!canTest && (credential.kind === 'basic' || credential.kind === 'apiKey' || credential.kind === 'bearer')) {
        setFailure({ scope: 'connectionSettings', key: 'browserSaveBlocked' });
        return;
      }
      const ca = caChange();
      if (ca === null) return;
      if (!canTest && ca.kind === 'replace') {
        setFailure({ scope: 'connectionSettings', key: 'browserSaveBlocked' });
        return;
      }
      await onSave(clean, existing?.id, { credential, ca });
      clearSecrets();
      onClose();
    } catch (cause) {
      // The draft (and any typed material in its fields) stays for a deliberate retry.
      setFailure({ scope: 'errors', key: errorCode(cause) });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  /** Closing is a no-op while the save is in flight, from the button, Esc or the overlay alike. */
  const close = () => {
    if (submitting.current || pending || busy) return;
    clearSecrets();
    onClose();
  };

  const credentialHint = authKind === 'none'
    ? (storedAuth !== 'none' ? 'credentialNoneHint' : null)
    : existing !== null && existing.auth === authKind
      ? (existing.hasCredential === true ? 'credentialKeepHint' : 'credentialMissingHint')
      : 'credentialNewHint';
  const http = input.endpoint.trim().startsWith('http:');
  const secretDisabled = locked || !canTest;

  return <Modal open={value !== null} onClose={close} title={t(existing ? 'connections:edit' : 'connections:add')}
    description={t(canTest ? 'connectionSettings:editorDescriptionDesktop' : 'connectionSettings:editorDescriptionBrowser')}>
    <form className="connection-editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="form-field">{t('connections:name')}<input autoComplete="off" required maxLength={80} disabled={locked}
        value={input.displayName} onChange={(event) => edit({ displayName: event.target.value })} /></label>
      <label className="form-field">{t('connections:endpoint')}<input autoComplete="off" spellCheck={false} required type="url"
        maxLength={2048} disabled={locked} value={input.endpoint} onChange={(event) => edit({ endpoint: event.target.value })} /></label>
      <label className="form-field">{t('connections:environment')}<SelectControl value={input.environment} disabled={locked}
        onChange={(event) => edit({ environment: event.target.value as ConnectionInput['environment'] })}>
        {(['development', 'staging', 'production'] as const).map((env) => <option key={env} value={env}>{t(`connections:${env}`)}</option>)}
      </SelectControl></label>

      {http ? <div className="notice warning connection-notice" role="status"><TriangleAlert size={16} aria-hidden="true" />
        <span>{t(authKind === 'none' ? 'connections:httpWarning' : 'connectionSettings:httpAuthWarning')}</span></div> : null}
      {!canTest ? <div className="notice warning connection-notice" role="status"><Monitor size={16} aria-hidden="true" />
        <span>{t('connectionSettings:browserNotice')}</span></div> : null}

      <div className="form-field"><label htmlFor="connection-auth">{t('connections:authentication')}</label>
        <SelectControl id="connection-auth" value={authKind} disabled={locked}
          onChange={(event) => changeAuthKind(event.target.value as AuthKind)}>
          <option value="none">{t('connectionSettings:authNone')}</option>
          <option value="basic">{t('connectionSettings:authBasic')}</option>
          <option value="apiKey">{t('connectionSettings:authApiKey')}</option>
          <option value="bearer">{t('connectionSettings:authBearer')}</option>
        </SelectControl></div>

      {authKind === 'basic' ? <>
        <div className="connection-field">
          <label htmlFor="connection-username">{t('connectionSettings:fieldUsername')}</label>
          <input id="connection-username" ref={usernameRef} autoComplete="off" spellCheck={false} maxLength={256}
            disabled={secretDisabled} onChange={() => setFieldError(null)} />
        </div>
        <div className="connection-field">
          <label htmlFor="connection-password">{t('connectionSettings:fieldPassword')}</label>
          <div className="connection-secret-row">
            <input id="connection-password" ref={passwordRef} type={visible.password ? 'text' : 'password'} autoComplete="off"
              spellCheck={false} maxLength={1536} disabled={secretDisabled} onChange={() => setFieldError(null)} />
            <IconButton icon={visible.password ? EyeOff : Eye} disabled={secretDisabled}
              label={t(visible.password ? 'connectionSettings:hideSecret' : 'connectionSettings:showSecret',
                { field: t('connectionSettings:fieldPassword') })}
              onClick={() => setVisible((current) => ({ ...current, password: !current.password }))} />
          </div>
        </div>
      </> : null}

      {authKind === 'apiKey' ? <>
        <div className="connection-field">
          <label htmlFor="connection-api-id">{t('connectionSettings:fieldApiId')}</label>
          <input id="connection-api-id" ref={apiIdRef} autoComplete="off" spellCheck={false} maxLength={256}
            disabled={secretDisabled} onChange={() => setFieldError(null)} />
        </div>
        <div className="connection-field">
          <label htmlFor="connection-api-key">{t('connectionSettings:fieldApiKey')}</label>
          <div className="connection-secret-row">
            <input id="connection-api-key" ref={keyRef} type={visible.key ? 'text' : 'password'} autoComplete="off"
              spellCheck={false} maxLength={1536} disabled={secretDisabled} onChange={() => setFieldError(null)} />
            <IconButton icon={visible.key ? EyeOff : Eye} disabled={secretDisabled}
              label={t(visible.key ? 'connectionSettings:hideSecret' : 'connectionSettings:showSecret',
                { field: t('connectionSettings:fieldApiKey') })}
              onClick={() => setVisible((current) => ({ ...current, key: !current.key }))} />
          </div>
        </div>
      </> : null}

      {authKind === 'bearer' ? <div className="connection-field">
        <label htmlFor="connection-token">{t('connectionSettings:fieldToken')}</label>
        <div className="connection-secret-row">
          <input id="connection-token" ref={tokenRef} type={visible.token ? 'text' : 'password'} autoComplete="off"
            spellCheck={false} maxLength={1536} disabled={secretDisabled} onChange={() => setFieldError(null)} />
          <IconButton icon={visible.token ? EyeOff : Eye} disabled={secretDisabled}
            label={t(visible.token ? 'connectionSettings:hideSecret' : 'connectionSettings:showSecret',
              { field: t('connectionSettings:fieldToken') })}
            onClick={() => setVisible((current) => ({ ...current, token: !current.token }))} />
        </div>
      </div> : null}

      {canTest && credentialHint ? <p className="muted small connection-hint">{t(`connectionSettings:${credentialHint}`)}</p> : null}

      <div className="form-field"><label htmlFor="connection-ca">{t('connectionSettings:caLabel')}</label>
        <SelectControl id="connection-ca" value={caChoice} disabled={locked}
          onChange={(event) => changeCaChoice(event.target.value as CaChoice)}>
          {existing?.hasCustomCa === true ? <option value="keep">{t('connectionSettings:caKeep')}</option> : null}
          <option value="default">{t('connectionSettings:caDefault')}</option>
          <option value="replace">{t('connectionSettings:caReplace')}</option>
        </SelectControl></div>
      {existing?.hasCustomCa === true
        ? <p className="muted small connection-hint">{t('connectionSettings:caConfigured')}</p> : null}
      {caChoice === 'replace' ? <div className="form-field">
        <label htmlFor="connection-ca-pem">{t('connectionSettings:caPemLabel')}</label>
        <textarea id="connection-ca-pem" className="connection-ca-input" ref={caPemRef} rows={5} spellCheck={false}
          maxLength={65536} disabled={locked || !canTest} placeholder={t('connectionSettings:caPemPlaceholder')}
          aria-describedby="connection-ca-hint" onChange={() => setFieldError(null)} />
        <span id="connection-ca-hint" className="muted small">{t('connectionSettings:caReplaceHint')}</span>
      </div> : null}

      {securityAtRisk ? <div className="notice warning connection-notice" role="status"><TriangleAlert size={16} aria-hidden="true" />
        <span>{t('connectionSettings:endpointChangeWarning')}</span></div> : null}
      {failure ? <div className="notice error connection-notice" role="alert"><TriangleAlert size={16} aria-hidden="true" />
        <span>{failure.scope === 'errors'
          ? `${t('connectionSettings:saveFailed')} ${t(`errors:${failure.key}`, { defaultValue: t('errors:unexpected') })}`
          : t(`connectionSettings:${failure.key}`)}</span></div> : null}
      {fieldError ? <div className="notice error connection-notice" role="alert"><TriangleAlert size={16} aria-hidden="true" />
        <span>{t(`connectionSettings:${fieldError}`)}</span></div> : null}

      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={locked} onClick={close}>{t('cancel')}</button>
        <button type="submit" className="primary" disabled={locked}>
          {locked ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}{t('save')}</button>
      </div>
    </form>
  </Modal>;
}

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import {
  readConnectionAccess, type AccessFeedback, type ConnectionAccessResponse,
} from '../../services/connection-access';
import { cancelRequest, errorCode, type CancelRequest } from '../../services/ipc';
import '../../styles/connection-access.css';

interface Props {
  profile: ConnectionProfile;
  available: boolean;
  inspect?: typeof readConnectionAccess;
  cancel?: typeof cancelRequest;
}

export function ConnectionAccess({ profile, available, inspect = readConnectionAccess, cancel = cancelRequest }: Props) {
  const { t } = useTranslation('connectionAccess');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState('');
  const [running, setRunning] = useState<ConnectionProfile | null>(null);
  const pending = useRef<CancelRequest | null>(null);
  const [result, setResult] = useState<{ profile: ConnectionProfile; response: ConnectionAccessResponse } | null>(null);
  const [error, setError] = useState<{ profile: ConnectionProfile; code: string } | null>(null);
  useEffect(() => () => {
    const request = pending.current;
    pending.current = null;
    if (request) void cancel(request).catch(() => undefined);
  }, [profile, cancel]);

  const busy = running === profile;
  const stop = () => {
    const request = pending.current;
    pending.current = null;
    setRunning(null);
    if (request) void cancel(request).catch(() => undefined);
  };
  const run = async () => {
    if (!available || pending.current) return;
    const request = { requestId: crypto.randomUUID(), connectionId: profile.id };
    pending.current = request;
    setRunning(profile);
    setError(null);
    setResult(null);
    try {
      const target = index.trim() || null;
      const response = await inspect({ ...request, ...(target ? { index: target } : {}) });
      if (pending.current !== request) return;
      if (response.requestId !== request.requestId || response.connectionId !== request.connectionId
        || response.endpoint !== profile.endpoint || response.index !== target) throw { code: 'invalidResponse' };
      setResult({ profile, response });
    } catch (cause) {
      if (pending.current === request) setError({ profile, code: errorCode(cause, 'unexpected') });
    } finally {
      if (pending.current === request) { pending.current = null; setRunning(null); }
    }
  };
  const response = result?.profile === profile ? result.response : null;
  const status = (value: AccessFeedback) => <span data-access={value.status}
    title={value.code ? t(`errors:${value.code}`, { defaultValue: t('failed') }) : undefined}>{t(value.status)}</span>;
  return <>
    <IconButton icon={ShieldCheck} label={available ? t('inspect', { name: profile.displayName }) : t('desktopOnly')}
      disabled={!available} onClick={() => setOpen(true)} />
    <Modal open={open} title={t('title')} onClose={() => { stop(); setOpen(false); }}>
      <form className="connection-access" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <p className="endpoint">{profile.displayName} / {profile.endpoint}</p>
        <label className="form-field">{t('index')}<input value={index} placeholder={t('optional')} autoComplete="off"
          maxLength={2048} disabled={busy} onChange={(event) => setIndex(event.target.value)} /></label>
        {error?.profile === profile ? <div role="alert" className="notice error">{t(`errors:${error.code}`, { defaultValue: t('failed') })}</div> : null}
        {result && result.profile !== profile ? <p role="status" className="notice warning">{t('stale')}</p> : null}
        {response ? <div className="access-results">
          <h3>{t('identity')}</h3>
          <dl>
            <div><dt>{t('identity')}</dt><dd>{status(response.identity)}</dd></div>
            <div><dt>{t('username')}</dt><dd>{response.identity.username ?? t('unknown')}</dd></div>
            <div><dt>{t('roles')}</dt><dd>{response.identity.roles.join(', ') || t('none')}</dd></div>
          </dl>
          <h3>{t('permissions')}</h3>
          <dl>
            <div><dt>{t('monitor')}</dt><dd>{status(response.privileges.monitor)}</dd></div>
            <div><dt>{t('index')}</dt><dd>{response.index ?? t('noIndex')}</dd></div>
            <div><dt>{t('read')}</dt><dd>{status(response.privileges.read)}</dd></div>
            <div><dt>{t('viewIndexMetadata')}</dt><dd>{status(response.privileges.viewIndexMetadata)}</dd></div>
          </dl>
          <h3 title={t('apiScope')}>{t('capabilities')}</h3>
          <dl>
            <div><dt>{t('version')}</dt><dd>{response.version ?? t('unknown')}</dd></div>
            <div><dt>{t('search')}</dt><dd>{status(response.capabilities.search)}</dd></div>
            <div><dt>{t('pit')}</dt><dd>{status(response.capabilities.pit)}</dd></div>
          </dl>
        </div> : null}
        <div className="dialog-actions">
          {busy ? <button type="button" className="secondary" onClick={stop}>{t('common:cancel')}</button> : null}
          <button type="submit" className="primary" disabled={busy || !available}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}{t(busy ? 'pending' : 'run')}
          </button>
        </div>
      </form>
    </Modal>
  </>;
}

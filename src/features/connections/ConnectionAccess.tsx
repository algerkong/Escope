import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import {
  capabilityNames, readConnectionAccess, type AccessFeedback, type ConnectionAccessResponse,
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
  const { t, i18n } = useTranslation('connectionAccess');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState('');
  const [running, setRunning] = useState<ConnectionProfile | null>(null);
  const pending = useRef<CancelRequest | null>(null);
  const [result, setResult] = useState<{ profile: ConnectionProfile; response: ConnectionAccessResponse } | null>(null);
  const [error, setError] = useState<{ profile: ConnectionProfile; code: string } | null>(null);
  const [expiredReport, setExpiredReport] = useState<ConnectionAccessResponse | null>(null);
  useEffect(() => () => {
    const request = pending.current;
    pending.current = null;
    if (request) void cancel(request).catch(() => undefined);
  }, [profile, cancel]);
  useEffect(() => {
    if (!result) return;
    const response = result.response;
    const deliveryAge = Math.max(0, Date.now() - response.checkedAtMs);
    const timer = window.setTimeout(() => setExpiredReport(response),
      Math.max(0, response.reports.ttlMs - response.reports.ageMs - deliveryAge));
    return () => window.clearTimeout(timer);
  }, [result]);

  const busy = running === profile;
  const stop = () => {
    const request = pending.current;
    pending.current = null;
    setRunning(null);
    if (request) void cancel(request).catch(() => undefined);
  };
  const run = async (refresh = false) => {
    if (!available || pending.current) return;
    const request = { requestId: crypto.randomUUID(), connectionId: profile.id };
    pending.current = request;
    setRunning(profile);
    setError(null);
    setResult(null);
    try {
      const target = index.trim() || null;
      const response = await inspect({ ...request, ...(target ? { index: target } : {}), ...(refresh ? { refresh: true } : {}) });
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
  const response = result?.profile === profile && result.response.index === (index.trim() || null) ? result.response : null;
  const diagnosticError = (code: string) => t(`errors.${code}`, { defaultValue: t(`errors:${code}`, { defaultValue: t('failed') }) });
  const status = (value: AccessFeedback, report = false) => <span data-access={report ? `report-${value.status}` : value.status}
    title={value.code ? diagnosticError(value.code) : undefined}>{t(report && value.status === 'available' ? 'reportAvailable' : value.status)}</span>;
  const time = (value: number | string | null) => {
    if (value === null) return t('notReported');
    const number = Number(value);
    const date = new Date(number);
    if (!Number.isSafeInteger(number) || Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(date);
  };
  return <>
    <IconButton icon={ShieldCheck} label={available ? t('inspect', { name: profile.displayName }) : t('desktopOnly')}
      disabled={!available} onClick={() => setOpen(true)} />
    <Modal open={open} title={t('title')} onClose={() => { stop(); setOpen(false); }}>
      <form className="connection-access" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <p className="endpoint">{profile.displayName} / {profile.endpoint}</p>
        <label className="form-field">{t('index')}<input value={index} placeholder={t('optional')} autoComplete="off"
          maxLength={2048} disabled={busy} onChange={(event) => setIndex(event.target.value)} /></label>
        {error?.profile === profile ? <div role="alert" className="notice error">
          {error.code === 'notFound' ? t('errors:notFound') : diagnosticError(error.code)}
        </div> : null}
        {result && !response ? <p role="status" className="notice warning">{t('stale')}</p> : null}
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
          <h3>{t('server')}</h3>
          <dl>
            <div><dt>{t('serverRead')}</dt><dd>{status(response.server, true)}</dd></div>
            <div><dt>{t('version')}</dt><dd>{response.server.version ?? t('unknown')}
              <span className="access-evidence">{t(`versionKinds.${response.server.versionKind}`)}</span></dd></div>
            <div><dt>{t('clusterUuid')}</dt><dd>{response.server.clusterUuid ?? t('notReported')}</dd></div>
            <div><dt>{t('buildFlavor')}</dt><dd>{t(`flavors.${response.server.buildFlavor}`)}</dd></div>
            <div><dt>{t('deployment')}</dt><dd>{t(response.server.deployment === 'serverless' ? 'serverless' : 'deploymentUnknown')}</dd></div>
          </dl>
          <h3>{t('license')}</h3>
          <dl>
            <div><dt>{t('licenseRead')}</dt><dd>{status(response.license, true)}</dd></div>
            <div><dt>{t('licenseKind')}</dt><dd>{response.license.kind ? t(`licenseKinds.${response.license.kind}`) : t('unknown')}</dd></div>
            <div><dt>{t('licenseState')}</dt><dd data-license={response.license.state ?? undefined}>
              {response.license.state ? t(`licenseStates.${response.license.state}`) : t('unknown')}</dd></div>
            <div><dt>{t('expiry')}</dt><dd>{time(response.license.expiryTimeMs)}</dd></div>
          </dl>
          <h3>{t('capabilities')}</h3>
          <dl>
            <div><dt>{t('featureRead')}</dt><dd>{status(response.featureReport, true)}</dd></div>
            {capabilityNames.map((name) => {
              const capability = response.capabilities[name];
              const flags = name === 'search' || name === 'pit' ? null : response.featureReport[name];
              return <div key={name}><dt>{t(name)}</dt><dd>
                <span data-capability={capability.status} title={capability.code ? diagnosticError(capability.code) : t(`reasons.${capability.reason}`)}>
                  {t(capability.status)}
                </span>
                <span className="access-evidence" title={t(`reasons.${capability.reason}`)}>{t(`sources.${capability.source}`)}</span>
                {flags ? <span className="access-evidence">{t('flags', { available: t(flags.available ? 'yes' : 'no'), enabled: t(flags.enabled ? 'yes' : 'no') })}</span> : null}
              </dd></div>;
            })}
            <div><dt>{t('operationChecks')}</dt><dd>{t('notRun')}</dd></div>
          </dl>
          <dl className="access-freshness">
            <div><dt>{t('checkedAt')}</dt><dd>{time(response.checkedAtMs)}</dd></div>
            <div><dt>{t('reportsAt')}</dt><dd>{time(response.reports.checkedAtMs)}</dd></div>
            <div><dt>{t('reportSource')}</dt><dd>{t(response.reports.source)}</dd></div>
            <div><dt>{t('validity')}</dt><dd>{t('validityValue')}</dd></div>
          </dl>
          {expiredReport === response ? <p role="status" className="notice warning">{t('reportExpired')}</p> : null}
        </div> : null}
        <div className="dialog-actions">
          {response ? <IconButton icon={RefreshCw} label={t('refresh')} disabled={busy || !available}
            onClick={() => void run(true)} /> : null}
          {busy ? <button type="button" className="secondary" onClick={stop}>{t('common:cancel')}</button> : null}
          <button type="submit" className="primary" disabled={busy || !available}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}{t(busy ? 'pending' : 'run')}
          </button>
        </div>
      </form>
    </Modal>
  </>;
}

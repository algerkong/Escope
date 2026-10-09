import { useCallback, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Database, KeyRound, Pencil, PlugZap, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { ConnectionInput, ConnectionProfile, ConnectionSecurityChange } from '../../domain/connection';
import { EmptyState, IconButton, Modal } from '../../components/controls';
import { errorCode } from '../../services/ipc';
import type { ConnectionTestState } from './useConnectionTests';
import { ConnectionTestResult } from './ConnectionTestResult';
import { ConnectionEditor } from './ConnectionEditor';
import '../../styles/connection-settings.css';

export interface ConnectionPanelProps {
  connections: ConnectionProfile[];
  activeId: string | null;
  busy: boolean;
  canTest: boolean;
  testResults: Record<string, ConnectionTestState>;
  timeZone: string;
  /** True while detached credentials are still queued for cleanup on this device. */
  cleanupPending?: boolean;
  /** True while the parent's cleanup request is in flight. */
  cleanupBusy?: boolean;
  onCleanup?: () => Promise<void>;
  onTest: (id: string) => void;
  onSelect: (id: string) => Promise<void>;
  onSave: (input: ConnectionInput, id?: string, security?: ConnectionSecurityChange) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /**
   * Reserved integration slot for the permission/access diagnostics component (owned by the app
   * shell). Rendered inside every row after the test result; this panel adds no permission checks.
   */
  renderAccess?: (profile: ConnectionProfile) => ReactNode;
}

/** Authentication metadata as shown in the row; never reads or shows any stored secret. */
function authSummary(t: TFunction, profile: ConnectionProfile): string {
  if (profile.auth === 'none') return t('connectionSettings:authNone');
  const label = t(profile.auth === 'basic' ? 'connectionSettings:authBasic'
    : profile.auth === 'apiKey' ? 'connectionSettings:authApiKey' : 'connectionSettings:authBearer');
  const state = t(profile.hasCredential === true
    ? 'connectionSettings:authCredentialSaved' : 'connectionSettings:authCredentialMissing');
  return `${label} · ${state}`;
}

export function ConnectionPanel({
  connections, activeId, busy, canTest, testResults, timeZone,
  cleanupPending = false, cleanupBusy = false, onCleanup, renderAccess,
  onTest, onSelect, onSave, onDelete,
}: ConnectionPanelProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ConnectionProfile | 'new' | null>(null);
  const [removing, setRemoving] = useState<ConnectionProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const cleanupLock = useRef(false);

  const retryCleanup = useCallback(async () => {
    if (!onCleanup || cleanupLock.current || cleanupBusy) return;
    cleanupLock.current = true;
    setCleaning(true);
    setCleanupError(null);
    try {
      await onCleanup();
    } catch (cause) {
      setCleanupError(errorCode(cause));
    } finally {
      cleanupLock.current = false;
      setCleaning(false);
    }
  }, [cleanupBusy, onCleanup]);

  const filtered = connections.filter((profile) => `${profile.displayName} ${profile.endpoint}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <div className="connections-toolbar">
      <label className="search-input"><Search size={16} /><input aria-label={t('connections:filter')} placeholder={t('connections:filter')}
        value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <button className="primary" onClick={() => setEditing('new')}><Plus size={16} />{t('connections:add')}</button>
    </div>
    <div className="subheading muted">{t('connections:count', { count: connections.length })}</div>
    {cleanupPending ? <div className="notice warning connection-cleanup" role="alert">
      <KeyRound size={16} aria-hidden="true" /><span>{t('connectionSettings:cleanupPending')}</span>
      {onCleanup ? <button type="button" className="secondary compact-button" disabled={busy || cleanupBusy || cleaning}
        onClick={() => void retryCleanup()}>{t('connectionSettings:cleanupRetry')}</button> : null}
    </div> : null}
    {cleanupError ? <div className="notice error connection-cleanup" role="alert">
      <AlertTriangle size={16} aria-hidden="true" /><span>{t('connectionSettings:cleanupFailed')}{' '}
      {t(`errors:${cleanupError}`, { defaultValue: t('errors:unexpected') })}</span>
    </div> : null}
    {error ? <div className="notice error" role="alert">{t(`errors:${error}`, { defaultValue: t('errors:unexpected') })}</div> : null}
    {filtered.length ? <div className="connection-list">
      {filtered.map((profile) => <article className="connection-row" key={profile.id} data-selected={profile.id === activeId} aria-label={profile.displayName}>
        <Database size={20} className="muted" />
        <div className="connection-info"><div className="connection-title"><strong>{profile.displayName}</strong>
          <span className={`environment ${profile.environment}`}>{t(`connections:${profile.environment}`)}</span></div>
          <div className="endpoint">{profile.endpoint}</div>
          <div className="connection-meta small">
            <span className={`connection-badge${profile.auth !== 'none' && profile.hasCredential !== true ? ' warn' : ''}`}>
              <KeyRound size={12} aria-hidden="true" />{authSummary(t, profile)}</span>
            <span className="connection-badge"><ShieldCheck size={12} aria-hidden="true" />
              {t(profile.hasCustomCa === true ? 'connectionSettings:caBadgeCustom' : 'connectionSettings:caBadgeDefault')}</span>
          </div>
          <ConnectionTestResult result={testResults[profile.id]} timeZone={timeZone} />
          {renderAccess ? renderAccess(profile) : null}
        </div>
        <div className="connection-actions">
          <IconButton icon={PlugZap} label={canTest ? t('connections:test', { name: profile.displayName }) : t('connections:testDesktopOnly')}
            disabled={busy || !canTest} aria-disabled={testResults[profile.id]?.status === 'running'}
            onClick={() => { if (testResults[profile.id]?.status !== 'running') onTest(profile.id); }} />
          <button className="secondary compact-button" disabled={busy || profile.id === activeId} onClick={() => {
            setError(null); void onSelect(profile.id).catch((cause: unknown) => setError(errorCode(cause)));
          }}>{profile.id === activeId ? <Check size={14} /> : null}{t(profile.id === activeId ? 'selected' : 'select')}</button>
          <IconButton icon={Pencil} label={`${t('edit')} ${profile.displayName}`} disabled={busy} onClick={() => setEditing(profile)} />
          <IconButton icon={Trash2} label={`${t('delete')} ${profile.displayName}`} disabled={busy} onClick={() => { setError(null); setRemoving(profile); }} />
        </div>
      </article>)}
    </div> : <EmptyState icon={Database} title={t(connections.length ? 'noMatches' : 'connections:empty')}
      description={connections.length ? undefined : t('connections:emptyDetail')} />}
    <ConnectionEditor key={editing === 'new' ? 'new' : editing?.id ?? 'closed'} value={editing} busy={busy}
      canTest={canTest} onClose={() => { if (!busy) setEditing(null); }} onSave={onSave} />
    <Modal open={removing !== null} onClose={() => { if (!busy) setRemoving(null); }} title={t('connections:deleteTitle')}
      description={t('connections:deleteDetail', { name: removing?.displayName })}>
      {error ? <div className="notice error" role="alert">{t(`errors:${error}`, { defaultValue: t('errors:unexpected') })}</div> : null}
      <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</button>
        <button className="danger" disabled={busy} onClick={() => {
          if (!removing) return;
          setError(null);
          void onDelete(removing.id).then(() => setRemoving(null)).catch((cause: unknown) => setError(errorCode(cause)));
        }}><Trash2 size={16} />{t('delete')}</button></div>
    </Modal>
  </>;
}

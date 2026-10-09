import { useState } from 'react';
import { Check, Database, Pencil, Plus, Search, Trash2, AlertTriangle, PlugZap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConnectionInput, ConnectionProfile } from '../../domain/connection';
import { validateConnection } from '../../domain/connection';
import { EmptyState, IconButton, Modal, SelectControl } from '../../components/controls';
import { errorCode } from '../../services/ipc';
import type { ConnectionTestState } from './useConnectionTests';
import { ConnectionTestResult } from './ConnectionTestResult';

interface Props {
  connections: ConnectionProfile[];
  activeId: string | null;
  busy: boolean;
  canTest: boolean;
  testResults: Record<string, ConnectionTestState>;
  timeZone: string;
  onTest: (id: string) => void;
  onSelect: (id: string) => Promise<void>;
  onSave: (input: ConnectionInput, id?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ConnectionPanel({ connections, activeId, busy, canTest, testResults, timeZone, onTest, onSelect, onSave, onDelete }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ConnectionProfile | 'new' | null>(null);
  const [removing, setRemoving] = useState<ConnectionProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filtered = connections.filter((profile) => `${profile.displayName} ${profile.endpoint}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <div className="connections-toolbar">
      <label className="search-input"><Search size={16} /><input aria-label={t('connections:filter')} placeholder={t('connections:filter')}
        value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <button className="primary" onClick={() => setEditing('new')}><Plus size={16} />{t('connections:add')}</button>
    </div>
    <div className="subheading muted">{t('connections:count', { count: connections.length })}</div>
    {error ? <div className="notice error" role="alert">{t(`errors:${error}`)}</div> : null}
    {filtered.length ? <div className="connection-list">
      {filtered.map((profile) => <article className="connection-row" key={profile.id} data-selected={profile.id === activeId} aria-label={profile.displayName}>
        <Database size={20} className="muted" />
        <div className="connection-info"><div className="connection-title"><strong>{profile.displayName}</strong>
          <span className={`environment ${profile.environment}`}>{t(`connections:${profile.environment}`)}</span></div>
          <div className="endpoint">{profile.endpoint}</div>
          <ConnectionTestResult result={testResults[profile.id]} timeZone={timeZone} />
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
      onClose={() => { if (!busy) setEditing(null); }} onSave={onSave} />
    <Modal open={removing !== null} onClose={() => { if (!busy) setRemoving(null); }} title={t('connections:deleteTitle')}
      description={t('connections:deleteDetail', { name: removing?.displayName })}>
      {error ? <div className="notice error" role="alert">{t(`errors:${error}`)}</div> : null}
      <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</button>
        <button className="danger" disabled={busy} onClick={() => {
          if (!removing) return;
          setError(null);
          void onDelete(removing.id).then(() => setRemoving(null)).catch((cause: unknown) => setError(errorCode(cause)));
        }}><Trash2 size={16} />{t('delete')}</button></div>
    </Modal>
  </>;
}

function ConnectionEditor({ value, busy, onClose, onSave }:
  { value: ConnectionProfile | 'new' | null; busy: boolean; onClose: () => void; onSave: Props['onSave'] }) {
  const { t } = useTranslation();
  const existing = value && value !== 'new' ? value : null;
  const [input, setInput] = useState<ConnectionInput>(() => ({
    displayName: existing?.displayName ?? '', endpoint: existing?.endpoint ?? 'https://',
    environment: existing?.environment ?? 'development',
  }));
  const [error, setError] = useState<string | null>(null);
  return <Modal open={value !== null} onClose={onClose} title={t(existing ? 'connections:edit' : 'connections:add')}
    description={t('connections:authPending')}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      setError(null);
      try {
        const clean = validateConnection(input);
        void onSave(clean, existing?.id).then(onClose).catch((cause: unknown) => setError(errorCode(cause)));
      } catch (cause) { setError(errorCode(cause)); }
    }}>
      <label className="form-field">{t('connections:name')}<input autoComplete="off" required maxLength={80} value={input.displayName}
        onChange={(event) => setInput({ ...input, displayName: event.target.value })} /></label>
      <label className="form-field">{t('connections:endpoint')}<input autoComplete="off" spellCheck={false} required type="url" maxLength={2048}
        value={input.endpoint} onChange={(event) => setInput({ ...input, endpoint: event.target.value })} /></label>
      <label className="form-field">{t('connections:environment')}<SelectControl value={input.environment}
        onChange={(event) => setInput({ ...input, environment: event.target.value as ConnectionInput['environment'] })}>
        {(['development', 'staging', 'production'] as const).map((env) => <option key={env} value={env}>{t(`connections:${env}`)}</option>)}
      </SelectControl></label>
      <div className="form-field"><span>{t('connections:authentication')}</span><span className="muted">{t('connections:none')}</span></div>
      {input.endpoint.startsWith('http:') ? <div className="notice warning"><AlertTriangle size={16} />{t('connections:httpWarning')}</div> : null}
      {error ? <div className="notice error" role="alert">{t(`errors:${error}`)}</div> : null}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>{t('cancel')}</button>
        <button className="primary" type="submit" disabled={busy}>{t('save')}</button></div>
    </form>
  </Modal>;
}

import { Clock3, Database, FileText, History, LoaderCircle, RefreshCw, RotateCcw, Search, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import type { ConnectionProfile } from '../../domain/connection';
import type { QueryDocument } from '../../domain/query';
import { MAX_EXECUTION_HISTORY, restoreHistoryQuery, type ExecutionHistoryEntry } from '../../domain/workspace-recovery';
import type { WorkspaceRecoveryController } from './useWorkspaceRecovery';
import { executionErrorKey } from './error-message';
import { TimeRangeSummary } from './QueryTimeRangeDialog';
import '../../styles/workspace-recovery.css';

export function WorkspaceRecoveryStatus({ recovery }: { recovery: WorkspaceRecoveryController }) {
  const { t } = useTranslation();
  const [confirmReload, setConfirmReload] = useState(false);
  const loadFailed = recovery.status === 'error' || recovery.status === 'conflict';
  const saveFailed = recovery.status === 'ready' && recovery.saveStatus.status === 'error';
  const busy = recovery.status === 'loading' || recovery.saveStatus.status === 'saving';
  const failed = loadFailed || saveFailed;
  const message = recovery.status === 'conflict' ? 'conflict'
    : recovery.status === 'error' ? recovery.loadError === 'invalidResponse' ? 'damaged' : 'loadFailed'
    : saveFailed ? recovery.saveStatus.code === 'invalidInput' ? 'limit' : 'saveFailed'
    : recovery.status === 'loading' ? 'loading'
    : recovery.kind === 'session' ? 'session'
    : recovery.saveStatus.status === 'saving' ? 'saving' : 'saved';

  return <>
    <div className={`workspace-recovery-state${failed ? ' failed' : ''}`} role={failed ? 'alert' : 'status'}>
      {failed ? <TriangleAlert size={14} aria-hidden="true" /> : busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}
      <span>{t(`workspaceRecovery:${message}`)}</span>
      {loadFailed ? <button type="button" className="secondary compact-button" onClick={() => setConfirmReload(true)}>
        <RefreshCw size={13} aria-hidden="true" />{t('workspaceRecovery:reload')}</button> : null}
      {saveFailed ? <button type="button" className="secondary compact-button" onClick={recovery.retrySave}>{t('retry')}</button> : null}
    </div>
    <Modal open={confirmReload} onClose={() => setConfirmReload(false)} title={t('workspaceRecovery:reloadTitle')}
      description={t('workspaceRecovery:reloadDetail')}>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => setConfirmReload(false)}>{t('cancel')}</button>
        <button type="button" className="danger" onClick={() => { setConfirmReload(false); recovery.reload(); }}>
          {t('workspaceRecovery:reload')}
        </button>
      </div>
    </Modal>
  </>;
}

export function ExecutionHistoryDialog({ open, recovery, profiles, onClose, onRestore }: {
  open: boolean;
  recovery: WorkspaceRecoveryController;
  profiles: readonly ConnectionProfile[];
  onClose: () => void;
  onRestore?: (query: QueryDocument) => void;
}) {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState('');
  const [removing, setRemoving] = useState<{ entry: ExecutionHistoryEntry | null } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const connections = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.displayName])), [profiles]);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium' }), [i18n.language]);
  const numberFormat = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  if (!open) return null;
  const needle = filter.toLocaleLowerCase(i18n.language);
  const entries = recovery.history.filter((entry) => `${entry.name} ${entry.snapshot.index} ${connections.get(entry.snapshot.connectionId) ?? ''}`
    .toLocaleLowerCase(i18n.language).includes(needle));
  const canDelete = recovery.status === 'ready';
  const remove = () => {
    recovery.deleteHistory(removing?.entry?.snapshot.requestId ?? null);
    setRemoving(null);
    requestAnimationFrame(() => listRef.current?.focus());
  };

  return <Modal open={open} onClose={onClose} title={t('queryHistory:title')}>
    <div className="qhistory-panel">
      <div className="qhistory-toolbar">
        <label className="qhistory-search"><Search size={14} aria-hidden="true" />
          <input type="search" value={filter} aria-label={t('queryHistory:search')} placeholder={t('queryHistory:search')}
            onChange={(event) => setFilter(event.target.value)} /></label>
        <span className="muted" title={t('queryHistory:limit', { count: MAX_EXECUTION_HISTORY })}>
          {numberFormat.format(recovery.history.length)} / {MAX_EXECUTION_HISTORY}
        </span>
        <IconButton icon={Trash2} label={t('queryHistory:clear')} disabled={!canDelete || !recovery.history.some((entry) => entry.status !== 'running')}
          onClick={() => setRemoving({ entry: null })} />
      </div>
      {entries.length === 0 ? <div className="qhistory-empty"><History size={22} aria-hidden="true" />
        <p>{t(filter ? 'queryHistory:noMatches' : 'queryHistory:empty')}</p></div> : null}
      <ul className="qhistory-list" ref={listRef} tabIndex={-1} aria-label={t('queryHistory:title')}>
        {entries.map((entry) => {
          const label = entry.name || entry.snapshot.index;
          const duration = entry.finishedAt === null ? null : new Date(entry.finishedAt).getTime() - new Date(entry.snapshot.startedAt).getTime();
          return <li key={entry.snapshot.requestId} className="qhistory-entry">
            <div className="qhistory-entry-heading">
              {entry.kind === 'index' ? <Database size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
              <strong title={label}>{label}</strong>
              <span className={`qhistory-outcome ${entry.status}`}
                title={entry.errorCode === null ? undefined : t(executionErrorKey(entry.errorCode, (key) => i18n.exists(key)))}>
                {t(`queryHistory:${entry.status}`)}
              </span>
              <IconButton icon={RotateCcw} label={t('queryHistory:restore')} disabled={!onRestore}
                onClick={() => { onRestore?.(restoreHistoryQuery(entry)); onClose(); }} />
              <IconButton icon={Trash2} label={t('queryHistory:delete')} disabled={!canDelete || entry.status === 'running'}
                onClick={() => setRemoving({ entry })} />
            </div>
            <div className="qhistory-meta">
              <span>{connections.get(entry.snapshot.connectionId) ?? t('removedConnection')}</span>
              <span>{entry.snapshot.index}</span>
              <span>{t(`queryHistory:kind${entry.kind}`)}</span>
            </div>
            <div className="qhistory-meta">
              <Clock3 size={12} aria-hidden="true" /><time dateTime={entry.snapshot.startedAt}>{timeFormat.format(new Date(entry.snapshot.startedAt))}</time>
              {duration !== null ? <span>{t('queryHistory:duration', { value: numberFormat.format(duration) })}</span> : null}
            </div>
            {entry.snapshot.timeRange ? <TimeRangeSummary time={entry.snapshot.timeRange} /> : null}
          </li>;
        })}
      </ul>
    </div>
    <Modal open={removing !== null} onClose={() => setRemoving(null)}
      title={t(removing?.entry ? 'queryHistory:deleteTitle' : 'queryHistory:clearTitle')}
      description={t('queryHistory:deleteDetail')}>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => setRemoving(null)}>{t('cancel')}</button>
        <button type="button" className="danger" onClick={remove}>{t('delete')}</button>
      </div>
    </Modal>
  </Modal>;
}

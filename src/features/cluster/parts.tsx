import { Database, LoaderCircle, RefreshCw, TriangleAlert, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/controls';
import { useCopyText } from '../query/useCopyText';
import { clusterErrorKey } from './error-message';
import type { ClusterLoad } from './useClusterResources';

/**
 * Shared surfaces for the read-only cluster resource pages. Data (target, metrics, JSON, table
 * cells) stays selectable and copyable; only chrome such as headings and buttons is opted out by
 * the global selection policy.
 */

/** Rows rendered per page: a large response never renders every row into the DOM at once. */
export const CLUSTER_PAGE_SIZE = 100;

/** Current connection target shown under every resource page title. */
export function ClusterTarget({ name, endpoint, status }: { name: string; endpoint: string; status: string }) {
  return <div className="resource-target cluster-target">
    <Database size={16} />
    <div className="cluster-target-body">
      <strong className="cluster-target-name">{name}</strong>
      <span className="endpoint">{endpoint}</span>
    </div>
    <span className="muted">{status}</span>
  </div>;
}

/** Section heading with an explicit refresh; nothing on this page refreshes on its own. */
export function ClusterToolbar({ title, onRefresh, children }:
  { title: string; onRefresh: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return <div className="cluster-toolbar">
    <h2>{title}</h2>
    {children}
    <button type="button" className="secondary compact-button cluster-refresh" onClick={onRefresh}>
      <RefreshCw size={14} />{t('cluster:refresh')}</button>
  </div>;
}

/**
 * Loading, cancelled and failed states for one read. A cancelled read states that the response
 * was discarded, and whether the backend confirmed the cancellation.
 */
export function ClusterState({ state, onRetry, onCancel }:
  { state: ClusterLoad<unknown>; onRetry: () => void; onCancel: () => void }) {
  const { t, i18n } = useTranslation();
  if (state.status === 'loading') {
    return <div className="cluster-state" role="status">
      <LoaderCircle size={15} className="spin" />{t('cluster:loading')}
      <button type="button" className="secondary compact-button" onClick={onCancel}>{t('cluster:cancel')}</button>
    </div>;
  }
  if (state.status === 'cancelled') {
    return <div className="cluster-state" role="status">
      <XCircle size={15} />
      <span>{t('cluster:cancelled')}</span>
      {state.confirmed ? null : <span className="muted">{t('cluster:cancelUnconfirmed')}</span>}
      <button type="button" className="secondary compact-button" onClick={onRetry}>{t('cluster:retry')}</button>
    </div>;
  }
  if (state.status === 'error') {
    return <div className="cluster-state error" role="alert">
      <TriangleAlert size={15} />
      <span>{t(clusterErrorKey(state.code, (key) => i18n.exists(key)))}</span>
      <button type="button" className="secondary compact-button" onClick={onRetry}>{t('cluster:retry')}</button>
    </div>;
  }
  return null;
}

/** Local paging notice; the full response is never rendered into the DOM at once. */
export function ClusterPaging({ page, pageCount, shown, total, onPage }:
  { page: number; pageCount: number; shown: number; total: number; onPage: (page: number) => void }) {
  const { t } = useTranslation();
  return <div className="cluster-paging">
    <span>{t('cluster:rowsCapped', { shown, total })}</span>
    <button type="button" className="secondary compact-button" disabled={page === 0}
      onClick={() => onPage(page - 1)}>{t('cluster:prevPage')}</button>
    <span>{t('cluster:pageLabel', { page: page + 1, total: pageCount })}</span>
    <button type="button" className="secondary compact-button" disabled={page >= pageCount - 1}
      onClick={() => onPage(page + 1)}>{t('cluster:nextPage')}</button>
  </div>;
}

export function ClusterBadge({ children, tone }: { children: ReactNode; tone?: 'warn' }) {
  return <span className={`cluster-badge${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

/** Verbatim response text, shown only after the user asks for it. */
export function RawJsonModal({ open, onClose, title, text }:
  { open: boolean; onClose: () => void; title: string; text: string }) {
  const { t } = useTranslation();
  const copy = useCopyText();
  return <Modal open={open} onClose={onClose} title={title} description={t('cluster:rawHint')}>
    <pre className="cluster-pre">{text}</pre>
    <div className="cluster-actions">
      <button type="button" className="secondary compact-button" onClick={() => copy.copy(text)}>{t('cluster:copyRaw')}</button>
      {copy.status === 'idle' ? null : <span className={`cluster-copy-note ${copy.status}`} role="status">
        {copy.status === 'failed' ? t('cluster:copyFailed') : t('cluster:copied')}</span>}
    </div>
  </Modal>;
}

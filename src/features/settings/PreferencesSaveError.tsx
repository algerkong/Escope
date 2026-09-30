import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/controls';

/**
 * Preference save failure. Presented as a modal instead of a banner so the header and the query
 * area are never pushed down, and so the rejected draft stays visible behind it. Closing keeps the
 * draft; retrying re-sends the newest draft through the same queue that rejected it.
 */
export function PreferencesSaveError({ code, saving, onRetry, onClose }:
  { code: string | null; saving: boolean; onRetry: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  return <Modal open={code !== null} onClose={onClose} title={t('errors:saveTitle')}>
    <p className="notice error" role="alert"><TriangleAlert size={16} />
      <span>{t('errors:saveFailed')}{code ? ` ${t(`errors:${code}`)}` : ''}</span></p>
    <div className="dialog-actions">
      <button type="button" className="secondary" onClick={onClose}>{t('close')}</button>
      <button type="button" className="primary" disabled={saving} onClick={onRetry}>
        {saving ? <LoaderCircle size={14} className="spin" /> : null}{t('retry')}
      </button>
    </div>
  </Modal>;
}

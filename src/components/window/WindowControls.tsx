import { Copy, Minus, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// In-app caption buttons for desktop platforms without a native title bar. Sizes are fixed
// so the bar never shifts between the maximize and restore states.
export function WindowControls({ maximized, onMinimize, onToggleMaximize, onClose }:
  { maximized: boolean; onMinimize: () => void; onToggleMaximize: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const toggleLabel = t(maximized ? 'window:restore' : 'window:maximize');
  return <div className="window-controls" role="group" aria-label={t('window:controls')}>
    <button type="button" className="window-control" aria-label={t('window:minimize')} title={t('window:minimize')} onClick={onMinimize}>
      <Minus size={16} />
    </button>
    <button type="button" className="window-control" aria-label={toggleLabel} title={toggleLabel}
      aria-pressed={maximized} onClick={onToggleMaximize}>
      {maximized ? <Copy size={13} /> : <Square size={13} />}
    </button>
    <button type="button" className="window-control window-control-close" aria-label={t('window:close')} title={t('window:close')} onClick={onClose}>
      <X size={16} />
    </button>
  </div>;
}

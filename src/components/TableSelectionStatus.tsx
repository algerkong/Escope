import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './controls';

export function TableSelectionStatus({ count, onClear }: { count: number; onClear: () => void }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return <span className="table-selection-status">
    <span role="status">{t('selectedRows', { count })}</span>
    <IconButton icon={X} label={t('clearSelection')} onClick={onClear} />
  </span>;
}

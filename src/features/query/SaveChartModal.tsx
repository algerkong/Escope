import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, SelectControl } from '../../components/controls';
import type {
  ChartAggregationClause,
  ChartType,
  SavedChartDefinition,
} from '../../domain/saved-charts';
import type { SavedChartsController } from './useSavedCharts';
import '../../styles/query-charts.css';

interface Props {
  open: boolean;
  onClose: () => void;
  clauses: readonly ChartAggregationClause[];
  connectionId: string | null;
  index: string;
  initialName?: string;
  initialChartType?: ChartType;
  initialPreferredMetric?: string | null;
  controller: SavedChartsController;
  onSaved?: (definition: SavedChartDefinition) => void;
}

export function SaveChartModal({
  open,
  onClose,
  clauses,
  connectionId,
  index,
  initialName = '',
  initialChartType,
  initialPreferredMetric = null,
  controller,
  onSaved,
}: Props) {
  const { t } = useTranslation('queryCharts');

  const defaultChartType = useMemo((): ChartType => {
    if (initialChartType) return initialChartType;
    if (clauses.length === 1) {
      const first = clauses[0]!;
      if (['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'].includes(first.aggregationType)) {
        return 'metric';
      }
      if (first.aggregationType === 'terms') {
        return 'bar';
      }
      if (first.aggregationType === 'date_histogram') {
        return 'line';
      }
    }
    return 'table';
  }, [initialChartType, clauses]);

  const [name, setName] = useState(initialName || (clauses[0]?.name ? `${clauses[0].name} Chart` : 'New Chart'));
  const [chartType, setChartType] = useState<ChartType>(defaultChartType);
  const [preferredMetric, setPreferredMetric] = useState<string | null>(initialPreferredMetric);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableMetrics = useMemo(() => {
    const list: string[] = [];
    for (const c of clauses) {
      if (['sum', 'avg', 'min', 'max', 'value_count', 'cardinality'].includes(c.aggregationType)) {
        list.push(c.name);
      }
      if (c.subMetrics) {
        for (const sub of c.subMetrics) {
          list.push(sub.name);
        }
      }
    }
    return list;
  }, [clauses]);

  const canSave = name.trim().length > 0 && clauses.length > 0 && !submitting && !controller.saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);

    const definition: SavedChartDefinition = {
      id: crypto.randomUUID(),
      name: name.trim(),
      connectionId,
      index,
      chartType,
      clauses: structuredClone(clauses),
      preferredMetric: preferredMetric || null,
      description: description.trim() || null,
      updatedAt: new Date().toISOString(),
    };

    const success = await controller.saveChart(definition);
    setSubmitting(false);

    if (success) {
      if (onSaved) onSaved(definition);
      onClose();
    } else {
      setError(controller.error ?? 'saveFailed');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('saveModalTitle')}>
      <div className="qc-save-modal">
        <label>
          {t('chartName')}
          <input
            type="text"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label>
          {t('chartType')}
          <SelectControl
            value={chartType}
            onChange={(e) => setChartType(e.target.value as ChartType)}
            disabled={submitting}
          >
            <option value="table">{t('chartTypeTable')}</option>
            <option value="metric">{t('chartTypeMetric')}</option>
            <option value="bar">{t('chartTypeBar')}</option>
            <option value="line">{t('chartTypeLine')}</option>
          </SelectControl>
        </label>

        {availableMetrics.length > 0 ? (
          <label>
            {t('preferredMetric')}
            <SelectControl
              value={preferredMetric ?? ''}
              onChange={(e) => setPreferredMetric(e.target.value || null)}
              disabled={submitting}
            >
              <option value="">{t('orderMetric')}: _count / Default</option>
              {availableMetrics.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </SelectControl>
          </label>
        ) : null}

        <label>
          {t('description')}
          <textarea
            value={description}
            maxLength={500}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
          />
        </label>

        {error ? (
          <div className="notice error" role="alert">
            <span>{t(error === 'savedChartConflict' ? 'saveConflict' : error === 'savedChartConnectionMissing' ? 'connectionMissing' : 'saveFailed')}</span>
          </div>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={submitting}>
            {t('common:cancel', { defaultValue: 'Cancel' })}
          </button>
          <button type="button" className="primary" onClick={handleSave} disabled={!canSave}>
            {t('saveButton')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

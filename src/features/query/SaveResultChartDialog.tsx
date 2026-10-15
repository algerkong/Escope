import { Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/controls';
import { MAX_CHART_DEFINITIONS, MAX_CHART_NAME_CHARS, parseChartDefinition } from '../../domain/chart-definitions';
import type { ResultChartDefinitionSource } from '../../domain/chart-definition-sources';
import type { ChartDefinitionsController } from './useChartDefinitions';
import '../../styles/chart-definitions.css';

interface Props {
  source: ResultChartDefinitionSource;
  endpoint: string | null;
  requestId: string;
  page: number;
  controller: ChartDefinitionsController;
  onClose: () => void;
  onSaved: () => void;
}

export function SaveResultChartDialog({ source, endpoint, requestId, page, controller, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [captured] = useState(() => structuredClone(source));
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(captured.aggregation);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const candidate = parseChartDefinition({
    id, name: name.trim(), connectionId: captured.connectionId, index: captured.index,
    draft: captured.draft, measure: captured.measure,
  });
  const raw = JSON.stringify(candidate ?? captured, null, 2);
  const ready = controller.status === 'ready' && !controller.error && !controller.saving && !saving;
  const atLimit = controller.entries.length >= MAX_CHART_DEFINITIONS;
  const canSave = candidate !== null && ready && !atLimit && reviewed === raw;
  const save = async () => {
    if (!canSave || !candidate || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setFailed(false);
    try {
      const success = await controller.save(candidate);
      if (mounted.current) {
        if (success) onSaved();
        else setFailed(true);
      }
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return <Modal open title={t('queryCharts:saveFromResults')} onClose={onClose}>
    <div className="chart-definitions-panel">
      <dl className="qa-metadata">
        <dt>{t('documentDetail:execution')}</dt><dd><code>{requestId}</code></dd>
        <dt>{t('documentDetail:connection')}</dt><dd><code>{captured.connectionId}</code></dd>
        <dt>{t('documentDetail:endpoint')}</dt><dd><code>{endpoint ?? t('documentDetail:notRecorded')}</code></dd>
        <dt>{t('documentDetail:target')}</dt><dd><code>{captured.index}</code></dd>
        <dt>{t('queryAggregations:receivedPage')}</dt><dd>{page}</dd>
      </dl>
      <label className="chart-definition-result-name">{t('chartDefinitions:name')}
        <input value={name} maxLength={MAX_CHART_NAME_CHARS} disabled={saving} autoFocus
          onChange={(event) => { setName(event.target.value); setReviewed(null); setFailed(false); }} />
      </label>
      <pre className="ql-pre chart-definition-result-preview" aria-label={t('chartDefinitions:resultDefinition')}>{raw}</pre>
      <label className="chart-definition-result-review">
        <input type="checkbox" checked={reviewed === raw} disabled={!candidate || !ready}
          onChange={(event) => setReviewed(event.target.checked ? raw : null)} />
        {t('chartDefinitions:resultReviewed')}
      </label>
      {atLimit ? <p role="status">{t('chartDefinitions:limit', { count: MAX_CHART_DEFINITIONS })}</p> : null}
      {!candidate ? <p role="status">{t('chartDefinitions:invalidDefinition')}</p> : null}
      {controller.error || failed ? <p className="notice error" role="alert">
        {t(controller.error === 'chartDefinitionConflict' ? 'chartDefinitions:exchangeConflict'
          : controller.error === 'chartDefinitionConnectionMissing' ? 'chartDefinitions:reuseNoConnection'
            : 'chartDefinitions:saveUnavailable')}
      </p> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={saving}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={!canSave} onClick={() => { void save(); }}>
          <Save size={14} aria-hidden="true" />{t(saving ? 'chartDefinitions:saving' : 'chartDefinitions:saveAction')}
        </button>
      </div>
    </div>
  </Modal>;
}

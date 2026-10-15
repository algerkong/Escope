import { Copy, Download, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, IconButton, Modal } from '../../components/controls';
import type { SavedChartDefinition } from '../../domain/saved-charts';
import type { SavedChartsController } from './useSavedCharts';
import '../../styles/query-charts.css';

interface Props {
  open: boolean;
  onClose: () => void;
  currentIndex: string;
  controller: SavedChartsController;
  onApplyChart: (chart: SavedChartDefinition) => void;
  canApplyChart?: (chart: SavedChartDefinition) => boolean;
  legacy?: boolean;
}

function chartTypeBadgeLabel(type: SavedChartDefinition['chartType']): string {
  switch (type) {
    case 'metric':
      return 'chartTypeMetric';
    case 'bar':
      return 'chartTypeBar';
    case 'line':
      return 'chartTypeLine';
    case 'table':
      return 'chartTypeTable';
  }
}

export function SavedChartsDialog({
  open,
  onClose,
  currentIndex,
  controller,
  onApplyChart,
  canApplyChart,
  legacy = false,
}: Props) {
  const { t } = useTranslation('queryCharts');
  const [search, setSearch] = useState('');
  const [filterCurrentOnly, setFilterCurrentOnly] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const filteredEntries = useMemo(() => {
    return controller.entries.filter((entry) => {
      if (filterCurrentOnly && entry.index !== currentIndex) {
        return false;
      }
      if (search.trim()) {
        const query = search.trim().toLowerCase();
        return (
          entry.name.toLowerCase().includes(query) ||
          entry.index.toLowerCase().includes(query) ||
          (entry.description && entry.description.toLowerCase().includes(query))
        );
      }
      return true;
    });
  }, [controller.entries, filterCurrentOnly, currentIndex, search]);

  const handleCopyJson = async (chart: SavedChartDefinition) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(chart, null, 2));
      setCopiedId(chart.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleExportAll = async () => {
    try {
      const json = JSON.stringify(controller.entries, null, 2);
      await navigator.clipboard.writeText(json);
      setStatusMessage(t('copiedJson'));
      setTimeout(() => setStatusMessage(null), 3000);
    } catch {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm(t('deleteConfirm'))) {
      await controller.deleteChart(id);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t(legacy ? 'chartDefinitions:legacyLibrary' : 'chartLibraryTitle')}
      description={t(legacy ? 'chartDefinitions:legacyBoundary' : 'chartLibraryDescription')}>
      <div className="qc-dialog-content">
        <div className="qc-toolbar">
          <div className="qc-toolbar-start">
            <input
              type="text"
              placeholder={t('searchCharts')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 200 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={filterCurrentOnly}
                onChange={(e) => setFilterCurrentOnly(e.target.checked)}
              />
              <span>{t('currentTargetOnly')}</span>
            </label>
          </div>
          <div className="qc-toolbar-end">
            <IconButton
              icon={Download}
              label={t('exportAll')}
              onClick={handleExportAll}
              disabled={controller.entries.length === 0}
            />
            <IconButton
              icon={RefreshCw}
              label={t('common:retry', { defaultValue: 'Reload' })}
              onClick={controller.reload}
              disabled={controller.saving}
            />
          </div>
        </div>

        {statusMessage ? (
          <div className="notice success" role="status">
            <span>{statusMessage}</span>
          </div>
        ) : null}

        {controller.error ? (
          <div className="notice error" role="alert">
            <span>{t('saveFailed')}: {controller.error}</span>
          </div>
        ) : null}

        {filteredEntries.length === 0 ? (
          <EmptyState
            icon={Download}
            title={t('noSavedCharts')}
            description={search ? t('noSavedCharts') : undefined}
          />
        ) : (
          <ul className="qc-chart-list">
            {filteredEntries.map((chart) => (
              <li key={chart.id} className="qc-chart-card">
                <div className="qc-chart-card-top">
                  <div className="qc-chart-card-title">
                    <span>{chart.name}</span>
                    <span className="qc-badge">{t(chartTypeBadgeLabel(chart.chartType))}</span>
                  </div>
                  <div className="qc-chart-actions">
                    <button
                      type="button"
                      className="primary compact-button"
                      disabled={controller.saving || Boolean(controller.error) || canApplyChart?.(chart) === false}
                      title={legacy ? t('chartDefinitions:legacyReuseBoundary') : undefined}
                      onClick={() => {
                        if (canApplyChart?.(chart) === false) return;
                        onApplyChart(chart);
                        onClose();
                      }}
                    >
                      {t(legacy ? 'chartDefinitions:reuse' : 'loadIntoQuery')}
                    </button>
                    <IconButton
                      icon={Copy}
                      label={copiedId === chart.id ? t('copiedJson') : t('copyJson')}
                      onClick={() => handleCopyJson(chart)}
                    />
                    <IconButton
                      icon={Trash2}
                      label={t('deleteChart')}
                      onClick={() => handleDelete(chart.id)}
                      disabled={controller.saving}
                    />
                  </div>
                </div>
                <div className="qc-chart-card-meta">
                  <span><code>{chart.index}</code></span>
                  <span>
                    {chart.clauses.map((c) => `${c.name} (${c.aggregationType})`).join(', ')}
                  </span>
                  <span>{new Date(chart.updatedAt).toLocaleString()}</span>
                </div>
                {chart.description ? (
                  <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
                    {chart.description}
                  </p>
                ) : null}
                {legacy ? <details>
                  <summary>{t('chartDefinitions:legacyDefinition')}</summary>
                  <pre className="ql-pre">{JSON.stringify(chart, null, 2)}</pre>
                </details> : null}
              </li>
            ))}
          </ul>
        )}

        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t('common:close', { defaultValue: 'Close' })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

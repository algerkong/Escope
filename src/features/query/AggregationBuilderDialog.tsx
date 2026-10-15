import { Bookmark, Braces, Plus, Save, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import {
  isFieldSuitableForAggregation,
  parseAggregationClausesFromDsl,
  previewAggregationDsl,
  suggestAggregationFieldList,
} from '../../domain/query-aggregation-builder';
import type { FieldCatalog } from '../../domain/resource';
import {
  VALID_BUCKET_TYPES,
  VALID_METRIC_TYPES,
  type AggregationBuilderType,
  type ChartAggregationClause,
  type ChartSubMetric,
  type MetricType,
  type SavedChartDefinition,
} from '../../domain/saved-charts';
import { SaveChartModal } from './SaveChartModal';
import { SavedChartsDialog } from './SavedChartsDialog';
import type { SavedChartsController } from './useSavedCharts';
import '../../styles/query-charts.css';

interface Props {
  open: boolean;
  onClose: () => void;
  currentDsl: string;
  currentIndex: string;
  connectionId: string | null;
  fieldCatalog?: FieldCatalog;
  onApplyDsl: (newDsl: string) => void;
  savedChartsController: SavedChartsController;
}

export function AggregationBuilderDialog({
  open,
  onClose,
  currentDsl,
  currentIndex,
  connectionId,
  fieldCatalog,
  onApplyDsl,
  savedChartsController,
}: Props) {
  const { t } = useTranslation('queryCharts');

  // Parse initial clauses from current DSL
  const initialClauses = useMemo(() => {
    const parsed = parseAggregationClausesFromDsl(currentDsl);
    return parsed.ok ? parsed.clauses : [];
  }, [currentDsl]);

  const [clauses, setClauses] = useState<readonly ChartAggregationClause[]>(initialClauses);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [showDslPreview, setShowDslPreview] = useState(false);

  // Suggested field lists for dropdown helpers
  const fieldNames = useMemo(() => {
    return fieldCatalog?.fields.map((f) => f.name) ?? [];
  }, [fieldCatalog]);

  const preview = useMemo(() => {
    return previewAggregationDsl(currentDsl, clauses);
  }, [currentDsl, clauses]);

  const handleAddClause = () => {
    const defaultField = fieldNames[0] || 'field';
    const newClause: ChartAggregationClause = {
      id: crypto.randomUUID(),
      name: `agg_${clauses.length + 1}`,
      aggregationType: 'terms',
      field: defaultField,
      size: 10,
      orderMetric: '_count',
      orderDirection: 'desc',
    };
    setClauses((prev) => [...prev, newClause]);
  };

  const handleUpdateClause = (id: string, patch: Partial<ChartAggregationClause>) => {
    setClauses((prev) =>
      prev.map((clause) => {
        if (clause.id !== id) return clause;
        const updated = { ...clause, ...patch };
        // If type changed, reset type-specific options
        if (patch.aggregationType && patch.aggregationType !== clause.aggregationType) {
          if (patch.aggregationType === 'terms') {
            updated.size = 10;
            updated.orderMetric = '_count';
            updated.orderDirection = 'desc';
            delete updated.interval;
            delete updated.intervalType;
            delete updated.minDocCount;
          } else if (patch.aggregationType === 'date_histogram') {
            updated.interval = '1d';
            updated.intervalType = 'calendar';
            delete updated.size;
            delete updated.orderMetric;
            delete updated.orderDirection;
          } else {
            // metric
            delete updated.size;
            delete updated.orderMetric;
            delete updated.orderDirection;
            delete updated.interval;
            delete updated.intervalType;
            delete updated.minDocCount;
            delete updated.subMetrics;
          }
        }
        return updated;
      })
    );
  };

  const handleRemoveClause = (id: string) => {
    setClauses((prev) => prev.filter((c) => c.id !== id));
  };

  const handleAddSubMetric = (clauseId: string) => {
    const defaultField = fieldNames[0] || 'field';
    const newSub: ChartSubMetric = {
      id: crypto.randomUUID(),
      name: `sub_metric_${Date.now() % 1000}`,
      metricType: 'avg',
      field: defaultField,
    };
    setClauses((prev) =>
      prev.map((c) => {
        if (c.id !== clauseId) return c;
        const existing = c.subMetrics ?? [];
        return { ...c, subMetrics: [...existing, newSub] };
      })
    );
  };

  const handleUpdateSubMetric = (clauseId: string, subId: string, patch: Partial<ChartSubMetric>) => {
    setClauses((prev) =>
      prev.map((c) => {
        if (c.id !== clauseId || !c.subMetrics) return c;
        return {
          ...c,
          subMetrics: c.subMetrics.map((sm) => (sm.id === subId ? { ...sm, ...patch } : sm)),
        };
      })
    );
  };

  const handleRemoveSubMetric = (clauseId: string, subId: string) => {
    setClauses((prev) =>
      prev.map((c) => {
        if (c.id !== clauseId || !c.subMetrics) return c;
        const remaining = c.subMetrics.filter((sm) => sm.id !== subId);
        return { ...c, subMetrics: remaining.length > 0 ? remaining : undefined };
      })
    );
  };

  const handleApply = () => {
    if (preview.ok) {
      onApplyDsl(preview.dsl);
      onClose();
    }
  };

  const handleLoadChart = (chart: SavedChartDefinition) => {
    setClauses(structuredClone(chart.clauses));
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('builderTitle')}
        description={t('builderDescription')}
      >
        <div className="qc-dialog-content">
          <div className="qc-toolbar">
            <div className="qc-toolbar-start">
              <button type="button" className="primary compact-button" onClick={handleAddClause}>
                <Plus size={14} />
                <span>{t('addAggregation')}</span>
              </button>
              <button
                type="button"
                className="secondary compact-button"
                onClick={() => setLibraryDialogOpen(true)}
              >
                <Bookmark size={14} />
                <span>{t('loadFromLibrary')}</span>
              </button>
            </div>
            <div className="qc-toolbar-end">
              <button
                type="button"
                className="secondary compact-button"
                disabled={clauses.length === 0}
                onClick={() => setSaveModalOpen(true)}
              >
                <Save size={14} />
                <span>{t('saveAsChart')}</span>
              </button>
              <button
                type="button"
                className="secondary compact-button"
                onClick={() => setShowDslPreview((v) => !v)}
              >
                <Braces size={14} />
                <span>{t('previewDsl')}</span>
              </button>
            </div>
          </div>

          {clauses.length === 0 ? (
            <p className="muted" style={{ padding: '16px 0', textAlign: 'center' }}>
              {t('noAggregationsConfigured')}
            </p>
          ) : (
            <div className="qc-clauses-list">
              {clauses.map((clause) => {
                const isBucket = (VALID_BUCKET_TYPES as readonly string[]).includes(clause.aggregationType);
                const suitability = isFieldSuitableForAggregation(
                  clause.field,
                  clause.aggregationType,
                  fieldCatalog
                );

                return (
                  <div key={clause.id} className="qc-clause-card">
                    <div className="qc-clause-header">
                      <input
                        type="text"
                        value={clause.name}
                        placeholder={t('clauseName')}
                        onChange={(e) => handleUpdateClause(clause.id, { name: e.target.value })}
                        aria-label={t('clauseName')}
                      />
                      <SelectControl
                        value={clause.aggregationType}
                        onChange={(e) =>
                          handleUpdateClause(clause.id, {
                            aggregationType: e.target.value as AggregationBuilderType,
                          })
                        }
                        aria-label={t('clauseType')}
                      >
                        <optgroup label="Metric Aggregations">
                          {VALID_METRIC_TYPES.map((type) => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Bucket Aggregations">
                          {VALID_BUCKET_TYPES.map((type) => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                        </optgroup>
                      </SelectControl>
                      <IconButton
                        icon={Trash2}
                        label={t('removeClause')}
                        onClick={() => handleRemoveClause(clause.id)}
                      />
                    </div>

                    <div className="qc-clause-row">
                      <div className="qc-field-group">
                        <label>{t('field')}</label>
                        <input
                          type="text"
                          value={clause.field}
                          list={`fields-${clause.id}`}
                          placeholder="field_name"
                          onChange={(e) => handleUpdateClause(clause.id, { field: e.target.value })}
                          aria-label={t('field')}
                        />
                        <datalist id={`fields-${clause.id}`}>
                          {suggestAggregationFieldList(clause.aggregationType, fieldCatalog).map((f) => (
                            <option key={f} value={f} />
                          ))}
                        </datalist>
                        {!suitability.suitable && suitability.warning ? (
                          <span className="qc-field-warning" role="alert">
                            {t(suitability.warning)}
                          </span>
                        ) : null}
                      </div>

                      {clause.aggregationType === 'terms' ? (
                        <>
                          <div className="qc-field-group">
                            <label>{t('size')}</label>
                            <input
                              type="number"
                              min={1}
                              max={10000}
                              value={clause.size ?? 10}
                              onChange={(e) =>
                                handleUpdateClause(clause.id, { size: Number(e.target.value) || 10 })
                              }
                              aria-label={t('size')}
                            />
                          </div>
                          <div className="qc-field-group">
                            <label>{t('orderMetric')}</label>
                            <input
                              type="text"
                              value={clause.orderMetric ?? '_count'}
                              onChange={(e) =>
                                handleUpdateClause(clause.id, { orderMetric: e.target.value })
                              }
                              aria-label={t('orderMetric')}
                            />
                          </div>
                          <div className="qc-field-group">
                            <label>{t('orderDirection')}</label>
                            <SelectControl
                              value={clause.orderDirection ?? 'desc'}
                              onChange={(e) =>
                                handleUpdateClause(clause.id, {
                                  orderDirection: e.target.value as 'asc' | 'desc',
                                })
                              }
                              aria-label={t('orderDirection')}
                            >
                              <option value="desc">{t('orderDesc')}</option>
                              <option value="asc">{t('orderAsc')}</option>
                            </SelectControl>
                          </div>
                        </>
                      ) : null}

                      {clause.aggregationType === 'date_histogram' ? (
                        <>
                          <div className="qc-field-group">
                            <label>{t('interval')}</label>
                            <input
                              type="text"
                              value={clause.interval ?? '1d'}
                              placeholder="1d, 1h, 1m"
                              onChange={(e) =>
                                handleUpdateClause(clause.id, { interval: e.target.value })
                              }
                              aria-label={t('interval')}
                            />
                          </div>
                          <div className="qc-field-group">
                            <label>{t('intervalType')}</label>
                            <SelectControl
                              value={clause.intervalType ?? 'calendar'}
                              onChange={(e) =>
                                handleUpdateClause(clause.id, {
                                  intervalType: e.target.value as 'calendar' | 'fixed',
                                })
                              }
                              aria-label={t('intervalType')}
                            >
                              <option value="calendar">{t('calendarInterval')}</option>
                              <option value="fixed">{t('fixedInterval')}</option>
                            </SelectControl>
                          </div>
                        </>
                      ) : null}
                    </div>

                    {isBucket ? (
                      <div className="qc-submetrics">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{t('subMetrics')}</span>
                          <button
                            type="button"
                            className="secondary compact-button"
                            style={{ fontSize: '0.72rem', padding: '2px 6px' }}
                            onClick={() => handleAddSubMetric(clause.id)}
                          >
                            <Plus size={12} />
                            <span>{t('addSubMetric')}</span>
                          </button>
                        </div>

                        {clause.subMetrics && clause.subMetrics.length > 0 ? (
                          clause.subMetrics.map((sm) => (
                            <div key={sm.id} className="qc-submetric-row">
                              <input
                                type="text"
                                value={sm.name}
                                placeholder={t('subMetricName')}
                                onChange={(e) =>
                                  handleUpdateSubMetric(clause.id, sm.id, { name: e.target.value })
                                }
                                aria-label={t('subMetricName')}
                              />
                              <SelectControl
                                value={sm.metricType}
                                onChange={(e) =>
                                  handleUpdateSubMetric(clause.id, sm.id, {
                                    metricType: e.target.value as MetricType,
                                  })
                                }
                                aria-label={t('subMetricType')}
                              >
                                {VALID_METRIC_TYPES.map((type) => (
                                  <option key={type} value={type}>{type}</option>
                                ))}
                              </SelectControl>
                              <input
                                type="text"
                                value={sm.field}
                                placeholder={t('subMetricField')}
                                onChange={(e) =>
                                  handleUpdateSubMetric(clause.id, sm.id, { field: e.target.value })
                                }
                                aria-label={t('subMetricField')}
                              />
                              <IconButton
                                icon={Trash2}
                                label={t('removeSubMetric')}
                                onClick={() => handleRemoveSubMetric(clause.id, sm.id)}
                              />
                            </div>
                          ))
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {showDslPreview ? (
            <div className="qc-preview-container">
              <label style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{t('previewDsl')}</label>
              <pre className="qc-dsl-pre">
                {preview.ok ? preview.dsl : `Error: ${preview.code}`}
              </pre>
            </div>
          ) : null}

          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              {t('common:cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!preview.ok || !preview.changed}
              onClick={handleApply}
            >
              {t('applyToQuery')}
            </button>
          </div>
        </div>
      </Modal>

      {saveModalOpen ? (
        <SaveChartModal
          open={saveModalOpen}
          onClose={() => setSaveModalOpen(false)}
          clauses={clauses}
          connectionId={connectionId}
          index={currentIndex}
          controller={savedChartsController}
        />
      ) : null}

      {libraryDialogOpen ? (
        <SavedChartsDialog
          open={libraryDialogOpen}
          onClose={() => setLibraryDialogOpen(false)}
          currentIndex={currentIndex}
          controller={savedChartsController}
          onApplyChart={handleLoadChart}
        />
      ) : null}
    </>
  );
}

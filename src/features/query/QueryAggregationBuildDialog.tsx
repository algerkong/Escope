import { ArrowDown, ArrowUp, Check, Eye, Group, Plus, RefreshCw, Repeat2, Save, Sigma, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import { matchesQueryDraft, type QueryDocument, type QueryDocumentPatch } from '../../domain/query';
import { formatQueryDsl } from '../../domain/query-dsl';
import {
  AGGREGATION_BUILD_LIMITS, BUILD_INTERVALS, BUILD_METRIC_TYPES,
  aggregationBuildEvidence, parseAggregationBuild, previewAggregationBuild,
  type AggregationBuildDraft, type AggregationBuildPreview, type BuildGroup, type BuildGroupType,
  type BuildInterval, type BuildMetric,
} from '../../domain/query-aggregation-build';
import { MAX_CHART_DEFINITIONS, MAX_CHART_NAME_CHARS, parseChartDefinition, validChartTarget } from '../../domain/chart-definitions';
import type { ChartDefinition, ChartDefinitionSelection } from '../../domain/chart-definitions';
import type { ChartDefinitionsController } from './useChartDefinitions';
import { DOC_COUNT_MEASURE } from '../../domain/query-aggregation-charts';
import type { MetricAggregationType } from '../../domain/query-aggregations';
import type { FieldCatalog } from '../../domain/resource';
import { runtimeFieldNamesFromDsl } from '../../domain/runtime-fields-dsl';
import type { Loadable } from './useQueryResources';
import '../../styles/chart-definitions.css';
import '../../styles/query-aggregation-build.css';

interface Props {
  source: QueryDocument;
  endpoint: string;
  current: QueryDocument | undefined;
  fields: Loadable<FieldCatalog>;
  targetCurrent: boolean;
  canInspect: boolean;
  onInspect: () => void;
  onCommit: (source: QueryDocument, patch: QueryDocumentPatch) => boolean;
  /** Frozen reuse copy: seeds the reviewed rows only, never pre-applies or runs anything. */
  seed?: ChartDefinitionSelection;
  /** Local definition library offered for saving this shape. Absent means no save affordance. */
  definitions?: ChartDefinitionsController;
  onSaveDefinition?: (definition: ChartDefinition) => Promise<boolean>;
  onClose: () => void;
}

interface GroupRow {
  readonly id: string;
  readonly kind: 'none' | BuildGroupType;
  readonly name: string;
  readonly field: string;
  readonly size: string;
  readonly interval: BuildInterval;
  readonly intervalValue: string;
  readonly timeZone: string;
}

interface MetricRow extends BuildMetric { readonly id: string }

const buildGroup = (row: GroupRow): BuildGroup | null => row.kind === 'none' ? null : row.kind === 'terms'
  ? { name: row.name, type: 'terms', field: row.field, size: row.size }
  : { name: row.name, type: 'date_histogram', field: row.field, interval: row.interval,
    intervalValue: row.intervalValue, timeZone: row.timeZone };

const toDraft = (group: GroupRow, metrics: readonly MetricRow[]): AggregationBuildDraft => ({
  group: buildGroup(group),
  metrics: metrics.map(({ name, type, field }) => ({ name, type, field })),
});

function fromGroup(group: BuildGroup | null): Omit<GroupRow, 'id'> {
  if (!group) return { kind: 'none', name: '', field: '', size: '', interval: 'fixed_interval', intervalValue: '', timeZone: '' };
  return group.type === 'terms'
    ? { kind: 'terms', name: group.name, field: group.field, size: group.size, interval: 'fixed_interval', intervalValue: '', timeZone: '' }
    : { kind: 'date_histogram', name: group.name, field: group.field, size: '', interval: group.interval,
      intervalValue: group.intervalValue, timeZone: group.timeZone };
}

const nextName = (prefix: string, taken: readonly string[]) => {
  const used = new Set(taken);
  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
};

export function QueryAggregationBuildDialog({ source, endpoint, current, fields, targetCurrent, canInspect, onInspect, onCommit,
  seed, definitions, onSaveDefinition, onClose }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const parsed = useMemo(() => parseAggregationBuild(source.dsl), [source.dsl]);
  // A reuse copy seeds rows only when it still names this exact connection and target; otherwise
  // the review starts from the current draft instead of quietly building against another target.
  const seeded = seed && seed.definition.connectionId === source.connectionId
    && seed.definition.index === source.index.trim() ? seed : undefined;
  const [group, setGroup] = useState<GroupRow>(() => ({
    id: 'group', ...fromGroup(seeded ? seeded.definition.draft.group : parsed.ok ? parsed.draft.group : null),
  }));
  const [metrics, setMetrics] = useState<readonly MetricRow[]>(() => {
    const rows = seeded ? seeded.definition.draft.metrics : parsed.ok ? parsed.draft.metrics : [];
    return rows.map((metric) => ({ ...metric, id: crypto.randomUUID() }));
  });
  const [definitionName, setDefinitionName] = useState(() => seeded?.definition.name ?? '');
  const [measure, setMeasure] = useState(() => seeded?.definition.measure ?? DOC_COUNT_MEASURE);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [review, setReview] = useState<{
    result: AggregationBuildPreview; draft: AggregationBuildDraft; fields: Loadable<FieldCatalog>;
  } | null>(null);
  const catalog = fields.status === 'ready' && !fields.refreshing && !fields.refreshError ? fields.data : undefined;
  const busy = fields.status === 'loading' || fields.status === 'ready' && Boolean(fields.refreshing);
  const currentTarget = targetCurrent && matchesQueryDraft(current, source) && !conflict;
  const draft = useMemo(() => toDraft(group, metrics), [group, metrics]);
  const evidence = useMemo(() => aggregationBuildEvidence(source.dsl, draft, catalog), [source.dsl, draft, catalog]);
  const suggestions = useMemo(() => [...new Set([
    ...runtimeFieldNamesFromDsl(source.dsl), ...(catalog?.fields.slice(0, 200).map((field) => field.name) ?? []),
  ])], [source.dsl, catalog]);
  const reviewed = review && review.draft === draft && review.fields === fields ? review.result : null;
  const preview = reviewed?.ok ? reviewed : null;
  const preserved = preview?.preserved ?? (parsed.ok ? parsed.preserved : []);
  const formatted = useMemo(() => preview ? formatQueryDsl(preview.dsl) : null, [preview]);
  const finalDsl = formatted?.ok && new TextEncoder().encode(formatted.formatted).length <= AGGREGATION_BUILD_LIMITS.dslBytes
    ? formatted.formatted : preview?.dsl ?? '';
  const applyAllowed = currentTarget && !busy && Boolean(preview?.changed);
  const reviewedCode = reviewed === null || reviewed.ok ? null : reviewed.code;
  const problem = !currentTarget ? 'draftChanged' : !parsed.ok ? parsed.code : reviewedCode;
  const change = (patch: Partial<GroupRow>) => { setGroup((row) => ({ ...row, ...patch })); setReview(null); setSaved(false); };
  const changeMetrics = (next: readonly MetricRow[]) => { setMetrics(next); setReview(null); setSaved(false); };
  const updateMetric = (row: MetricRow, patch: Partial<BuildMetric>) =>
    changeMetrics(metrics.map((item) => item.id === row.id ? { ...item, ...patch } : item));
  const moveMetric = (index: number, delta: number) => {
    const destination = index + delta;
    if (destination < 0 || destination >= metrics.length) return;
    const next = [...metrics];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    changeMetrics(next);
  };
  const groupEvidence = group.kind === 'none' ? undefined : evidence[0];
  const metricEvidence = (index: number) => evidence[group.kind === 'none' ? index : index + 1];
  // Saving a definition is a separate library write: it stores these literals for this target and
  // never touches the draft DSL, the review or execution.
  const measureOptions = draft.group
    ? [DOC_COUNT_MEASURE, ...draft.metrics.map((metric) => metric.name)]
    : draft.metrics.map((metric) => metric.name);
  const candidate = parseChartDefinition({
    id: 'pending', name: definitionName.trim(), connectionId: source.connectionId ?? '',
    index: source.index.trim(), draft, measure: measureOptions.includes(measure) ? measure : measureOptions[0] ?? measure,
  });
  // The target is checked on its own so an unusable pattern is never reported as bad rows.
  const saveReason = !source.connectionId ? 'chartDefinitions:saveNeedsConnection'
    : definitionName.trim() === '' ? 'chartDefinitions:saveNeedsName'
      : !validChartTarget(source.index.trim()) ? 'chartDefinitions:saveNeedsTarget'
        : !candidate ? 'chartDefinitions:saveNeedsDraft' : null;
  const libraryReady = definitions !== undefined && definitions.status === 'ready' && definitions.error === null && !definitions.saving;
  const atLimit = definitions !== undefined && definitions.entries.length >= MAX_CHART_DEFINITIONS;
  const saveDisabled = !onSaveDefinition || !libraryReady || !currentTarget || atLimit || saveReason !== null;
  const saveStatus = saved ? 'chartDefinitions:saved'
    : definitions?.error ? 'chartDefinitions:saveUnavailable'
      : saveReason ?? (atLimit ? 'chartDefinitions:limit' : null);
  const saveDefinition = async () => {
    if (!candidate || !onSaveDefinition || saveDisabled) return;
    setSaved(await onSaveDefinition({ ...candidate, id: crypto.randomUUID() }));
  };

  return <Modal open onClose={onClose} title={t('queryAggregationBuild:title')}>
    <div className="qaggb-review">
      <div className="qaggb-origin"><code>{endpoint}</code><code>{source.index}</code>
        <span title={t('queryAggregationBuild:scopeBoundary')}>{t('queryAggregationBuild:scope')}</span></div>
      <div className="qaggb-actions">
        <span className="muted" title={t('queryAggregationBuild:evidenceBoundary')}>
          {fields.status === 'error' || fields.status === 'ready' && fields.refreshError ? t('queryAggregationBuild:inspectionFailed')
            : busy ? t('queryAggregationBuild:inspecting') : t('queryAggregationBuild:fieldEvidence')}
        </span>
        <IconButton icon={RefreshCw} label={t('queryAggregationBuild:inspect')} disabled={!canInspect || !currentTarget || busy} onClick={() => {
          setReview(null);
          onInspect();
        }} />
      </div>
      <datalist id={`${id}-fields`}>{suggestions.map((field) => <option key={field} value={field} />)}</datalist>
      {!parsed.ok ? null : <>
        <fieldset className="qaggb-group">
          <legend><Group size={13} aria-hidden="true" />{t('queryAggregationBuild:group')}</legend>
          <div className="qaggb-group-heading">
            <label>{t('queryAggregationBuild:groupType')}
              <SelectControl aria-label={t('queryAggregationBuild:groupType')} value={group.kind} disabled={!currentTarget}
                onChange={(event) => {
                  const kind = event.target.value as GroupRow['kind'];
                  change({ kind, name: kind === 'none' ? '' : group.name || (kind === 'terms' ? 'by_host' : 'per_day') });
                }}>
                <option value="none">{t('queryAggregationBuild:noGroup')}</option>
                {['terms', 'date_histogram'].map((type) => <option key={type} value={type}>{type}</option>)}
              </SelectControl>
            </label>
            {group.kind === 'none' ? null : <label className="qaggb-name">{t('queryAggregationBuild:groupName')}
              <input aria-label={t('queryAggregationBuild:groupName')} value={group.name} spellCheck={false} autoComplete="off"
                maxLength={AGGREGATION_BUILD_LIMITS.nameBytes} disabled={!currentTarget}
                onChange={(event) => change({ name: event.target.value })} />
            </label>}
          </div>
          {group.kind === 'none' ? <p className="muted qaggb-hint">{t('queryAggregationBuild:noGroupHint')}</p> : <>
            <div className="qaggb-options">
              <label>{t('queryAggregationBuild:field')}
                <input aria-label={t('queryAggregationBuild:groupField')} value={group.field} list={`${id}-fields`}
                  spellCheck={false} autoComplete="off" maxLength={AGGREGATION_BUILD_LIMITS.nameBytes} disabled={!currentTarget}
                  aria-invalid={group.field !== '' && groupEvidence !== undefined && !groupEvidence.ok}
                  onChange={(event) => change({ field: event.target.value })} />
              </label>
              {group.kind === 'terms' ? <label title={t('queryAggregationBuild:sizeBoundary')}>{t('queryAggregationBuild:size')}
                <input aria-label={t('queryAggregationBuild:size')} value={group.size} inputMode="numeric" spellCheck={false}
                  maxLength={7} disabled={!currentTarget} placeholder={t('queryAggregationBuild:sizeDefault')}
                  onChange={(event) => change({ size: event.target.value })} />
              </label> : <>
                <label>{t('queryAggregationBuild:interval')}
                  <SelectControl aria-label={t('queryAggregationBuild:interval')} value={group.interval} disabled={!currentTarget}
                    onChange={(event) => change({ interval: event.target.value as BuildInterval })}>
                    {BUILD_INTERVALS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </SelectControl>
                </label>
                <label title={t('queryAggregationBuild:intervalBoundary')}>{t('queryAggregationBuild:intervalValue')}
                  <input aria-label={t('queryAggregationBuild:intervalValue')} value={group.intervalValue} spellCheck={false}
                    autoComplete="off" maxLength={AGGREGATION_BUILD_LIMITS.intervalChars} disabled={!currentTarget}
                    placeholder="1d" onChange={(event) => change({ intervalValue: event.target.value })} />
                </label>
                <label title={t('queryAggregationBuild:zoneBoundary')}>{t('queryAggregationBuild:zone')}
                  <input aria-label={t('queryAggregationBuild:zone')} value={group.timeZone} spellCheck={false} autoComplete="off"
                    maxLength={AGGREGATION_BUILD_LIMITS.zoneChars} disabled={!currentTarget} placeholder="UTC"
                    onChange={(event) => change({ timeZone: event.target.value })} />
                </label>
              </>}
            </div>
            <div className={`qaggb-evidence ${groupEvidence?.ok ? 'muted' : 'qaggb-warning'}`} role="status">
              {groupEvidence?.ok ? <>{groupEvidence.fieldType} ({t(`queryAggregationBuild:${groupEvidence.origin}`)})</>
                : groupEvidence && !groupEvidence.ok ? t(`queryAggregationBuild:${groupEvidence.code}`) : t('queryAggregationBuild:fieldRequired')}
            </div>
          </>}
        </fieldset>
        <fieldset className="qaggb-metrics">
          <legend><Sigma size={13} aria-hidden="true" />{t('queryAggregationBuild:metrics')}</legend>
          <ol className="qaggb-list" aria-label={t('queryAggregationBuild:metricOrder')}>
            {metrics.map((row, index) => {
              const field = metricEvidence(index);
              return <li key={row.id}>
                <div className="qaggb-row-heading">
                  <span className="qaggb-rank" aria-hidden="true">{index + 1}</span>
                  <label className="qaggb-name">{t('queryAggregationBuild:metricName')}
                    <input aria-label={t('queryAggregationBuild:metricNameAt', { position: index + 1 })} value={row.name}
                      spellCheck={false} autoComplete="off" maxLength={AGGREGATION_BUILD_LIMITS.nameBytes} disabled={!currentTarget}
                      onChange={(event) => updateMetric(row, { name: event.target.value })} />
                  </label>
                  <label>{t('queryAggregationBuild:metricType')}
                    <SelectControl aria-label={t('queryAggregationBuild:metricTypeAt', { position: index + 1 })} value={row.type}
                      disabled={!currentTarget}
                      onChange={(event) => updateMetric(row, { type: event.target.value as MetricAggregationType })}>
                      {BUILD_METRIC_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                    </SelectControl>
                  </label>
                  <label>{t('queryAggregationBuild:field')}
                    <input aria-label={t('queryAggregationBuild:metricFieldAt', { position: index + 1 })} value={row.field}
                      list={`${id}-fields`} spellCheck={false} autoComplete="off" maxLength={AGGREGATION_BUILD_LIMITS.nameBytes}
                      disabled={!currentTarget} aria-invalid={row.field !== '' && field !== undefined && !field.ok}
                      onChange={(event) => updateMetric(row, { field: event.target.value })} />
                  </label>
                  <div className="qaggb-row-actions">
                    <IconButton icon={ArrowUp} label={t('queryAggregationBuild:moveUp', { position: index + 1 })}
                      disabled={!currentTarget || index === 0} onClick={() => moveMetric(index, -1)} />
                    <IconButton icon={ArrowDown} label={t('queryAggregationBuild:moveDown', { position: index + 1 })}
                      disabled={!currentTarget || index === metrics.length - 1} onClick={() => moveMetric(index, 1)} />
                    <IconButton icon={Trash2} label={t('queryAggregationBuild:remove', { position: index + 1 })} disabled={!currentTarget}
                      onClick={() => changeMetrics(metrics.filter((item) => item.id !== row.id))} />
                  </div>
                </div>
                <div className={`qaggb-evidence ${field?.ok ? 'muted' : 'qaggb-warning'}`} role="status">
                  {field?.ok ? <>{field.fieldType} ({t(`queryAggregationBuild:${field.origin}`)})</>
                    : field && !field.ok ? t(`queryAggregationBuild:${field.code}`) : t('queryAggregationBuild:fieldRequired')}
                </div>
              </li>;
            })}
          </ol>
          {!metrics.length ? <p className="muted qaggb-hint">{t(group.kind === 'none' ? 'queryAggregationBuild:noAggregations' : 'queryAggregationBuild:groupOnly')}</p> : null}
          <div className="qaggb-actions">
            <button type="button" className="secondary compact-button" disabled={!currentTarget || metrics.length >= AGGREGATION_BUILD_LIMITS.metrics}
              title={t('queryAggregationBuild:limit', { count: AGGREGATION_BUILD_LIMITS.metrics })}
              onClick={() => changeMetrics([...metrics, {
                id: crypto.randomUUID(), name: nextName('metric', [group.name, ...metrics.map((row) => row.name)]),
                type: 'sum', field: '',
              }])}>
              <Plus size={14} aria-hidden="true" />{t('queryAggregationBuild:add')}
            </button>
            <IconButton icon={Trash2} label={t('queryAggregationBuild:clear')} disabled={!currentTarget || !metrics.length}
              onClick={() => changeMetrics([])} />
          </div>
        </fieldset>
        {seeded ? <p className="qaggb-seeded" title={t('chartDefinitions:seededHint')}>
          <Repeat2 size={13} aria-hidden="true" />{t('chartDefinitions:seededFrom', { name: seeded.definition.name })}
        </p> : null}
        {onSaveDefinition ? <details className="qaggb-save">
          <summary><Save size={13} aria-hidden="true" />{t('chartDefinitions:saveTitle')}</summary>
          <p className="qaggb-save-status" title={t('chartDefinitions:saveBoundary')}>{t('chartDefinitions:saveBoundary')}</p>
          <div className="qaggb-save-fields">
            <label>{t('chartDefinitions:saveName')}
              <input aria-label={t('chartDefinitions:saveName')} value={definitionName} maxLength={MAX_CHART_NAME_CHARS}
                spellCheck={false} autoComplete="off" disabled={!currentTarget || !libraryReady}
                onChange={(event) => { setDefinitionName(event.target.value); setSaved(false); }} />
            </label>
            <label>{t('chartDefinitions:saveMeasure')}
              <SelectControl aria-label={t('chartDefinitions:saveMeasure')} value={measureOptions.includes(measure) ? measure : measureOptions[0] ?? ''}
                disabled={!currentTarget || !libraryReady || measureOptions.length === 0}
                onChange={(event) => { setMeasure(event.target.value); setSaved(false); }}>
                {measureOptions.length === 0 ? <option value="">{t('chartDefinitions:noMeasure')}</option> : null}
                {measureOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </SelectControl>
            </label>
          </div>
          <div className="qaggb-actions">
            <button type="button" className="secondary compact-button" disabled={saveDisabled} onClick={() => { void saveDefinition(); }}>
              <Save size={14} aria-hidden="true" />{t('chartDefinitions:saveAction')}
            </button>
          </div>
          {saveStatus ? <span className={saved || definitions?.error ? 'qaggb-save-status' : 'qaggb-warning'} role="status">
            {t(saveStatus, { count: MAX_CHART_DEFINITIONS })}
          </span> : null}
          {!saved && !definitions?.error && saveReason === null && !atLimit && definitions?.status === 'loading'
            ? <span className="qaggb-save-status" role="status">{t('chartDefinitions:loading')}</span> : null}
        </details> : null}
        {preserved.length > 0 ? <details className="qaggb-preserved">
          <summary>{t('queryAggregationBuild:preserved', { count: preserved.length })}</summary>
          <p className="muted qaggb-hint" title={t('queryAggregationBuild:preservedBoundary')}>{t('queryAggregationBuild:preservedHint')}</p>
          <ul>{preserved.map(({ name, raw }) => <li key={name}><code>{name}</code><code>{raw}</code></li>)}</ul>
        </details> : null}
        <button type="button" className="secondary compact-button qaggb-preview" disabled={!currentTarget || busy}
          onClick={() => setReview({ result: previewAggregationBuild(source, draft, catalog), draft, fields })}>
          <Eye size={14} aria-hidden="true" />{t('queryAggregationBuild:preview')}
        </button>
      </>}
      <details><summary>{t('queryAggregationBuild:currentDsl')}</summary><pre className="qaggb-current">{source.dsl}</pre></details>
      {preview ? <>
        <label htmlFor={`${id}-dsl`}>{t('queryAggregationBuild:finalDsl')}</label>
        <textarea id={`${id}-dsl`} className="qaggb-code" value={finalDsl} readOnly spellCheck={false} />
        {!preview.changed ? <span role="status" className="muted">{t('queryAggregationBuild:unchanged')}</span> : null}
      </> : null}
      {problem ? <div className="notice error" role="alert">{t(`queryAggregationBuild:${problem}`)}</div> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={!applyAllowed} onClick={() => {
          if (!applyAllowed || !preview) return;
          if (onCommit(source, { ...preview.patch, dsl: finalDsl })) onClose();
          else setConflict(true);
        }}><Check size={14} aria-hidden="true" />{t('queryAggregationBuild:apply')}</button>
      </div>
    </div>
  </Modal>;
}

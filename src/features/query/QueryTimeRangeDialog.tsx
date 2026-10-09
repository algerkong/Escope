import { Check, Clock3, Eye, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../components/controls';
import { matchesQueryDraft, type QueryDocument, type QueryDocumentPatch } from '../../domain/query';
import { formatQueryDsl } from '../../domain/query-dsl';
import {
  MAX_TIME_RANGE_AMOUNT, TIME_RANGE_UNITS, previewTimeRange, removeAppliedTimeRange, timeRangeFieldEvidence, timeRangeLocalBound,
  type ExecutionTimeRange, type QueryTimeRange, type TimeRangeDefinition, type TimeRangeProblem, type TimeRangeUnit,
} from '../../domain/query-time-range';
import type { FieldCatalog } from '../../domain/resource';
import '../../styles/query-time-range.css';

type Review = { readonly ok: true; readonly dsl: string; readonly timeRange: QueryTimeRange | null }
  | { readonly ok: false; readonly code: TimeRangeProblem };

const ZONES = ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', '+08:00'];

export function TimeRangeSummary({ time, managed = false, onEdit }: {
  time: ExecutionTimeRange; managed?: boolean; onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const { definition, bounds } = time;
  return <div className={`qtime-summary${managed ? ' managed' : ''}`} role="group"
    aria-label={t(managed ? 'timeRange:managed' : 'timeRange:executed')} title={managed ? t('timeRange:managedHint') : undefined}>
    {onEdit ? <IconButton icon={Clock3} label={t('timeRange:open')} onClick={onEdit} /> : <Clock3 size={13} aria-hidden="true" />}
    <strong>{t(managed ? 'timeRange:managed' : 'timeRange:executed')}</strong>
    <code>{definition.field}</code>
    {managed && definition.range.kind === 'relative' ? <span>{t('timeRange:relativeLabel', {
      amount: definition.range.amount, unit: t(`timeRange:${definition.range.unit}`),
    })}</span> : <span className="qtime-boundary">{t('timeRange:rangeLabel', { from: bounds.from, to: bounds.to })}</span>}
    <span>{definition.timeZone}</span>
  </div>;
}

/** A review owns its source/capability snapshot; no effect rebases or executes the user's draft. */
export function QueryTimeRangeDialog({ source, current, catalog, targetCurrent, initialTimeZone = 'UTC', onCommit, onClose }: {
  source: QueryDocument; current: QueryDocument | undefined; catalog?: FieldCatalog; targetCurrent: boolean; initialTimeZone?: string;
  onCommit: (source: QueryDocument, patch: QueryDocumentPatch) => boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [definition, setDefinition] = useState<TimeRangeDefinition>(() => {
    if (source.timeRange) return { ...source.timeRange.definition, range: { ...source.timeRange.definition.range } };
    const field = source.dataView?.definition.defaultTimeField ?? '';
    const type = catalog?.fields.find((item) => item.name === field)?.types;
    return { field, fieldType: type?.length === 1 && type[0]?.type === 'date_nanos' ? 'date_nanos' : 'date', timeZone: initialTimeZone,
      range: { kind: 'relative', amount: 15, unit: 'minutes' } };
  });
  const [review, setReview] = useState<Review | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [conflict, setConflict] = useState(false);
  const currentTarget = targetCurrent && matchesQueryDraft(current, source);
  const evidence = timeRangeFieldEvidence(source, definition, catalog);
  const needsAcknowledgment = evidence === 'unchecked' || evidence === 'missing';
  const preview = review?.ok ? review : null;
  const formatted = useMemo(() => preview ? formatQueryDsl(preview.dsl) : null, [preview]);
  const code = !currentTarget || conflict ? 'draftChanged' : review && !review.ok ? review.code : null;
  const update = (next: TimeRangeDefinition) => { setDefinition(next); setReview(null); setAcknowledged(false); };
  const { range } = definition;
  const allowApply = currentTarget && !conflict && preview !== null && (preview.timeRange === null || !needsAcknowledgment || acknowledged);
  const commit = () => {
    if (!allowApply || !preview) return;
    if (onCommit(source, { dsl: preview.dsl, timeRange: preview.timeRange })) onClose();
    else setConflict(true);
  };
  return <Modal open onClose={onClose} title={t('timeRange:title')}>
    <div className="qtime-review">
      <code className="qtime-target">{source.index}</code>
      <div className="qtime-fields">
        <label className="qtime-field">{t('timeRange:field')}
          <input value={definition.field} list={`${id}-fields`} spellCheck={false} autoComplete="off"
            onChange={(event) => update({ ...definition, field: event.target.value })} />
          <datalist id={`${id}-fields`}>{catalog?.fields.filter((field) => field.types.some((type) => type.type === 'date' || type.type === 'date_nanos'))
            .map((field) => <option key={field.name} value={field.name} />)}</datalist>
        </label>
        <label>{t('timeRange:fieldType')}
          <SelectControl value={definition.fieldType} onChange={(event) => update({ ...definition, fieldType: event.target.value as TimeRangeDefinition['fieldType'] })}>
            <option value="date">date</option><option value="date_nanos">date_nanos</option>
          </SelectControl>
        </label>
        <label className="qtime-zone">{t('timeRange:timeZone')}
          <input value={definition.timeZone} list={`${id}-zones`} autoComplete="off" spellCheck={false} maxLength={100}
            onChange={(event) => update({ ...definition, timeZone: event.target.value })} />
          <datalist id={`${id}-zones`}>{ZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>
        </label>
      </div>
      <span className={evidence === 'valid' || evidence === 'runtime' ? 'muted' : 'qtime-warning'} role="status">
        {t(`timeRange:evidence_${evidence}`)}
      </span>
      {evidence === 'runtime' ? <span className="qtime-warning">{t('timeRange:runtimeBoundary')}</span> : null}
      <div className="segment qtime-mode" role="group" aria-label={t('timeRange:mode')}>
        {(['relative', 'absolute'] as const).map((kind) => <button key={kind} type="button" aria-pressed={range.kind === kind}
          title={t(kind === 'relative' ? 'timeRange:relativeHint' : 'timeRange:absoluteHint')}
          onClick={() => {
            if (kind !== range.kind) update({ ...definition, range: kind === 'relative'
              ? { kind, amount: 15, unit: 'minutes' } : { kind, from: '', to: '' } });
          }}>{t(`timeRange:${kind}`)}</button>)}
      </div>
      {range.kind === 'relative' ? <div className="qtime-relative">
        <label>{t('timeRange:amount')}<input type="number" min={1} max={MAX_TIME_RANGE_AMOUNT} step={1} value={Number.isNaN(range.amount) ? '' : range.amount}
          onChange={(event) => update({ ...definition, range: { ...range, amount: event.target.valueAsNumber } })} /></label>
        <label>{t('timeRange:unit')}<SelectControl value={range.unit}
          onChange={(event) => update({ ...definition, range: { ...range, unit: event.target.value as TimeRangeUnit } })}>
          {TIME_RANGE_UNITS.map((unit) => <option key={unit} value={unit}>{t(`timeRange:${unit}`)}</option>)}
        </SelectControl></label>
      </div> : <div className="qtime-absolute">
        {(['from', 'to'] as const).map((key) => <label key={key}>{t(`timeRange:${key}`)}
          <input value={range[key]} maxLength={29} autoComplete="off" spellCheck={false} placeholder="2026-10-10T00:00:00"
            title={t('timeRange:inputFormat')} onChange={(event) => update({ ...definition, range: { ...range, [key]: event.target.value } })} />
        </label>)}
      </div>}
      {needsAcknowledgment ? <label className="qtime-checkbox"><input type="checkbox" checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)} />{t('timeRange:acknowledge')}</label> : null}
      <div className="qtime-actions">
        <button type="button" className="secondary compact-button" disabled={!currentTarget || conflict}
          onClick={() => setReview(previewTimeRange(source, definition, new Date(), catalog))}>
          <Eye size={14} aria-hidden="true" />{t('timeRange:preview')}
        </button>
        {source.timeRange ? <IconButton icon={Trash2} label={t('timeRange:remove')} disabled={!currentTarget || conflict} onClick={() => {
          const dsl = removeAppliedTimeRange(source);
          setReview(dsl === null ? { ok: false, code: 'invalidBinding' } : { ok: true, dsl, timeRange: null });
        }} /> : null}
      </div>
      {preview ? <>
        {preview.timeRange ? <dl className="qtime-preview-bounds">
          <dt>{t('timeRange:previewAt')}</dt><dd>{preview.timeRange.bounds.resolvedAt}</dd>
          <dt>{t('timeRange:from')}</dt><dd>{timeRangeLocalBound(preview.timeRange.bounds.from, preview.timeRange.definition.timeZone)}</dd>
          <dt>{t('timeRange:to')}</dt><dd>{timeRangeLocalBound(preview.timeRange.bounds.to, preview.timeRange.definition.timeZone)}</dd>
        </dl> : <strong>{t('timeRange:removing')}</strong>}
        <details><summary>{t('timeRange:currentDsl')}</summary><pre className="qtime-current">{source.dsl}</pre></details>
        <label htmlFor={`${id}-dsl`}>{t('timeRange:finalDsl')}</label>
        <textarea id={`${id}-dsl`} value={formatted?.ok ? formatted.formatted : preview.dsl} readOnly className="qtime-code" spellCheck={false} />
      </> : null}
      {code ? <div role="alert" className="notice error">{t(`timeRange:${code}`)}</div> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={!allowApply} onClick={commit}><Check size={14} aria-hidden="true" />{t('timeRange:apply')}</button>
      </div>
    </div>
  </Modal>;
}

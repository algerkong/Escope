import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal, SelectControl } from '../../../components/controls';
import {
  CHART_REFERENCE_LIMIT, applyChartReference,
  type ChartReferenceError, type ChartReferenceInput, type ChartReferenceLine,
} from '../../../domain/query-aggregation-chart-references';
import { chartValueDomain, type PlottedChart } from '../../../domain/query-aggregation-charts';
import type { AggregationChartRuntime } from './chart-loader';

type BucketChart = Exclude<PlottedChart, { kind: 'singleValue' }>;
interface Session {
  readonly chart: BucketChart;
  readonly lines: readonly ChartReferenceLine[];
  readonly editor: ChartReferenceInput | null;
  readonly error: ChartReferenceError | null;
}

function emptySession(chart: BucketChart): Session {
  return { chart, lines: [], editor: null, error: null };
}

/** Bound to the memoized entry/measure model; the parent also keys its execution/page source. */
export function AggregationChartReferences({ chart, Canvas, label, axes }: {
  chart: BucketChart; Canvas: AggregationChartRuntime['AggregationChartCanvas'];
  label: string; axes: Record<'left' | 'right', string>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const axisInput = useRef<HTMLSelectElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState(() => emptySession(chart));
  // A changed entry or either measure discards both applied lines and an unfinished editor before paint.
  const current = session.chart === chart ? session : emptySession(chart);
  if (current !== session) setSession(current);
  const { lines, editor, error } = current;
  const name = (number: number) => t('queryAggregationCharts:referenceName', { id: number });
  const axisName = (side: 'left' | 'right') => t(`queryAggregationCharts:axisValue${side === 'left' ? 'Left' : 'Right'}`,
    { measure: axes[side] });
  const chosen = editor?.axis === 'left' ? chart : editor?.axis === 'right' ? chart.secondary : null;
  const domain = chosen ? chartValueDomain(chosen.valueExtent) : null;
  const axisError = error === 'axisRequired' || error === 'rightUnavailable';
  const close = () => setSession({ ...current, editor: null, error: null });

  return <>
    <section className="qac-references" aria-labelledby={`${id}-heading`}>
      <div className="qac-reference-heading">
        <h4 id={`${id}-heading`} ref={heading} tabIndex={-1}>{t('queryAggregationCharts:references')}</h4>
        <span className="qac-reference-count">{lines.length} / {CHART_REFERENCE_LIMIT}</span>
        <IconButton icon={Plus} label={t('queryAggregationCharts:referenceAdd')}
          aria-disabled={lines.length >= CHART_REFERENCE_LIMIT}
          onClick={() => {
            if (lines.length < CHART_REFERENCE_LIMIT) {
              setSession({ ...current, editor: { id: null, axis: '', raw: '' }, error: null });
            }
          }} />
      </div>
      {lines.length > 0 ? <ul className="qac-reference-list">
        {lines.map((line) => {
          const coincident = line.position === null ? [] : lines.filter((other) =>
            other.id !== line.id && other.position === line.position).map((other) => other.id);
          return <li key={line.id} className="qac-reference-row" aria-label={name(line.id)}>
            <div className="qac-reference-content">
              <div className="qac-reference-label">
                <svg width="32" height="12" aria-hidden="true" className="qac-reference-swatch">
                  <line x1="0" x2="32" y1="6" y2="6" className="qac-reference-stroke" data-reference={line.id} />
                </svg>
                <span>{name(line.id)}</span><span>{axisName(line.axis)}</span>
              </div>
              <code className="qac-reference-raw" tabIndex={0}
                aria-label={t('queryAggregationCharts:referenceRaw', { id: line.id })}>{line.raw}</code>
              {!line.precise ? <p className="qac-warning">
                {t('queryAggregationCharts:referenceImprecise', { value: String(line.value) })}
              </p> : null}
              {line.placement !== 'inside' ? <p className="qac-warning">
                {t(`queryAggregationCharts:reference_${line.placement}`)}
              </p> : null}
              {coincident.length > 0 ? <p className="qac-reference-overlap">
                {t('queryAggregationCharts:referenceCoincident', { ids: coincident.join(', ') })}
              </p> : null}
            </div>
            <div className="qac-reference-actions">
              <IconButton icon={Pencil} label={t('queryAggregationCharts:referenceEdit', { id: line.id })}
                onClick={() => setSession({ ...current, editor: { id: line.id, axis: line.axis, raw: line.raw }, error: null })} />
              <IconButton icon={Trash2} label={t('queryAggregationCharts:referenceDelete', { id: line.id })}
                onClick={() => {
                  setSession({ ...current, lines: lines.filter((item) => item.id !== line.id) });
                  heading.current?.focus();
                }} />
            </div>
          </li>;
        })}
      </ul> : null}
    </section>
    <Canvas chart={chart} label={label} axes={axes} references={lines} />
    {editor ? <Modal open onClose={close} title={editor.id === null
      ? t('queryAggregationCharts:referenceAdd') : t('queryAggregationCharts:referenceEdit', { id: editor.id })}>
      <form className="qac-reference-editor" onSubmit={(event) => {
        event.preventDefault();
        const result = applyChartReference(chart, lines, editor);
        if (!result.ok) {
          setSession({ ...current, error: result.code });
          if (result.code === 'axisRequired' || result.code === 'rightUnavailable') axisInput.current?.focus();
          else valueInput.current?.focus();
        } else setSession({ ...current, lines: result.lines, editor: null, error: null });
      }} onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}>
        <label>{t('queryAggregationCharts:referenceAxis')}
          <SelectControl ref={axisInput} value={editor.axis} aria-invalid={axisError}
            aria-describedby={axisError ? `${id}-error` : undefined}
            onChange={(event) => setSession({ ...current, editor: { ...editor, axis: event.currentTarget.value }, error: null })}>
            <option value="">{t('queryAggregationCharts:referenceChooseAxis')}</option>
            <option value="left">{axisName('left')}</option>
            {chart.secondary ? <option value="right">{axisName('right')}</option> : null}
          </SelectControl>
        </label>
        <label>{t('queryAggregationCharts:referenceValue')}
          <input ref={valueInput} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
            value={editor.raw} aria-invalid={error !== null && !axisError}
            aria-describedby={[domain ? `${id}-domain` : '', error !== null && !axisError ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined}
            onChange={(event) => setSession({ ...current, editor: { ...editor, raw: event.currentTarget.value }, error: null })} />
        </label>
        {domain ? <p className="qac-reference-domain" id={`${id}-domain`}>
          {t('queryAggregationCharts:referenceDomain', { min: String(domain.min), max: String(domain.max) })}
        </p> : null}
        {error ? <p id={`${id}-error`} className="qac-warning" role="alert">
          {t(`queryAggregationCharts:referenceError_${error}`)}
        </p> : null}
        <div className="qac-reference-actions">
          <IconButton icon={Check} type="submit" label={t('queryAggregationCharts:referenceApply')} />
          <IconButton icon={X} label={t('queryAggregationCharts:referenceCancel')} onClick={close} />
        </div>
      </form>
    </Modal> : null}
  </>;
}

import {
  DOC_COUNT_MEASURE, chartValueDomain, convertChartValue,
  type ChartMeasure, type ChartValue, type PlottedChart,
} from './query-aggregation-charts';
import { compareDecimalText } from './result-grid';

export const CHART_REFERENCE_LIMIT = 4;
export type ChartReferenceAxis = 'left' | 'right';

/** Session-only literal. It never contributes to a data extent or a saved chart definition. */
export interface ChartReferenceLine extends ChartValue {
  readonly id: number;
  readonly axis: ChartReferenceAxis;
  readonly measure: ChartMeasure;
  readonly placement: 'inside' | 'below' | 'above';
  /** Fraction of the unchanged data domain, or null when the original literal is outside it. */
  readonly position: number | null;
}

export interface ChartReferenceInput {
  readonly id: number | null;
  readonly axis: string;
  readonly raw: string;
}

export type ChartReferenceError = 'unsupported' | 'axisRequired' | 'rightUnavailable' | 'invalidToken'
  | 'outOfRange' | 'unsafeCount' | 'spanOutOfRange' | 'limit' | 'notFound' | 'bindingChanged';
export type ChartReferenceResult = { readonly ok: true; readonly lines: readonly ChartReferenceLine[] }
  | { readonly ok: false; readonly code: ChartReferenceError };

/** Applies one explicit add/edit atomically; refusal leaves every existing reference untouched. */
export function applyChartReference(
  chart: PlottedChart, lines: readonly ChartReferenceLine[], input: ChartReferenceInput,
): ChartReferenceResult {
  if (chart.kind === 'singleValue') return { ok: false, code: 'unsupported' };
  if (lines.length > CHART_REFERENCE_LIMIT || (input.id === null && lines.length === CHART_REFERENCE_LIMIT)) {
    return { ok: false, code: 'limit' };
  }
  if (input.id !== null && !lines.some((line) => line.id === input.id)) return { ok: false, code: 'notFound' };
  if (input.axis !== 'left' && input.axis !== 'right') return { ok: false, code: 'axisRequired' };
  const axis = input.axis === 'left' ? chart : chart.secondary;
  if (axis === null) return { ok: false, code: 'rightUnavailable' };
  if (lines.some((line) => {
    const current = line.axis === 'left' ? chart.measure : chart.secondary?.measure;
    return current?.name !== line.measure.name || current?.type !== line.measure.type;
  })) return { ok: false, code: 'bindingChanged' };

  const value = convertChartValue({ kind: 'number', raw: input.raw });
  if (typeof value === 'string') {
    return { ok: false, code: value === 'outOfRange' ? 'outOfRange' : 'invalidToken' };
  }
  if (axis.measure.type === DOC_COUNT_MEASURE && (!value.precise || !Number.isSafeInteger(value.value))) {
    return { ok: false, code: 'unsafeCount' };
  }
  const domain = chartValueDomain(axis.valueExtent);
  const span = domain.max - domain.min;
  // Check extrapolation span too, but never use it to resize the actual data axis.
  if (!Number.isFinite(span) || span <= 0
    || !Number.isFinite(Math.max(domain.max, value.value) - Math.min(domain.min, value.value))) {
    return { ok: false, code: 'spanOutOfRange' };
  }
  // Comparing raw decimals avoids rounding an out-of-domain literal onto the boundary.
  const placement = compareDecimalText(value.raw, String(domain.min)) < 0 ? 'below'
    : compareDecimalText(value.raw, String(domain.max)) > 0 ? 'above' : 'inside';
  const position = placement === 'inside' ? (value.value - domain.min) / span : null;
  if (position !== null && (!Number.isFinite(position) || position < 0 || position > 1)) {
    return { ok: false, code: 'spanOutOfRange' };
  }
  const id = input.id ?? Array.from({ length: CHART_REFERENCE_LIMIT }, (_, index) => index + 1)
    .find((candidate) => !lines.some((line) => line.id === candidate))!;
  const line: ChartReferenceLine = Object.freeze({
    id, axis: input.axis, measure: Object.freeze({ ...axis.measure }), ...value, placement, position,
  });
  return {
    ok: true,
    lines: Object.freeze(input.id === null ? [...lines, line] : lines.map((item) => item.id === id ? line : item)),
  };
}

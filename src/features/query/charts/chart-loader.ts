export type AggregationChartRuntime = typeof import('./AggregationChartCanvas');

let loaded: AggregationChartRuntime | undefined;
let pending: Promise<AggregationChartRuntime> | undefined;

/** The chart library stays out of the main bundle; nothing is imported until a chart is opened. */
export function loadAggregationChart(): AggregationChartRuntime | Promise<AggregationChartRuntime> {
  if (loaded) return loaded;
  pending ??= import('./AggregationChartCanvas').then((runtime) => {
    loaded = runtime;
    return runtime;
  }).catch(() => {
    pending = undefined;
    throw new Error('aggregationChartUnavailable');
  });
  return pending;
}

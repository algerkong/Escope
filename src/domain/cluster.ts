import type { Node } from 'jsonc-parser';
import { boolOf, items, parseRawJson, property, rangeOf, textOf, type RawRange } from './query-result';
import type { ResourceParse } from './resource';

/**
 * Read-only cluster, node, shard and index metadata parsed from verbatim Elasticsearch
 * responses.
 *
 * Display text always comes from the response source: a counter is shown as the exact token
 * the server sent, so a value beyond `Number.MAX_SAFE_INTEGER` is never rounded. A JS number
 * is only produced where the UI has to compare or add up values, and that conversion is
 * checked — a missing, non-numeric or non-finite value stays `null` (shown as unknown) and is
 * never turned into `0`.
 */

/** One counter: verbatim display text plus the checked numeric conversion used for comparisons. */
export interface ClusterCount {
  readonly text: string;
  readonly value: number | null;
}

export type HealthStatus = 'green' | 'yellow' | 'red';

/** `_cluster/health`. Every count is `null` when the server did not report a usable value. */
export interface ClusterHealth {
  readonly clusterName: string | null;
  readonly status: HealthStatus | null;
  readonly timedOut: boolean | null;
  readonly numberOfNodes: ClusterCount | null;
  readonly numberOfDataNodes: ClusterCount | null;
  readonly activePrimaryShards: ClusterCount | null;
  readonly activeShards: ClusterCount | null;
  readonly relocatingShards: ClusterCount | null;
  readonly initializingShards: ClusterCount | null;
  readonly unassignedShards: ClusterCount | null;
  readonly delayedUnassignedShards: ClusterCount | null;
  readonly numberOfPendingTasks: ClusterCount | null;
  readonly numberOfInFlightFetch: ClusterCount | null;
  /** Elasticsearch's own `active_shards_percent_as_number` text, e.g. `50.0`. */
  readonly activeShardsPercent: string | null;
  /** Verbatim `task_max_waiting_in_queue_millis` text. */
  readonly taskMaxWaitingTimeInQueue: string | null;
}

/**
 * What a health status actually means for this cluster. Allocation only: a green status says
 * every shard is assigned, never that queries are fast or that a node has spare capacity.
 */
export type HealthMeaning = 'healthy' | 'replicasUnassigned' | 'primariesUnassigned' | 'unassignedReported' | 'unknown';

/** One thread pool whose cumulative `rejected` counter is non-zero. */
export interface NodePoolRejections {
  readonly pool: string;
  /** Verbatim `rejected` token. */
  readonly rejected: string;
}

/** Whether every node the request asked for answered, as reported by `_nodes`. */
export type NodesCompleteness = 'complete' | 'partial' | 'unknown';

/** One entry of `_nodes/stats/jvm,fs,os,process,thread_pool`. */
export interface NodeStats {
  readonly id: string;
  readonly name: string | null;
  readonly transportAddress: string | null;
  readonly host: string | null;
  readonly roles: readonly string[];
  /** Verbatim `jvm.mem.heap_used_percent`, accepted only inside 0..100. */
  readonly heapPercent: string | null;
  /** Verbatim byte counts, accepted only as non-negative integers. */
  readonly heapUsed: string | null;
  readonly heapMax: string | null;
  /** Verbatim `os.cpu.percent` inside 0..100; `null` when missing, unusable or the `-1` sentinel. */
  readonly cpuPercent: string | null;
  readonly loadAverage: string | null;
  readonly fsTotal: string | null;
  readonly fsAvailable: string | null;
  /**
   * Exact sum of `thread_pool.*.rejected` as text (computed with BigInt), cumulative since node
   * start and never a rate. `null` when a pool's counter was missing or was not a count, so a
   * subset sum is never presented as the node total.
   */
  readonly threadPoolRejections: string | null;
  readonly rejectingPools: readonly NodePoolRejections[];
  /** Source range of this node's stats object, for the raw JSON view. */
  readonly range: RawRange | null;
}

/** `_nodes/stats` with the `_nodes` summary that states whether the answer is complete. */
export interface NodesStats {
  readonly nodes: readonly NodeStats[];
  readonly total: ClusterCount | null;
  readonly successful: ClusterCount | null;
  readonly failed: ClusterCount | null;
  /** `unknown` when the `_nodes` summary is missing or unusable, never silently `complete`. */
  readonly completeness: NodesCompleteness;
}

/** One row of `_cat/shards?format=json`. */
export interface ShardRow {
  readonly index: string;
  /** Verbatim shard ordinal token. */
  readonly shard: string;
  /** `prirep`: `true` primary, `false` replica, `null` when the server sent neither. */
  readonly primary: boolean | null;
  readonly state: string | null;
  /** Verbatim `docs` and `store` tokens, e.g. `0` and `225b`. */
  readonly docs: string | null;
  readonly store: string | null;
  readonly ip: string | null;
  readonly node: string | null;
  readonly unassignedReason: string | null;
}

export interface ShardStateCount {
  readonly state: string;
  readonly count: number;
}

/** One index of an `_settings` response, kept as a source range of the verbatim body. */
export interface IndexSettingsEntry {
  readonly index: string;
  readonly range: RawRange;
}

/** Display text of a scalar JSON value: strings decode exactly, numbers keep their token. */
export function verbatimText(raw: string, node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string') return String(node.value);
  if (node.type === 'number') return raw.slice(node.offset, node.offset + node.length);
  if (node.type === 'boolean') return String(node.value);
  // Objects, arrays and `null` are not measurements.
  return null;
}

function numberNode(node: Node | undefined): number | null {
  if (node?.type !== 'number') return null;
  const value = Number(node.value);
  return Number.isFinite(value) ? value : null;
}

/** Verbatim text of a number the caller accepts; anything else is unknown, never a guess. */
function checkedNumber(raw: string, node: Node | undefined, accept: (value: number) => boolean): string | null {
  const value = numberNode(node);
  if (value === null || !accept(value)) return null;
  return verbatimText(raw, node);
}

/**
 * A counter: non-negative integer only. The verbatim token is always the display text, and the
 * numeric conversion is kept only while it is a safe integer, so a larger value is never rounded.
 */
function countMetric(raw: string, node: Node | undefined): ClusterCount | null {
  const value = numberNode(node);
  if (value === null || !Number.isInteger(value) || value < 0) return null;
  const text = verbatimText(raw, node);
  if (text === null) return null;
  return { text, value: Number.isSafeInteger(value) ? value : null };
}

const PERCENT = (value: number) => value >= 0 && value <= 100;
const NON_NEGATIVE = (value: number) => value >= 0;
const BYTES = (value: number) => Number.isInteger(value) && value >= 0;

function isPositive(count: ClusterCount | null): boolean {
  if (!count) return false;
  if (count.value !== null) return count.value > 0;
  try {
    return BigInt(count.text) > 0n;
  } catch {
    return false;
  }
}

function sameCount(a: ClusterCount | null, b: ClusterCount | null): boolean {
  if (!a || !b) return false;
  return a.value !== null && b.value !== null ? a.value === b.value : a.text === b.text;
}

function byIndexName(a: IndexSettingsEntry, b: IndexSettingsEntry): number {
  return a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
}

/**
 * `GET /_cluster/health`. An unrecognized status is reported as unknown rather than mapped to
 * the closest known one, and a missing, negative or non-integer count stays unknown instead of
 * becoming `0`.
 */
export function parseClusterHealth(raw: string): ResourceParse<ClusterHealth> {
  const root = parseRawJson(raw);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const status = textOf(property(root, 'status'));
  return {
    ok: true,
    value: {
      clusterName: textOf(property(root, 'cluster_name')) ?? null,
      status: status === 'green' || status === 'yellow' || status === 'red' ? status : null,
      timedOut: boolOf(property(root, 'timed_out')) ?? null,
      numberOfNodes: countMetric(raw, property(root, 'number_of_nodes')),
      numberOfDataNodes: countMetric(raw, property(root, 'number_of_data_nodes')),
      activePrimaryShards: countMetric(raw, property(root, 'active_primary_shards')),
      activeShards: countMetric(raw, property(root, 'active_shards')),
      relocatingShards: countMetric(raw, property(root, 'relocating_shards')),
      initializingShards: countMetric(raw, property(root, 'initializing_shards')),
      unassignedShards: countMetric(raw, property(root, 'unassigned_shards')),
      delayedUnassignedShards: countMetric(raw, property(root, 'delayed_unassigned_shards')),
      numberOfPendingTasks: countMetric(raw, property(root, 'number_of_pending_tasks')),
      numberOfInFlightFetch: countMetric(raw, property(root, 'number_of_in_flight_fetch')),
      activeShardsPercent: checkedNumber(raw, property(root, 'active_shards_percent_as_number'), PERCENT),
      taskMaxWaitingTimeInQueue: checkedNumber(raw, property(root, 'task_max_waiting_in_queue_millis'), BYTES),
    },
  };
}

/** Explain a health status. `unassignedReported` flags a green status with unassigned shards. */
export function healthMeaning(health: ClusterHealth): HealthMeaning {
  if (health.status === 'red') return 'primariesUnassigned';
  if (health.status === 'yellow') return 'replicasUnassigned';
  if (health.status === 'green') return isPositive(health.unassignedShards) ? 'unassignedReported' : 'healthy';
  return 'unknown';
}

/**
 * `thread_pool.<pool>.rejected` is the cumulative rejection counter. The sum is computed with
 * BigInt from the verbatim tokens and returned as text, so a value beyond
 * `Number.MAX_SAFE_INTEGER` is never rounded. If a pool does not report a usable counter, or no
 * pool was reported at all, the total is unknown — a subset sum must not read as the node total.
 */
function sumRejected(raw: string, threadPool: Node | undefined): { total: string | null; pools: NodePoolRejections[] } {
  if (threadPool?.type !== 'object') return { total: null, pools: [] };
  let total = 0n;
  let examined = 0;
  let complete = true;
  const pools: NodePoolRejections[] = [];
  for (const pool of threadPool.children ?? []) {
    if (pool.type !== 'property') continue;
    const name = textOf(pool.children?.[0]);
    const body = pool.children?.[1];
    const rejected = property(body, 'rejected');
    const value = numberNode(rejected);
    const text = verbatimText(raw, rejected);
    if (name === undefined || value === null || !Number.isInteger(value) || value < 0 || text === null) {
      complete = false;
      continue;
    }
    try {
      total += BigInt(text);
    } catch {
      complete = false;
      continue;
    }
    examined += 1;
    if (value > 0) pools.push({ pool: name, rejected: text });
  }
  return { total: complete && examined > 0 ? total.toString() : null, pools };
}

/**
 * `GET /_nodes/stats/jvm,fs,os,process,thread_pool`. Nodes are sorted by name, then ID, and the
 * `_nodes` summary is kept so a partial answer is reported as partial instead of complete.
 */
export function parseNodesStats(raw: string): ResourceParse<NodesStats> {
  const root = parseRawJson(raw);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const nodes = property(root, 'nodes');
  if (!nodes || nodes.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const meta = property(root, '_nodes');
  const total = countMetric(raw, property(meta, 'total'));
  const successful = countMetric(raw, property(meta, 'successful'));
  const failed = countMetric(raw, property(meta, 'failed'));
  const completeness: NodesCompleteness =
    total === null || successful === null || failed === null ? 'unknown'
      : isPositive(failed) || !sameCount(total, successful) ? 'partial'
        : 'complete';
  const parsed: NodeStats[] = [];
  for (const entry of nodes.children ?? []) {
    if (entry.type !== 'property') continue;
    const id = textOf(entry.children?.[0]);
    const node = entry.children?.[1];
    if (id === undefined || node?.type !== 'object') continue;
    const memory = property(property(node, 'jvm'), 'mem');
    const fs = property(property(node, 'fs'), 'total');
    const rejected = sumRejected(raw, property(node, 'thread_pool'));
    parsed.push({
      id,
      name: textOf(property(node, 'name')) ?? null,
      transportAddress: textOf(property(node, 'transport_address')) ?? null,
      host: textOf(property(node, 'host')) ?? null,
      roles: items(property(node, 'roles')).map(textOf).filter((role): role is string => role !== undefined),
      heapPercent: checkedNumber(raw, property(memory, 'heap_used_percent'), PERCENT),
      heapUsed: checkedNumber(raw, property(memory, 'heap_used_in_bytes'), BYTES),
      heapMax: checkedNumber(raw, property(memory, 'heap_max_in_bytes'), BYTES),
      // `os.cpu.percent` is `-1` when the operating system does not expose CPU usage: that is a
      // missing measurement, so it is reported as unknown rather than as 0%.
      cpuPercent: checkedNumber(raw, property(property(property(node, 'os'), 'cpu'), 'percent'), PERCENT),
      loadAverage: checkedNumber(raw, property(property(property(property(node, 'os'), 'cpu'), 'load_average'), '1m'), NON_NEGATIVE),
      fsTotal: checkedNumber(raw, property(fs, 'total_in_bytes'), BYTES),
      fsAvailable: checkedNumber(raw, property(fs, 'available_in_bytes'), BYTES),
      threadPoolRejections: rejected.total,
      rejectingPools: rejected.pools,
      range: rangeOf(node),
    });
  }
  return {
    ok: true,
    value: {
      nodes: parsed.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id)),
      total, successful, failed, completeness,
    },
  };
}

/**
 * `GET /_cat/shards?format=json&h=…`. This is the bounded cat projection, not the full cluster
 * state, so no recovery or allocation detail is inferred from it.
 */
export function parseShards(raw: string): ResourceParse<readonly ShardRow[]> {
  const root = parseRawJson(raw);
  if (!root || root.type !== 'array') return { ok: false, code: 'invalidResponse' };
  const rows: ShardRow[] = [];
  for (const node of items(root)) {
    const index = textOf(property(node, 'index'));
    if (index === undefined) continue;
    const prirep = textOf(property(node, 'prirep'));
    rows.push({
      index,
      shard: verbatimText(raw, property(node, 'shard')) ?? '',
      primary: prirep === 'p' ? true : prirep === 'r' ? false : null,
      state: textOf(property(node, 'state')) ?? null,
      docs: verbatimText(raw, property(node, 'docs')),
      store: verbatimText(raw, property(node, 'store')),
      ip: verbatimText(raw, property(node, 'ip')),
      node: verbatimText(raw, property(node, 'node')),
      // `h=unassigned.reason` returns that key; older projections used the underscore form.
      unassignedReason: textOf(property(node, 'unassigned.reason')) ?? textOf(property(node, 'unassigned_reason')) ?? null,
    });
  }
  return { ok: true, value: rows };
}

/** Shard count per reported state token, most frequent first. */
export function shardStateCounts(rows: readonly ShardRow[]): readonly ShardStateCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.state === null) continue;
    counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  }
  return [...counts].map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));
}

/**
 * `GET /{target}/_settings` without `include_defaults`. Each index keeps its source range, so
 * the settings are displayed and copied exactly as the cluster returned them.
 */
export function parseIndexSettings(raw: string): ResourceParse<readonly IndexSettingsEntry[]> {
  const root = parseRawJson(raw);
  if (!root || root.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const entries: IndexSettingsEntry[] = [];
  for (const entry of root.children ?? []) {
    if (entry.type !== 'property') continue;
    const index = textOf(entry.children?.[0]);
    const body = entry.children?.[1];
    if (index === undefined || !body) continue;
    const range = rangeOf(property(body, 'settings')) ?? rangeOf(body);
    if (range) entries.push({ index, range });
  }
  return { ok: true, value: entries.sort(byIndexName) };
}

const MAX_TARGET_BYTES = 2048;
const MAX_TARGETS = 64;
const MAX_INDEX_BYTES = 255;
const TARGET_ITEM = /^[A-Za-z0-9._\-*]+$/;

/**
 * Client-side mirror of the backend index-target rule, so an obvious typo is refused before a
 * request is sent. The backend validates the target again and stays authoritative: this only
 * repeats the closed character set, and every comma-separated item is checked on its own.
 */
export function isValidIndexTarget(value: string): boolean {
  const target = value.trim();
  if (target === '' || target.length > MAX_TARGET_BYTES) return false;
  const parts = target.split(',');
  if (parts.length > MAX_TARGETS) return false;
  return parts.every((part) => part !== '' && part.length <= MAX_INDEX_BYTES && part !== '.' && part !== '..'
    && !part.startsWith('_') && !part.startsWith('-') && TARGET_ITEM.test(part));
}

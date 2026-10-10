import { createScanner, type Node } from 'jsonc-parser';
import { parseRawJson, property, rawTextOf, textOf } from './query-result';

export const AGGREGATION_LIMITS = Object.freeze({
  dslBytes: 256 * 1024,
  responseBytes: 1024 * 1024,
  depth: 64,
  tokens: 100_000,
  numberLength: 4096,
  definitions: 32,
  nameBytes: 1024,
  buckets: 4096,
  pageSize: 50,
});

export type AggregationReadError = 'tooLarge' | 'tooDeep' | 'tooComplex' | 'invalidDsl' | 'invalidResponse';
export type MetricAggregationType = 'sum' | 'avg' | 'min' | 'max' | 'value_count' | 'cardinality';
export type BucketAggregationType = 'terms' | 'date_histogram';

export interface AggregationValue {
  readonly kind: 'missing' | 'null' | 'number' | 'string' | 'boolean';
  /** The original JSON token, including string escapes; never a formatted or decoded number. */
  readonly raw: string | null;
}

export interface AggregationMetric {
  readonly name: string;
  readonly type: MetricAggregationType;
  readonly value: AggregationValue;
  readonly valueAsString: AggregationValue;
}

export interface AggregationBucket {
  /** Object member name for an explicitly keyed histogram, not an inferred date or bucket key. */
  readonly member: string | null;
  readonly key: AggregationValue;
  readonly keyAsString: AggregationValue;
  readonly docCount: AggregationValue;
  readonly docCountError: AggregationValue;
  readonly metrics: readonly AggregationMetric[];
  readonly raw: string;
}

interface AggregationBase {
  readonly name: string;
  readonly rawDefinition: string | null;
  readonly rawResponse: string | null;
}

export type AggregationResult =
  | (AggregationBase & { readonly status: 'unrequested' | 'unsupported' | 'missing' | 'invalid'; readonly type: string | null })
  | (AggregationBase & { readonly status: 'metric'; readonly type: MetricAggregationType; readonly metric: AggregationMetric })
  | (AggregationBase & {
    readonly status: 'buckets';
    readonly type: BucketAggregationType;
    readonly buckets: readonly AggregationBucket[];
    readonly metrics: readonly { readonly name: string; readonly type: MetricAggregationType }[];
    readonly docCountError: AggregationValue;
    readonly sumOtherDocCount: AggregationValue;
    /** Exact request options, not defaults or evidence from a newer field catalog. */
    readonly options: readonly { readonly name: string; readonly raw: string }[];
  });

export type AggregationNotice = 'postFilter' | 'runtime' | 'script' | 'searchScope' | 'timedOut'
  | 'terminatedEarly' | 'shardFailures' | 'unknownShards' | 'clusterReport';

export type AggregationPageResult =
  | { readonly ok: false; readonly code: AggregationReadError }
  | {
    readonly ok: true;
    readonly responseState: 'missing' | 'empty' | 'present';
    readonly entries: readonly AggregationResult[];
    readonly notices: readonly AggregationNotice[];
  };

interface MetricDefinition {
  readonly name: string;
  readonly type: MetricAggregationType;
}

interface Definition {
  readonly type: MetricAggregationType | BucketAggregationType;
  readonly options: Node;
  readonly metrics: readonly MetricDefinition[];
}

const METRICS = new Set<string>(['sum', 'avg', 'min', 'max', 'value_count', 'cardinality']);
const BUCKETS = new Set<string>(['terms', 'date_histogram']);
const MISSING: AggregationValue = Object.freeze({ kind: 'missing', raw: null });
const encoder = new TextEncoder();
// jsonc-parser's ambient const enums cannot be imported as values with isolatedModules.
const TOKEN = { objectOpen: 1, objectClose: 2, arrayOpen: 3, arrayClose: 4, number: 11, eof: 17 } as const;

/** Enforce allocation bounds before asking the existing strict/lossless reader for another tree. */
function readBounded(raw: string, maxBytes: number, invalid: AggregationReadError): Node | AggregationReadError {
  if (raw.length > maxBytes || encoder.encode(raw).length > maxBytes) return 'tooLarge';
  const scanner = createScanner(raw, true);
  let depth = 0;
  let count = 0;
  for (let token = scanner.scan(); token !== TOKEN.eof; token = scanner.scan()) {
    if (++count > AGGREGATION_LIMITS.tokens) return 'tooComplex';
    if (token === TOKEN.objectOpen || token === TOKEN.arrayOpen) {
      if (++depth > AGGREGATION_LIMITS.depth) return 'tooDeep';
    } else if (token === TOKEN.objectClose || token === TOKEN.arrayClose) depth--;
    if (token === TOKEN.number && scanner.getTokenLength() > AGGREGATION_LIMITS.numberLength) return 'tooComplex';
  }
  const root = parseRawJson(raw);
  return root?.type === 'object' ? root : invalid;
}

function members(node: Node | undefined): readonly { name: string; value: Node }[] {
  return node?.type === 'object' ? (node.children ?? []).map((entry) => ({
    name: textOf(entry.children?.[0])!, value: entry.children![1]!,
  })) : [];
}

function onlyKeys(node: Node, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return node.type === 'object' && members(node).every(({ name }) => names.has(name));
}

function valueOf(raw: string, node: Node | undefined): AggregationValue {
  return node === undefined ? MISSING : { kind: node.type as AggregationValue['kind'], raw: rawTextOf(raw, node) };
}

function numericValue(node: Node | undefined): boolean {
  return node === undefined || node.type === 'number' || node.type === 'null';
}

function stringValue(node: Node | undefined): boolean {
  return node === undefined || node.type === 'string';
}

function countValue(raw: string, node: Node | undefined, allowUnknown = false): boolean {
  if (node === undefined) return true;
  if (node.type !== 'number') return false;
  const token = rawTextOf(raw, node)!;
  return /^\d+$/.test(token) || allowUnknown && token === '-1';
}

function aggregationDefinitions(node: Node): Node | undefined | null {
  const short = property(node, 'aggs');
  const long = property(node, 'aggregations');
  if (short && long) return null;
  const result = short ?? long;
  return result === undefined || result.type === 'object' ? result : null;
}

function readDefinition(node: Node, allowBuckets = true): Definition | null {
  if (node.type !== 'object') return null;
  const types = members(node).filter(({ name }) => !['meta', 'aggs', 'aggregations'].includes(name));
  const type = types[0];
  if (types.length !== 1 || type?.value.type !== 'object' || !METRICS.has(type.name) && (!allowBuckets || !BUCKETS.has(type.name))) return null;
  const children = aggregationDefinitions(node);
  if (children === null) return null;
  const childEntries = members(children);
  if (METRICS.has(type.name)) {
    if (children !== undefined) return null;
    return { type: type.name as MetricAggregationType, options: type.value, metrics: [] };
  }
  const metrics: MetricDefinition[] = [];
  for (const child of childEntries) {
    const definition = readDefinition(child.value, false);
    if (!definition || !METRICS.has(definition.type)) return null;
    metrics.push({ name: child.name, type: definition.type as MetricAggregationType });
  }
  const keyed = property(type.value, 'keyed');
  if (keyed && (type.name !== 'date_histogram' || keyed.type !== 'boolean')) return null;
  return { type: type.name as BucketAggregationType, options: type.value, metrics };
}

function readMetric(raw: string, node: Node | undefined, definition: MetricDefinition): AggregationMetric | null {
  if (node && !onlyKeys(node, ['value', 'value_as_string', 'meta'])) return null;
  const value = property(node, 'value');
  const formatted = property(node, 'value_as_string');
  if (!numericValue(value) || !stringValue(formatted)) return null;
  if (['value_count', 'cardinality'].includes(definition.type) && value?.type === 'number' && !countValue(raw, value)) return null;
  return { ...definition, value: valueOf(raw, value), valueAsString: valueOf(raw, formatted) };
}

function readBucket(
  raw: string, node: Node, member: string | null, definition: Definition,
): AggregationBucket | null {
  if (!onlyKeys(node, ['key', 'key_as_string', 'doc_count', ...(definition.type === 'terms' ? ['doc_count_error_upper_bound'] : []),
    ...definition.metrics.map(({ name }) => name)])) return null;
  const key = property(node, 'key');
  if (!key || !['string', 'number', 'boolean'].includes(key.type)) return null;
  if (definition.type === 'date_histogram' && (key.type !== 'number' || !/^-?\d+$/.test(rawTextOf(raw, key)!))) return null;
  if (!stringValue(property(node, 'key_as_string'))
    || !countValue(raw, property(node, 'doc_count'))
    || !countValue(raw, property(node, 'doc_count_error_upper_bound'), true)) return null;
  const metrics: AggregationMetric[] = [];
  for (const metric of definition.metrics) {
    const read = readMetric(raw, property(node, metric.name), metric);
    if (!read) return null;
    metrics.push(read);
  }
  return {
    member, key: valueOf(raw, key), keyAsString: valueOf(raw, property(node, 'key_as_string')),
    docCount: valueOf(raw, property(node, 'doc_count')),
    docCountError: valueOf(raw, property(node, 'doc_count_error_upper_bound')),
    metrics, raw: rawTextOf(raw, node)!,
  };
}

const DISPLAY_OPTIONS = ['field', 'size', 'shard_size', 'order', 'min_doc_count', 'shard_min_doc_count',
  'calendar_interval', 'fixed_interval', 'interval', 'time_zone', 'offset', 'extended_bounds', 'hard_bounds',
  'missing', 'include', 'exclude', 'format', 'keyed', 'show_term_doc_count_error'];

function readEntry(
  dsl: string, raw: string, name: string, request: Node | undefined, response: Node | undefined, budget: { buckets: number },
): AggregationResult | AggregationReadError {
  const base: AggregationBase = { name, rawDefinition: rawTextOf(dsl, request), rawResponse: rawTextOf(raw, response) };
  if (!request) return { ...base, status: 'unrequested', type: null };
  const definition = readDefinition(request);
  if (!definition) {
    const types = members(request).filter(({ name }) => !['meta', 'aggs', 'aggregations'].includes(name));
    return { ...base, status: 'unsupported', type: types.length === 1 ? types[0]!.name : null };
  }
  const { type } = definition;
  if (!response) return { ...base, status: 'missing', type };
  if (METRICS.has(type)) {
    const metric = readMetric(raw, response, { name, type: type as MetricAggregationType });
    return metric ? { ...base, status: 'metric', type: metric.type, metric } : { ...base, status: 'invalid', type };
  }
  if (!onlyKeys(response, ['buckets', 'meta', ...(type === 'terms' ? ['doc_count_error_upper_bound', 'sum_other_doc_count'] : [])])
    || !countValue(raw, property(response, 'doc_count_error_upper_bound'), true)
    || !countValue(raw, property(response, 'sum_other_doc_count'))) return { ...base, status: 'invalid', type };
  const bucketNode = property(response, 'buckets');
  const keyed = property(definition.options, 'keyed')?.value === true;
  if (bucketNode?.type !== (keyed ? 'object' : 'array')) return { ...base, status: 'invalid', type };
  const bucketNodes = keyed ? members(bucketNode).map(({ name, value }) => ({ member: name, node: value }))
    : (bucketNode.children ?? []).map((node) => ({ member: null, node }));
  budget.buckets += bucketNodes.length;
  if (budget.buckets > AGGREGATION_LIMITS.buckets) return 'tooComplex';
  const buckets: AggregationBucket[] = [];
  for (const { member, node } of bucketNodes) {
    const bucket = readBucket(raw, node, member, definition);
    if (!bucket) return { ...base, status: 'invalid', type };
    buckets.push(bucket);
  }
  return {
    ...base, status: 'buckets', type: type as BucketAggregationType, buckets, metrics: definition.metrics,
    docCountError: valueOf(raw, property(response, 'doc_count_error_upper_bound')),
    sumOtherDocCount: valueOf(raw, property(response, 'sum_other_doc_count')),
    options: members(definition.options).filter(({ name }) => DISPLAY_OPTIONS.includes(name))
      .map(({ name, value }) => ({ name, raw: rawTextOf(dsl, value)! })),
  };
}

function notices(dsl: Node, response: Node): AggregationNotice[] {
  const result: AggregationNotice[] = [];
  if (property(dsl, 'post_filter')) result.push('postFilter');
  if (property(dsl, 'runtime_mappings')) result.push('runtime');
  const scripted = members(aggregationDefinitions(dsl) ?? undefined).some(({ value }) => {
    const definition = readDefinition(value);
    return definition && (property(definition.options, 'script')
      || members(aggregationDefinitions(value) ?? undefined).some(({ value }) => {
        const metric = readDefinition(value, false);
        return metric && property(metric.options, 'script');
      }));
  });
  if (scripted) result.push('script');
  if (['knn', 'retriever', 'slice', 'terminate_after'].some((name) => property(dsl, name))) result.push('searchScope');
  if (property(response, 'timed_out')?.value === true) result.push('timedOut');
  if (property(response, 'terminated_early')?.value === true) result.push('terminatedEarly');
  const shards = property(response, '_shards');
  const failed = property(shards, 'failed');
  if (failed === undefined) result.push('unknownShards');
  if ((failed?.value ?? 0) > 0 || (property(shards, 'failures')?.children?.length ?? 0) > 0) result.push('shardFailures');
  if (property(response, '_clusters')) result.push('clusterReport');
  return result;
}

/**
 * Interpret one received page against its immutable execution DSL. This never combines pages,
 * infers an aggregation type from a response shape, or uses present-day field/format settings.
 * Unsupported entries keep both original slices; a resource-limit failure rejects the whole view.
 */
export function readAggregationPage(rawDsl: string, rawResponse: string): AggregationPageResult {
  const request = readBounded(rawDsl, AGGREGATION_LIMITS.dslBytes, 'invalidDsl');
  if (typeof request === 'string') return { ok: false, code: request };
  const response = readBounded(rawResponse, AGGREGATION_LIMITS.responseBytes, 'invalidResponse');
  if (typeof response === 'string') return { ok: false, code: response };
  const definitions = aggregationDefinitions(request);
  if (definitions === null) return { ok: false, code: 'invalidDsl' };
  const returned = property(response, 'aggregations');
  if (returned !== undefined && returned.type !== 'object') return { ok: false, code: 'invalidResponse' };
  const requests = new Map(members(definitions).map(({ name, value }) => [name, value]));
  const responses = new Map(members(returned).map(({ name, value }) => [name, value]));
  const names = new Set([...requests.keys(), ...responses.keys()]);
  let definitionCount = names.size;
  const nameFits = (name: string) => name.length <= AGGREGATION_LIMITS.nameBytes && encoder.encode(name).length <= AGGREGATION_LIMITS.nameBytes;
  for (const [name, node] of requests) {
    const children = members(aggregationDefinitions(node) ?? undefined);
    definitionCount += children.length;
    const typeNames = [node, ...children.map(({ value }) => value)].flatMap((definition) =>
      members(definition).map(({ name }) => name));
    if (!nameFits(name) || children.some(({ name }) => !nameFits(name)) || typeNames.some((name) => !nameFits(name))) {
      return { ok: false, code: 'tooComplex' };
    }
  }
  if (definitionCount > AGGREGATION_LIMITS.definitions || [...names].some((name) => !nameFits(name))) {
    return { ok: false, code: 'tooComplex' };
  }
  const entries: AggregationResult[] = [];
  const budget = { buckets: 0 };
  for (const name of names) {
    const entry = readEntry(rawDsl, rawResponse, name, requests.get(name), responses.get(name), budget);
    if (typeof entry === 'string') return { ok: false, code: entry };
    entries.push(entry);
  }
  return {
    ok: true, responseState: returned === undefined ? 'missing' : responses.size === 0 ? 'empty' : 'present',
    entries, notices: notices(request, response),
  };
}

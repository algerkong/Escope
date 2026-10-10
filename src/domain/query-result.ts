import { applyEdits, createScanner, format, parseTree, type Node, type ParseError } from 'jsonc-parser';

/**
 * Lossless reader for raw Elasticsearch JSON responses.
 *
 * The whole pipeline keeps the response text verbatim: values are read either from
 * jsonc-parser source offsets (`offset`/`length`) or, for strings and booleans only, from
 * the decoded node value. Numbers are never decoded for display, so integers beyond
 * `Number.MAX_SAFE_INTEGER` survive every view and copy path. Counters that *are* decoded
 * (`took`, shard counts, totals) are validated as non-negative safe integers or verbatim
 * digit strings, so a value is never silently rounded into a claim.
 */

/** Half-open source range inside the verbatim response text. */
export interface RawRange {
  readonly offset: number;
  readonly length: number;
}

export function sliceRaw(raw: string, range: RawRange): string {
  return raw.slice(range.offset, range.offset + range.length);
}

/**
 * Offset of the first repeated property name, walking the whole tree.
 * A response with duplicate keys is ambiguous, so it is rejected rather than merged.
 */
function hasDuplicateKey(root: Node): boolean {
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.type === 'object') {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const [keyNode, valueNode] = property.children ?? [];
        if (keyNode !== undefined && typeof keyNode.value === 'string') {
          if (seen.has(keyNode.value)) return true;
          seen.add(keyNode.value);
        }
        if (valueNode !== undefined) pending.push(valueNode);
      }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) pending.push(child);
    }
  }
  return false;
}

/**
 * Parse a response body into a node tree, or `null` when it is not strict JSON:
 * comments, trailing commas, duplicate keys and parser failures are all rejected.
 */
export function parseRawJson(raw: string): Node | null {
  const errors: ParseError[] = [];
  let root: Node | undefined;
  try {
    root = parseTree(raw, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  } catch {
    // Nesting beyond the recursive parser stack is a resource failure, not a value.
    return null;
  }
  if (errors.length > 0 || root === undefined) return null;
  return hasDuplicateKey(root) ? null : root;
}

/** Display-only indentation. Copy paths still use the original bytes, including numeric tokens. */
export function formatRawJson(raw: string): string {
  if (parseRawJson(raw) === null) return raw;
  return applyEdits(raw, format(raw, undefined, {
    insertSpaces: true, tabSize: 2, eol: '\n', insertFinalNewline: false,
  }));
}

export function property(node: Node | null | undefined, name: string): Node | undefined {
  if (!node || node.type !== 'object') return undefined;
  for (const child of node.children ?? []) {
    if (child.type === 'property' && child.children?.[0]?.value === name) return child.children?.[1];
  }
  return undefined;
}

export function items(node: Node | null | undefined): Node[] {
  return node?.type === 'array' ? node.children ?? [] : [];
}

export function textOf(node: Node | undefined): string | undefined {
  return node?.type === 'string' ? String(node.value) : undefined;
}

export function boolOf(node: Node | undefined): boolean | undefined {
  return node?.type === 'boolean' ? Boolean(node.value) : undefined;
}

/**
 * Small counters (`took`, shard counts): only a non-negative safe integer is accepted.
 * Anything else (fraction, negative, exponent, string, huge value) yields `null` so the
 * caller can reject the response instead of publishing a rounded number.
 */
export function countOf(node: Node | undefined): number | null {
  if (node?.type !== 'number') return null;
  const value = Number(node.value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function rawTextOf(raw: string, node: Node | undefined): string | null {
  return node ? raw.slice(node.offset, node.offset + node.length) : null;
}

export function rangeOf(node: Node | undefined): RawRange | null {
  return node ? { offset: node.offset, length: node.length } : null;
}

const PREVIEW_LIMIT = 160;
export const MAX_PIT_ID_LENGTH = 64 * 1024;

export function isValidPitId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PIT_ID_LENGTH
    && /^[\x21-\x7e]+$/.test(value);
}

function truncate(text: string): string {
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/**
 * One-line preview. Scalars keep their verbatim token text; only strings are unescaped
 * (string decoding is exact). For nested data, only whitespace between JSON tokens is
 * removed. Whitespace and escapes inside string values remain untouched.
 */
function previewOf(raw: string, node: Node): { preview: string; nested: boolean } {
  if (node.type === 'string') return { preview: truncate(String(node.value ?? '')), nested: false };
  const text = raw.slice(node.offset, node.offset + node.length);
  if (node.type === 'object' || node.type === 'array') {
    const scanner = createScanner(text, true);
    let compact = '';
    while (scanner.getPosition() < text.length) {
      scanner.scan();
      if (scanner.getTokenLength() === 0) break;
      compact += text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength());
      if (compact.length > PREVIEW_LIMIT) break;
    }
    return { preview: truncate(compact), nested: true };
  }
  return { preview: truncate(text), nested: false };
}

export interface ResultColumn {
  readonly name: string;
  readonly runtime?: true;
  /** Display text; never a re-serialized number. */
  readonly preview: string;
  readonly nested: boolean;
  /** Full scalar text for local sorting; string values are decoded, numbers remain raw tokens. */
  readonly value: {
    readonly kind: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
    readonly text: string;
  };
}

export interface ResultHit {
  /** Complete hit in its received page, including the distinction between absent and null keys. */
  readonly raw: RawRange;
  /** `_id` when present, otherwise the position in the returned array. */
  readonly id: string;
  readonly index: string | null;
  /** Verbatim `_score` text, e.g. `null`. */
  readonly score: string | null;
  readonly source: RawRange | null;
  readonly fields: RawRange | null;
  /** Raw `sort` array of this hit: the continuation cursor when the request defined a sort. */
  readonly sort: RawRange | null;
  /** Top-level source columns; executed runtime names read only from returned `fields`. */
  readonly columns: readonly ResultColumn[];
  readonly hasSource: boolean;
}

export interface ResultShardFailure {
  readonly index: string | null;
  readonly shard: number | null;
  readonly reason: string | null;
}

export interface ResultShards {
  readonly total: number | null;
  readonly successful: number | null;
  readonly skipped: number | null;
  readonly failed: number | null;
  readonly failures: readonly ResultShardFailure[];
}

export interface ResultTotals {
  /** Verbatim hit-count digits, so a count beyond `Number.MAX_SAFE_INTEGER` is not rounded. */
  readonly text: string;
  /** `gte` means the value is a lower bound, not an exact total. */
  readonly relation: 'eq' | 'gte';
}

export interface QuerySummary {
  readonly tookMs: number | null;
  readonly timedOut: boolean;
  /** ES stopped scanning early; the result is a lower bound even with every shard successful. */
  readonly terminatedEarly: boolean;
  readonly totals: ResultTotals | null;
  readonly maxScore: string | null;
  /** Snapshot id the cluster returned with this page, verbatim; `null` when none was sent. */
  readonly pitId: string | null;
  readonly shards: ResultShards;
  readonly hits: readonly ResultHit[];
}

export type QueryResultParse =
  | { readonly ok: true; readonly summary: QuerySummary }
  | { readonly ok: false; readonly code: 'invalidResponse' };

const INVALID: QueryResultParse = { ok: false, code: 'invalidResponse' };

function hitColumns(raw: string, source: Node | undefined, fields: Node | undefined, runtime: ReadonlySet<string>): ResultColumn[] {
  const container = source?.type === 'object' ? source : fields?.type === 'object' ? fields : undefined;
  if (!container) return [];
  const columns: ResultColumn[] = [];
  const entries = container === source && runtime.size > 0
    ? [...(source.children ?? []).filter((entry) => !runtime.has(textOf(entry.children?.[0]) ?? '')),
      ...(fields?.children ?? []).filter((entry) => runtime.has(textOf(entry.children?.[0]) ?? ''))]
    : container.children ?? [];
  for (const entry of entries) {
    if (entry.type !== 'property') continue;
    const name = textOf(entry.children?.[0]);
    const value = entry.children?.[1];
    if (name === undefined || value === undefined) continue;
    const kind = value.type === 'property' ? 'null' : value.type;
    columns.push({
      name, ...(runtime.has(name) ? { runtime: true as const } : {}), ...previewOf(raw, value),
      value: { kind, text: kind === 'string' ? String(value.value) : raw.slice(value.offset, value.offset + value.length) },
    });
  }
  return columns;
}

function parseHit(raw: string, node: Node, position: number, runtime: ReadonlySet<string>): ResultHit {
  const sourceNode = property(node, '_source');
  const source = sourceNode?.type === 'object' || sourceNode?.type === 'array' ? sourceNode : undefined;
  const fieldsNode = property(node, 'fields');
  const fields = fieldsNode?.type === 'object' ? fieldsNode : undefined;
  // A cursor only exists when the request produced sort values; anything that is not an array is
  // treated as absent instead of failing the whole page, because the cursor is optional.
  const sortNode = property(node, 'sort');
  const sort = sortNode?.type === 'array' ? sortNode : undefined;
  return {
    raw: { offset: node.offset, length: node.length },
    id: textOf(property(node, '_id')) ?? String(position),
    index: textOf(property(node, '_index')) ?? null,
    score: rawTextOf(raw, property(node, '_score')),
    source: rangeOf(source),
    fields: rangeOf(fields),
    sort: rangeOf(sort),
    columns: hitColumns(raw, source, fields, runtime),
    hasSource: source !== undefined,
  };
}

function parseShards(node: Node | undefined): ResultShards | null {
  if (node === undefined) return { total: null, successful: null, skipped: null, failed: null, failures: [] };
  if (node.type !== 'object') return null;
  const counters: (keyof Omit<ResultShards, 'failures'>)[] = ['total', 'successful', 'skipped', 'failed'];
  const parsed: Record<string, number | null> = {};
  for (const name of counters) {
    const value = property(node, name);
    const count = countOf(value);
    if (value !== undefined && count === null) return null;
    parsed[name] = count;
  }
  const failuresNode = property(node, 'failures');
  if (failuresNode !== undefined && failuresNode.type !== 'array') return null;
  const failures = items(failuresNode).map((failure) => ({
    index: textOf(property(failure, '_index')) ?? null,
    shard: countOf(property(failure, 'shard')) ?? countOf(property(failure, '_shard')),
    reason: textOf(property(property(failure, 'reason'), 'reason')) ?? textOf(property(failure, 'reason')) ?? null,
  }));
  return {
    total: parsed.total ?? null, successful: parsed.successful ?? null,
    skipped: parsed.skipped ?? null, failed: parsed.failed ?? null, failures,
  };
}

/** A missing total stays `null` (shown as unknown); a malformed one rejects the response. */
function parseTotals(raw: string, node: Node | undefined): { ok: true; totals: ResultTotals | null } | { ok: false } {
  if (node === undefined) return { ok: true, totals: null };
  if (node.type === 'object') {
    const text = rawTextOf(raw, property(node, 'value'));
    const relation = textOf(property(node, 'relation'));
    if (text === null || !/^\d+$/.test(text)) return { ok: false };
    if (relation !== 'eq' && relation !== 'gte') return { ok: false };
    return { ok: true, totals: { text, relation } };
  }
  if (node.type === 'number') {
    const text = rawTextOf(raw, node);
    if (text === null || !/^\d+$/.test(text)) return { ok: false };
    return { ok: true, totals: { text, relation: 'eq' } };
  }
  return { ok: false };
}

/**
 * Top-level `pit_id` a snapshot search returns. Absent means the server did not send one; present
 * but not a bounded printable token rejects the response, because the id is used verbatim in the
 * next request.
 */
function parsePitId(node: Node | undefined): { ok: true; pitId: string | null } | { ok: false } {
  if (node === undefined) return { ok: true, pitId: null };
  const value = textOf(node);
  if (!isValidPitId(value)) {
    return { ok: false };
  }
  return { ok: true, pitId: value };
}

/**
 * Parse an `_search` response body without decoding data values.
 * Wrongly typed `hits`, `hits.hits`, `timed_out`, `_shards` or totals reject the body
 * instead of being read as a completed search.
 */
export function parseQueryResult(raw: string, runtimeFields: readonly string[] = []): QueryResultParse {
  const runtime = new Set(runtimeFields);
  const root = parseRawJson(raw);
  if (!root || root.type !== 'object') return INVALID;
  const hitsNode = property(root, 'hits');
  if (!hitsNode || hitsNode.type !== 'object') return INVALID;
  const hitNodes = property(hitsNode, 'hits');
  if (!hitNodes || hitNodes.type !== 'array') return INVALID;
  if (items(hitNodes).some((hit) => hit.type !== 'object')) return INVALID;
  const timedOutNode = property(root, 'timed_out');
  const timedOut = boolOf(timedOutNode);
  if (timedOutNode !== undefined && timedOut === undefined) return INVALID;
  const terminatedNode = property(root, 'terminated_early');
  const terminatedEarly = boolOf(terminatedNode);
  if (terminatedNode !== undefined && terminatedEarly === undefined) return INVALID;
  const tookNode = property(root, 'took');
  const tookMs = countOf(tookNode);
  if (tookNode !== undefined && tookMs === null) return INVALID;
  const shards = parseShards(property(root, '_shards'));
  if (shards === null) return INVALID;
  const totals = parseTotals(raw, property(hitsNode, 'total'));
  if (!totals.ok) return INVALID;
  const pit = parsePitId(property(root, 'pit_id'));
  if (!pit.ok) return INVALID;
  return {
    ok: true,
    summary: {
      tookMs, timedOut: timedOut ?? false, terminatedEarly: terminatedEarly ?? false,
      totals: totals.totals,
      maxScore: rawTextOf(raw, property(hitsNode, 'max_score')),
      pitId: pit.pitId,
      shards,
      hits: items(hitNodes).map((hit, position) => parseHit(raw, hit, position, runtime)),
    },
  };
}

/**
 * A response is incomplete when the backend says so, the search timed out, stopped early,
 * lost a shard, or never reported a failed-shard count that could confirm completeness.
 */
export function isIncomplete(summary: QuerySummary, backendPartial: boolean): boolean {
  return backendPartial || summary.timedOut || summary.terminatedEarly
    || summary.shards.failed === null || summary.shards.failed > 0
    || summary.shards.failures.length > 0;
}

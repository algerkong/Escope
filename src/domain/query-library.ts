import { createScanner } from 'jsonc-parser';
import type { QueryDocument } from './query';
import { parseDataViewSelection, selectDataView, type DataViewSelection } from './data-views';
import { parametersPayload, parseQueryParameters, type QueryParameters } from './query-parameters';
import { copyQueryTimeRange, parseQueryTimeRange, type QueryTimeRange } from './query-time-range';
import { items, parseRawJson, property, rawTextOf, type ResultColumn, type ResultHit } from './query-result';

/**
 * Local query library (named drafts and favorites) plus loaded-result export.
 *
 * The library is one versioned JSON document. Every stored field is bounded and every entry
 * carries the stable connection ID it was saved under; a deleted connection never relabels an
 * entry and a restore never rebinds by name or to the currently active connection. Draft text is
 * stored verbatim, including invalid or incomplete DSL: only the byte size is bounded, because a
 * half-written query is exactly what a draft is for.
 *
 * Export reads only results that are already loaded: CSV keeps each number as its original
 * token and each nested value as its compact source text, JSONL emits one raw `_search` hit per
 * line with only inter-token whitespace removed. No value is ever routed through
 * `JSON.parse`/`Number`, so precision and formatting stay exact.
 */

export const QUERY_LIBRARY_VERSION = 1;
/** Hard bound on stored entries; mirrors the Rust IPC contract. */
export const MAX_SAVED_ENTRIES = 100;
export const MAX_ENTRY_ID_LENGTH = 64;
export const MAX_ENTRY_NAME_CHARS = 120;
export const MAX_CONNECTION_ID_BYTES = 64;
export const MAX_ENTRY_INDEX_BYTES = 1024;
export const MAX_ENTRY_DSL_BYTES = 256 * 1024;
export const MAX_UPDATED_AT_CHARS = 40;
/** Serialized library bound; mirrors the single database row bound. */
export const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;
/** One export payload bound before it reaches the native save dialog. */
export const MAX_EXPORT_CONTENT_BYTES = 16 * 1024 * 1024;

export interface SavedQueryEntry {
  readonly id: string;
  readonly name: string;
  /** Stable connection ID captured at save time; kept even after the connection is deleted. */
  readonly connectionId: string | null;
  readonly index: string;
  /** Verbatim DSL text, incomplete drafts included. */
  readonly dsl: string;
  readonly resultView: 'table' | 'json';
  readonly favorite: boolean;
  readonly updatedAt: string;
  readonly parameters?: QueryParameters;
  readonly dataView?: DataViewSelection;
  readonly timeRange?: QueryTimeRange;
}

export interface SavedQueryLibrary {
  readonly version: number;
  readonly entries: readonly SavedQueryEntry[];
}

export type EntryLimitCode =
  | 'tooManyEntries' | 'invalidEntryId' | 'nameTooLong' | 'indexTooLarge'
  | 'dslTooLarge' | 'invalidTimestamp' | 'connectionIdTooLong' | 'invalidParameters' | 'invalidDataView' | 'invalidTimeRange';

const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const UPDATED_AT_PATTERN = /^[0-9A-Za-z:.+-]+$/;
const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

export function createEmptyLibrary(): SavedQueryLibrary {
  return { version: QUERY_LIBRARY_VERSION, entries: [] };
}

/**
 * Snapshot one document into a library entry. The document is only read: saving never mutates
 * the editor, the revision or the displayed result. The caller supplies the entry ID so an
 * already-saved draft is updated in place instead of duplicated.
 */
export function entryFromDocument(document: QueryDocument, options: {
  readonly id: string;
  readonly name: string;
  readonly favorite: boolean;
  readonly now: Date;
}): SavedQueryEntry {
  return {
    id: options.id,
    name: options.name.trim(),
    connectionId: document.connectionId,
    index: document.index,
    dsl: document.dsl,
    resultView: document.resultView,
    favorite: options.favorite,
    updatedAt: options.now.toISOString(),
    ...(document.parameters === undefined ? {} : { parameters: parametersPayload(document.parameters) }),
    ...(document.dataView === undefined ? {} : { dataView: selectDataView(document.dataView.definition) }),
    ...(document.timeRange === undefined ? {} : { timeRange: copyQueryTimeRange(document.timeRange) }),
  };
}

/**
 * Restore target: a fresh query ID bound to the stored connection ID. The entry's identity is
 * never reused as a tab/query ID, and a `null` connection stays unbound instead of silently
 * attaching to whatever connection is active.
 */
export function documentFromEntry(entry: SavedQueryEntry, id: string = crypto.randomUUID()): QueryDocument {
  return {
    id,
    connectionId: entry.connectionId,
    name: entry.name,
    index: entry.index,
    dsl: entry.dsl,
    revision: 0,
    resultView: entry.resultView,
    ...(entry.parameters === undefined ? {} : { parameters: parametersPayload(entry.parameters) }),
    ...(entry.dataView === undefined ? {} : { dataView: selectDataView(entry.dataView.definition) }),
    ...(entry.timeRange === undefined ? {} : { timeRange: copyQueryTimeRange(entry.timeRange) }),
  };
}

export function findEntry(library: SavedQueryLibrary, id: string): SavedQueryEntry | undefined {
  return library.entries.find((entry) => entry.id === id);
}

export function upsertEntry(library: SavedQueryLibrary, entry: SavedQueryEntry): SavedQueryLibrary {
  const exists = library.entries.some((current) => current.id === entry.id);
  const entries = exists
    ? library.entries.map((current) => (current.id === entry.id ? entry : current))
    : [...library.entries, entry];
  return { version: QUERY_LIBRARY_VERSION, entries };
}

export function removeEntry(library: SavedQueryLibrary, id: string): SavedQueryLibrary {
  const entries = library.entries.filter((entry) => entry.id !== id);
  return entries.length === library.entries.length ? library : { version: QUERY_LIBRARY_VERSION, entries };
}

export function setEntryFavorite(library: SavedQueryLibrary, id: string, favorite: boolean): SavedQueryLibrary {
  return {
    version: QUERY_LIBRARY_VERSION,
    entries: library.entries.map((entry) => (entry.id === id ? { ...entry, favorite } : entry)),
  };
}

/** First violated bound, or `null`. Used before a mutation and again before serializing. */
export function entryLimitViolation(library: SavedQueryLibrary, entry: SavedQueryEntry): EntryLimitCode | null {
  const exists = library.entries.some((current) => current.id === entry.id);
  if (!exists && library.entries.length >= MAX_SAVED_ENTRIES) return 'tooManyEntries';
  if (entry.id.length > MAX_ENTRY_ID_LENGTH || !ENTRY_ID_PATTERN.test(entry.id)) return 'invalidEntryId';
  if ([...entry.name].length > MAX_ENTRY_NAME_CHARS) return 'nameTooLong';
  if (entry.connectionId !== null && utf8ByteLength(entry.connectionId) > MAX_CONNECTION_ID_BYTES) return 'connectionIdTooLong';
  if (utf8ByteLength(entry.index) > MAX_ENTRY_INDEX_BYTES) return 'indexTooLarge';
  if (utf8ByteLength(entry.dsl) > MAX_ENTRY_DSL_BYTES) return 'dslTooLarge';
  if (entry.updatedAt.length > MAX_UPDATED_AT_CHARS || !UPDATED_AT_PATTERN.test(entry.updatedAt)) return 'invalidTimestamp';
  if (entry.parameters !== undefined && parseQueryParameters(entry.parameters) === null) return 'invalidParameters';
  if (entry.dataView !== undefined && parseDataViewSelection(entry.dataView, entry.connectionId, entry.index) === null) return 'invalidDataView';
  if (entry.timeRange !== undefined && parseQueryTimeRange(entry.timeRange, entry.connectionId, entry.index, entry.dsl) === null) return 'invalidTimeRange';
  return null;
}

/** Whole-library check: count, unique IDs and every entry's own bounds. */
export function libraryLimitViolation(library: SavedQueryLibrary): EntryLimitCode | null {
  if (library.entries.length > MAX_SAVED_ENTRIES) return 'tooManyEntries';
  const ids = new Set<string>();
  for (const entry of library.entries) {
    if (ids.has(entry.id)) return 'invalidEntryId';
    ids.add(entry.id);
    const violation = entryLimitViolation(library, entry);
    if (violation !== null) return violation;
  }
  return null;
}

/** Canonical object shape for the IPC payload: exactly the fields the Rust contract knows. */
export function libraryPayload(library: SavedQueryLibrary): {
  version: number;
  entries: SavedQueryEntry[];
} {
  return {
    version: QUERY_LIBRARY_VERSION,
    entries: library.entries.map((entry) => ({
      id: entry.id, name: entry.name, connectionId: entry.connectionId, index: entry.index,
      dsl: entry.dsl, resultView: entry.resultView, favorite: entry.favorite, updatedAt: entry.updatedAt,
      ...(entry.parameters === undefined ? {} : { parameters: parametersPayload(entry.parameters) }),
      ...(entry.dataView === undefined ? {} : { dataView: selectDataView(entry.dataView.definition) }),
      ...(entry.timeRange === undefined ? {} : { timeRange: copyQueryTimeRange(entry.timeRange) }),
    })),
  };
}

/** Canonical serialization for the IPC payload and for change detection (dedupe on save). */
export function serializeLibrary(library: SavedQueryLibrary): string {
  return JSON.stringify(libraryPayload(library));
}

export type LibraryParseResult =
  | { readonly ok: true; readonly library: SavedQueryLibrary }
  | { readonly ok: false; readonly code: 'invalidLibrary' };

const ENTRY_KEYS = ['id', 'name', 'connectionId', 'index', 'dsl', 'resultView', 'favorite', 'updatedAt'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): SavedQueryEntry | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (!ENTRY_KEYS.every((key) => keys.includes(key))
    || keys.some((key) => key !== 'parameters' && key !== 'dataView' && key !== 'timeRange' && !ENTRY_KEYS.includes(key as typeof ENTRY_KEYS[number]))) return null;
  const { id, name, connectionId, index, dsl, resultView, favorite, updatedAt } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof index !== 'string'
    || typeof dsl !== 'string' || typeof updatedAt !== 'string') return null;
  if (connectionId !== null && typeof connectionId !== 'string') return null;
  if (typeof favorite !== 'boolean') return null;
  if (resultView !== 'table' && resultView !== 'json') return null;
  const parameters = Object.hasOwn(value, 'parameters') ? parseQueryParameters(value.parameters) : undefined;
  if (parameters === null) return null;
  const dataView = Object.hasOwn(value, 'dataView') ? parseDataViewSelection(value.dataView, connectionId, index) : undefined;
  if (dataView === null) return null;
  const timeRange = Object.hasOwn(value, 'timeRange') ? parseQueryTimeRange(value.timeRange, connectionId, index, dsl) : undefined;
  if (timeRange === null) return null;
  return { id, name, connectionId, index, dsl, resultView, favorite, updatedAt,
    ...(parameters ? { parameters } : {}), ...(dataView ? { dataView } : {}), ...(timeRange ? { timeRange } : {}) };
}

/**
 * Strict reader for a library payload. Anything this build cannot explain — a newer version,
 * unknown fields, an over-limit entry or a duplicate ID — is refused as a whole, so the caller
 * fails the load and leaves the stored bytes untouched instead of writing a repaired subset.
 */
export function parseLibraryPayload(value: unknown): LibraryParseResult {
  if (!isPlainObject(value)) return { ok: false, code: 'invalidLibrary' };
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('entries')) return { ok: false, code: 'invalidLibrary' };
  if (value.version !== QUERY_LIBRARY_VERSION) return { ok: false, code: 'invalidLibrary' };
  if (!Array.isArray(value.entries) || value.entries.length > MAX_SAVED_ENTRIES) return { ok: false, code: 'invalidLibrary' };
  const entries: SavedQueryEntry[] = [];
  const ids = new Set<string>();
  for (const raw of value.entries) {
    const entry = parseEntry(raw);
    if (entry === null || ids.has(entry.id)) return { ok: false, code: 'invalidLibrary' };
    ids.add(entry.id);
    const partial: SavedQueryLibrary = { version: QUERY_LIBRARY_VERSION, entries };
    if (entryLimitViolation(partial, entry) !== null) return { ok: false, code: 'invalidLibrary' };
    entries.push(entry);
  }
  return { ok: true, library: { version: QUERY_LIBRARY_VERSION, entries } };
}

// --- Loaded-result export ----------------------------------------------------------------

export type ExportFormat = 'csv' | 'jsonl';

export interface ExportContent {
  readonly content: string;
  readonly rows: number;
}

export interface CsvExport extends ExportContent {
  readonly columns: readonly string[];
}

const CSV_NEWLINE = '\r\n';
/** Leading identifier columns, matching the grid's `_index`/`_id` metadata columns. */
const CSV_META_COLUMNS: readonly string[] = ['_index', '_id'];

/**
 * Remove only the whitespace between JSON tokens (string contents stay byte-identical), so one
 * value or hit becomes a single line without ever re-encoding a number.
 */
export function compactJsonText(text: string): string {
  const scanner = createScanner(text, true);
  let compact = '';
  while (scanner.getPosition() < text.length) {
    scanner.scan();
    const length = scanner.getTokenLength();
    if (length === 0) break;
    compact += text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + length);
  }
  return compact;
}

/**
 * Formula-injection defense for text cells: a value that starts with `=`, `+`, `-`, `@`, or with
 * a leading run of whitespace/control characters followed by one of those, is prefixed with an
 * apostrophe. A leading tab, LF or CR is guarded on its own. Numbers do not pass through here —
 * they keep their exact token.
 */
const FORMULA_START = /^[=+\-@]/;
/** Space, C0 controls, DEL, BOM and Unicode whitespace can all precede a formula character. */
const UNICODE_SPACE = /\s/u;

function isGuardableLead(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  if (code <= 0x20 || code === 0x7f || code === 0xfeff) return true;
  return UNICODE_SPACE.test(value[index]!);
}

function guardFormula(value: string): string {
  let index = 0;
  while (index < value.length && isGuardableLead(value, index)) index += 1;
  if (FORMULA_START.test(value.slice(index))) return `'${value}`;
  const first = value.charCodeAt(0);
  if (first === 0x09 || first === 0x0a || first === 0x0d) return `'${value}`;
  return value;
}

function csvQuote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One CSV cell for text data: formula guard, then RFC 4180 quoting when needed. */
function csvText(value: string): string {
  return csvQuote(guardFormula(value));
}

/**
 * One CSV cell for a document value. Strings are decoded exactly; numbers, booleans and `null`
 * keep their raw token so precision and formatting survive; nested objects/arrays are emitted as
 * their compact source text; an absent column is an empty cell. `null` stays the literal token,
 * so it remains distinguishable from absent.
 */
function csvValue(column: ResultColumn | undefined): string {
  if (column === undefined) return '';
  const { kind, text } = column.value;
  if (kind === 'string') return csvText(text);
  if (kind === 'object' || kind === 'array') return csvQuote(compactJsonText(text));
  return text;
}

/** Loaded hits to CSV: `_index,_id` plus every source field, in first-seen order.
 *
 * A source field named `_id`/`_index` (or one that matches another field's alias) would vanish
 * under a naive dedupe, so each distinct source name gets a unique, non-colliding header label
 * and its values are still looked up by the original field name. No source field is dropped.
 */
export function buildCsvExport(hits: readonly ResultHit[]): CsvExport {
  const labels = new Map<string, string>();
  const used = new Set<string>(CSV_META_COLUMNS);
  for (const hit of hits) {
    for (const column of hit.columns) {
      if (labels.has(column.name)) continue;
      const label = uniqueHeader(column.name, used);
      used.add(label);
      labels.set(column.name, label);
    }
  }
  const names = [...labels.keys()];
  const columns = [...CSV_META_COLUMNS, ...names.map((name) => labels.get(name)!)];
  const lines = [columns.map(csvText).join(',')];
  for (const hit of hits) {
    const cells = [csvText(hit.index ?? ''), csvText(hit.id)];
    for (const name of names) {
      cells.push(csvValue(hit.columns.find((column) => column.name === name)));
    }
    lines.push(cells.join(','));
  }
  return { content: lines.length === 1 ? '' : lines.join(CSV_NEWLINE) + CSV_NEWLINE, columns, rows: hits.length };
}

/** First free label: the name itself, then `name (source)`, `name (source 2)`, … */
function uniqueHeader(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  let counter = 1;
  for (;;) {
    const candidate = counter === 1 ? `${name} (source)` : `${name} (source ${counter})`;
    if (!used.has(candidate)) return candidate;
    counter += 1;
  }
}

export type JsonlExport =
  | { readonly ok: true; readonly content: string; readonly rows: number }
  | { readonly ok: false; readonly code: 'invalidPage' };

/**
 * Loaded pages to JSONL: one raw hit object per line, exactly the tokens the cluster returned
 * (only inter-token whitespace removed). A page or hit that cannot be sliced exactly is a hard
 * failure — exporting fewer rows than the grid shows as a success would be a silent data loss.
 */
export function buildJsonlExport(pages: readonly { readonly rawResponse: string }[]): JsonlExport {
  const lines: string[] = [];
  for (const page of pages) {
    const root = parseRawJson(page.rawResponse);
    if (root === null || root.type !== 'object') return { ok: false, code: 'invalidPage' };
    const hits = property(property(root, 'hits'), 'hits');
    if (hits === undefined || hits.type !== 'array') return { ok: false, code: 'invalidPage' };
    for (const node of items(hits)) {
      if (node.type !== 'object') return { ok: false, code: 'invalidPage' };
      const raw = rawTextOf(page.rawResponse, node);
      if (raw === null || raw === '') return { ok: false, code: 'invalidPage' };
      lines.push(compactJsonText(raw));
    }
  }
  return { ok: true, content: lines.length === 0 ? '' : lines.join('\n') + '\n', rows: lines.length };
}

/** `escope-<base>-<timestamp>.<format>` with an ASCII-only, path-safe stem. */
export function defaultExportFileName(base: string, format: ExportFormat, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const stem = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
  return `escope-${stem || 'results'}-${stamp}.${format}`;
}

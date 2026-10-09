import { parseRawJson, sliceRaw, type ResultColumn } from './query-result';
import { compareDecimalText, parseDecimalToken } from './result-grid';
import type { FieldCatalog } from './resource';

export const FIELD_FORMATS_VERSION = 1;
export const MAX_FIELD_FORMATS = 32;
export const MAX_FIELD_FORMATS_BYTES = 16 * 1024;
export const MAX_FORMAT_FIELD_BYTES = 1024;
export const MAX_FORMAT_NUMBER_CHARS = 1024;
export const MAX_FORMAT_EXPANDED_CHARS = 2048;
export const MAX_FORMAT_OUTPUT_CHARS = 4096;
export const MAX_FORMAT_ARRAY_ITEMS = 32;

export type FieldFormat =
  | { readonly kind: 'number' | 'percent' | 'bytes'; readonly grouping: boolean }
  | { readonly kind: 'date'; readonly input: 'iso' | 'epoch_millis' };

export interface FieldFormatEntry {
  readonly field: string;
  readonly format: FieldFormat;
}

export interface DataViewFieldFormats {
  readonly version: number;
  readonly entries: readonly FieldFormatEntry[];
}

const encoder = new TextEncoder();
function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validFormatField(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim()
    && encoder.encode(value).length <= MAX_FORMAT_FIELD_BYTES
    && ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    });
}

export function parseFieldFormat(value: unknown): FieldFormat | null {
  if (shape(value, ['kind', 'grouping']) && typeof value.grouping === 'boolean'
    && (value.kind === 'number' || value.kind === 'percent' || value.kind === 'bytes')) {
    return { kind: value.kind, grouping: value.grouping };
  }
  if (shape(value, ['kind', 'input']) && value.kind === 'date' && (value.input === 'iso' || value.input === 'epoch_millis')) {
    return { kind: 'date', input: value.input };
  }
  return null;
}

export function parseFieldFormats(value: unknown): DataViewFieldFormats | null {
  if (!shape(value, ['version', 'entries']) || value.version !== FIELD_FORMATS_VERSION
    || !Array.isArray(value.entries) || value.entries.length > MAX_FIELD_FORMATS) return null;
  const fields = new Set<string>();
  const entries: FieldFormatEntry[] = [];
  for (const entry of value.entries) {
    if (!shape(entry, ['field', 'format']) || !validFormatField(entry.field) || fields.has(entry.field)) return null;
    const format = parseFieldFormat(entry.format);
    if (!format) return null;
    fields.add(entry.field);
    entries.push({ field: entry.field, format });
  }
  const result = { version: FIELD_FORMATS_VERSION, entries };
  return encoder.encode(JSON.stringify(result)).length <= MAX_FIELD_FORMATS_BYTES ? result : null;
}

export function fieldFormatsPayload(value: DataViewFieldFormats): DataViewFieldFormats {
  return {
    version: value.version,
    entries: value.entries.map(({ field, format }) => ({
      field, format: format.kind === 'date' ? { kind: format.kind, input: format.input } : { kind: format.kind, grouping: format.grouping },
    })),
  };
}

export type FieldFormatEvidence = 'unchecked' | 'missing' | 'conflict' | 'notNumeric' | 'notDate' | 'valid';
const NUMERIC_TYPES = new Set(['byte', 'short', 'integer', 'long', 'unsigned_long', 'half_float', 'float', 'double', 'scaled_float']);

export function fieldFormatEvidence(entry: FieldFormatEntry, catalog?: FieldCatalog): FieldFormatEvidence {
  if (!catalog) return 'unchecked';
  const field = catalog.fields.find((item) => item.name === entry.field);
  if (!field || field.types.length === 0) return 'missing';
  if (field.conflict || field.types.length !== 1) return 'conflict';
  const type = field.types[0]!.type;
  return entry.format.kind === 'date'
    ? type === 'date' || type === 'date_nanos' ? 'valid' : 'notDate'
    : NUMERIC_TYPES.has(type) ? 'valid' : 'notNumeric';
}

export type FieldFormatResult =
  | { readonly status: 'formatted'; readonly text: string }
  | { readonly status: 'raw'; readonly reason: 'type' | 'date' | 'limit' | 'structure' | 'empty' };

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const GROUPED_INTEGER = new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 });
const IEC_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const;
const IEC_THRESHOLDS = IEC_UNITS.map((_, index) => (1024n ** BigInt(index)).toString());

/** Only bounded decimal point positions become JS numbers; data digits remain text/BigInt. */
function expandedDecimal(digits: string, exponent: bigint, grouping: boolean): string | null {
  const point = BigInt(digits.length) + exponent;
  const size = point <= 0n ? 2n - point + BigInt(digits.length)
    : point >= BigInt(digits.length) ? point : BigInt(digits.length) + 1n;
  if (size > BigInt(MAX_FORMAT_EXPANDED_CHARS)) return null;
  const position = Number(point);
  const integer = position <= 0 ? '0' : position >= digits.length
    ? digits + '0'.repeat(position - digits.length) : digits.slice(0, position);
  const fraction = position <= 0 ? '0'.repeat(-position) + digits : digits.slice(position);
  return (grouping ? GROUPED_INTEGER.format(BigInt(integer)) : integer) + (fraction ? `.${fraction}` : '');
}

function formatNumber(text: string, format: Exclude<FieldFormat, { kind: 'date' }>): FieldFormatResult {
  if (text.length > MAX_FORMAT_NUMBER_CHARS) return { status: 'raw', reason: 'limit' };
  if (!JSON_NUMBER.test(text)) return { status: 'raw', reason: 'type' };
  const parsed = parseDecimalToken(text);
  if (!parsed) return { status: 'raw', reason: 'type' };
  let { digits, exponent } = parsed;
  let suffix = format.kind === 'percent' ? '%' : '';
  if (format.kind === 'percent' && parsed.sign !== 0) exponent += 2n;
  if (format.kind === 'bytes') {
    let unit = 0;
    const absolute = text.startsWith('-') ? text.slice(1) : text;
    while (unit + 1 < IEC_UNITS.length && compareDecimalText(absolute, IEC_THRESHOLDS[unit + 1]!) >= 0) unit += 1;
    if (unit > 0) {
      // Dividing by 1024^unit is exact: multiply by 5^(10*unit), then shift the decimal point.
      const power = BigInt(unit * 10);
      const product = (BigInt(digits) * 5n ** power).toString();
      digits = product.replace(/0+$/, '');
      exponent += BigInt(product.length - digits.length) - power;
    }
    suffix = ` ${IEC_UNITS[unit]}`;
  }
  const expanded = expandedDecimal(digits, exponent, format.grouping);
  return expanded === null ? { status: 'raw', reason: 'limit' }
    : { status: 'formatted', text: `${text.startsWith('-') ? '-' : ''}${expanded}${suffix}` };
}

const ISO_STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;
const DATE_LIMIT = 8_640_000_000_000_000n;

function formatDate(value: ResultColumn['value'], input: 'iso' | 'epoch_millis'): FieldFormatResult {
  if (input === 'epoch_millis') {
    if (value.kind !== 'number') return { status: 'raw', reason: 'type' };
    if (value.text.length > 17 || !/^-?(?:0|[1-9]\d*)$/.test(value.text)) return { status: 'raw', reason: 'date' };
    const millis = BigInt(value.text);
    if (millis < -DATE_LIMIT || millis > DATE_LIMIT) return { status: 'raw', reason: 'date' };
    // This range is entirely within safe integers; fractional/oversized values never reach Date.
    return { status: 'formatted', text: new Date(Number(millis)).toISOString() };
  }
  if (value.kind !== 'string') return { status: 'raw', reason: 'type' };
  const match = ISO_STAMP.exec(value.text);
  if (!match) return { status: 'raw', reason: 'date' };
  const [, seconds, fraction = '', zone] = match;
  const base = `${seconds}.000Z`;
  const date = new Date(base);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== base) return { status: 'raw', reason: 'date' };
  let offset = 0;
  if (zone !== 'Z') {
    const hours = Number(zone!.slice(1, 3));
    const minutes = Number(zone!.slice(4, 6));
    if (hours > 23 || minutes > 59 || zone === '-00:00') return { status: 'raw', reason: 'date' };
    offset = (hours * 60 + minutes) * (zone![0] === '-' ? -1 : 1);
  }
  const utc = new Date(date.getTime() - offset * 60_000).toISOString();
  return { status: 'formatted', text: `${utc.slice(0, -5)}${fraction}Z` };
}

function formatScalar(value: ResultColumn['value'], format: FieldFormat): FieldFormatResult {
  if (value.kind === 'null') return { status: 'raw', reason: 'empty' };
  if (format.kind === 'date') return formatDate(value, format.input);
  return value.kind === 'number' ? formatNumber(value.text, format) : { status: 'raw', reason: 'type' };
}

/** A presentation only. Never use its output for sorting, DSL, clipboard or export data. */
export function formatFieldValue(value: ResultColumn['value'], format: FieldFormat): FieldFormatResult {
  if (value.kind === 'object') return { status: 'raw', reason: 'structure' };
  if (value.kind !== 'array') return formatScalar(value, format);
  if (value.text.length > MAX_FIELD_FORMATS_BYTES) return { status: 'raw', reason: 'limit' };
  const root = parseRawJson(value.text);
  if (!root || root.type !== 'array') return { status: 'raw', reason: 'structure' };
  const children = root.children ?? [];
  if (children.length === 0) return { status: 'raw', reason: 'empty' };
  if (children.length > MAX_FORMAT_ARRAY_ITEMS) return { status: 'raw', reason: 'limit' };
  const formatted: string[] = [];
  let length = 2;
  for (const node of children) {
    if (node.type === 'array' || node.type === 'object' || node.type === 'property') return { status: 'raw', reason: 'structure' };
    if (node.type === 'null') {
      length += 6;
      if (length > MAX_FORMAT_OUTPUT_CHARS) return { status: 'raw', reason: 'limit' };
      formatted.push('null');
      continue;
    }
    const scalar = formatScalar({
      kind: node.type, text: node.type === 'string' ? String(node.value) : sliceRaw(value.text, node),
    }, format);
    if (scalar.status === 'raw') return scalar;
    const text = JSON.stringify(scalar.text);
    length += text.length + 2;
    if (length > MAX_FORMAT_OUTPUT_CHARS) return { status: 'raw', reason: 'limit' };
    formatted.push(text);
  }
  return { status: 'formatted', text: `[${formatted.join(', ')}]` };
}

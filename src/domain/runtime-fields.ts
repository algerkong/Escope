import type { FieldCatalog } from './resource';

export const RUNTIME_FIELDS_VERSION = 1;
export const MAX_RUNTIME_FIELDS = 32;
export const MAX_RUNTIME_FIELDS_BYTES = 64 * 1024;
export const MAX_RUNTIME_FIELD_BYTES = 1024;
export const MAX_RUNTIME_SCRIPT_BYTES = 4096;
export const RUNTIME_FIELD_TYPES = ['keyword', 'long', 'double', 'boolean', 'date', 'ip', 'geo_point'] as const;
export type RuntimeFieldType = typeof RUNTIME_FIELD_TYPES[number];

export interface RuntimeScript {
  readonly source: string;
  readonly lang?: 'painless';
}

export interface RuntimeMapping {
  readonly type: RuntimeFieldType;
  readonly script?: RuntimeScript;
}

export interface RuntimeField extends RuntimeMapping {
  readonly field: string;
}

export interface DataViewRuntimeFields {
  readonly version: number;
  readonly entries: readonly RuntimeField[];
}

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function control(code: number): boolean {
  return code < 32 || code >= 127 && code <= 159;
}

/** Exact field names only. Metadata and wildcard selectors are not local runtime fields. */
export function validRuntimeFieldName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim()
    && bytes(value) <= MAX_RUNTIME_FIELD_BYTES && value !== '$param' && !value.startsWith('_') && !/[*?]/.test(value)
    && ![...value].some((char) => control(char.charCodeAt(0)));
}

export function validRuntimeScript(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && bytes(value) <= MAX_RUNTIME_SCRIPT_BYTES
    && ![...value].some((char) => control(char.charCodeAt(0)) && !['\n', '\r', '\t'].includes(char));
}

export function parseRuntimeMapping(value: unknown): RuntimeMapping | null {
  if (!shape(value, ['type'], ['script']) || !RUNTIME_FIELD_TYPES.includes(value.type as RuntimeFieldType)) return null;
  if (!Object.hasOwn(value, 'script')) return { type: value.type as RuntimeFieldType };
  const script = value.script;
  if (!shape(script, ['source'], ['lang']) || !validRuntimeScript(script.source)
    || Object.hasOwn(script, 'lang') && script.lang !== 'painless') return null;
  return { type: value.type as RuntimeFieldType, script: {
    source: script.source, ...(script.lang === undefined ? {} : { lang: 'painless' }),
  } };
}

export function runtimeMappingPayload(value: RuntimeMapping): RuntimeMapping {
  return { type: value.type, ...(value.script === undefined ? {} : { script: {
    source: value.script.source, ...(value.script.lang === undefined ? {} : { lang: value.script.lang }),
  } }) };
}

/** Pinned declarations retain explicit language and exact source text, not just equivalent types. */
export function sameRuntimeMapping(left: RuntimeMapping, right: RuntimeMapping): boolean {
  return left.type === right.type && left.script?.source === right.script?.source && left.script?.lang === right.script?.lang;
}

export function runtimeFieldsPayload(value: DataViewRuntimeFields): DataViewRuntimeFields {
  return { version: value.version, entries: value.entries.map((entry) => ({ field: entry.field, ...runtimeMappingPayload(entry) })) };
}

export function parseRuntimeFields(value: unknown): DataViewRuntimeFields | null {
  if (!shape(value, ['version', 'entries']) || value.version !== RUNTIME_FIELDS_VERSION
    || !Array.isArray(value.entries) || value.entries.length > MAX_RUNTIME_FIELDS) return null;
  const names = new Set<string>();
  const entries: RuntimeField[] = [];
  for (const entry of value.entries) {
    if (!shape(entry, ['field', 'type'], ['script']) || !validRuntimeFieldName(entry.field) || names.has(entry.field)) return null;
    const mapping = parseRuntimeMapping({ type: entry.type, ...(Object.hasOwn(entry, 'script') ? { script: entry.script } : {}) });
    if (!mapping) return null;
    names.add(entry.field);
    entries.push({ field: entry.field, ...mapping });
  }
  const result = { version: RUNTIME_FIELDS_VERSION, entries };
  return bytes(JSON.stringify(result)) <= MAX_RUNTIME_FIELDS_BYTES ? result : null;
}

/** Applied DSL has the same bounded contract, independently checked by Rust before any search. */
export function parseRuntimeMappings(value: unknown): readonly RuntimeField[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const pairs = Object.entries(value);
  if (pairs.length > MAX_RUNTIME_FIELDS) return null;
  const entries: RuntimeField[] = [];
  for (const [field, candidate] of pairs) {
    const mapping = parseRuntimeMapping(candidate);
    if (!validRuntimeFieldName(field) || !mapping) return null;
    entries.push({ field, ...mapping });
  }
  return bytes(JSON.stringify(value)) <= MAX_RUNTIME_FIELDS_BYTES ? entries : null;
}

export type RuntimeFieldEvidence = 'unchecked' | 'absent' | 'shadow' | 'typeChange' | 'conflict';

export function runtimeFieldEvidence(entry: RuntimeField, catalog?: FieldCatalog): RuntimeFieldEvidence {
  if (!catalog) return 'unchecked';
  const found = catalog.fields.find((field) => field.name === entry.field);
  if (!found || found.types.length === 0) return 'absent';
  if (found.conflict || found.types.length !== 1) return 'conflict';
  return found.types[0]!.type === entry.type ? 'shadow' : 'typeChange';
}

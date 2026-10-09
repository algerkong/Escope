import type { FieldCapability, FieldCatalog } from './resource';

export const DATA_VIEWS_VERSION = 1;
export const MAX_DATA_VIEWS = 100;
export const MAX_DATA_VIEWS_BYTES = 256 * 1024;
export const MAX_DATA_VIEW_NAME_CHARS = 120;
export const MAX_DATA_VIEW_INDEX_BYTES = 1024;
export const MAX_DATA_VIEW_FIELD_BYTES = 1024;

export interface DataViewDefinition {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly index: string;
  readonly defaultTimeField: string | null;
}

export interface DataViewLibrary {
  readonly version: number;
  readonly entries: readonly DataViewDefinition[];
}

export interface DataViewRecord {
  readonly revision: number;
  readonly library: DataViewLibrary;
}

/** A draft owns a copy, not a live reference to a mutable library entry. */
export interface DataViewSelection {
  readonly version: number;
  readonly definition: DataViewDefinition;
}

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function noControls(value: string): boolean {
  return ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

/** The existing IndexTarget grammar, with the tighter local-draft byte bound. */
export function validDataViewIndex(value: string): boolean {
  const targets = value.split(',');
  return value !== '' && value === value.trim() && bytes(value) <= MAX_DATA_VIEW_INDEX_BYTES
    && targets.length <= 64 && targets.every((target) => target.length <= 255 && /^[A-Za-z0-9.*][A-Za-z0-9._*-]*$/.test(target)
      && target !== '.' && target !== '..');
}

export function validDataViewTimeField(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value !== '' && value === value.trim()
    && bytes(value) <= MAX_DATA_VIEW_FIELD_BYTES && noControls(value));
}

export function parseDataViewDefinition(value: unknown): DataViewDefinition | null {
  if (!shape(value, ['id', 'name', 'connectionId', 'index', 'defaultTimeField'])
    || !id(value.id) || !id(value.connectionId) || typeof value.name !== 'string'
    || value.name.trim() !== value.name || value.name === '' || [...value.name].length > MAX_DATA_VIEW_NAME_CHARS
    || !noControls(value.name) || typeof value.index !== 'string' || !validDataViewIndex(value.index)) return null;
  const field = value.defaultTimeField;
  if (!validDataViewTimeField(field)) return null;
  return { id: value.id, name: value.name, connectionId: value.connectionId, index: value.index, defaultTimeField: field };
}

export function emptyDataViews(): DataViewLibrary {
  return { version: DATA_VIEWS_VERSION, entries: [] };
}

export function parseDataViewLibrary(value: unknown): DataViewLibrary | null {
  if (!shape(value, ['version', 'entries']) || value.version !== DATA_VIEWS_VERSION
    || !Array.isArray(value.entries) || value.entries.length > MAX_DATA_VIEWS) return null;
  const ids = new Set<string>();
  const entries: DataViewDefinition[] = [];
  for (const candidate of value.entries) {
    const entry = parseDataViewDefinition(candidate);
    if (!entry || ids.has(entry.id)) return null;
    ids.add(entry.id);
    entries.push(entry);
  }
  const library = { version: DATA_VIEWS_VERSION, entries };
  return bytes(JSON.stringify(library)) <= MAX_DATA_VIEWS_BYTES ? library : null;
}

export function parseDataViewRecord(value: unknown): DataViewRecord | null {
  if (!shape(value, ['revision', 'library']) || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  const library = parseDataViewLibrary(value.library);
  return library && (value.revision !== 0 || library.entries.length === 0)
    ? { revision: value.revision, library } : null;
}

export function selectDataView(definition: DataViewDefinition): DataViewSelection {
  const { id, name, connectionId, index, defaultTimeField } = definition;
  return { version: DATA_VIEWS_VERSION, definition: { id, name, connectionId, index, defaultTimeField } };
}

export function parseDataViewSelection(value: unknown, connectionId: string | null, index: string): DataViewSelection | null {
  if (!shape(value, ['version', 'definition']) || value.version !== DATA_VIEWS_VERSION) return null;
  const definition = parseDataViewDefinition(value.definition);
  return definition && definition.connectionId === connectionId && definition.index === index
    ? selectDataView(definition) : null;
}

export function sameDataView(left: DataViewDefinition, right: DataViewDefinition): boolean {
  return left.id === right.id && left.connectionId === right.connectionId && left.name === right.name
    && left.index === right.index && left.defaultTimeField === right.defaultTimeField;
}

export type TimeFieldStatus = 'none' | 'unchecked' | 'missing' | 'conflict' | 'notDate' | 'notSearchable' | 'valid';

export function dataViewTimeFieldStatus(field: string | null, catalog?: FieldCatalog): TimeFieldStatus {
  if (field === null) return 'none';
  if (!catalog) return 'unchecked';
  return timeCapabilityStatus(catalog.fields.find((item) => item.name === field));
}

function timeCapabilityStatus(capability: FieldCapability | undefined): TimeFieldStatus {
  if (!capability || capability.types.length === 0) return 'missing';
  if (capability.conflict || capability.types.length !== 1) return 'conflict';
  const type = capability.types[0]!;
  if (type.type !== 'date' && type.type !== 'date_nanos') return 'notDate';
  return type.searchable ? 'valid' : 'notSearchable';
}

export function dataViewTimeFields(catalog: FieldCatalog): readonly FieldCapability[] {
  return catalog.fields.filter((field) => timeCapabilityStatus(field) === 'valid');
}

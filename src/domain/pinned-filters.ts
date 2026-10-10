import { validDataViewIndex } from './data-views';
import type { QueryDocument } from './query';
import {
  MAX_FILTER_GROUPS, MAX_QUERY_FILTERS, queryFilterCompositionProblem, queryFilterDefinitionProblem, queryFilterDuplicate,
  queryFilterEnabled, type QueryFilter, type QueryFilterComposition, type QueryFilterDraft, type QueryFilterOperation,
} from './query-filters';
import { matchesQueryFilterBinding, queryFilterEvidenceSource } from './query-filter-session';
import {
  parseRuntimeMapping, parseRuntimeMappings, RUNTIME_FIELD_TYPES, runtimeMappingPayload, sameRuntimeMapping, type RuntimeMapping,
} from './runtime-fields';
import { runtimeMappingsFromDsl } from './runtime-fields-dsl';

export const PINNED_FILTERS_VERSION = 3;
export const MAX_PINNED_FILTERS = 100;
export const MAX_PINNED_FILTERS_BYTES = 256 * 1024;
export const MAX_PINNED_FILTER_NAME_CHARS = 120;

/** Persisted literals deliberately exclude execution, evidence, endpoint and session binding. */
export interface PinnedFilter {
  readonly id: string;
  readonly field: string;
  readonly fieldType: string;
  readonly operation: QueryFilterOperation;
  readonly value: string | null;
  readonly enabled: boolean;
  readonly nestedPath?: string;
  readonly runtimeMapping?: RuntimeMapping;
}

export interface PinnedFilterDefinition {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly index: string;
  readonly filters: readonly PinnedFilter[];
  readonly composition: QueryFilterComposition;
}

export interface PinnedFilterLibrary {
  readonly version: number;
  readonly entries: readonly PinnedFilterDefinition[];
}

export interface PinnedFilterRecord {
  readonly revision: number;
  readonly library: PinnedFilterLibrary;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
function shape(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
}

export function validPinnedFilterName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim()
    && [...value].length <= MAX_PINNED_FILTER_NAME_CHARS
    && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159);
}

function literal(filter: PinnedFilter): QueryFilter {
  return { ...filter, evidence: filter.runtimeMapping === undefined ? 'mapped' : 'runtime', origin: 'saved' };
}

export function parsePinnedFilterDefinition(value: unknown, version = PINNED_FILTERS_VERSION): PinnedFilterDefinition | null {
  if (![1, 2, PINNED_FILTERS_VERSION].includes(version)
    || !shape(value, ['id', 'name', 'connectionId', 'index', 'filters', 'composition'])
    || !id(value.id) || !id(value.connectionId) || !validPinnedFilterName(value.name)
    || typeof value.index !== 'string' || !validDataViewIndex(value.index)
    || !Array.isArray(value.filters) || !value.filters.length || value.filters.length > MAX_QUERY_FILTERS) return null;
  const filters: PinnedFilter[] = [];
  const ids = new Set<string>();
  const declarations = new Map<string, RuntimeMapping | undefined>();
  for (const entry of value.filters) {
    if (!shape(entry, ['id', 'field', 'fieldType', 'operation', 'value', 'enabled'],
      [...(version >= 2 ? ['nestedPath'] : []), ...(version >= 3 ? ['runtimeMapping'] : [])])
      || !id(entry.id) || ids.has(entry.id) || typeof entry.field !== 'string' || typeof entry.fieldType !== 'string'
      || !['include', 'exclude', 'exists', 'missing'].includes(String(entry.operation))
      || typeof entry.operation !== 'string' || entry.value !== null && typeof entry.value !== 'string'
      || typeof entry.enabled !== 'boolean' || Object.hasOwn(entry, 'nestedPath') && typeof entry.nestedPath !== 'string') return null;
    const mapping = Object.hasOwn(entry, 'runtimeMapping') ? parseRuntimeMapping(entry.runtimeMapping) : undefined;
    if (mapping === null) return null;
    const previous = declarations.get(entry.field);
    if (declarations.has(entry.field) && (mapping || previous)
      && (!mapping || !previous || !sameRuntimeMapping(mapping, previous))) return null;
    declarations.set(entry.field, mapping);
    const filter: PinnedFilter = { id: entry.id, field: entry.field, fieldType: entry.fieldType,
      operation: entry.operation as QueryFilterOperation, value: entry.value, enabled: entry.enabled,
      ...(typeof entry.nestedPath === 'string' ? { nestedPath: entry.nestedPath } : {}),
      ...(mapping ? { runtimeMapping: mapping } : {}) };
    if (queryFilterDefinitionProblem(literal(filter))
      || filter.nestedPath === undefined && queryFilterDuplicate(filters.map(literal), literal(filter))) return null;
    filters.push(filter);
    ids.add(filter.id);
  }
  if (!parseRuntimeMappings(Object.fromEntries([...declarations].filter(([, mapping]) => mapping !== undefined)))) return null;
  const input = value.composition;
  if (!shape(input, ['mode', 'groups']) || !Array.isArray(input.groups) || input.groups.length > MAX_FILTER_GROUPS
    || input.groups.some((group) => !shape(group, ['id', 'mode', 'filterIds'], version >= 2 ? ['nested'] : []) || !id(group.id))) return null;
  const composition = input as unknown as QueryFilterComposition;
  if (queryFilterCompositionProblem(composition, filters.map(literal))) return null;
  const definition = { id: value.id, name: value.name, connectionId: value.connectionId, index: value.index, filters,
    composition: { mode: composition.mode, groups: composition.groups.map((group) => ({
      id: group.id, mode: group.mode, filterIds: [...group.filterIds],
      ...(group.nested ? { nested: { ...group.nested } } : {}),
    })) } };
  return bytes(JSON.stringify(definition)) <= MAX_PINNED_FILTERS_BYTES ? definition : null;
}

export function emptyPinnedFilters(): PinnedFilterLibrary {
  return { version: PINNED_FILTERS_VERSION, entries: [] };
}

export function parsePinnedFilterLibrary(value: unknown): PinnedFilterLibrary | null {
  if (!shape(value, ['version', 'entries']) || value.version !== 1 && value.version !== 2 && value.version !== PINNED_FILTERS_VERSION
    || !Array.isArray(value.entries) || value.entries.length > MAX_PINNED_FILTERS) return null;
  const entries: PinnedFilterDefinition[] = [];
  const ids = new Set<string>();
  for (const candidate of value.entries) {
    const entry = parsePinnedFilterDefinition(candidate, value.version);
    if (!entry || ids.has(entry.id)) return null;
    entries.push(entry);
    ids.add(entry.id);
  }
  const library = { version: value.version, entries };
  return bytes(JSON.stringify(library)) <= MAX_PINNED_FILTERS_BYTES ? library : null;
}

export function parsePinnedFilterRecord(value: unknown): PinnedFilterRecord | null {
  if (!shape(value, ['revision', 'library']) || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  const library = parsePinnedFilterLibrary(value.library);
  return library && (value.revision !== 0 || !library.entries.length) ? { revision: value.revision, library } : null;
}

export function samePinnedFilter(left: PinnedFilterDefinition, right: PinnedFilterDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type PinFilterProblem = 'unsupported' | 'invalid' | 'changed' | 'runtimeChanged';
export function pinFilterDefinition(draft: QueryFilterDraft, definitionId: string, name: string):
  { ok: true; definition: PinnedFilterDefinition } | { ok: false; code: PinFilterProblem } {
  if (draft.filters.some((filter) => filter.evidence !== 'mapped' && (filter.evidence !== 'runtime'
    || filter.nestedPath !== undefined || !RUNTIME_FIELD_TYPES.some((type) => type === filter.fieldType)))) return { ok: false, code: 'unsupported' };
  if (draft.binding && !matchesQueryFilterBinding(draft.binding, draft.source, draft.endpoint)) return { ok: false, code: 'changed' };
  if (draft.filters.some((filter) => Object.hasOwn(filter, 'enabled') && typeof filter.enabled !== 'boolean'
    || queryFilterDefinitionProblem(filter))) return { ok: false, code: 'invalid' };
  const runtime = draft.filters.some((filter) => filter.evidence === 'runtime');
  const current = runtime ? runtimeMappingsFromDsl(draft.source.dsl) : [];
  const observed = runtime && draft.snapshot ? runtimeMappingsFromDsl(draft.snapshot.rawDsl) : [];
  const evidenceSource = queryFilterEvidenceSource(draft);
  if (runtime && draft.snapshot && (draft.snapshot.queryId !== evidenceSource.id
    || draft.snapshot.connectionId !== draft.source.connectionId || draft.snapshot.index !== draft.source.index)) return { ok: false, code: 'changed' };
  const filters: PinnedFilter[] = [];
  for (const filter of draft.filters) {
    let mapping: RuntimeMapping | undefined;
    if (filter.evidence === 'runtime') {
      if (filter.origin !== 'saved' && !draft.snapshot) return { ok: false, code: 'changed' };
      const after = current?.find((entry) => entry.field === filter.field);
      const before = filter.origin === 'saved' ? filter.runtimeMapping : observed?.find((entry) => entry.field === filter.field);
      if (!after || !before || after.type !== filter.fieldType || !sameRuntimeMapping(before, after)) return { ok: false, code: 'runtimeChanged' };
      mapping = runtimeMappingPayload(after);
    }
    filters.push({ id: filter.id, field: filter.field, fieldType: filter.fieldType, operation: filter.operation,
      value: filter.value, enabled: queryFilterEnabled(filter),
      ...(filter.nestedPath === undefined ? {} : { nestedPath: filter.nestedPath }),
      ...(mapping ? { runtimeMapping: mapping } : {}) });
  }
  const definition = parsePinnedFilterDefinition({
    id: definitionId, name, connectionId: draft.source.connectionId, index: draft.source.index,
    filters,
    composition: draft.composition ?? { mode: 'all',
      groups: [{ id: 'default', mode: 'all', filterIds: draft.filters.map((filter) => filter.id) }] },
  });
  return definition ? { ok: true, definition } : { ok: false, code: 'invalid' };
}

/** No merge, rebind or execute: the caller must reserve an empty session draft for this target. */
export function draftFromPinnedFilters(definition: PinnedFilterDefinition, source: QueryDocument, endpoint: string): QueryFilterDraft | null {
  const checked = parsePinnedFilterDefinition(definition);
  if (!checked || checked.connectionId !== source.connectionId || checked.index !== source.index || !endpoint) return null;
  return { source: structuredClone(source), endpoint, snapshot: null, filters: checked.filters.map(literal), composition: checked.composition };
}

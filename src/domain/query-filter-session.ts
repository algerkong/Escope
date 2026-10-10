import { matchesQueryDraft, type QueryDocument } from './query';
import { formatQueryDsl } from './query-dsl';
import type { NestedFilterMappingResult } from './query-filter-mapping';
import {
  MAX_FILTER_DSL_BYTES, previewQueryFilters, queryFilterEnabled,
  type QueryFilterBinding, type QueryFilterComposition, type QueryFilterDraft, type QueryFilterPreview,
} from './query-filters';
import { copyQueryTimeRange } from './query-time-range';
import type { FieldCatalog } from './resource';

// Only bindings minted after a checked application may restore a baseline. Deserialized lookalikes cannot.
const bindings = new WeakSet<QueryFilterBinding>();

function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

export function matchesQueryFilterBinding(binding: QueryFilterBinding, current: QueryDocument | undefined, endpoint: string | null): boolean {
  return bindings.has(binding) && endpoint === binding.endpoint && matchesQueryDraft(current, binding.applied);
}

function compositionOf(draft: Pick<QueryFilterDraft, 'filters' | 'composition'>): QueryFilterComposition {
  return draft.composition ?? { mode: 'all',
    groups: draft.filters.length ? [{ id: 'default', mode: 'all', filterIds: draft.filters.map((filter) => filter.id) }] : [] };
}

export function queryFilterDraftChanged(draft: QueryFilterDraft): boolean {
  if (!draft.binding) return draft.filters.some(queryFilterEnabled);
  const definitions = (value: Pick<QueryFilterDraft, 'filters' | 'composition'>) => JSON.stringify({
    filters: value.filters.map((filter) => ({ ...filter, enabled: queryFilterEnabled(filter) })),
    composition: compositionOf(value),
  });
  return definitions(draft) !== definitions(draft.binding);
}

export function hasPendingQueryFilters(draft: QueryFilterDraft | undefined): boolean {
  return draft !== undefined && (draft.filters.length > 0 || draft.binding !== undefined);
}

/** Index-to-query creation retains its actual observation identity, not a fabricated query execution. */
export function queryFilterEvidenceSource(draft: QueryFilterDraft): QueryDocument {
  const binding = draft.binding;
  return binding && draft.snapshot && binding.snapshot && matchesQueryFilterBinding(binding, draft.source, draft.endpoint)
    && draft.snapshot.queryId !== draft.source.id && draft.snapshot.queryId === binding.baseline.id
    && draft.snapshot.requestId === binding.snapshot.requestId && draft.snapshot.rawDsl === binding.snapshot.rawDsl
    && draft.snapshot.connectionId === binding.snapshot.connectionId && draft.snapshot.index === binding.snapshot.index
    ? binding.baseline : draft.source;
}

/** Rebuild from the exact baseline, never append another wrapper to an already applied document. */
export function previewQueryFilterDraft(draft: QueryFilterDraft, catalog?: FieldCatalog, mapping?: NestedFilterMappingResult): QueryFilterPreview {
  const binding = draft.binding;
  if (binding && !matchesQueryFilterBinding(binding, draft.source, draft.endpoint)) return { ok: false, code: 'filterBindingChanged' };
  const baseline = binding?.baseline ?? draft.source;
  const snapshot = draft.snapshot;
  if (draft.snapshot && (draft.snapshot.connectionId !== draft.source.connectionId || draft.snapshot.index !== draft.source.index
    || draft.snapshot.queryId !== draft.source.id && queryFilterEvidenceSource(draft) === draft.source)) {
    return { ok: false, code: 'targetChanged' };
  }
  let result: QueryFilterPreview;
  if (binding && draft.filters.length === 0) {
    const composition = draft.composition;
    if (composition !== undefined && (composition === null || typeof composition !== 'object' || Array.isArray(composition)
      || composition.mode !== 'all' && composition.mode !== 'any'
      || !Array.isArray(composition.groups) || composition.groups.length !== 0
      || Object.keys(composition).some((key) => key !== 'mode' && key !== 'groups'))) {
      return { ok: false, code: 'invalidComposition' };
    }
    // The immutable, locally issued binding already validated this exact baseline and time wrapper.
    result = { ok: true, dsl: baseline.dsl, patch: { dsl: baseline.dsl,
      ...(baseline.timeRange ? { timeRange: copyQueryTimeRange(baseline.timeRange) } : {}) } };
  } else {
    // A locally checked index-to-query binding may now have a real observation from its new query.
    // Compile the original body with that observation's identity; never relabel the observation.
    const evidenceBaseline = snapshot && binding ? { ...baseline, id: snapshot.queryId } : baseline;
    result = previewQueryFilters(evidenceBaseline, snapshot, draft.filters, catalog, draft.composition, mapping);
  }
  if (!result.ok || result.dsl === baseline.dsl) return result;
  const formatted = formatQueryDsl(result.dsl);
  const dsl = formatted.ok && new TextEncoder().encode(formatted.formatted).length <= MAX_FILTER_DSL_BYTES
    ? formatted.formatted : result.dsl;
  return { ok: true, dsl, patch: { ...result.patch, dsl } };
}

/** Validate a CAS candidate or explicit same-target new query; publish only after that update succeeds. */
export function bindAppliedQueryFilters(draft: QueryFilterDraft, applied: QueryDocument,
  catalog?: FieldCatalog, mapping?: NestedFilterMappingResult): QueryFilterBinding | null {
  if (!draft.filters.length || !queryFilterDraftChanged(draft)) return null;
  const reviewed = previewQueryFilterDraft(draft, catalog, mapping);
  if (!reviewed.ok || applied.dsl !== reviewed.dsl || applied.connectionId !== draft.source.connectionId
    || applied.index !== draft.source.index || !applied.connectionId
    || JSON.stringify(applied.timeRange) !== JSON.stringify(reviewed.patch.timeRange ?? undefined)
    || JSON.stringify(applied.parameters) !== JSON.stringify(draft.source.parameters)
    || JSON.stringify(applied.dataView) !== JSON.stringify(draft.source.dataView)) return null;
  const binding: QueryFilterBinding = freezeCopy({
    baseline: draft.binding?.baseline ?? draft.source,
    applied, snapshot: draft.snapshot, endpoint: draft.endpoint,
    filters: draft.filters, ...(draft.composition === undefined ? {} : { composition: draft.composition }),
  });
  bindings.add(binding);
  return binding;
}

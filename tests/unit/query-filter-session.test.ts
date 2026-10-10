import { describe, expect, it } from 'vitest';
import {
  createQuery, createSnapshot, matchesQueryDraft, updateWorkspaceDocument,
  type QueryDocument, type QueryDocumentPatch, type WorkspaceState,
} from '../../src/domain/query';
import { parseNestedFilterMapping } from '../../src/domain/query-filter-mapping';
import {
  bindAppliedQueryFilters, hasPendingQueryFilters, matchesQueryFilterBinding,
  previewQueryFilterDraft, queryFilterDraftChanged, queryFilterEvidenceSource,
} from '../../src/domain/query-filter-session';
import { type QueryFilter, type QueryFilterBinding, type QueryFilterComposition, type QueryFilterDraft } from '../../src/domain/query-filters';
import { freezeTimeRange, previewTimeRange, removeAppliedTimeRange } from '../../src/domain/query-time-range';
import { parseFieldCaps } from '../../src/domain/resource';

const at = new Date('2026-10-10T00:00:00.000Z');
const endpoint = 'https://fixture.test';
const source: QueryDocument = {
  ...createQuery('connection'), id: 'query', index: 'events', dsl: '{ "query": {"bool":{"should":['
    + '{"term":{"n":9007199254740993}},{"term":{"status":"\\u0061"}}],"minimum_should_match":"75%","boost":1.2300e+2}},'
    + '"sort":[{"n":"desc"},"_score"],"size":25,"post_filter":{"exists":{"field":"status"}} }',
  parameters: { version: 1, template: '{"query":{"term":{"n":{"$param":"n"}}}}', definitions: [{ name: 'n', type: 'number' }] },
};
const fields = parseFieldCaps('{"indices":["events"],"fields":{"n":{"long":{"searchable":true}},'
  + '"status":{"keyword":{"searchable":true}},"comments.author":{"keyword":{"searchable":true}}}}');
if (!fields.ok) throw new Error('fixture');
const catalog = fields.value;
const mapping = parseNestedFilterMapping('{"events":{"mappings":{"properties":{"comments":{"type":"nested",'
  + '"properties":{"author":{"type":"keyword"}}}}}}}');
const n: QueryFilter = { id: 'n', field: 'n', fieldType: 'long', evidence: 'mapped', origin: 'source',
  operation: 'include', value: '9007199254740995' };
const status: QueryFilter = { id: 'status', field: 'status', fieldType: 'keyword', evidence: 'mapped', origin: 'source',
  operation: 'exclude', value: '"blocked"' };

function initial(document = source): QueryFilterDraft {
  return { source: structuredClone(document), snapshot: createSnapshot(document, 'request', at), endpoint,
    filters: [structuredClone(n), structuredClone(status)],
    composition: { mode: 'any', groups: [
      { id: 'first', mode: 'any', filterIds: ['n'] }, { id: 'second', mode: 'all', filterIds: ['status'] },
    ] } };
}
function patchDocument(document: QueryDocument, patch: QueryDocumentPatch) {
  const workspace: WorkspaceState = { activeConnectionId: document.connectionId, activeTabId: document.id,
    tabs: [{ kind: 'query', document }], lastTabByConnection: {} };
  return updateWorkspaceDocument(workspace, document.id, patch).tabs[0]!.document;
}
function commit(draft: QueryFilterDraft) {
  const preview = previewQueryFilterDraft(draft, catalog, mapping);
  if (!preview.ok) throw new Error(preview.code);
  const applied = patchDocument(draft.source, preview.patch);
  const binding = bindAppliedQueryFilters(draft, applied, catalog, mapping);
  if (!binding) throw new Error('binding');
  return binding;
}
function edit(binding: QueryFilterBinding): QueryFilterDraft {
  return { source: structuredClone(binding.applied), snapshot: binding.snapshot, endpoint: binding.endpoint,
    filters: structuredClone(binding.filters), composition: structuredClone(binding.composition), binding };
}
function disabled(draft: QueryFilterDraft): QueryFilterDraft {
  return { ...draft, filters: draft.filters.map((filter) => ({ ...filter, enabled: false })) };
}

describe('explicit applied filter session bindings', () => {
  it('retains independent, deeply frozen baseline, applied document, observation and definitions', () => {
    const draft = initial();
    const binding = commit(draft);
    expect(binding.baseline).toEqual(draft.source);
    expect(binding.baseline).not.toBe(draft.source);
    expect(binding.applied).not.toBe(draft.source);
    expect(binding.snapshot).not.toBe(draft.snapshot);
    expect(binding.filters).not.toBe(draft.filters);
    expect(binding.composition!.groups[0]!.filterIds).not.toBe(draft.composition!.groups[0]!.filterIds);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.applied.parameters!.definitions)).toBe(true);
    expect(Object.isFrozen(binding.composition!.groups[0]!.filterIds)).toBe(true);
    draft.source.dsl = '{}';
    draft.source.parameters = { ...draft.source.parameters!, template: '{}' };
    expect(binding.baseline.dsl).toBe(source.dsl);
    expect(binding.baseline.parameters!.template).toBe(source.parameters!.template);
    expect(matchesQueryFilterBinding(binding, binding.applied, endpoint)).toBe(true);
    expect(queryFilterDraftChanged(edit(binding))).toBe(false);
  });

  it('repeatedly replaces only its own contribution and restores exact original text without wrapper growth', () => {
    let binding = commit(initial());
    const appliedText = binding.applied.dsl;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const inactive = disabled(edit(binding));
      const preview = previewQueryFilterDraft(inactive);
      expect(preview).toEqual({ ok: true, dsl: source.dsl, patch: { dsl: source.dsl } });
      binding = commit(inactive);
      expect(binding.applied.dsl).toBe(source.dsl);
      expect(binding.filters).toHaveLength(2);
      expect(queryFilterDraftChanged(edit(binding))).toBe(false);
      binding = commit({ ...edit(binding), filters: binding.filters.map((filter) => ({ ...filter, enabled: true })) });
      expect(binding.applied.dsl).toBe(appliedText);
      expect(binding.baseline.dsl).toBe(source.dsl);
      expect(binding.applied.parameters).toEqual(source.parameters);
    }
    expect(appliedText).toContain('"n": 9007199254740993');
    expect(appliedText).toContain('"boost": 1.2300e+2');
    expect(appliedText).toContain('"status": "\\u0061"');
    expect(JSON.parse(appliedText).query.bool.must[0]).toEqual(JSON.parse(source.dsl).query);
    expect(JSON.parse(appliedText).post_filter).toEqual(JSON.parse(source.dsl).post_filter);
  });

  it('retains mixed disabled definitions on the first application and rechecks evidence before enabling', () => {
    const first = initial();
    const binding = commit({ ...first, filters: [n, { ...status, enabled: false }] });
    expect(binding.filters[1]).toEqual({ ...status, enabled: false });
    expect(binding.composition).toEqual(first.composition);
    const draft = edit(binding);
    const enabled = { ...draft, filters: [n, { ...status, enabled: true }] };
    const onlyN = { ...catalog, fields: catalog.fields.filter((field) => field.name === 'n') };
    expect(previewQueryFilterDraft(draft, onlyN).ok).toBe(true);
    expect(previewQueryFilterDraft(enabled, onlyN)).toEqual({ ok: false, code: 'fieldMissing' });
    expect(previewQueryFilterDraft(enabled, catalog).ok).toBe(true);
    expect(bindAppliedQueryFilters(enabled, binding.applied, catalog)).toBeNull();
  });

  it('can remove the last definition only through a bound baseline review, and keeps that pending state blocking', () => {
    const binding = commit(initial());
    const empty: QueryFilterDraft = { ...edit(binding), filters: [], composition: { mode: 'all', groups: [] } };
    expect(hasPendingQueryFilters(empty)).toBe(true);
    expect(queryFilterDraftChanged(empty)).toBe(true);
    expect(previewQueryFilterDraft(empty)).toEqual({ ok: true, dsl: source.dsl, patch: { dsl: source.dsl } });
    expect(bindAppliedQueryFilters(empty, source)).toBeNull();
    expect(previewQueryFilterDraft({ ...empty, composition: binding.composition })).toEqual({ ok: false, code: 'invalidComposition' });
    expect(previewQueryFilterDraft({ ...empty, binding: undefined })).toEqual({ ok: false, code: 'empty' });
    expect(queryFilterDraftChanged(disabled(initial()))).toBe(false);
    expect(bindAppliedQueryFilters(disabled(initial()), source)).toBeNull();
    expect(hasPendingQueryFilters(disabled(initial()))).toBe(true);
    expect(hasPendingQueryFilters({ ...initial(), filters: [] })).toBe(false);
  });

  it('allows explicit session-only group edits while all disabled, without revising or reformatting DSL', () => {
    const binding = commit(disabled(edit(commit(initial()))));
    const draft = edit(binding);
    const changed: QueryFilterDraft = { ...draft, composition: { ...draft.composition!, mode: 'all' } };
    expect(queryFilterDraftChanged(changed)).toBe(true);
    const updated = commit(changed);
    expect(updated.applied.dsl).toBe(binding.applied.dsl);
    expect(updated.applied.revision).toBe(binding.applied.revision);
    expect(updated.composition!.mode).toBe('all');
    expect(binding.composition!.mode).toBe('any');
  });

  it.each([
    { dsl: '{}' }, { dsl: source.dsl }, { index: 'other' }, { name: 'Renamed' },
    { parameters: { ...source.parameters!, template: '{}' } },
  ])('refuses later draft edits without discarding or overwriting them: %j', (patch) => {
    const binding = commit(initial());
    const current = patchDocument(binding.applied, patch);
    expect(matchesQueryDraft(current, binding.applied)).toBe(false);
    expect(matchesQueryFilterBinding(binding, current, endpoint)).toBe(false);
    expect(previewQueryFilterDraft({ ...disabled(edit(binding)), source: current }, catalog))
      .toEqual({ ok: false, code: 'filterBindingChanged' });
    expect(previewQueryFilterDraft({ ...edit(binding), source: current, filters: [] }, catalog))
      .toEqual({ ok: false, code: 'filterBindingChanged' });
    expect(current.dsl).toBe(patch.dsl ?? binding.applied.dsl);
  });

  it('guards connection, endpoint, closed document and binding identity, but permits result-view changes', () => {
    const binding = commit(initial());
    expect(matchesQueryFilterBinding(binding, { ...binding.applied, connectionId: 'other' }, endpoint)).toBe(false);
    expect(matchesQueryFilterBinding(binding, undefined, endpoint)).toBe(false);
    expect(matchesQueryFilterBinding(binding, binding.applied, 'https://other.test')).toBe(false);
    expect(matchesQueryFilterBinding(binding, binding.applied, null)).toBe(false);
    const jsonView = patchDocument(binding.applied, { resultView: 'json' });
    expect(matchesQueryFilterBinding(binding, jsonView, endpoint)).toBe(true);
    const copied = structuredClone(binding);
    expect(matchesQueryFilterBinding(copied, copied.applied, endpoint)).toBe(false);
    expect(previewQueryFilterDraft({ ...disabled(edit(binding)), binding: copied }))
      .toEqual({ ok: false, code: 'filterBindingChanged' });
    expect(previewQueryFilterDraft({ ...edit(binding), endpoint: 'https://other.test' }))
      .toEqual({ ok: false, code: 'filterBindingChanged' });
  });

  it('does not reverse-convert lookalike handwritten filters or nested exclusions already in the baseline', () => {
    const original = { ...source, dsl: '{"query":{"bool":{"must":[{"match_all":{}}],"must_not":['
      + '{"nested":{"path":"comments","query":{"term":{"comments.author":"alice"}}}}],"filter":[{"term":{"n":9007199254740995}}]}}}' };
    const draft = { ...initial(original), filters: [n], composition: undefined };
    const binding = commit(draft);
    const removed = previewQueryFilterDraft(disabled(edit(binding)));
    expect(removed).toEqual({ ok: true, dsl: original.dsl, patch: { dsl: original.dsl } });
    expect(binding.baseline.dsl).toBe(original.dsl);
  });

  it.each([source.dsl, '{ "size":25, "sort":[{"n":"desc"}] }'])('preserves time intent/hadQuery and freezes only execution: %s', (dsl) => {
    const base = { ...source, dsl };
    const time = previewTimeRange(base, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, at);
    if (!time.ok) throw new Error(time.code);
    const timed = { ...base, dsl: time.dsl, timeRange: time.timeRange };
    const binding = commit(initial(timed));
    expect(binding.applied.timeRange!.hadQuery).toBe(true);
    const later = createSnapshot(binding.applied, 'later', new Date('2026-10-10T01:00:00.000Z'));
    expect(later.rawDsl).not.toBe(binding.applied.dsl);
    const off = { ...disabled(edit(binding)), snapshot: later };
    const inactive = commit(off);
    expect(inactive.applied.dsl).toBe(timed.dsl);
    expect(inactive.applied.timeRange).toEqual(timed.timeRange);
    expect(removeAppliedTimeRange(inactive.applied)).toBe(dsl);
    expect(freezeTimeRange(inactive.applied, new Date('2026-10-10T02:00:00.000Z')).ok).toBe(true);
    expect(later.rawDsl).toContain('"n": 9007199254740995');
    expect(binding.applied.parameters).toEqual(source.parameters);
    expect(binding.snapshot?.rawDsl).not.toBe(later.rawDsl);
    const changedTime = patchDocument(binding.applied, { timeRange: null });
    expect(matchesQueryFilterBinding(binding, changedTime, endpoint)).toBe(false);
  });

  it('retains nested parent exclusion and group identity across disabled cycles, without empty nested clauses', () => {
    const nested: QueryFilter = { id: 'nested', field: 'comments.author', fieldType: 'keyword', evidence: 'mapped',
      origin: 'input', nestedPath: 'comments', operation: 'exclude', value: '"alice"' };
    const draft: QueryFilterDraft = { ...initial(), filters: [n, nested], composition: { mode: 'any', groups: [
      { id: 'flat', mode: 'all', filterIds: ['n'] },
      { id: 'nested', mode: 'any', filterIds: ['nested'], nested: { path: 'comments', match: 'exclude' } },
    ] } };
    const binding = commit(draft);
    const off = { ...edit(binding), filters: [n, { ...nested, enabled: false }] };
    const inactive = commit(off);
    expect(inactive.applied.dsl).not.toContain('"nested"');
    expect(inactive.composition).toEqual(binding.composition);
    expect(previewQueryFilterDraft({ ...edit(inactive), filters: [n, nested] }, catalog))
      .toEqual({ ok: false, code: 'mappingUnchecked' });
    expect(commit({ ...edit(inactive), filters: [n, nested] }).applied.dsl).toBe(binding.applied.dsl);
  });

  it('retains the observed index snapshot through explicit same-target query creation, without forging execution identity', () => {
    const draft = initial();
    const preview = previewQueryFilterDraft(draft, catalog);
    if (!preview.ok) throw new Error(preview.code);
    const applied = { ...patchDocument(source, preview.patch), id: 'new-query', revision: 0 };
    const binding = bindAppliedQueryFilters(draft, applied, catalog);
    if (!binding) throw new Error('binding');
    expect(binding.baseline.id).toBe(source.id);
    expect(binding.applied.id).toBe('new-query');
    expect(binding.snapshot?.queryId).toBe(source.id);
    expect(queryFilterEvidenceSource(edit(binding))).toBe(binding.baseline);
    expect(previewQueryFilterDraft(disabled(edit(binding))).ok).toBe(true);
    const nextSnapshot = createSnapshot(applied, 'new-query-run', at);
    const next = { ...disabled(edit(binding)), snapshot: nextSnapshot };
    expect(queryFilterEvidenceSource(next)).toBe(next.source);
    expect(previewQueryFilterDraft(next).ok).toBe(true);
    expect(previewQueryFilterDraft({ ...next, snapshot: { ...nextSnapshot, queryId: 'unrelated' } }))
      .toEqual({ ok: false, code: 'targetChanged' });
    expect(bindAppliedQueryFilters(draft, { ...applied, connectionId: 'other' }, catalog)).toBeNull();
    expect(bindAppliedQueryFilters(draft, { ...applied, index: 'other' }, catalog)).toBeNull();
    expect(bindAppliedQueryFilters(draft, { ...applied, dsl: '{}' }, catalog)).toBeNull();
  });

  it('rejects changed runtime declarations from a later execution instead of reusing old source values', () => {
    const runtimeSource = { ...source, dsl: '{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(1);"}}},"fields":["n"]}' };
    const binding = commit({ ...initial(runtimeSource), filters: [{ ...n, evidence: 'runtime', origin: 'fields' }], composition: undefined });
    const snapshot = createSnapshot(binding.applied, 'later', at);
    expect(previewQueryFilterDraft({ ...edit(binding), snapshot: { ...snapshot, rawDsl: snapshot.rawDsl.replace('emit(1)', 'emit(2)') } }, catalog))
      .toEqual({ ok: false, code: 'runtimeChanged' });
    const inactive = commit(disabled(edit(binding)));
    expect(inactive.filters[0]!.origin).toBe('fields');
    expect(inactive.applied.dsl).toBe(runtimeSource.dsl);
  });

  it('retains the newer checked observation when adding runtime conditions after a later execution', () => {
    const executed = { ...source, dsl: '{"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(1);"}}},"fields":["n"]}' };
    const current = { ...executed, dsl: executed.dsl.replace('emit(1)', 'emit(2)') };
    const first: QueryFilterDraft = { source: current, snapshot: createSnapshot(executed, 'old', at), endpoint, filters: [status] };
    const binding = commit(first);
    const snapshot = createSnapshot(binding.applied, 'newer', at);
    const updated = commit({ ...edit(binding), snapshot, filters: [status, { ...n, evidence: 'runtime', origin: 'fields' }] });
    expect(updated.snapshot?.requestId).toBe('newer');
    expect(previewQueryFilterDraft(edit(updated), catalog).ok).toBe(true);
    expect(binding.snapshot?.requestId).toBe('old');
    expect(binding.snapshot?.rawDsl).toContain('emit(1)');
  });

  it.each([null, [], {}, { mode: 'all', groups: [], unknown: true }])('rejects malformed empty-removal composition without throwing: %j', (composition) => {
    const binding = commit(initial());
    expect(previewQueryFilterDraft({ ...edit(binding), filters: [], composition: composition as unknown as QueryFilterComposition }))
      .toEqual({ ok: false, code: 'invalidComposition' });
  });
});

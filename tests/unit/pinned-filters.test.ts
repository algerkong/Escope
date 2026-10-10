import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/pinned-filters-v1.json';
import {
  MAX_PINNED_FILTERS, MAX_PINNED_FILTERS_BYTES, draftFromPinnedFilters, emptyPinnedFilters,
  parsePinnedFilterDefinition, parsePinnedFilterLibrary, parsePinnedFilterRecord, pinFilterDefinition,
} from '../../src/domain/pinned-filters';
import { createQuery, createSnapshot, createWorkspace, updateWorkspaceDocument } from '../../src/domain/query';
import { bindAppliedQueryFilters, matchesQueryFilterBinding, previewQueryFilterDraft, queryFilterDraftChanged } from '../../src/domain/query-filter-session';
import { parseFieldCaps } from '../../src/domain/resource';
import { previewTimeRange } from '../../src/domain/query-time-range';
import { recoveryWorkspace, parseRecoveryDocument } from '../../src/domain/workspace-recovery';

const definition = parsePinnedFilterDefinition(fixture.entries[0])!;
const source = { ...createQuery(definition.connectionId, 'table'), index: definition.index,
  dsl: '{"query":{"bool":{"should":[{"term":{"original":9007199254740995}}]}},"sort":["_score"],"size":25}' };
const fields = parseFieldCaps('{"indices":["orders-1"],"fields":{"status":{"keyword":{"searchable":true}},"amount":{"long":{"searchable":true}}}}');
if (!fields.ok) throw new Error('Invalid fixture');
const catalog = fields.value;
const draft = () => draftFromPinnedFilters(definition, source, 'https://fixture.test')!;

describe('bounded pinned filter definitions', () => {
  it('parses the shared v1 contract with exact tokens, booleans, groups and detached copies', () => {
    expect(parsePinnedFilterLibrary(fixture)).toEqual(fixture);
    expect(parsePinnedFilterLibrary(fixture)).not.toBe(fixture);
    expect(parsePinnedFilterRecord({ revision: 0, library: emptyPinnedFilters() })).not.toBeNull();
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(parsePinnedFilterRecord({ revision, library: fixture })).toBeNull();
    }
    const copy = parsePinnedFilterLibrary(fixture)!;
    Object.assign(copy.entries[0]!.filters[0]!, { value: '"mutated"' });
    expect(definition.filters[0]!.value).toBe('"r\\u0065ady"');
  });

  it.each(['snapshot', 'binding', 'endpoint', 'headers', 'runtimeFields', 'rawResponse', 'dsl', 'parameters'])(
    'rejects unknown persisted %s rather than silently dropping it', (key) => {
      expect(parsePinnedFilterLibrary({ ...fixture, [key]: {} })).toBeNull();
      expect(parsePinnedFilterDefinition({ ...definition, [key]: {} })).toBeNull();
      const filters = definition.filters.map((filter, index) => index ? filter : { ...filter, [key]: {} });
      expect(parsePinnedFilterDefinition({ ...definition, filters })).toBeNull();
    });

  it('rejects newer versions, malformed states, duplicates, dotted fields and nested groups including disabled entries', () => {
    expect(parsePinnedFilterLibrary({ ...fixture, version: 4 })).toBeNull();
    for (const patch of [
      { id: '' }, { name: ' bad' }, { name: 'x'.repeat(121) }, { connectionId: null }, { index: 'remote:orders' },
      { filters: [] }, { composition: null },
      { composition: { mode: 'all', groups: [] } },
      { composition: { ...definition.composition, groups: [{ id: 'g', mode: 'all', filterIds: ['status'], nested: { path: 'x', match: 'include' } }] } },
    ]) expect(parsePinnedFilterDefinition({ ...definition, ...patch })).toBeNull();
    for (const patch of [
      { enabled: undefined }, { enabled: 'false' }, { enabled: null }, { enabled: 0 }, { field: 'a.b' }, { field: '$param' },
      { evidence: 'mapped' }, { origin: 'source' }, { nestedPath: 'comments' }, { fieldType: 'nested' }, { operation: ['include'] },
      { value: '{}' }, { value: '[]' }, { value: 'null' }, { value: 'true' }, { value: '"x"' + ' '.repeat(4096) },
    ]) expect(parsePinnedFilterDefinition({ ...definition, filters: definition.filters.map((filter, index) => index ? filter : { ...filter, ...patch }) })).toBeNull();
    const duplicate = { ...definition.filters[0]!, id: 'note', enabled: false };
    expect(parsePinnedFilterDefinition({ ...definition, filters: [definition.filters[0]!, definition.filters[1]!, duplicate, definition.filters[3]!] })).toBeNull();
  });

  it.each([
    ['long', '9007199254740993', true], ['long', '9.007199254740993e15', true], ['long', '9223372036854775808', false],
    ['long', '1.1', false], ['long', '-9223372036854775808', true], ['byte', '127.00', true], ['byte', '128', false],
    ['unsigned_long', '18446744073709551615', true], ['unsigned_long', '-1', false], ['double', '1e309', false],
    ['double', '1e-999', true], ['boolean', 'true', true], ['boolean', '1', false], ['date', '"2026-10-10"', false],
    ['text', '" "', false], ['keyword', '""', true], ['long', '0e9999999999999999999999999999', true],
  ])('validates %s %s without numeric coercion', (fieldType, value, valid) => {
    const changed = structuredClone(definition);
    Object.assign(changed.filters[0]!, { fieldType, value });
    expect(parsePinnedFilterDefinition(changed) !== null).toBe(valid);
  });

  it('bounds total bytes, entries, filters and groups without truncation', () => {
    const entries = Array.from({ length: MAX_PINNED_FILTERS }, (_, index) => ({ ...definition, id: `set-${index}` }));
    expect(parsePinnedFilterLibrary({ version: 1, entries })).not.toBeNull();
    expect(parsePinnedFilterLibrary({ version: 1, entries: [...entries, { ...definition, id: 'extra' }] })).toBeNull();
    expect(parsePinnedFilterLibrary({ version: 1, entries: [definition, definition] })).toBeNull();
    const large = { version: 1, entries: entries.map((entry) => ({ ...entry,
      filters: entry.filters.map((filter, index) => index ? filter : { ...filter, value: JSON.stringify('"'.repeat(1900)) }) })) };
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(MAX_PINNED_FILTERS_BYTES);
    expect(parsePinnedFilterLibrary(large)).toBeNull();
    expect(parsePinnedFilterDefinition({ ...definition, filters: Array(33).fill(definition.filters[0]) })).toBeNull();
    expect(parsePinnedFilterDefinition({ ...definition, composition: { mode: 'all', groups: Array(9).fill(definition.composition.groups[0]) } })).toBeNull();
  });

  it('requires each member exactly once and rejects unknown group flags', () => {
    for (const filterIds of [[], ['status'], ['status', 'status', 'amount', 'note', 'date'], ['status', 'amount', 'note', 'date', 'unknown']]) {
      expect(parsePinnedFilterDefinition({ ...definition, composition: { mode: 'all', groups: [{ id: 'g', mode: 'any', filterIds }] } })).toBeNull();
    }
    for (const extra of [{ minimum_should_match: 2 }, { enabled: false }, { not: true }]) {
      expect(parsePinnedFilterDefinition({ ...definition, composition: { ...definition.composition, ...extra } })).toBeNull();
    }
  });
});

describe('saved literals versus execution values', () => {
  it('loads only the exact stable target, with no snapshot or binding, leaving source and storage untouched', () => {
    expect(draftFromPinnedFilters(definition, { ...source, connectionId: 'another' }, 'https://fixture.test')).toBeNull();
    expect(draftFromPinnedFilters(definition, { ...source, index: 'orders-1' }, 'https://fixture.test')).toBeNull();
    const pending = draft();
    expect(pending.snapshot).toBeNull();
    expect(pending.binding).toBeUndefined();
    expect(pending.filters.every((filter) => filter.origin === 'saved' && filter.evidence === 'mapped')).toBe(true);
    expect(pending.source).toEqual(source);
    expect(pending.source).not.toBe(source);
    expect(pending.composition).toEqual(definition.composition);
  });

  it('requires current evidence on enabled conditions, preserves exact values and original should scoring', () => {
    expect(previewQueryFilterDraft(draft())).toEqual({ ok: false, code: 'fieldUnchecked' });
    const result = previewQueryFilterDraft(draft(), catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dsl).toContain('9007199254740993');
    expect(result.dsl).toContain('9007199254740995');
    expect(result.dsl).toContain('r\\u0065ady');
    const body = JSON.parse(result.dsl);
    expect(body.query.bool.must[0]).toEqual(JSON.parse(source.dsl).query);
    expect(body.query.bool.filter[0].bool.minimum_should_match).toBe(1);
    expect(body.sort).toEqual(['_score']);
    expect(result.dsl).not.toContain('customer note');
    const enabled = { ...draft(), filters: draft().filters.map((filter) => ({ ...filter, enabled: true })) };
    expect(previewQueryFilterDraft(enabled, catalog)).toEqual({ ok: false, code: 'fieldMissing' });
  });

  it('refuses runtime shadowing, conflicting evidence or non-literal definitions without an actual observation', () => {
    const changed = { ...source, dsl: '{"runtime_mappings":{"status":{"type":"keyword"}}}' };
    expect(previewQueryFilterDraft(draftFromPinnedFilters(definition, changed, 'https://fixture.test')!, catalog))
      .toEqual({ ok: false, code: 'savedFilterUnsupported' });
    expect(previewQueryFilterDraft({ ...draft(), filters: draft().filters.map((filter) => ({ ...filter, origin: 'source' })) }, catalog))
      .toEqual({ ok: false, code: 'targetChanged' });
    const conflict = { ...catalog, fields: catalog.fields.map((field) => ({ ...field, conflict: true })) };
    expect(previewQueryFilterDraft(draft(), conflict)).toEqual({ ok: false, code: 'fieldConflict' });
    const runtime = { ...draft(), filters: draft().filters.map((filter) => ({ ...filter, evidence: 'runtime' as const, enabled: false })) };
    expect(previewQueryFilterDraft(runtime, catalog)).toEqual({ ok: false, code: 'savedFilterUnsupported' });
  });

  it('saves the entire set or rejects it, never serializes a binding or silently removes runtime/invalid nested', () => {
    const pinned = pinFilterDefinition(draft(), 'copy', 'Copy');
    expect(pinned.ok).toBe(true);
    if (pinned.ok) {
      expect(pinned.definition).toEqual({ ...definition, id: 'copy', name: 'Copy' });
      expect(Object.keys(pinned.definition)).toEqual(['id', 'name', 'connectionId', 'index', 'filters', 'composition']);
    }
    for (const [patch, code] of [
      [{ evidence: 'runtime', origin: 'fields' }, 'unsupported'], [{ nestedPath: 'comments', origin: 'input' }, 'invalid'],
    ] as const) {
      const filters = draft().filters.map((filter, index) => index === 2 ? { ...filter, ...patch, enabled: false } : filter);
      expect(pinFilterDefinition({ ...draft(), filters } as ReturnType<typeof draft>, 'copy', 'Copy')).toEqual({ ok: false, code });
    }
  });

  it('binds only after review, permits later disable/remove from exact baseline and never restores deserialized trust', () => {
    const pending = draft();
    const result = previewQueryFilterDraft(pending, catalog);
    if (!result.ok) throw new Error(result.code);
    const applied = { ...source, dsl: result.dsl, revision: 1 };
    const binding = bindAppliedQueryFilters(pending, applied, catalog)!;
    expect(binding.snapshot).toBeNull();
    expect(Object.isFrozen(binding.filters[0])).toBe(true);
    expect(matchesQueryFilterBinding(binding, applied, pending.endpoint)).toBe(true);
    expect(matchesQueryFilterBinding(structuredClone(binding), applied, pending.endpoint)).toBe(false);
    const editing = { source: applied, snapshot: null, endpoint: pending.endpoint, binding,
      filters: binding.filters.map((filter) => ({ ...filter, enabled: false })), composition: binding.composition };
    expect(queryFilterDraftChanged(editing)).toBe(true);
    expect(previewQueryFilterDraft(editing).ok && previewQueryFilterDraft(editing)).toMatchObject({ dsl: source.dsl });
    expect(previewQueryFilterDraft({ ...editing, source: { ...applied, revision: 2 } }, catalog)).toEqual({ ok: false, code: 'filterBindingChanged' });
    expect(previewQueryFilterDraft({ ...editing, filters: [], composition: { mode: 'all', groups: [] } }, catalog)).toMatchObject({ dsl: source.dsl });
  });

  it('retains real later observations after a literal-only index-to-query binding without changing the baseline identity', () => {
    const pending = draft();
    const preview = previewQueryFilterDraft(pending, catalog);
    if (!preview.ok) throw new Error(preview.code);
    const applied = { ...createQuery(source.connectionId), index: source.index, dsl: preview.dsl };
    const initial = bindAppliedQueryFilters(pending, applied, catalog)!;
    expect(initial.snapshot).toBeNull();
    expect(initial.baseline.id).toBe(source.id);
    const snapshot = createSnapshot(applied, 'real-first', new Date('2026-10-10T00:00:00Z'));
    const editing = { source: applied, endpoint: pending.endpoint, binding: initial, snapshot,
      filters: [...initial.filters, { id: 'new-cell', field: 'status', fieldType: 'keyword', evidence: 'mapped' as const,
        origin: 'source' as const, operation: 'exclude' as const, value: '"blocked"' }],
      composition: { mode: 'all' as const, groups: [{ id: 'g', mode: 'all' as const, filterIds: [...initial.filters.map((filter) => filter.id), 'new-cell'] }] } };
    const next = previewQueryFilterDraft(editing, catalog);
    if (!next.ok) throw new Error(next.code);
    const nextDocument = { ...applied, dsl: next.dsl, revision: 1 };
    const binding = bindAppliedQueryFilters(editing, nextDocument, catalog)!;
    expect(binding.snapshot).toEqual(snapshot);
    expect(binding.snapshot?.queryId).toBe(applied.id);
    expect(binding.baseline.id).toBe(source.id);
    const latest = createSnapshot(nextDocument, 'real-second', new Date('2026-10-10T00:01:00Z'));
    const edit = { ...editing, source: nextDocument, binding, snapshot: latest,
      filters: editing.filters.map((filter) => ({ ...filter, enabled: false })) };
    expect(previewQueryFilterDraft(edit, catalog)).toMatchObject({ ok: true, dsl: source.dsl });
    const disabled = bindAppliedQueryFilters(edit, { ...nextDocument, dsl: source.dsl, revision: 2 }, catalog)!;
    expect(disabled.snapshot?.requestId).toBe('real-second');
    expect(disabled.baseline.id).toBe(source.id);
    expect(initial.snapshot).toBeNull();
  });

  it('preserves time intent and parameters, while ordinary recovery contains only the applied DSL', () => {
    const timed = previewTimeRange(source, { field: 'created', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, new Date('2026-10-10T00:00:00Z'));
    if (!timed.ok) throw new Error(timed.code);
    const timedSource = { ...source, dsl: timed.dsl, timeRange: timed.timeRange };
    const pending = draftFromPinnedFilters(definition, timedSource, 'https://fixture.test')!;
    const result = previewQueryFilterDraft(pending, catalog);
    if (!result.ok) throw new Error(result.code);
    expect(result.patch.timeRange).toEqual(timed.timeRange);
    const initial = createWorkspace(source.connectionId);
    const workspace = { ...initial, tabs: [{ ...initial.tabs[0]!, document: timedSource }], activeTabId: source.id };
    const updated = updateWorkspaceDocument(workspace, source.id, result.patch);
    const saved = { version: 1, workspace: recoveryWorkspace(updated), history: [] };
    expect(parseRecoveryDocument(saved)).not.toBeNull();
    const raw = JSON.stringify(saved);
    expect(raw).not.toContain('"origin":"saved"');
    expect(raw).not.toContain('"filters":[');
    expect(updated.tabs[0]!.document.dsl).toBe(result.dsl);
  });
});

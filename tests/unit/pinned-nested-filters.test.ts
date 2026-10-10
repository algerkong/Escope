import { describe, expect, it } from 'vitest';
import legacy from '../fixtures/pinned-filters-v1.json';
import fixture from '../fixtures/pinned-filters-v2.json';
import {
  MAX_PINNED_FILTERS_BYTES, draftFromPinnedFilters, parsePinnedFilterDefinition, parsePinnedFilterLibrary, pinFilterDefinition,
} from '../../src/domain/pinned-filters';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { parseNestedFilterMapping } from '../../src/domain/query-filter-mapping';
import {
  bindAppliedQueryFilters, matchesQueryFilterBinding, previewQueryFilterDraft,
} from '../../src/domain/query-filter-session';
import { previewQueryFilters, type QueryFilterDraft } from '../../src/domain/query-filters';
import { parseFieldCaps } from '../../src/domain/resource';
import { freezeTimeRange, previewTimeRange, removeAppliedTimeRange } from '../../src/domain/query-time-range';

const definition = parsePinnedFilterLibrary(fixture)!.entries[0]!;
const source = { ...createQuery(definition.connectionId), index: definition.index,
  dsl: '{"query":{"bool":{"should":[{"term":{"original":9007199254740995}}],"minimum_should_match":"75%"}},"sort":["_score"],"size":25}' };
const at = new Date('2026-10-10T00:00:00Z');
const rawMapping = { events: { mappings: { properties: {
  status: { type: 'keyword' }, comments: { type: 'nested', properties: { author: { type: 'keyword' }, n: { type: 'long' } } },
} } } };
const proof = parseNestedFilterMapping(JSON.stringify(rawMapping));
const parsed = parseFieldCaps('{"indices":["events"],"fields":{"status":{"keyword":{"searchable":true}},"comments.author":{"keyword":{"searchable":true}},"comments.n":{"long":{"searchable":true}}}}');
if (!parsed.ok) throw new Error('fixture');
const catalog = parsed.value;
const pending = () => draftFromPinnedFilters(definition, source, 'https://fixture.test')!;

describe('versioned mapped nested pinned definitions', () => {
  it('keeps v1 intact, accepts v2 and never silently upgrades or partially decodes unknown records', () => {
    expect(parsePinnedFilterLibrary(legacy)).toEqual(legacy);
    expect(parsePinnedFilterLibrary(fixture)).toEqual(fixture);
    expect(parsePinnedFilterLibrary({ version: 2, entries: [...legacy.entries, ...fixture.entries] }))
      .toEqual({ version: 2, entries: [...legacy.entries, ...fixture.entries] });
    expect(parsePinnedFilterLibrary({ ...fixture, version: 1 })).toBeNull();
    expect(parsePinnedFilterDefinition(definition, 1)).toBeNull();
    for (const version of [0, 4, null, '2', 2.1]) expect(parsePinnedFilterLibrary({ ...fixture, version })).toBeNull();
    const copy = parsePinnedFilterLibrary(fixture)!;
    Object.assign(copy.entries[0]!.composition.groups[1]!.nested!, { match: 'exclude' });
    Object.assign(copy.entries[0]!.filters[1]!, { nestedPath: 'other' });
    expect(parsePinnedFilterLibrary(fixture)!.entries[0]).toEqual(definition);
  });

  it.each([
    { nestedPath: null }, { nestedPath: undefined }, { nestedPath: ['comments'] }, { nestedPath: '' },
    { nestedPath: 'comments.author' }, { nestedPath: 'comments[0]' }, { nestedPath: 'comments/child' },
    { nestedPath: '_comments' }, { nestedPath: '$param' }, { nestedPath: 'other' },
    { field: 'comments.author.name' }, { field: 'comments.' }, { field: 'comments.author[0]' },
    { field: 'comments.$param' }, { field: 'comments._id' }, { field: 'comments.author/name' },
    { field: `comments.${'x'.repeat(1024)}` }, { fieldType: 'nested' }, { origin: 'saved' },
    { evidence: 'runtime' }, { runtime_mappings: {} }, { value: '{}' }, { value: '[]' }, { value: 'null' },
  ])('rejects malformed or unsupported nested leaf data, even when disabled: %j', (patch) => {
    const copy = structuredClone(definition);
    Object.assign(copy.filters[1]!, { enabled: false, ...patch });
    expect(parsePinnedFilterDefinition(copy)).toBeNull();
  });

  it.each([
    null, undefined, [], {}, { path: 'comments', match: ['include'] }, { path: 'comments', match: 'all' },
    { path: 'comments.author', match: 'include' }, { path: 'other', match: 'include' },
    { path: 'comments', match: 'include', score_mode: 'avg' },
    { path: 'comments', match: 'exclude', ignore_unmapped: true },
    { path: 'comments', match: 'exclude', minimum_should_match: 2 },
  ])('rejects invalid group scopes rather than silently losing parent semantics: %j', (nested) => {
    const copy = structuredClone(definition);
    Object.assign(copy.composition.groups[1]!, { nested });
    expect(parsePinnedFilterDefinition(copy)).toBeNull();
  });

  it('allows the same nested literal in separate existential groups but rejects same-group duplicates and mixed paths', () => {
    expect(parsePinnedFilterDefinition(definition)).not.toBeNull();
    const copy = structuredClone(definition);
    Object.assign(copy.filters[3]!, { enabled: false });
    Object.assign(copy.composition.groups[1]!, { filterIds: ['author', 'n', 'other-author'] });
    Object.assign(copy.composition.groups[2]!, { filterIds: ['missing'] });
    expect(parsePinnedFilterDefinition(copy)).toBeNull();
    for (const filterIds of [['status', 'n'], ['author', 'tag'], ['author', 'author'], ['author', 'absent']]) {
      const copy = structuredClone(definition);
      Object.assign(copy.composition.groups[1]!, { filterIds });
      expect(parsePinnedFilterDefinition(copy)).toBeNull();
    }
    const unscoped = structuredClone(definition);
    delete (unscoped.filters[1] as { nestedPath?: string }).nestedPath;
    expect(parsePinnedFilterDefinition(unscoped)).toBeNull();
  });

  it('pins every authored scope and disabled definition, while refusing runtime or unscoped partial saves', () => {
    const draft: QueryFilterDraft = { ...pending(), snapshot: createSnapshot(source, 'real', at),
      filters: pending().filters.map((filter) => ({ ...filter, origin: filter.nestedPath ? 'input' : 'source' })) };
    expect(pinFilterDefinition(draft, definition.id, definition.name)).toEqual({ ok: true, definition });
    expect(pinFilterDefinition({ ...draft, composition: undefined }, 'copy', 'Copy')).toEqual({ ok: false, code: 'invalid' });
    const runtime = { ...draft, filters: draft.filters.map((filter, index) => index === 5
      ? { ...filter, evidence: 'runtime' as const, origin: 'fields' as const, enabled: false } : filter) };
    expect(pinFilterDefinition(runtime, 'copy', 'Copy')).toEqual({ ok: false, code: 'unsupported' });
  });

  it('retains all count and serialized byte bounds for v2, including disabled nested values', () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ ...definition, id: `set-${index}` }));
    expect(parsePinnedFilterLibrary({ version: 2, entries })).not.toBeNull();
    expect(parsePinnedFilterLibrary({ version: 2, entries: [...entries, { ...definition, id: 'extra' }] })).toBeNull();
    const large = { version: 2, entries: entries.map((entry) => ({ ...entry,
      filters: entry.filters.map((filter, index) => index === 5 ? { ...filter, value: JSON.stringify('"'.repeat(1000)) } : filter),
    })) };
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(MAX_PINNED_FILTERS_BYTES);
    expect(parsePinnedFilterLibrary(large)).toBeNull();
    expect(parsePinnedFilterDefinition({ ...definition, filters: Array(33).fill(definition.filters[1]) })).toBeNull();
    expect(parsePinnedFilterDefinition({ ...definition,
      composition: { mode: 'all', groups: Array(9).fill(definition.composition.groups[1]) } })).toBeNull();
  });
});

describe('rechecking saved nested literals without fabricated observations', () => {
  it('requires current Mapping and the complete actual field-caps index set', () => {
    const draft = pending();
    expect(draft.snapshot).toBeNull();
    expect(draft.binding).toBeUndefined();
    expect(previewQueryFilterDraft(draft)).toEqual({ ok: false, code: 'fieldUnchecked' });
    expect(previewQueryFilterDraft(draft, catalog)).toEqual({ ok: false, code: 'mappingUnchecked' });
    for (const indices of [[], ['other'], ['events', 'events'], ['events', 'other']]) {
      expect(previewQueryFilterDraft(draft, { ...catalog, indices }, proof)).toEqual({ ok: false, code: 'mappingTargetChanged' });
    }
    const conflict = parseNestedFilterMapping(JSON.stringify({ events: { mappings: { properties: {
      ...rawMapping.events.mappings.properties, comments: { type: 'object', properties: { author: { type: 'keyword' } } },
    } } } }));
    expect(previewQueryFilterDraft(draft, catalog, conflict)).toEqual({ ok: false, code: 'nestedPathConflict' });
    expect(draftFromPinnedFilters(definition, { ...source, connectionId: 'other' }, draft.endpoint)).toBeNull();
    expect(draftFromPinnedFilters(definition, { ...source, index: 'events' }, draft.endpoint)).toBeNull();
  });

  it('compiles identically to explicit input, retaining same-object conjunction, inner negation and branch-local parent exclusion', () => {
    const draft = pending();
    const result = previewQueryFilters(source, null, draft.filters, catalog, draft.composition, proof);
    const authored = previewQueryFilters(source, createSnapshot(source, 'actual', at),
      draft.filters.map((filter) => ({ ...filter, origin: filter.nestedPath ? 'input' : 'source' })), catalog, draft.composition, proof);
    expect(result).toEqual(authored);
    if (!result.ok) throw new Error(result.code);
    expect(result.dsl).toContain('9007199254740993');
    expect(result.dsl).toContain('"a\\u006cice"');
    const query = JSON.parse(result.dsl).query.bool;
    expect(query.must).toEqual([JSON.parse(source.dsl).query]);
    expect(query.must_not).toBeUndefined();
    const or = query.filter[0].bool;
    expect(or.minimum_should_match).toBe(1);
    expect(or.should).toHaveLength(3);
    expect(or.should[1].nested).toMatchObject({ path: 'comments', score_mode: 'none', ignore_unmapped: false,
      query: { bool: { filter: [{ term: { 'comments.author': 'alice' } }] } } });
    expect(result.dsl).toContain('"must_not":[{"term":{"comments.n":9007199254740993}}]');
    expect(or.should[2].bool.must_not[0].nested.query.bool).toEqual({
      should: [{ term: { 'comments.author': 'alice' } }], minimum_should_match: 1,
    });
    expect(result.dsl).not.toContain('"tags"');
    expect(result.dsl).not.toContain('comments.message');
    expect(result.dsl).not.toContain('"snapshot"');
  });

  it.each(['comments', 'comments.author', 'comments.other'])('never substitutes flat runtime evidence at %s', (field) => {
    const runtime = { [field]: { type: 'keyword', script: { source: 'emit("x")' } } };
    const current = { ...source, dsl: JSON.stringify({ runtime_mappings: runtime }) };
    expect(previewQueryFilterDraft(draftFromPinnedFilters(definition, current, pending().endpoint)!, catalog, proof))
      .toEqual({ ok: false, code: 'nestedRuntime' });
    const mapping = parseNestedFilterMapping(JSON.stringify({ events: {
      mappings: { ...rawMapping.events.mappings, runtime },
    } }));
    expect(previewQueryFilterDraft(pending(), catalog, mapping)).toEqual({ ok: false, code: 'nestedRuntime' });
    // Saved literals use current evidence, not an old execution's removed runtime declaration.
    expect(previewQueryFilterDraft({ ...pending(), snapshot: createSnapshot(current, 'earlier', at) }, catalog, proof).ok).toBe(true);
  });

  it('rechecks current types and searchability; disabled fields can stay unavailable until explicitly enabled', () => {
    const changed = (type: string, searchable: boolean) => ({ ...catalog, fields: catalog.fields.map((field) =>
      field.name === 'comments.author' ? { ...field, types: [{ ...field.types[0]!, type, searchable }] } : field) });
    expect(previewQueryFilterDraft(pending(), changed('text', true), proof)).toEqual({ ok: false, code: 'nestedFieldConflict' });
    expect(previewQueryFilterDraft(pending(), changed('keyword', false), proof)).toEqual({ ok: false, code: 'fieldNotSearchable' });
    const draft = pending();
    expect(previewQueryFilterDraft(draft, catalog, proof).ok).toBe(true);
    const enable = (id: string) => ({ ...draft, filters: draft.filters.map((filter) => filter.id === id ? { ...filter, enabled: true } : filter) });
    expect(previewQueryFilterDraft(enable('tag'), catalog, proof)).toEqual({ ok: false, code: 'nestedPathMissing' });
    expect(previewQueryFilterDraft(enable('missing'), catalog, proof)).toEqual({ ok: false, code: 'nestedFieldMissing' });
    expect(previewQueryFilterDraft({ ...draft, filters: draft.filters.map((filter) => ({ ...filter, enabled: false })) }))
      .toMatchObject({ ok: true, dsl: source.dsl });
  });

  it('binds only after review and can disable/remove from the exact baseline without trusting serialized copies', () => {
    const draft = pending();
    const result = previewQueryFilterDraft(draft, catalog, proof);
    if (!result.ok) throw new Error(result.code);
    const applied = { ...source, dsl: result.dsl, revision: source.revision + 1 };
    const binding = bindAppliedQueryFilters(draft, applied, catalog, proof)!;
    expect(binding.snapshot).toBeNull();
    expect(Object.isFrozen(binding.composition!.groups[1]!.nested)).toBe(true);
    expect(matchesQueryFilterBinding(structuredClone(binding), applied, draft.endpoint)).toBe(false);
    const edit = { ...draft, source: applied, binding, filters: draft.filters.map((filter) => ({ ...filter, enabled: false })) };
    expect(previewQueryFilterDraft(edit)).toMatchObject({ ok: true, dsl: source.dsl });
    expect(previewQueryFilterDraft({ ...edit, filters: [], composition: { mode: 'all', groups: [] } }))
      .toMatchObject({ ok: true, dsl: source.dsl });
    expect(previewQueryFilterDraft({ ...edit, source: { ...applied, revision: applied.revision + 1 } }))
      .toEqual({ ok: false, code: 'filterBindingChanged' });
    expect(definition.composition).toEqual(fixture.entries[0]!.composition);
  });

  it('preserves time intent, exact base query, sort and parameter templates across explicit application', () => {
    const base = { ...source, parameters: { version: 1, template: '{"query":{"term":{"status":{"$param":"status"}}}}',
      definitions: [{ name: 'status', type: 'string' as const }] } };
    const time = previewTimeRange(base, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, at);
    if (!time.ok) throw new Error(time.code);
    const timed = { ...base, dsl: time.dsl, timeRange: time.timeRange };
    const draft = draftFromPinnedFilters(definition, timed, pending().endpoint)!;
    const result = previewQueryFilterDraft(draft, catalog, proof);
    if (!result.ok) throw new Error(result.code);
    const applied = { ...timed, dsl: result.dsl, timeRange: result.patch.timeRange ?? undefined };
    expect(applied.parameters).toEqual(base.parameters);
    const frozen = freezeTimeRange(applied, new Date('2026-10-10T01:00:00Z'));
    if (!frozen.ok) throw new Error(frozen.code);
    expect(JSON.parse(frozen.dsl).query.bool.must).toEqual(JSON.parse(result.dsl).query.bool.must);
    expect(JSON.parse(removeAppliedTimeRange(applied)!).query).toEqual(JSON.parse(result.dsl).query.bool.must[0]);
    expect(JSON.parse(result.dsl).sort).toEqual(['_score']);
  });
});

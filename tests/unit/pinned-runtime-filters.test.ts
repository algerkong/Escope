import { describe, expect, it } from 'vitest';
import legacy from '../fixtures/pinned-filters-v1.json';
import nested from '../fixtures/pinned-filters-v2.json';
import fixture from '../fixtures/pinned-filters-v3.json';
import { selectDataView } from '../../src/domain/data-views';
import {
  MAX_PINNED_FILTERS_BYTES, draftFromPinnedFilters, parsePinnedFilterDefinition, parsePinnedFilterLibrary, pinFilterDefinition,
  type PinnedFilterDefinition,
} from '../../src/domain/pinned-filters';
import { createQuery, createSnapshot, createWorkspace, updateWorkspaceDocument } from '../../src/domain/query';
import { parseNestedFilterMapping } from '../../src/domain/query-filter-mapping';
import { bindAppliedQueryFilters, matchesQueryFilterBinding, previewQueryFilterDraft } from '../../src/domain/query-filter-session';
import { createQueryFilter, previewQueryFilters, type QueryFilterDraft } from '../../src/domain/query-filters';
import { freezeTimeRange, previewTimeRange, removeAppliedTimeRange } from '../../src/domain/query-time-range';
import { parseFieldCaps } from '../../src/domain/resource';
import { recoveryWorkspace } from '../../src/domain/workspace-recovery';

// Keep the unparsed fixture available so a rejected v3 reports a test failure, not a collection error.
const definition = fixture.entries[0]! as PinnedFilterDefinition;
const mappings = Object.fromEntries(definition.filters.map((filter) => [filter.field, filter.runtimeMapping]));
const source = { ...createQuery(definition.connectionId), index: definition.index,
  dsl: '{"query":{"bool":{"should":[{"term":{"original":9007199254740993}}],"minimum_should_match":"75%"}},"sort":["_score"],'
    + `"runtime_mappings":${JSON.stringify(mappings)}}` };
const at = new Date('2026-10-10T00:00:00Z');
const pending = (current = source) => draftFromPinnedFilters(definition, current, 'https://fixture.test')!;
const one = (patch = {}): PinnedFilterDefinition => ({ ...definition,
  filters: [{ ...definition.filters[0]!, ...patch }], composition: { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: ['n'] }] } });
function observed(): QueryFilterDraft {
  return { source, endpoint: 'https://fixture.test', snapshot: createSnapshot(source, 'actual', at),
    filters: definition.filters.map((filter) => ({ id: filter.id, field: filter.field, fieldType: filter.fieldType,
      operation: filter.operation, value: filter.value, enabled: filter.enabled, evidence: 'runtime', origin: 'fields' })),
    composition: definition.composition };
}

describe('v3 pinned runtime declarations', () => {
  it('reads all three versions without upgrading or dropping exact script text, literals, language or disabled entries', () => {
    for (const library of [legacy, nested, fixture]) expect(parsePinnedFilterLibrary(library)).toEqual(library);
    const mixed = { version: 3, entries: [...legacy.entries, ...nested.entries, ...fixture.entries] };
    expect(parsePinnedFilterLibrary(mixed)).toEqual(mixed);
    for (const version of [0, 4, '3', null, 3.1]) expect(parsePinnedFilterLibrary({ ...fixture, version })).toBeNull();
    for (const version of [1, 2]) {
      expect(parsePinnedFilterLibrary({ ...fixture, version })).toBeNull();
      expect(parsePinnedFilterDefinition(definition, version)).toBeNull();
    }
    const copy = parsePinnedFilterDefinition(definition)!;
    Object.assign(copy.filters[0]!.runtimeMapping!.script!, { source: 'changed' });
    expect(definition.filters[0]!.runtimeMapping!.script!.source).toBe('emit(9007199254740995L);');
  });

  it.each([
    null, undefined, {}, [], { type: 'long', extra: true }, { type: 'date_nanos' }, { type: 'lookup' },
    { type: 'composite' }, { type: 'long', on_script_error: 'continue' }, { type: 'long', script: null },
    { type: 'long', script: 'emit(1);' }, { type: 'long', script: { id: 'stored' } },
    { type: 'long', script: { source: 'emit(1);', params: {} } },
    { type: 'long', script: { source: 'emit(1);', lang: null } },
    { type: 'long', script: { source: 'emit(1);', lang: 'expression' } },
    { type: 'long', script: { source: ' ' } }, { type: 'long', script: { source: 'emit(1);\u0000' } },
    { type: 'long', script: { source: 'x'.repeat(4097) } }, { type: 'long', script: { source: '\u00e9'.repeat(2049) } },
  ])('rejects malformed declarations even on disabled leaves: %j', (runtimeMapping) => {
    expect(parsePinnedFilterDefinition(one({ runtimeMapping, enabled: false }))).toBeNull();
  });

  it('refuses type mismatches, runtime nested paths, mixed interpretations and different declarations for one field', () => {
    for (const patch of [
      { fieldType: 'keyword' }, { field: 'comments.n', nestedPath: 'comments' }, { field: 'a.b' },
      { runtimeMapping: { type: 'unsigned_long' } }, { origin: 'saved' }, { evidence: 'runtime' },
    ]) expect(parsePinnedFilterDefinition(one(patch))).toBeNull();
    const duplicateField = (runtimeMapping: unknown) => ({
      ...one(), filters: [definition.filters[0], { ...definition.filters[0], id: 'other', operation: 'exclude',
        runtimeMapping, enabled: false }],
      composition: { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: ['n', 'other'] }] },
    });
    expect(parsePinnedFilterDefinition(duplicateField(mappings.n))).not.toBeNull();
    expect(parsePinnedFilterDefinition(duplicateField({ type: 'long' }))).toBeNull();
    const mixed = duplicateField(mappings.n);
    delete (mixed.filters[1] as { runtimeMapping?: unknown }).runtimeMapping;
    expect(parsePinnedFilterDefinition(mixed)).toBeNull();
    for (const type of ['date', 'ip', 'geo_point']) {
      expect(parsePinnedFilterDefinition(one({ fieldType: type, runtimeMapping: { type }, value: '"value"' }))).toBeNull();
      expect(parsePinnedFilterDefinition(one({ fieldType: type, runtimeMapping: { type }, operation: 'exists', value: null }))).not.toBeNull();
    }
    expect(parsePinnedFilterDefinition(one({ fieldType: 'geo_point', runtimeMapping: undefined, operation: 'exists', value: null }))).toBeNull();
  });

  it('counts UTF-8 script bytes, distinct declaration bytes, all leaves, groups and serialized library bytes', () => {
    const fullScript = 'emit(1);' + ' '.repeat(4088);
    expect(parsePinnedFilterDefinition(one({ runtimeMapping: { type: 'long', script: { source: fullScript } } }))).not.toBeNull();
    const many = (count: number, script: string) => {
      const filters = Array.from({ length: count }, (_, index) => ({ ...definition.filters[0]!, id: `f${index}`, field: `f${index}`,
        enabled: false, runtimeMapping: { type: 'long' as const, script: { source: script } } }));
      return { ...definition, filters, composition: { mode: 'all', groups: [{ id: 'g', mode: 'all', filterIds: filters.map((f) => f.id) }] } };
    };
    expect(parsePinnedFilterDefinition(many(32, 'emit(1);'))).not.toBeNull();
    expect(parsePinnedFilterDefinition(many(33, 'emit(1);'))).toBeNull();
    expect(parsePinnedFilterDefinition(many(15, fullScript))).not.toBeNull();
    expect(parsePinnedFilterDefinition(many(16, fullScript))).toBeNull();
    expect(parsePinnedFilterDefinition({ ...one(), composition: { mode: 'all', groups: Array(9).fill(one().composition.groups[0]) } })).toBeNull();
    const entries = Array.from({ length: 100 }, (_, index) => ({ ...one(), id: `set-${index}` }));
    expect(parsePinnedFilterLibrary({ version: 3, entries })).not.toBeNull();
    expect(parsePinnedFilterLibrary({ version: 3, entries: [...entries, { ...one(), id: 'extra' }] })).toBeNull();
    const large = { version: 3, entries: entries.map((entry) => ({ ...entry, filters: many(2, fullScript).filters,
      composition: many(2, fullScript).composition })) };
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(MAX_PINNED_FILTERS_BYTES);
    expect(parsePinnedFilterLibrary(large)).toBeNull();
  });

  it('captures only declarations applied to the actual source, comparing the genuine observation even when disabled', () => {
    expect(pinFilterDefinition(observed(), definition.id, definition.name)).toEqual({ ok: true, definition });
    const changed = { ...source, dsl: source.dsl.replace('emit(9007199254740995L);', 'emit(1);') };
    for (const enabled of [true, false]) {
      expect(pinFilterDefinition({ ...observed(), source: changed, filters: observed().filters.map((filter) => ({ ...filter, enabled })) }, 'copy', 'Copy'))
        .toEqual({ ok: false, code: 'runtimeChanged' });
    }
    expect(pinFilterDefinition({ ...observed(), snapshot: null }, 'copy', 'Copy')).toEqual({ ok: false, code: 'changed' });
    expect(pinFilterDefinition({ ...observed(), snapshot: createSnapshot({ ...source, connectionId: 'other' }, 'wrong', at) }, 'copy', 'Copy'))
      .toEqual({ ok: false, code: 'changed' });
    expect(pinFilterDefinition(pending(), definition.id, definition.name)).toEqual({ ok: true, definition });
    const unapplied = { ...source, dsl: '{"query":{"match_all":{}}}', dataView: selectDataView({
      id: 'view', name: 'View', connectionId: source.connectionId!, index: source.index,
      defaultTimeField: null, runtimeFields: { version: 1, entries: Object.entries(mappings).map(([field, mapping]) => ({ field, ...mapping! })) },
    }) };
    expect(pinFilterDefinition({ ...observed(), source: unapplied }, 'copy', 'Copy')).toEqual({ ok: false, code: 'runtimeChanged' });
  });
});

describe('saved runtime literals remain unobserved and never inject scripts', () => {
  it('uses the current DSL without requiring or fabricating an execution or fields values', () => {
    const draft = pending();
    expect(draft.snapshot).toBeNull();
    expect(draft.binding).toBeUndefined();
    expect(draft.filters.every((filter) => filter.origin === 'saved' && filter.evidence === 'runtime')).toBe(true);
    const result = previewQueryFilterDraft(draft);
    if (!result.ok) throw new Error(result.code);
    expect(result.dsl).toContain('9007199254740995');
    expect(result.dsl).toContain('9007199254740993');
    expect(result.dsl).toContain('1.2300e-8');
    expect(result.dsl).toContain('r\\u0065ady');
    const body = JSON.parse(result.dsl);
    expect(body.runtime_mappings).toEqual(mappings);
    expect(body.fields).toBeUndefined();
    expect(body.query.bool.must).toEqual([JSON.parse(source.dsl).query]);
    expect(body.query.bool.filter[0].bool.minimum_should_match).toBe(1);
    expect(body.sort).toEqual(['_score']);
    expect(source.dsl).not.toContain('"term":{"n":');
  });

  it('matches declaration properties and exact source text, never an old execution or unapplied view definition', () => {
    for (const dsl of [
      '{}', source.dsl.replace('emit(9007199254740995L);', 'emit(1);'),
      source.dsl.replace('"type":"long"', '"type":"double"'),
      source.dsl.replace('"source":"emit(9007199254740995L);"', '"source":"emit(9007199254740995L);","lang":"painless"'),
    ]) {
      const current = { ...source, dsl };
      expect(previewQueryFilterDraft({ ...pending(current), snapshot: createSnapshot(source, 'old', at) }))
        .toEqual({ ok: false, code: 'runtimeChanged' });
    }
    const reordered = { ...source, dsl: source.dsl.replace('"type":"long","script":{"source":"emit(9007199254740995L);"}',
      '"script": { "source": "emit(9007199254740995L);" }, "type": "long"') };
    expect(previewQueryFilterDraft(pending(reordered)).ok).toBe(true);
    expect(previewQueryFilterDraft(pending({ ...source, dsl: source.dsl.replace('emit(9007199254740995L);', '\\u0065mit(9007199254740995L);') })).ok).toBe(true);
    for (const dsl of ['{"runtime_mappings":{"n":{"type":"long","type":"long"}}}', '{"runtime_mappings":null}',
      '{"runtime_mappings":{},"runtime_mappings":{}}']) {
      expect(previewQueryFilterDraft(pending({ ...source, dsl })).ok).toBe(false);
    }
  });

  it('retains disabled declarations without current evidence but rechecks them on enable and never pins a changed declaration', () => {
    const current = { ...source, dsl: '{}' };
    const draft = { ...pending(current), filters: pending(current).filters.map((filter) => ({ ...filter, enabled: false })) };
    expect(previewQueryFilterDraft(draft)).toMatchObject({ ok: true, dsl: '{}' });
    expect(previewQueryFilterDraft({ ...draft, filters: draft.filters.map((filter, i) => i ? filter : { ...filter, enabled: true }) }))
      .toEqual({ ok: false, code: 'runtimeChanged' });
    expect(pinFilterDefinition(draft, 'copy', 'Copy')).toEqual({ ok: false, code: 'runtimeChanged' });
    const malformed = { ...draft, filters: draft.filters.map((filter) => ({ ...filter, runtimeMapping: undefined })) };
    expect(previewQueryFilterDraft(malformed)).toEqual({ ok: false, code: 'savedFilterUnsupported' });
    const disguised = { ...draft, filters: draft.filters.map((filter) => ({ ...filter, origin: 'fields' as const })) };
    expect(previewQueryFilterDraft(disguised)).toEqual({ ok: false, code: 'targetChanged' });
  });

  it('deeply freezes only reviewed bindings and removes filters without removing the baseline scripts', () => {
    const draft = pending();
    const result = previewQueryFilterDraft(draft);
    if (!result.ok) throw new Error(result.code);
    const applied = { ...source, dsl: result.dsl, revision: 1 };
    const binding = bindAppliedQueryFilters(draft, applied)!;
    expect(binding.snapshot).toBeNull();
    expect(Object.isFrozen(binding.filters[0]!.runtimeMapping!.script)).toBe(true);
    expect(matchesQueryFilterBinding(structuredClone(binding), applied, draft.endpoint)).toBe(false);
    const edit = { ...draft, source: applied, binding, filters: draft.filters.map((filter) => ({ ...filter, enabled: false })) };
    expect(previewQueryFilterDraft(edit)).toMatchObject({ ok: true, dsl: source.dsl });
    expect(previewQueryFilterDraft({ ...edit, filters: [], composition: { mode: 'all', groups: [] } })).toMatchObject({ dsl: source.dsl });
    expect(previewQueryFilterDraft({ ...edit, source: { ...applied, revision: 2 } })).toEqual({ ok: false, code: 'filterBindingChanged' });
    const initial = createWorkspace(source.connectionId);
    const workspace = { ...initial, activeTabId: source.id, tabs: [{ ...initial.tabs[0]!, document: source }] };
    const restored = recoveryWorkspace(updateWorkspaceDocument(workspace, source.id, result.patch));
    expect(JSON.stringify(restored)).not.toContain('"runtimeMapping"');
    expect(JSON.stringify(restored)).not.toContain('"origin":"saved"');
    expect(restored.tabs[0]!.document.dsl).toBe(result.dsl);
  });

  it('mixes flat runtime and mapped nested definitions without bypassing current nested evidence', () => {
    const mixed = { ...one(), filters: [definition.filters[0]!, {
      id: 'author', field: 'comments.author', fieldType: 'keyword', nestedPath: 'comments',
      operation: 'include' as const, value: '"a\\u006cice"', enabled: true,
    }], composition: { mode: 'any' as const, groups: [
      { id: 'flat', mode: 'all' as const, filterIds: ['n'] },
      { id: 'nested', mode: 'all' as const, filterIds: ['author'], nested: { path: 'comments', match: 'exclude' as const } },
    ] } };
    const draft = draftFromPinnedFilters(mixed, source, pending().endpoint)!;
    expect(pinFilterDefinition(draft, mixed.id, mixed.name)).toEqual({ ok: true, definition: mixed });
    expect(previewQueryFilterDraft(draft)).toEqual({ ok: false, code: 'mappingUnchecked' });
    const fields = parseFieldCaps('{"indices":["events"],"fields":{"comments.author":{"keyword":{"searchable":true}}}}');
    if (!fields.ok) throw new Error('fixture');
    const mapping = parseNestedFilterMapping('{"events":{"mappings":{"properties":{"comments":{"type":"nested","properties":{"author":{"type":"keyword"}}}}}}}');
    const result = previewQueryFilterDraft(draft, fields.value, mapping);
    if (!result.ok) throw new Error(result.code);
    expect(result.dsl).toContain('"n": 9007199254740995');
    expect(result.dsl).toContain('a\\u006cice');
    expect(JSON.parse(result.dsl).query.bool.filter[0].bool.should[1].bool.must_not[0].nested.path).toBe('comments');
    expect(previewQueryFilterDraft(draft, { ...fields.value, indices: ['other'] }, mapping))
      .toEqual({ ok: false, code: 'mappingTargetChanged' });
  });

  it('retains time intent, sort and parameter templates while later actual observations keep their real identity', () => {
    const base = { ...source, parameters: { version: 1, template: '{"query":{"term":{"n":{"$param":"n"}}}}',
      definitions: [{ name: 'n', type: 'number' as const }] } };
    const time = previewTimeRange(base, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, at);
    if (!time.ok) throw new Error(time.code);
    const timed = { ...base, dsl: time.dsl, timeRange: time.timeRange };
    const draft = pending(timed);
    const result = previewQueryFilterDraft(draft);
    if (!result.ok) throw new Error(result.code);
    const applied = { ...timed, dsl: result.dsl, timeRange: result.patch.timeRange ?? undefined };
    const binding = bindAppliedQueryFilters(draft, applied)!;
    const actual = createSnapshot(applied, 'actual-later', at);
    const edit = { ...draft, source: applied, binding, snapshot: actual,
      filters: draft.filters.map((filter) => ({ ...filter, enabled: false })) };
    const next = bindAppliedQueryFilters(edit, { ...applied, dsl: timed.dsl, timeRange: timed.timeRange, revision: 1 })!;
    expect(next.snapshot?.requestId).toBe('actual-later');
    expect(binding.snapshot).toBeNull();
    expect(applied.parameters).toEqual(base.parameters);
    const frozen = freezeTimeRange(applied, new Date('2026-10-10T01:00:00Z'));
    if (!frozen.ok) throw new Error(frozen.code);
    expect(JSON.parse(frozen.dsl).runtime_mappings).toEqual(mappings);
    expect(JSON.parse(removeAppliedTimeRange(applied)!).query).toEqual(JSON.parse(result.dsl).query.bool.must[0]);
  });

  it('supports only presence for runtime geo_point and still refuses mapped geo_point or source equality', () => {
    const snapshot = createSnapshot(source, 'actual', at);
    const selection = { field: 'point', origin: 'fields' as const, value: undefined };
    const result = createQueryFilter(source, snapshot, selection, 'exists', null);
    expect(result).toMatchObject({ ok: true, filter: { fieldType: 'geo_point', evidence: 'runtime', value: null } });
    if (!result.ok) return;
    expect(previewQueryFilters(source, snapshot, [{ ...result.filter, id: 'point' }]).ok).toBe(true);
    expect(createQueryFilter(source, snapshot, { ...selection, value: { kind: 'string', text: '1,2' } }, 'include', '"1,2"'))
      .toEqual({ ok: false, code: 'valueUnsupported' });
    expect(createQueryFilter(source, snapshot, { field: 'n', origin: 'source', value: { kind: 'number', text: '9007199254740995' } },
      'include', '9007199254740995')).toEqual({ ok: false, code: 'runtimeValueRequired' });
    const mapped = { ...source, dsl: '{}' };
    const fields = parseFieldCaps('{"indices":["events"],"fields":{"point":{"geo_point":{"searchable":true}}}}');
    if (!fields.ok) throw new Error('fixture');
    expect(createQueryFilter(mapped, createSnapshot(mapped, 'mapped', at), selection, 'exists', null, fields.value))
      .toEqual({ ok: false, code: 'fieldUnsupported' });
  });
});

import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/query-nested-filters-v1.json';
import { createQuery, createSnapshot, type QueryDocument } from '../../src/domain/query';
import {
  MAX_FILTER_MAPPING_BYTES, MAX_FILTER_MAPPING_FIELDS, MAX_FILTER_MAPPING_INDICES,
  nestedMappingFieldEvidence, parseNestedFilterMapping,
} from '../../src/domain/query-filter-mapping';
import {
  createNestedQueryFilter, filterGroupAccepts, nestedQueryFilterFieldEvidence, previewQueryFilters,
  type QueryFilter, type QueryFilterComposition, type QueryFilterGroup, type QueryFilterOperation,
} from '../../src/domain/query-filters';
import { parseRawJson, property, sliceRaw } from '../../src/domain/query-result';
import { freezeTimeRange, parseQueryTimeRange, previewTimeRange, removeAppliedTimeRange } from '../../src/domain/query-time-range';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import { parseVisualForm } from '../../src/domain/visual-query';

const at = new Date('2026-10-10T00:00:00.000Z');
const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'events-*',
  dsl: '{"query":{"bool":{"should":[{"match":{"message":"\\u0061"}},{"term":{"id":9007199254740993}}],"minimum_should_match":"75%","boost":1.1000000000000000001}},"sort":[{"n":"desc"}],"_source":false,"size":25}' };
const snapshot = createSnapshot(source, 'execution', at);
const leaves = { author: { type: 'keyword' }, message: { type: 'text' }, n: { type: 'long' }, active: { type: 'boolean' },
  date: { type: 'date' }, ip: { type: 'ip' } };
const properties = { comments: { type: 'nested', properties: leaves }, status: { type: 'keyword' } };
const indexMapping = { mappings: { properties } };
function mapping(entries: object = { events: indexMapping }) { return parseNestedFilterMapping(JSON.stringify(entries)); }
function capabilities(types: Record<string, string> = { 'comments.author': 'keyword', 'comments.message': 'text',
  'comments.n': 'long', 'comments.active': 'boolean', 'comments.date': 'date', 'comments.ip': 'ip', status: 'keyword' },
indices: readonly string[] = ['events']): FieldCatalog {
  const result = parseFieldCaps(JSON.stringify({ indices, fields: Object.fromEntries(Object.entries(types).map(([field, type]) =>
    [field, { [type]: { searchable: true, aggregatable: true } }])) }));
  if (!result.ok) throw new Error('fixture');
  return result.value;
}
const catalog = capabilities();
const proof = mapping();
const atom = (field: string, value: string | null, operation: QueryFilterOperation = 'include', id = field): QueryFilter => {
  const result = createNestedQueryFilter(source, snapshot, 'comments', field, operation, value, catalog, proof);
  if (!result.ok) throw new Error(result.code);
  return { ...result.filter, id };
};
const group = (filters: readonly QueryFilter[], options: Partial<QueryFilterGroup> = {}): QueryFilterGroup =>
  ({ id: 'g', mode: 'all', filterIds: filters.map((filter) => filter.id), nested: { path: 'comments', match: 'include' }, ...options });
function preview(filters: readonly QueryFilter[], composition: QueryFilterComposition = { mode: 'all', groups: [group(filters)] },
  document = source, fields = catalog, evidence = proof) {
  const result = previewQueryFilters(document, snapshot, filters, fields, composition, evidence);
  if (!result.ok) throw new Error(result.code);
  return result;
}

describe('explicit Mapping evidence for nested filters', () => {
  it('reads direct properties only and checks the complete resolved index set without relying on flattened field names', () => {
    const result = mapping({ 'events-2': indexMapping, events: indexMapping });
    expect(result.ok && result.value.paths).toEqual([{ path: 'comments',
      fields: ['comments.active', 'comments.author', 'comments.date', 'comments.ip', 'comments.message', 'comments.n'] }]);
    expect(nestedMappingFieldEvidence(result, ['events', 'events-2'], 'comments', 'comments.author')).toEqual({ ok: true, fieldType: 'keyword' });
    for (const indices of [[], ['events'], ['events', 'events'], ['events', 'other']]) {
      expect(nestedMappingFieldEvidence(result, indices, 'comments', 'comments.author')).toEqual({ ok: false, code: 'mappingTargetChanged' });
    }
    expect(nestedMappingFieldEvidence(undefined, ['events'], 'comments', 'comments.author')).toEqual({ ok: false, code: 'mappingUnchecked' });
  });

  it.each(['[]', '{}', 'null', '{"events":{}}', '{"events":{"mappings":[]}}',
    '{"events":{"mappings":{"properties":[]}}}', '{"events":{"mappings":{"runtime":[]}}}',
    '{"events":{"mappings":{}},"\\u0065vents":{"mappings":{}}}',
    '{"events":{"mappings":{"properties":{"comments":{"type":"nested","properties":[]}}}}}',
  ])('rejects missing, malformed or ambiguous responses: %s', (raw) => {
    expect(parseNestedFilterMapping(raw)).toEqual({ ok: false, code: 'mappingInvalid' });
  });

  it('rejects over-limit Mapping responses instead of retaining a truncated evidence set', () => {
    expect(parseNestedFilterMapping(' '.repeat(MAX_FILTER_MAPPING_BYTES + 1))).toEqual({ ok: false, code: 'mappingTooLarge' });
    expect(mapping(Object.fromEntries(Array.from({ length: MAX_FILTER_MAPPING_INDICES + 1 }, (_, i) => [`i${i}`, indexMapping]))))
      .toEqual({ ok: false, code: 'mappingTooLarge' });
    expect(mapping({ events: { mappings: { properties: Object.fromEntries(Array.from({ length: MAX_FILTER_MAPPING_FIELDS + 1 },
      (_, i) => [`p${i}`, { type: 'keyword' }])) } } })).toEqual({ ok: false, code: 'mappingTooLarge' });
  });

  it.each([
    ['ordinary object', { comments: { properties: leaves } }, 'nestedPathConflict'],
    ['literal dotted key', { 'comments.author': { type: 'keyword' } }, 'nestedPathUnsupported'],
    ['dotted collision', { ...properties, 'comments.author': { type: 'keyword' } }, 'nestedPathUnsupported'],
    ['absent path', { other: { type: 'nested', properties: leaves } }, 'nestedPathMissing'],
    ['missing leaf', { comments: { type: 'nested', properties: {} } }, 'nestedFieldMissing'],
    ['object leaf', { comments: { type: 'nested', properties: { author: { properties: { name: { type: 'keyword' } } } } } }, 'nestedPathUnsupported'],
    ['nested leaf', { comments: { type: 'nested', properties: { author: { type: 'nested', properties: leaves } } } }, 'nestedPathUnsupported'],
    ['alias leaf', { comments: { type: 'nested', properties: { author: { type: 'alias', path: 'status' } } } }, 'nestedPathUnsupported'],
    ['disabled parent', { comments: { type: 'nested', enabled: false, properties: leaves } }, 'nestedPathUnsupported'],
    ['flattened parent', { comments: { type: 'nested', subobjects: false, properties: leaves } }, 'nestedPathUnsupported'],
    ['unknown object flags', { comments: { type: 'nested', enabled: 'false', properties: leaves } }, 'nestedPathUnsupported'],
    ['automatic subobjects', { comments: { type: 'nested', subobjects: 'auto', properties: leaves } }, 'nestedPathUnsupported'],
  ])('does not accept %s as nested evidence', (_, nextProperties, code) => {
    expect(nestedMappingFieldEvidence(mapping({ events: { mappings: { properties: nextProperties } } }), ['events'], 'comments', 'comments.author'))
      .toEqual({ ok: false, code });
  });

  it.each([
    ['comments.author', 'comments.author.name'], ['comments', 'comments.author.name'], ['comments', 'other.author'],
    ['comments', 'comments.'], ['comments[0]', 'comments[0].author'], ['_meta', '_meta.author'],
  ])('refuses deep, unrelated or ambiguous scope %s / %s', (path, field) => {
    expect(nestedMappingFieldEvidence(proof, ['events'], path, field)).toEqual({ ok: false, code: 'nestedPathUnsupported' });
  });

  it('refuses missing and conflicting evidence on any resolved index, including legacy typed mappings', () => {
    expect(nestedMappingFieldEvidence(mapping({ events: indexMapping, other: { mappings: {} } }),
      ['events', 'other'], 'comments', 'comments.author')).toEqual({ ok: false, code: 'nestedPathMissing' });
    expect(nestedMappingFieldEvidence(mapping({ events: indexMapping, other: { mappings: { _doc: { properties } } } }),
      ['events', 'other'], 'comments', 'comments.author')).toEqual({ ok: false, code: 'nestedPathMissing' });
    const other = { mappings: { properties: { comments: { type: 'nested', properties: { author: { type: 'text' } } } } } };
    expect(nestedMappingFieldEvidence(mapping({ events: indexMapping, other }), ['events', 'other'], 'comments', 'comments.author'))
      .toEqual({ ok: false, code: 'nestedFieldConflict' });
    expect(nestedQueryFilterFieldEvidence(source, snapshot, 'comments', 'comments.author',
      capabilities({ 'comments.author': 'text' }), proof)).toEqual({ ok: false, code: 'nestedFieldConflict' });
  });

  it('rejects unknown field shapes and root object flags instead of treating them as affirmative evidence', () => {
    for (const field of [null, {}, 7]) {
      expect(nestedMappingFieldEvidence(proof, ['events'], 'comments', field as unknown as string))
        .toEqual({ ok: false, code: 'nestedPathUnsupported' });
    }
    for (const flags of [{ enabled: false }, { enabled: 'true' }, { subobjects: false }, { subobjects: 'auto' }]) {
      expect(nestedMappingFieldEvidence(mapping({ events: { mappings: { properties, ...flags } } }), ['events'], 'comments', 'comments.author'))
        .toEqual({ ok: false, code: 'nestedPathUnsupported' });
    }
  });

  it('still requires searchable, unambiguous field caps and never substitutes a keyword subfield', () => {
    const variants = [
      { ...catalog, fields: [] },
      { ...catalog, fields: catalog.fields.map((field) => ({ ...field, conflict: true })) },
      { ...catalog, fields: catalog.fields.map((field) => ({ ...field, types: field.types.map((type) => ({ ...type, searchable: false })) })) },
    ];
    for (const [index, code] of ['fieldMissing', 'fieldConflict', 'fieldNotSearchable'].entries()) {
      expect(nestedQueryFilterFieldEvidence(source, snapshot, 'comments', 'comments.author', variants[index], proof)).toEqual({ ok: false, code });
    }
    expect(nestedQueryFilterFieldEvidence(source, snapshot, 'comments', 'comments.message.keyword', catalog, proof))
      .toEqual({ ok: false, code: 'nestedPathUnsupported' });
    const result = preview([atom('comments.message', '"words here"')]);
    expect(result.dsl).toContain('"match_phrase":{"comments.message":"words here"}');
    expect(result.dsl).not.toContain('comments.message.keyword');
  });

  it.each(['comments', 'comments.author', 'comments.other'])('rejects flat runtime declarations at or below %s', (name) => {
    const runtime = { [name]: { type: 'keyword', script: { source: 'emit("runtime");' } } };
    const current = { ...source, dsl: JSON.stringify({ runtime_mappings: runtime }) };
    expect(nestedQueryFilterFieldEvidence(current, snapshot, 'comments', 'comments.author', catalog, proof))
      .toEqual({ ok: false, code: 'nestedRuntime' });
    expect(nestedQueryFilterFieldEvidence(source, createSnapshot(current, 'rt', at), 'comments', 'comments.author', catalog, proof))
      .toEqual({ ok: false, code: 'nestedRuntime' });
    expect(nestedMappingFieldEvidence(mapping({ events: { mappings: { properties, runtime } } }), ['events'], 'comments', 'comments.author'))
      .toEqual({ ok: false, code: 'nestedRuntime' });
  });
});

type Clause = { match_all?: object; term?: Record<string, string | number>; exists?: { field: string };
  nested?: { path: string; query: Clause };
  bool?: { must?: Clause[]; filter?: Clause[]; must_not?: Clause[]; should?: Clause[]; minimum_should_match?: number } };
type TestDocument = Record<string, unknown>;
// Quantifier oracle for generated term/exists/bool/nested, not an Elasticsearch or scoring emulator.
function matches(clause: Clause, document: TestDocument): boolean {
  if (clause.match_all) return true;
  if (clause.term) return Object.entries(clause.term).every(([field, value]) => document[field] === value);
  if (clause.exists) return document[clause.exists.field] !== undefined && document[clause.exists.field] !== null;
  if (clause.nested) {
    const { path, query } = clause.nested;
    return ((document[path] ?? []) as TestDocument[]).some((child) =>
      matches(query, Object.fromEntries(Object.entries(child).map(([field, value]) => [`${path}.${field}`, value]))));
  }
  if (!clause.bool) throw new Error('Unexpected oracle clause');
  const { must = [], filter = [], must_not = [], should = [], minimum_should_match = 0 } = clause.bool;
  return [...must, ...filter].every((child) => matches(child, document)) && !must_not.some((child) => matches(child, document))
    && should.filter((child) => matches(child, document)).length >= minimum_should_match;
}

describe('reviewed nested query compilation', () => {
  it('matches the frontend/backend request fixture without rewriting scoring, literals or unrelated runtime fields', () => {
    const document = { ...source, dsl: fixture.sourceDsl };
    const result = previewQueryFilters(document, createSnapshot(document, 'fixture', at), fixture.filters as QueryFilter[],
      catalog, fixture.composition as QueryFilterComposition, proof);
    if (!result.ok) throw new Error(result.code);
    expect(result.dsl).toBe(fixture.nestedDsl);
    expect(result.patch).toEqual({ dsl: fixture.nestedDsl });
  });

  it('keeps AND conditions inside one nested object and preserves the original scoring query verbatim', () => {
    const filters = [atom('comments.author', '"alice"'), atom('comments.n', '2')];
    const result = preview(filters);
    const root = parseRawJson(result.dsl)!;
    expect(sliceRaw(result.dsl, property(property(property(root, 'query'), 'bool'), 'must')!.children![0]!))
      .toBe(sliceRaw(source.dsl, property(parseRawJson(source.dsl), 'query')!));
    expect(result.dsl).toContain('"minimum_should_match":"75%","boost":1.1000000000000000001');
    const nested = JSON.parse(result.dsl).query.bool.filter[0] as Clause;
    expect(nested).toMatchObject({ nested: { path: 'comments', score_mode: 'none', ignore_unmapped: false,
      query: { bool: { filter: [{ term: { 'comments.author': 'alice' } }, { term: { 'comments.n': 2 } }] } } } });
    expect(matches(nested, { comments: [{ author: 'alice', n: 1 }, { author: 'bob', n: 2 }] })).toBe(false);
    expect(matches(nested, { comments: [{ author: 'alice', n: 2 }] })).toBe(true);
    expect(matches(nested, { comments: [] })).toBe(false);
    expect(matches(nested, {})).toBe(false);
    expect(parseVisualForm(result.dsl).ok).toBe(false);
    expect(snapshot.rawDsl).toBe(source.dsl);
  });

  it('distinguishes inner negation from excluding every parent with a matching nested object', () => {
    const excluded = atom('comments.author', '"alice"', 'exclude');
    const included = atom('comments.author', '"alice"');
    const inner = JSON.parse(preview([excluded]).dsl).query.bool.filter[0] as Clause;
    const outer = JSON.parse(preview([included], { mode: 'all', groups: [group([included], {
      nested: { path: 'comments', match: 'exclude' },
    })] }).dsl).query as Clause;
    const outerFilter = { bool: { must_not: outer.bool!.must_not } };
    const rows: [TestDocument, boolean, boolean][] = [
      [{ comments: [{ author: 'alice' }, { author: 'bob' }] }, true, false],
      [{ comments: [{ author: 'alice' }] }, false, false],
      [{ comments: [{ author: 'bob' }] }, true, true],
      [{ comments: [{}] }, true, true],
      [{ comments: [] }, false, true],
      [{}, false, true],
    ];
    for (const [document, inside, outside] of rows) {
      expect(matches(inner, document)).toBe(inside);
      expect(matches(outerFilter, document)).toBe(outside);
    }
    expect(outer.bool!.must_not).toHaveLength(1);
    expect(outer.bool!.filter).toBeUndefined();
  });

  it('keeps negative OR branches within one nested object and writes explicit MSM at both levels', () => {
    const filters = [atom('comments.author', '"alice"', 'exclude'), atom('comments.n', null, 'missing')];
    const result = preview(filters, { mode: 'any', groups: [group(filters, { mode: 'any' })] });
    const clause = JSON.parse(result.dsl).query.bool.filter[0] as Clause;
    expect(result.dsl.match(/"minimum_should_match":1/g)).toHaveLength(2);
    expect(matches(clause, { comments: [{ author: 'alice', n: 2 }] })).toBe(false);
    expect(matches(clause, { comments: [{ author: 'alice' }] })).toBe(true);
    expect(matches(clause, { comments: [{ author: 'bob', n: 2 }] })).toBe(true);
    expect(matches(clause, { comments: [] })).toBe(false);
  });

  it('does not promote an outer nested exclusion out of its parent-level OR branch', () => {
    const filters: QueryFilter[] = [atom('comments.author', '"alice"'),
      { id: 'flat', field: 'status', fieldType: 'keyword', evidence: 'mapped', origin: 'source', operation: 'include', value: '"ready"' }];
    const composition: QueryFilterComposition = { mode: 'any', groups: [
      group([filters[0]!], { nested: { path: 'comments', match: 'exclude' } }),
      { id: 'flat-group', mode: 'all', filterIds: ['flat'] },
    ] };
    const query = JSON.parse(preview(filters, composition).dsl).query as Clause;
    expect(query.bool!.must_not).toBeUndefined();
    const clause = query.bool!.filter![0]!;
    expect(matches(clause, { status: 'ready', comments: [{ author: 'alice' }] })).toBe(true);
    expect(matches(clause, { status: 'blocked', comments: [{ author: 'alice' }] })).toBe(false);
    expect(matches(clause, { status: 'blocked', comments: [] })).toBe(true);
  });

  it('allows identical leaves in distinct nested groups because each group has its own existential object', () => {
    const first = [atom('comments.author', '"alice"'), atom('comments.n', '1', 'include', 'one')];
    const second = [atom('comments.author', '"alice"', 'include', 'second-author'), atom('comments.n', '2', 'include', 'two')];
    const result = preview([...first, ...second], { mode: 'all', groups: [group(first), group(second, { id: 'second' })] });
    const conjunction: Clause = { bool: { filter: JSON.parse(result.dsl).query.bool.filter } };
    expect(matches(conjunction, { comments: [{ author: 'alice', n: 1 }, { author: 'alice', n: 2 }] })).toBe(true);
    expect(matches(conjunction, { comments: [{ author: 'alice', n: 1 }] })).toBe(false);
    expect(previewQueryFilters(source, snapshot, [first[0]!, second[0]!], catalog, { mode: 'all', groups: [group([first[0]!, second[0]!])] }, proof))
      .toEqual({ ok: false, code: 'duplicate' });
  });

  it.each([
    ['all', 'all', 'include'], ['all', 'all', 'exclude'], ['all', 'any', 'include'], ['all', 'any', 'exclude'],
    ['any', 'all', 'include'], ['any', 'all', 'exclude'], ['any', 'any', 'include'], ['any', 'any', 'exclude'],
  ] as const)('preserves quantifiers and negation while toggling %s / %s / %s groups', (rootMode, innerMode, parentMatch) => {
    const definitions: QueryFilter[] = [atom('comments.author', '"alice"'), atom('comments.n', '2', 'exclude'),
      { id: 'flat', field: 'status', fieldType: 'keyword', evidence: 'mapped', origin: 'source', operation: 'include', value: '"ready"' }];
    const composition: QueryFilterComposition = { mode: rootMode, groups: [
      group(definitions.slice(0, 2), { mode: innerMode, nested: { path: 'comments', match: parentMatch } }),
      { id: 'flat-group', mode: 'any', filterIds: ['flat'] },
    ] };
    for (let enabled = 0; enabled < 8; enabled += 1) {
      const filters = definitions.map((filter, index) => ({ ...filter, enabled: Boolean(enabled & (1 << index)) }));
      const saved = structuredClone({ filters, composition });
      const result = preview(filters, composition);
      const query = JSON.parse(result.dsl).query as Clause;
      const generated: Clause = enabled === 0 ? { match_all: {} }
        : { bool: { filter: query.bool!.filter, must_not: query.bool!.must_not } };
      expect(result.dsl).not.toContain('"bool":{}');
      expect(result.dsl).not.toContain('"should":[]');
      if (!(enabled & 3)) expect(result.dsl).not.toContain('"nested"');
      const objects: (TestDocument[] | undefined)[] = [undefined, [], [{}], [{ author: 'alice', n: 2 }], [{ author: 'bob', n: 1 }],
        [{ author: 'alice', n: 2 }, { author: 'bob', n: 1 }], [{ author: 'alice', n: 1 }]];
      for (const comments of objects) {
        for (const status of ['ready', 'blocked']) {
          const hasObject = comments?.some((object) => {
            const conditions = [object.author === 'alice', object.n !== 2].filter((_, index) => Boolean(enabled & (1 << index)));
            return innerMode === 'all' ? conditions.every(Boolean) : conditions.some(Boolean);
          }) ?? false;
          const groups = [
            ...(enabled & 3 ? [parentMatch === 'include' ? hasObject : !hasObject] : []),
            ...(enabled & 4 ? [status === 'ready'] : []),
          ];
          expect(matches(generated, { comments, status }), `enabled ${enabled}: ${JSON.stringify({ comments, status })}`)
            .toBe(!groups.length || (rootMode === 'all' ? groups.every(Boolean) : groups.some(Boolean)));
        }
      }
      expect({ filters, composition }).toEqual(saved);
    }
  });

  it('retains disabled nested definitions and membership while requiring fresh Mapping only for enabled leaves', () => {
    const included = atom('comments.author', '"alice"');
    const disabled = { ...included, enabled: false };
    const composition: QueryFilterComposition = { mode: 'any', groups: [group([disabled], { nested: { path: 'comments', match: 'exclude' } })] };
    expect(previewQueryFilters(source, snapshot, [disabled], undefined, composition, undefined))
      .toEqual({ ok: true, dsl: source.dsl, patch: { dsl: source.dsl } });
    expect(previewQueryFilters(source, snapshot, [included], catalog, composition, undefined))
      .toEqual({ ok: false, code: 'mappingUnchecked' });
    expect(previewQueryFilters(source, snapshot, [disabled], undefined, { ...composition, groups: [{ ...composition.groups[0]!, nested: { path: 'other', match: 'exclude' } }] }))
      .toEqual({ ok: false, code: 'nestedGroupMismatch' });
    expect(previewQueryFilters(source, snapshot, [{ ...disabled, nestedPath: 'comments.author' }], undefined, composition))
      .toEqual({ ok: false, code: 'fieldPath' });
    const duplicate = { ...disabled, id: 'duplicate' };
    expect(previewQueryFilters(source, snapshot, [included, duplicate], catalog, { mode: 'all', groups: [group([included, duplicate])] }, proof))
      .toEqual({ ok: false, code: 'duplicate' });
    expect(previewQueryFilters(source, snapshot, [included, duplicate], catalog,
      { mode: 'all', groups: [group([included]), group([duplicate], { id: 'independent' })] }, proof).ok).toBe(true);
  });

  it('preserves exact authored tokens and rejects coercion, compound values and oversized values', () => {
    expect(preview([atom('comments.n', '9007199254740993')]).dsl).toContain('"comments.n":9007199254740993');
    expect(preview([atom('comments.author', '"\\u0061"')]).dsl).toContain('"comments.author":"\\u0061"');
    expect(preview([atom('comments.active', 'false')]).dsl).toContain('"comments.active":false');
    const invalid: [string, string | null, string][] = [
      ['comments.n', '"2"', 'valueTypeMismatch'], ['comments.n', '9223372036854775808', 'valueOutOfRange'],
      ['comments.n', '1.1', 'valueOutOfRange'], ['comments.author', '[]', 'invalidValue'],
      ['comments.author', '{"x":1}', 'invalidValue'], ['comments.author', 'null', 'invalidValue'],
      ['comments.author', JSON.stringify('x'.repeat(4096)), 'tooLarge'], ['comments.message', '" "', 'emptyPhrase'],
      ['comments.date', '"2026-10-10"', 'valueUnsupported'], ['comments.ip', '"127.0.0.1"', 'valueUnsupported'],
    ];
    for (const [field, value, code] of invalid) {
      expect(createNestedQueryFilter(source, snapshot, 'comments', field, 'include', value, catalog, proof)).toEqual({ ok: false, code });
    }
    expect(atom('comments.date', null, 'exists')).toMatchObject({ origin: 'input', nestedPath: 'comments', value: null });
  });

  it('keeps nested filters through time freeze/removal and leaves the parameter template unchanged', () => {
    const base = { ...source, parameters: { version: 1, template: '{"query":{"term":{"id":{"$param":"id"}}}}',
      definitions: [{ name: 'id', type: 'number' as const }] } };
    const time = previewTimeRange(base, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, at);
    if (!time.ok) throw new Error(time.code);
    const document = { ...base, dsl: time.dsl, timeRange: time.timeRange };
    const result = preview([atom('comments.author', '"alice"')], undefined, document);
    const updated = { ...document, ...result.patch, dsl: result.dsl } as QueryDocument;
    expect(updated.parameters).toEqual(base.parameters);
    expect(parseQueryTimeRange(updated.timeRange, updated.connectionId, updated.index, updated.dsl)).not.toBeNull();
    const frozen = freezeTimeRange(updated, new Date('2026-10-10T01:00:00.000Z'));
    if (!frozen.ok) throw new Error(frozen.code);
    expect(JSON.parse(frozen.dsl).query.bool.must).toEqual(JSON.parse(result.dsl).query.bool.must);
    expect(JSON.parse(removeAppliedTimeRange(updated)!).query).toEqual(JSON.parse(result.dsl).query.bool.must[0]);
    expect(JSON.parse(result.dsl).sort).toEqual(JSON.parse(source.dsl).sort);
  });

  it('rejects unscoped, mixed, forged, changed or unsupported nested groups without changing source text', () => {
    const filters = [atom('comments.author', '"alice"')];
    const flat: QueryFilterComposition = { mode: 'all', groups: [{ id: 'flat', mode: 'all', filterIds: [filters[0]!.id] }] };
    expect(previewQueryFilters(source, snapshot, filters, catalog, undefined, proof)).toEqual({ ok: false, code: 'nestedGroupMismatch' });
    expect(previewQueryFilters(source, snapshot, filters, catalog, flat, proof)).toEqual({ ok: false, code: 'nestedGroupMismatch' });
    const composition: QueryFilterComposition = { mode: 'all', groups: [group(filters)] };
    expect(filterGroupAccepts(composition.groups[0]!, filters[0]!)).toBe(true);
    expect(filterGroupAccepts(flat.groups[0]!, filters[0]!)).toBe(false);
    expect(previewQueryFilters(source, snapshot, [{ ...filters[0]!, origin: 'fields' }], catalog, composition, proof))
      .toEqual({ ok: false, code: 'nestedGroupMismatch' });
    expect(previewQueryFilters(source, snapshot, [{ ...filters[0]!, fieldType: 'text' }], catalog, composition, proof))
      .toEqual({ ok: false, code: 'fieldChanged' });
    expect(previewQueryFilters({ ...source, index: 'other' }, snapshot, filters, catalog, composition, proof))
      .toEqual({ ok: false, code: 'targetChanged' });
    for (const nested of [null, {}, { path: 'comments', match: 'all' }, { path: 'comments.author', match: 'include' },
      { path: 'comments', match: ['include'] }, { path: 'comments', match: ['exclude'] },
      { path: 'comments', match: 'include', score_mode: 'avg' }, { path: 'comments', match: 'include', ignore_unmapped: true }]) {
      expect(previewQueryFilters(source, snapshot, filters, catalog,
        { mode: 'all', groups: [{ ...group(filters), nested }] } as QueryFilterComposition, proof)).toEqual({ ok: false, code: 'invalidComposition' });
    }
    expect(previewQueryFilters(source, snapshot, filters, catalog, composition, mapping({ events: { mappings: { properties: { comments: { type: 'object', properties: leaves } } } } })))
      .toEqual({ ok: false, code: 'nestedPathConflict' });
    expect(snapshot.rawDsl).toBe(source.dsl);
  });
});

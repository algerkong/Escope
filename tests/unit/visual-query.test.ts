import { describe, expect, it } from 'vitest';
import { createQuery } from '../../src/domain/query';
import type { FieldCapability } from '../../src/domain/resource';
import {
  buildVisualDsl, parseVisualForm, VISUAL_SIZE_MAX,
  type VisualCondition, type VisualForm,
} from '../../src/domain/visual-query';

function capability(name: string, types: FieldCapability['types'], conflict = false): FieldCapability {
  return { name, types, conflict };
}

const FIELDS: FieldCapability[] = [
  capability('id', [{ type: 'long', searchable: true, aggregatable: true, metadata: false }]),
  capability('name', [{ type: 'text', searchable: true, aggregatable: false, metadata: false }]),
  capability('ok', [{ type: 'boolean', searchable: true, aggregatable: true, metadata: false }]),
  capability('when', [{ type: 'date', searchable: true, aggregatable: true, metadata: false }]),
  capability('bad', [
    { type: 'long', searchable: true, aggregatable: true, metadata: false },
    { type: 'text', searchable: true, aggregatable: false, metadata: false },
  ], true),
  capability('nestedDoc', [{ type: 'nested', searchable: true, aggregatable: false, metadata: false }]),
  capability('items', [{ type: 'nested', searchable: true, aggregatable: false, metadata: false }]),
  capability('items.price', [{ type: 'long', searchable: true, aggregatable: true, metadata: false }]),
  capability('noAgg', [{ type: 'keyword', searchable: true, aggregatable: false, metadata: false }]),
  capability('secret', [{ type: 'keyword', searchable: false, aggregatable: true, metadata: false }]),
];

function condition(overrides: Partial<VisualCondition> & Pick<VisualCondition, 'field' | 'operator'>): VisualCondition {
  return {
    id: overrides.id ?? 'c0', context: 'must', valueType: 'string', value: '',
    ...overrides,
  };
}

function form(overrides: Partial<VisualForm>): VisualForm {
  return { mode: 'all', conditions: [], size: '', sort: null, ...overrides };
}

describe('createQuery default draft', () => {
  const DEFAULT_DSL = createQuery(null).dsl;

  it('parses the seeded match_all draft as an empty form and keeps its bytes', () => {
    expect(DEFAULT_DSL).toBe('{\n  "query": {\n    "match_all": {}\n  },\n  "size": 25\n}');
    const parsed = parseVisualForm(DEFAULT_DSL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.form.conditions).toEqual([]);
    expect(parsed.form.mode).toBe('all');
    expect(parsed.form.size).toBe('25');
    expect(parsed.form.sort).toBeNull();
    expect(buildVisualDsl(DEFAULT_DSL, parsed.form, FIELDS, parsed.form).dsl).toBeUndefined();
  });

  it('replaces match_all with the first real condition and preserves size', () => {
    const parsed = parseVisualForm(DEFAULT_DSL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next: VisualForm = {
      ...parsed.form,
      conditions: [condition({ field: 'id', operator: 'eq', valueType: 'number', value: '1' })],
    };
    const result = buildVisualDsl(DEFAULT_DSL, next, FIELDS, parsed.form);
    expect(result.problems).toEqual([]);
    expect(result.dsl).toBe('{\n  "query": {"term":{"id":1}},\n  "size": 25\n}');
  });

  it('drops the query property when the last condition is deleted (default match_all semantics)', () => {
    const raw = '{\n  "query": {"term":{"id":1}},\n  "size": 25\n}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = buildVisualDsl(raw, { mode: 'all', conditions: [], size: '25', sort: null }, FIELDS, parsed.form);
    expect(result.dsl).toBe('{\n  "size": 25\n}');
    expect(parseVisualForm(result.dsl ?? '').ok).toBe(true);
  });
});

describe('parseVisualForm: supported subset', () => {
  it('reverses a bare term with its exact long-integer token', () => {
    const parsed = parseVisualForm('{"query":{"term":{"id":9007199254740993}}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.form.mode).toBe('all');
    expect(parsed.form.size).toBe('');
    expect(parsed.form.sort).toBeNull();
    expect(parsed.form.conditions).toHaveLength(1);
    const [row] = parsed.form.conditions;
    expect(row).toMatchObject({ field: 'id', operator: 'eq', context: 'must', valueType: 'number', value: '9007199254740993' });
    expect(row?.original?.raw).toBe('9007199254740993');
    expect(buildVisualDsl('{"query":{"term":{"id":9007199254740993}}}', parsed.form, FIELDS, parsed.form).dsl).toBeUndefined();
  });

  it('reverses match (wrapped and plain), range, exists and must_not clauses', () => {
    const wrapped = parseVisualForm('{"query":{"match":{"name":{"query":"caf\\u00e9"}}}}');
    expect(wrapped.ok).toBe(true);
    if (wrapped.ok) {
      expect(wrapped.form.conditions[0]).toMatchObject({ field: 'name', operator: 'match', valueType: 'string', value: 'café' });
      expect(wrapped.form.conditions[0]?.original?.raw).toBe('"caf\\u00e9"');
    }
    const range = parseVisualForm('{"query":{"range":{"id":{"gte":10}}}}');
    expect(range.ok).toBe(true);
    if (range.ok) expect(range.form.conditions[0]).toMatchObject({ field: 'id', operator: 'gte', valueType: 'number', value: '10' });
    const exists = parseVisualForm('{"query":{"exists":{"field":"name"}}}');
    expect(exists.ok).toBe(true);
    if (exists.ok) expect(exists.form.conditions[0]).toMatchObject({ field: 'name', operator: 'exists' });
    const negative = parseVisualForm('{"query":{"bool":{"filter":[{"term":{"id":1}}],"must_not":[{"term":{"name":"x"}},{"exists":{"field":"ok"}}]}}}');
    expect(negative.ok).toBe(true);
    if (negative.ok) {
      expect(negative.form.conditions.map((row) => [row.field, row.operator, row.context])).toEqual([
        ['id', 'eq', 'filter'],
        ['name', 'neq', 'must'],
        ['ok', 'missing', 'must'],
      ]);
    }
  });

  it('reverses scoring must and should clauses with explicit minimum_should_match', () => {
    const must = parseVisualForm('{"query":{"bool":{"must":[{"term":{"id":1}}]}}}');
    expect(must.ok).toBe(true);
    if (must.ok) expect(must.form.conditions[0]).toMatchObject({ operator: 'eq', context: 'must' });
    const should = parseVisualForm('{"query":{"bool":{"should":[{"term":{"id":1}},{"term":{"id":2}}],"minimum_should_match":1}}}');
    expect(should.ok).toBe(true);
    if (should.ok) {
      expect(should.form.mode).toBe('any');
      expect(should.form.conditions).toHaveLength(2);
    }
  });

  it('reverses scalar value types without coercing numbers through JS Number', () => {
    const parsed = parseVisualForm('{"query":{"bool":{"filter":[{"term":{"ok":true}},{"term":{"id":1e300}},{"term":{"id":-0.5}}]}}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.form.conditions.map((row) => [row.valueType, row.value])).toEqual([
      ['boolean', 'true'],
      ['number', '1e300'],
      ['number', '-0.5'],
    ]);
  });

  it('reverses integer size and the supported sort shapes', () => {
    const object = parseVisualForm('{"query":{"term":{"id":1}},"size":25,"sort":{"id":"desc"}}');
    expect(object.ok).toBe(true);
    if (object.ok) {
      expect(object.form.size).toBe('25');
      expect(object.form.sort).toEqual({ field: 'id', direction: 'desc' });
    }
    const array = parseVisualForm('{"sort":[{"id":{"order":"asc"}}]}');
    expect(array.ok).toBe(true);
    if (array.ok) expect(array.form.sort).toEqual({ field: 'id', direction: 'asc' });
  });

  it('keeps unrelated top-level properties out of the form but parseable', () => {
    const raw = '{"aggs":{"x":{"terms":{"field":"id"}}},"_source":false,"unknown":true,"query":{"term":{"id":1}}}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.form.conditions).toHaveLength(1);
  });

  it('treats an empty or blank draft as an empty form', () => {
    for (const raw of ['', '   ']) {
      const parsed = parseVisualForm(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.form).toEqual(form({}));
    }
  });
});

describe('parseVisualForm: unsupported or invalid DSL', () => {
  it('reports invalid JSON with a structured code and position', () => {
    const parsed = parseVisualForm('{"query":{"term":@}}');
    expect(parsed).toMatchObject({ ok: false, reason: 'invalidDsl', error: { code: 'dslSyntaxError' } });
  });

  it.each([
    ['match_all boost', '{"query":{"match_all":{"boost":2}}}'],
    ['match_all non-object', '{"query":{"match_all":[]}}'],
    ['empty OR', '{"query":{"bool":{"should":[],"minimum_should_match":1}}}'],
    ['script', '{"query":{"script":{"script":{"source":"1"}}}}'],
    ['empty bool', '{"query":{"bool":{}}}'],
    ['nested bool', '{"query":{"bool":{"filter":[{"bool":{"must":[{"term":{"id":1}}]}}]}}}'],
    ['bool boost', '{"query":{"bool":{"filter":[{"term":{"id":1}}],"boost":2}}}'],
    ['implicit OR', '{"query":{"bool":{"should":[{"term":{"id":1}}]}}}'],
    ['should with must', '{"query":{"bool":{"must":[{"term":{"id":1}}],"should":[{"term":{"id":2}}],"minimum_should_match":1}}}'],
    ['multi-bound range', '{"query":{"range":{"id":{"gte":1,"lte":2}}}}'],
    ['term array', '{"query":{"term":{"id":[1,2]}}}'],
    ['two query keys', '{"query":{"term":{"id":1},"size":2}}'],
  ])('rejects %s without guessing', (_label, raw) => {
    expect(parseVisualForm(raw)).toEqual({ ok: false, reason: 'query' });
  });

  it('reports unrepresentable size and sort instead of rewriting them', () => {
    for (const raw of ['{"size":1.5}', '{"size":20000}', '{"size":-1}', '{"size":"25"}', `{"size":${VISUAL_SIZE_MAX + 1}}`]) {
      expect(parseVisualForm(raw)).toEqual({ ok: false, reason: 'size' });
    }
    for (const raw of ['{"sort":[{"id":"asc"},{"name":"desc"}]}', '{"sort":{"id":"up"}}', '{"sort":[]}']) {
      expect(parseVisualForm(raw)).toEqual({ ok: false, reason: 'sort' });
    }
  });
});

describe('buildVisualDsl: lossless forward edits', () => {
  it('preserves long integers, escapes, size, sort, aggs and _source byte-for-byte when only one condition changes', () => {
    const raw = '{"query":{"bool":{"must":[{"term":{"id":9007199254740993}},{"match":{"name":"caf\\u00e9"}}]}},"size":25,"sort":[{"id":{"order":"asc"}}],"aggs":{"x":{"terms":{"field":"id"}}},"_source":false}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next: VisualForm = {
      ...parsed.form,
      conditions: parsed.form.conditions.map((row) => (row.field === 'name' ? { ...row, value: 'x' } : row)),
    };
    const result = buildVisualDsl(raw, next, FIELDS, parsed.form);
    expect(result.problems).toEqual([]);
    expect(result.dsl).toBe('{"query":{"bool":{"must":[{"term":{"id":9007199254740993}},{"match":{"name":"x"}}]}},"size":25,"sort":[{"id":{"order":"asc"}}],"aggs":{"x":{"terms":{"field":"id"}}},"_source":false}');
  });

  it('edits only size and keeps the query value untouched, including its escape sequence', () => {
    const raw = '{"query":{"term":{"name":"caf\\u00e9"}},"size":25}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = buildVisualDsl(raw, { ...parsed.form, size: '3' }, FIELDS, parsed.form);
    expect(result.problems).toEqual([]);
    expect(result.dsl).toBe('{"query":{"term":{"name":"caf\\u00e9"}},"size":3}');
  });

  it('edits only the query and leaves existing size and sort untouched', () => {
    const raw = '{"query":{"term":{"id":1}},"size":25,"sort":[{"id":"desc"}]}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next: VisualForm = {
      ...parsed.form,
      conditions: parsed.form.conditions.map((row) => ({ ...row, value: '7' })),
    };
    const result = buildVisualDsl(raw, next, FIELDS, parsed.form);
    expect(result.dsl).toBe('{"query":{"term":{"id":7}},"size":25,"sort":[{"id":"desc"}]}');
  });

  it('emits OR with an explicit minimum_should_match and round-trips it', () => {
    const raw = '{"query":{"bool":{"should":[{"term":{"id":1}},{"term":{"id":2}}],"minimum_should_match":1}}}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next: VisualForm = {
      ...parsed.form,
      conditions: parsed.form.conditions.map((row, index) => (index === 1 ? { ...row, value: '3' } : row)),
    };
    const result = buildVisualDsl(raw, next, FIELDS, parsed.form);
    expect(result.dsl).toBe('{"query":{"bool":{"should":[{"term":{"id":1}},{"term":{"id":3}}],"minimum_should_match":1}}}');
    const round = parseVisualForm(result.dsl ?? '');
    expect(round.ok).toBe(true);
    if (round.ok) {
      expect(round.form.mode).toBe('any');
      expect(buildVisualDsl(result.dsl ?? '', round.form, FIELDS, round.form).dsl).toBeUndefined();
    }
  });

  it('emits neq and missing through must_not, preserving filter and scoring contexts', () => {
    const result = buildVisualDsl('{}', form({
      conditions: [
        condition({ id: 'a', field: 'id', operator: 'eq', context: 'filter', valueType: 'number', value: '1' }),
        condition({ id: 'b', field: 'name', operator: 'neq', context: 'must', value: 'x' }),
      ],
    }), FIELDS, form({}));
    expect(result.problems).toEqual([]);
    expect(result.dsl).toBe('{\n  "query": {"bool":{"filter":[{"term":{"id":1}}],"must_not":[{"term":{"name":"x"}}]}}\n}');
    const missing = buildVisualDsl('{}', form({
      conditions: [condition({ id: 'a', field: 'name', operator: 'missing', valueType: 'string' })],
    }), FIELDS, form({}));
    expect(missing.dsl).toBe('{\n  "query": {"bool":{"must_not":[{"exists":{"field":"name"}}]}}\n}');
  });

  it('keeps a single scoring condition as a bare clause and a single filter condition inside bool.filter', () => {
    const must = buildVisualDsl('{}', form({ conditions: [condition({ field: 'id', operator: 'eq', valueType: 'number', value: '7' })] }), FIELDS, form({}));
    expect(must.dsl).toBe('{\n  "query": {"term":{"id":7}}\n}');
    const filter = buildVisualDsl('{}', form({ conditions: [condition({ field: 'id', operator: 'eq', context: 'filter', valueType: 'number', value: '7' })] }), FIELDS, form({}));
    expect(filter.dsl).toBe('{\n  "query": {"bool":{"filter":[{"term":{"id":7}}]}}\n}');
  });

  it('reuses the exact source token of unchanged values after structure changes', () => {
    const raw = '{"query":{"bool":{"filter":[{"term":{"id":9007199254740993}}]}}}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next: VisualForm = {
      ...parsed.form,
      conditions: [...parsed.form.conditions, condition({ id: 'new', field: 'name', operator: 'match', context: 'filter', value: 'y' })],
    };
    const result = buildVisualDsl(raw, next, FIELDS, parsed.form);
    expect(result.dsl).toBe('{"query":{"bool":{"filter":[{"term":{"id":9007199254740993}},{"match":{"name":"y"}}]}}}');
  });

  it('removes query, size and sort without leaving invalid JSON', () => {
    const raw = '{"query":{"term":{"id":1}},"size":25,"sort":[{"id":{"order":"asc"}}]}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = buildVisualDsl(raw, { mode: 'all', conditions: [], size: '', sort: null }, FIELDS, parsed.form);
    expect(result.problems).toEqual([]);
    expect(result.dsl).toBe('{}');
    const intermediate = '{"query":{"term":{"id":1}},"size":25}';
    const removal = buildVisualDsl(intermediate, { mode: 'all', conditions: [], size: '', sort: null }, FIELDS, {
      mode: 'all', conditions: parsed.form.conditions, size: '25', sort: null,
    });
    expect(removal.dsl).toBe('{}');
  });

  it('applies a valid size edit even while a condition row is still incomplete', () => {
    const result = buildVisualDsl('{}', form({
      conditions: [condition({ field: '', operator: 'eq', value: 'x' })],
      size: '5',
    }), FIELDS, form({}));
    expect(result.problems).toEqual([{ code: 'fieldRequired', conditionId: 'c0' }]);
    expect(result.dsl).toBe('{\n  "size": 5\n}');
  });

  it('omits the draft when nothing changed and never invents match_all', () => {
    const raw = '{"query":{"term":{"id":1}},"size":25}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(buildVisualDsl(raw, parsed.form, FIELDS, parsed.form).dsl).toBeUndefined();
    const removed = buildVisualDsl(raw, { mode: 'all', conditions: [], size: '25', sort: null }, FIELDS, parsed.form);
    expect(removed.dsl).toBe('{"size":25}');
    expect(removed.dsl).not.toContain('match_all');
  });
});

describe('buildVisualDsl: validation', () => {
  const invalid: Array<[string, Partial<VisualCondition> & Pick<VisualCondition, 'field' | 'operator'>, VisualForm['mode'], ReturnType<typeof buildVisualDsl>['problems'][number]['code']]> = [
    ['missing field', { field: ' ', operator: 'eq', value: 'x' }, 'all', 'fieldRequired'],
    ['conflicting field', { field: 'bad', operator: 'eq', value: 'x' }, 'all', 'fieldConflict'],
    ['nested field', { field: 'nestedDoc', operator: 'eq', value: 'x' }, 'all', 'fieldNested'],
    ['nested descendant', { field: 'items.price', operator: 'eq', value: '1', valueType: 'number' }, 'all', 'fieldNested'],
    ['non-searchable field', { field: 'secret', operator: 'eq', value: 'x' }, 'all', 'fieldNotSearchable'],
    ['range on text', { field: 'name', operator: 'gt', value: 'x' }, 'all', 'operatorNotAllowed'],
    ['match on boolean', { field: 'ok', operator: 'match', value: 'true', valueType: 'boolean' }, 'all', 'operatorNotAllowed'],
    ['string type on numeric field', { field: 'id', operator: 'eq', value: '5' }, 'all', 'valueTypeMismatch'],
    ['number type on boolean field', { field: 'ok', operator: 'eq', value: '1', valueType: 'number' }, 'all', 'valueTypeMismatch'],
    ['missing value', { field: 'id', operator: 'eq', value: ' ', valueType: 'number' }, 'all', 'valueRequired'],
    ['invalid number grammar', { field: 'id', operator: 'eq', value: '1.2.3', valueType: 'number' }, 'all', 'valueInvalidNumber'],
    ['leading zero', { field: 'id', operator: 'eq', value: '007', valueType: 'number' }, 'all', 'valueInvalidNumber'],
    ['invalid boolean', { field: 'ok', operator: 'eq', value: 'yes', valueType: 'boolean' }, 'all', 'valueInvalidBoolean'],
    ['negative in OR', { field: 'name', operator: 'neq', value: 'x' }, 'any', 'negativeInAny'],
  ];

  it.each(invalid)('rejects %s with %s and no draft', (_label, patch, mode, code) => {
    const result = buildVisualDsl('{}', form({ mode, conditions: [condition(patch)] }), FIELDS, form({}));
    expect(result.problems.map((problem) => problem.code)).toContain(code);
    expect(result.dsl).toBeUndefined();
  });

  it.each([['abc', 'sizeInvalid'], ['1.5', 'sizeInvalid'], ['-1', 'sizeInvalid'], ['20000', 'sizeOutOfRange'], [`${VISUAL_SIZE_MAX + 1}`, 'sizeOutOfRange']])(
    'rejects size "%s" with %s',
    (size, code) => {
      const result = buildVisualDsl('{}', form({ size }), FIELDS, form({}));
      expect(result.problems.map((problem) => problem.code)).toContain(code);
      expect(result.dsl).toBeUndefined();
    },
  );

  it('accepts valid number, boolean and long text values without coercion', () => {
    const result = buildVisualDsl('{}', form({
      conditions: [
        condition({ id: 'a', field: 'id', operator: 'gt', value: '9007199254740993', valueType: 'number' }),
        condition({ id: 'b', field: 'id', operator: 'lte', value: '1e3', valueType: 'number' }),
        condition({ id: 'c', field: 'ok', operator: 'eq', value: 'false', valueType: 'boolean' }),
        condition({ id: 'd', field: 'name', operator: 'match', value: 'café', valueType: 'string' }),
        condition({ id: 'e', field: 'custom', operator: 'eq', value: 'manual', valueType: 'string' }),
      ],
    }), FIELDS, form({}));
    expect(result.problems).toEqual([]);
    expect(result.dsl).toContain('"gt":9007199254740993');
    expect(result.dsl).toContain('"lte":1e3');
    expect(result.dsl).toContain('"ok":false');
    expect(result.dsl).toContain('"match":{"name":"café"}');
    expect(result.dsl).toContain('"custom":"manual"');
  });
});

describe('OR mode preserves filter context', () => {
  it('wraps filter rows so switching to OR does not promote them to scoring', () => {
    const result = buildVisualDsl('{}', form({
      mode: 'any',
      conditions: [condition({ field: 'id', operator: 'eq', context: 'filter', valueType: 'number', value: '1' })],
    }), FIELDS, form({}));
    expect(result.problems).toEqual([]);
    expect(result.dsl).toBe('{\n  "query": {"bool":{"should":[{"bool":{"filter":[{"term":{"id":1}}]}}],"minimum_should_match":1}}\n}');
  });

  it('round-trips scoring and non-scoring rows in one OR query', () => {
    const raw = '{"query":{"bool":{"should":[{"bool":{"filter":[{"term":{"id":1}}]}},{"match":{"name":"x"}}],"minimum_should_match":1}}}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.form.conditions.map((row) => row.context)).toEqual(['filter', 'must']);
    expect(buildVisualDsl(raw, parsed.form, FIELDS, parsed.form).dsl).toBeUndefined();
    const rebuilt = buildVisualDsl('{}', parsed.form, FIELDS, form({}));
    expect(rebuilt.dsl).toBe('{\n  "query": {"bool":{"should":[{"bool":{"filter":[{"term":{"id":1}}]}},{"match":{"name":"x"}}],"minimum_should_match":1}}\n}');
  });

  it('still rejects nested bool wrappers that are not the single filter wrapper', () => {
    expect(parseVisualForm('{"query":{"bool":{"should":[{"bool":{"must":[{"term":{"id":1}}]}}],"minimum_should_match":1}}}')).toEqual({ ok: false, reason: 'query' });
    expect(parseVisualForm('{"query":{"bool":{"should":[{"bool":{"filter":[{"term":{"id":1}},{"term":{"id":2}}]}}],"minimum_should_match":1}}}')).toEqual({ ok: false, reason: 'query' });
  });
});

describe('sort shorthands and validation', () => {
  it.each([
    ['["_score"]', '_score', 'desc'],
    ['["_doc"]', '_doc', 'asc'],
    ['["_shard_doc"]', '_shard_doc', 'asc'],
    ['["name"]', 'name', 'asc'],
    ['"id"', 'id', 'asc'],
  ])('reverses sort shorthand %s with the ES default direction', (fragment, field, direction) => {
    const raw = `{"sort":${fragment}}`;
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.form.sort).toEqual({ field, direction });
    expect(buildVisualDsl(raw, parsed.form, FIELDS, parsed.form).dsl).toBeUndefined();
  });

  it('keeps known unsortable sort drafts local without rewriting the last valid DSL', () => {
    const raw = '{"query":{"term":{"id":1}},"sort":[{"id":{"order":"asc"}}]}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const field of ['name', 'nestedDoc', 'items.price', 'bad', 'noAgg', '   ']) {
      const result = buildVisualDsl(raw, { ...parsed.form, sort: { field, direction: 'asc' } }, FIELDS, parsed.form);
      expect(result.dsl, field).toBeUndefined();
      const expected = field.trim() === '' ? 'sortFieldRequired' : 'sortFieldInvalid';
      expect(result.problems.map((problem) => problem.code), field).toContain(expected);
    }
  });

  it('allows built-in and manually typed sort fields and writes the explicit order form', () => {
    const raw = '{"query":{"term":{"id":1}}}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const field of ['_score', '_doc', '_shard_doc', 'manual']) {
      const result = buildVisualDsl(raw, { ...parsed.form, sort: { field, direction: 'asc' } }, FIELDS, parsed.form);
      expect(result.problems, field).toEqual([]);
      expect(result.dsl, field).toBe(`{"query":{"term":{"id":1}},\n  "sort": [{${JSON.stringify(field)}:{"order":"asc"}}]}`);
    }
  });

  it('makes the _score default direction explicit only when it is changed', () => {
    const raw = '{"query":{"term":{"id":1}},"sort":["_score"]}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.form.sort).toEqual({ field: '_score', direction: 'desc' });
    expect(buildVisualDsl(raw, parsed.form, FIELDS, parsed.form).dsl).toBeUndefined();
    const flipped = buildVisualDsl(raw, { ...parsed.form, sort: { field: '_score', direction: 'asc' } }, FIELDS, parsed.form);
    expect(flipped.dsl).toBe('{"query":{"term":{"id":1}},"sort":[{"_score":{"order":"asc"}}]}');
  });
});

describe('buildVisualDsl: fail closed on unsupported sources', () => {
  it.each([
    '{"query":{"match_all":{"boost":2}}}',
    '{"query":{"bool":{"filter":[{"term":{"id":1}}],"boost":2}}}',
    '{"query":@}',
    '{"size":1.5}',
  ])('never rewrites %s', (raw) => {
    const result = buildVisualDsl(raw, form({
      conditions: [condition({ field: 'id', operator: 'eq', valueType: 'number', value: '1' })],
      size: '7',
    }), FIELDS);
    expect(result.problems).toEqual([{ code: 'sourceUnsupported' }]);
    expect(result.dsl).toBeUndefined();
  });
});

describe('round-trip stability', () => {
  it.each([
    '{"query":{"term":{"id":9007199254740993}}}',
    '{"query":{"match":{"name":{"query":"x"}}}}',
    '{"query":{"range":{"id":{"gte":10}}}}',
    '{"query":{"exists":{"field":"name"}}}',
    '{"query":{"bool":{"filter":[{"term":{"id":1}},{"range":{"id":{"lt":5}}}]}}}',
    '{"query":{"bool":{"must":[{"match":{"name":"x"}}]}}}',
    '{"query":{"bool":{"must":[{"term":{"id":1}}],"filter":[{"exists":{"field":"name"}}]}}}',
    '{"query":{"bool":{"filter":[{"term":{"id":1}}],"must_not":[{"term":{"name":"x"}},{"exists":{"field":"ok"}}]}}}',
    '{"query":{"bool":{"should":[{"term":{"id":1}},{"match":{"name":"x"}}],"minimum_should_match":1}}}',
    '{"query":{"term":{"id":1}},"size":25,"sort":[{"id":{"order":"desc"}}],"unknown":{"kept":true}}',
  ])('is a fixed point for %s', (raw) => {
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(buildVisualDsl(raw, parsed.form, FIELDS, parsed.form).dsl).toBeUndefined();
  });

  it('re-emits an identical draft after a no-op forward build on canonical shapes', () => {
    const raw = '{"query":{"bool":{"filter":[{"term":{"id":1}}],"must_not":[{"exists":{"field":"ok"}}]}},"size":10}';
    const parsed = parseVisualForm(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = buildVisualDsl(raw, parsed.form, FIELDS, parsed.form);
    expect(result.dsl).toBeUndefined();
  });

  it('never emits an operator outside the parsed model', () => {
    const parsed = parseVisualForm('{"query":{"bool":{"must_not":[{"term":{"id":1}}]}}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.form.conditions.map((row) => row.operator)).toEqual(['neq']);
  });
});

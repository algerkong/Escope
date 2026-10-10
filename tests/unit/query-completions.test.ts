import { describe, expect, it } from 'vitest';
import {
  MAX_COMPLETION_DSL_BYTES, MAX_COMPLETION_FIELDS, MAX_COMPLETION_ITEMS, MAX_COMPLETION_NAME_BYTES,
  queryCompletions, type QueryCompletionContext,
} from '../../src/domain/query-completions';
import type { FieldCapability } from '../../src/domain/resource';

const target = { connectionId: 'c1', endpoint: 'http://localhost:9200', index: 'logs-*' };
const field = (name: string, type = 'keyword', searchable = true, aggregatable = true): FieldCapability => ({
  name, conflict: false, types: [{ type, searchable, aggregatable, metadata: false }],
});
const context: QueryCompletionContext = { target, fields: { target, catalog: { indices: ['logs-1'], fields: [
  field('status'), field('message', 'text', true, false), field('created', 'date'), field('bytes', 'long'),
  field('events.kind'), field('account', 'nested'), field('account.id'), field('point', 'geo_point'),
  field('not_searchable', 'keyword', false), field('not_aggregatable', 'keyword', true, false),
  { ...field('conflict'), conflict: true, types: [...field('x').types, ...field('x', 'long').types] },
] } } };

function suggestions(marked: string, input = context) {
  const offset = marked.indexOf('|');
  if (offset < 0) throw new Error('missingCursor');
  const source = marked.slice(0, offset) + marked.slice(offset + 1);
  return queryCompletions(source, offset, input);
}
const names = (marked: string, input = context) => suggestions(marked, input).map(({ name }) => name);
function apply(marked: string, name: string, input = context) {
  const source = marked.replace('|', '');
  const completion = suggestions(marked, input).find((item) => item.name === name)!;
  expect(completion).toBeDefined();
  return source.slice(0, completion.offset) + completion.text + source.slice(completion.offset + completion.length);
}
const local = { target: null };

describe('bounded JSON field completion positions', () => {
  it.each([
    '{"query":{"term":{"st|":9007199254740993}}}',
    '{"query":{"terms":{"st|":["ok"]}}}',
    '{"query":{"match":{"st|":"ok"}}}',
    '{"query":{"match_phrase":{"st|":"ok"}}}',
    '{"query":{"range":{"st|":{"gte":"a"}}}}',
    '{"post_filter":{"term":{"st|":"ok"}}}',
    '{"query":{"bool":{"filter":[{"term":{"st|":"ok"}}]}}}',
    '{"query":{"bool":{"should":{"bool":{"must_not":[{"term":{"st|":"ok"}}]}}}}}',
    '{"query":{"constant_score":{"filter":{"term":{"st|":"ok"}}}}}',
    '{"query":{"exists":{"field":"st|"}}}',
    '{"sort":[{"st|":"asc"}]}',
    '{"sort":{"st|":{"order":"asc","missing":"_last"}}}',
    '{"sort":["st|"]}',
    '{"sort":"st|"}',
    '{"fields":["st|"]}',
    '{"fields":[{"field":"st|","format":"epoch_millis"}]}',
    '{"_source":"st|"}',
    '{"_source":["st|"]}',
    '{"_source":{"includes":["st|"],"excludes":[]}}',
    '{"_source":{"excludes":"st|"}}',
  ])('completes only the explicit field token: %s', (marked) => {
    expect(names(marked)).toEqual(['status']);
    const edited = apply(marked, 'status');
    expect(edited).toBe(marked.replace('"st|"', '"status"').replace(' |', ' "status"'));
  });

  it('inserts an empty key without inventing a value or rewriting the rest of the query', () => {
    const marked = '{ "query": { "term": { | } }, "unknown": 9223372036854775807 }';
    expect(apply(marked, 'status')).toBe('{ "query": { "term": { "status":  } }, "unknown": 9223372036854775807 }');
    expect(apply('{"query":{"term":{"st|"}}}', 'status')).toBe('{"query":{"term":{"status": }}}');
    expect(apply('{"fields":[ | ]}', 'status')).toBe('{"fields":[ "status" ]}');
    expect(apply('{"query":{"exists":{"field": |}}}', 'status')).toBe('{"query":{"exists":{"field": "status"}}}');
  });

  it.each([
    '{"query":{"unknown":{"st|":"x"}}}',
    '{"unknown":{"term":{"st|":"x"}}}',
    '{"query":{"nested":{"path":"account","query":{"term":{"st|":"x"}}}}}',
    '{"query":{"query_string":{"query":"st|"}}}',
    '{"query":{"script":{"script":{"source":"st|"}}}}',
    '{"runtime_mappings":{"st|":{"type":"keyword"}}}',
    '{"aggs":{"terms":{"field":"st|"}}}',
    '{"query":{"term":{"status":"st|"}}}',
    '{"query":{"terms":{"boost|":2,"status":["ok"]}}}',
    '{"sort":[{"_script|":{"type":"number","script":"x"}}]}',
    '{"sort":[{"status":{"missing":"st|"}}]}',
    '{"docvalue_fields":["st|"]}',
    '{"$schema":"https://st|"}',
    '{"fields":[{"unknown":"st|"}]}',
    '{"_source":{"unknown":["st|"]}}',
    '{"st|":1}',
  ])('does not infer a field location in unsupported or literal text: %s', (marked) => {
    expect(suggestions(marked)).toEqual([]);
  });

  it('preserves every non-edited token, including exact numbers, escapes, whitespace and unknown clauses', () => {
    const marked = '{\r\n"query":{"term":{"st|":9223372036854775807}}, "x":0.1234567890123456789, "z":1e-1000, "a":"\\u0061", "unknown":{"raw":true}\r\n}';
    expect(apply(marked, 'status')).toBe(marked.replace('"st|"', '"status"'));
  });

  it('JSON-escapes exact returned field names without snippets, values or guessed subfields', () => {
    const input: QueryCompletionContext = { target, fields: { target, catalog: { indices: ['logs-1'], fields: [
      field('a"b\\c${value}'), field('status'), field('exact.path'),
    ] } } };
    expect(names('{"fields":["|"]}', input)).toEqual(['a"b\\c${value}', 'exact.path', 'status']);
    expect(apply('{"fields":["a|"]}', 'a"b\\c${value}', input)).toBe('{"fields":["a\\"b\\\\c${value}"]}');
    expect(names('{"fields":["\\u0073t|"]}', input)).toEqual(['status']);
    expect(names('{"fields":["STATUS|"]}', input)).toEqual(['status']);
    expect(names('{"fields":["status.|"]}', input)).toEqual([]);
  });

  it('does not introduce duplicate keys, including escaped sibling names', () => {
    expect(names('{"sort":{"|":"asc","\\u0073tatus":"desc"}}')).not.toContain('status');
    expect(suggestions('{"query":{"term":{"st|":"x"}},"size":1,"\\u0073ize":2}')).toEqual([]);
    expect(suggestions('{"query":{"term":{"st|":"x","st":"y"}}}')).toEqual([]);
  });

  it('keeps conflicting, non-searchable, nested, unsupported and non-aggregatable evidence separate', () => {
    const query = names('{"query":{"term":{"|":"x"}}}');
    expect(query).toContain('message');
    expect(query).toContain('events.kind');
    for (const absent of ['conflict', 'not_searchable', 'account', 'account.id', 'point']) expect(query).not.toContain(absent);
    const sort = names('{"sort":["|"]}');
    for (const absent of ['message', 'not_aggregatable', 'conflict', 'account.id', 'point']) expect(sort).not.toContain(absent);
    expect(sort).toContain('not_searchable');
    expect(names('{"query":{"exists":{"field":"|"}}}')).toContain('point');
    expect(names('{"fields":["|"]}')).toContain('not_searchable');
  });
});

describe('current evidence and local declaration boundaries', () => {
  it.each([
    { ...target, connectionId: 'c2' }, { ...target, endpoint: 'http://localhost:9201' },
    { ...target, index: 'logs-1' }, { ...target, index: 'logs-* ' },
  ])('rejects field evidence for a different immutable target: %o', (other) => {
    expect(suggestions('{"fields":["st|"]}', { ...context, target: other })).toEqual([]);
  });

  it('does not obtain fields for a missing, removed or uninspected target', () => {
    expect(suggestions('{"fields":["|"]}', local)).toEqual([]);
    expect(suggestions('{"fields":["|"]}', { ...context, target: null })).toEqual([]);
    expect(suggestions('{"fields":["|"]}', { target })).toEqual([]);
  });

  it('uses only current DSL runtime declarations, with explicit shadowing and no script text', () => {
    const marked = '{"runtime_mappings":{"status":{"type":"long","script":{"source":"emit(123); /* never-display */"}},"local":{"type":"keyword"}},"fields":["|"]}';
    const values = suggestions(marked);
    expect(values.filter(({ name }) => name === 'status')).toEqual([expect.objectContaining({
      name: 'status', type: 'long', origin: 'runtime', shadows: true,
    })]);
    expect(values).toContainEqual(expect.objectContaining({ name: 'local', origin: 'runtime', shadows: false }));
    expect(JSON.stringify(values)).not.toContain('never-display');
    expect(names('{"runtime_mappings":{"other":{"type":"keyword"}},"fields":["lo|"]}')).toEqual([]);
    expect(names(marked, local)).toEqual(['local', 'status']);
    const sourceNames = suggestions(marked.replace('"fields":["|"]', '"_source":["|"]'));
    expect(sourceNames).not.toContainEqual(expect.objectContaining({ name: 'local' }));
    expect(sourceNames).toContainEqual(expect.objectContaining({ name: 'status', origin: 'mapped' }));
  });

  it('never falls back to a mapped field when the runtime declaration is invalid', () => {
    expect(suggestions('{"runtime_mappings":{"status":{"type":"unknown"}},"fields":["st|"]}')).toEqual([]);
    expect(suggestions('{"runtime_mappings":{"status":{"type":"keyword","script":{"id":"stored"}}},"fields":["st|"]}')).toEqual([]);
    expect(names('{"fields":["st|"]}')).toEqual(['status']);
  });

  it('keeps runtime geo_point out of ordinary query and sort positions', () => {
    const base = '"runtime_mappings":{"local":{"type":"geo_point"}}';
    expect(names(`{${base},"query":{"term":{"lo|":"x"}}}`)).toEqual([]);
    expect(names(`{${base},"sort":["lo|"]}`)).toEqual([]);
    expect(names(`{${base},"query":{"exists":{"field":"lo|"}}}`)).toEqual(['local']);
    expect(names(`{${base},"fields":["lo|"]}`)).toEqual(['local']);
  });

  it('completes parameter names only in a whole-value placeholder without exposing template values', () => {
    const parameters = { version: 1, template: '{"private":"never-display"}', definitions: [
      { name: 'status', type: 'string' as const }, { name: 'size', type: 'number' as const },
    ] };
    const input = { target: null, parameters };
    const marked = '{"query":{"term":{"status":{"$param":"st|"}}}}';
    expect(suggestions(marked, input)).toEqual([expect.objectContaining({
      name: 'status', origin: 'parameter', type: 'string', text: '"status"',
    })]);
    expect(apply(marked, 'status', input)).toBe(marked.replace('"st|"', '"status"'));
    expect(names('{"size":{"$param": |}}', input)).toEqual(['size', 'status']);
    expect(JSON.stringify(suggestions(marked, input))).not.toContain('never-display');
    expect(parameters.template).toBe('{"private":"never-display"}');
    for (const unsupported of [
      '{"$param":"st|"}', '{"size":{"$param":"st|","other":1}}', '{"size":{"$par|":"status"}}',
      '{"query":{"term":{"status":"st|"}}}', '{"size": |}',
    ]) expect(suggestions(unsupported, input)).toEqual([]);
    expect(suggestions(marked, local)).toEqual([]);
    expect(suggestions(marked, { ...input, parameters: { ...parameters, version: 2 } })).toEqual([]);
  });
});

describe('completion work and input limits', () => {
  it('bounds output after prefix matching, not before it', () => {
    const input = { target, fields: { target, catalog: { indices: [], fields: Array.from({ length: 160 },
      (_, i) => field(`field${String(i).padStart(3, '0')}`)) } } };
    expect(suggestions('{"fields":["|"]}', input)).toHaveLength(MAX_COMPLETION_ITEMS);
    expect(names('{"fields":["field14|"]}', input)).toHaveLength(10);
    expect(names('{"fields":["field159|"]}', input)).toEqual(['field159']);
  });

  it('rejects oversized evidence and unsafe names without generating partial names', () => {
    const input = { target, fields: { target, catalog: { indices: [], fields: Array.from({ length: MAX_COMPLETION_FIELDS + 1 },
      (_, i) => field(`field${i}`)) } } };
    expect(suggestions('{"fields":["|"]}', input)).toEqual([]);
    const namesToCheck = ['*', 'x?', '', ' ', 'line\nbreak', 'control\u0000', 'bidi\u202e', 'a'.repeat(MAX_COMPLETION_NAME_BYTES + 1),
      '\u4e2d'.repeat(342), 'valid'];
    expect(names('{"fields":["|"]}', { target, fields: { target, catalog: { indices: [], fields: namesToCheck.map((name) => field(name)) } } }))
      .toEqual(['valid']);
  });

  it.each([
    '{"fields":["st|]}', '{"fields":[st|]}', '{"fields":["\\u0|"]}',
    '{"fields":["st|"],}', '{"fields":["st|"],/* comment */"size":2}',
    '["st|"]', '{"fields":["st|"],"invalid":@}',
  ])('does not repair malformed or ambiguous JSON: %s', (marked) => {
    expect(suggestions(marked)).toEqual([]);
  });

  it('bounds JSON bytes and nesting before recursive parsing, and validates cursor offsets', () => {
    expect(suggestions(`{"fields":["st|"],"x":"${'x'.repeat(MAX_COMPLETION_DSL_BYTES)}"}`)).toEqual([]);
    expect(suggestions(`{"fields":["st|"],"x":"${'\u4e2d'.repeat(MAX_COMPLETION_DSL_BYTES / 2)}"}`)).toEqual([]);
    expect(suggestions(`{"fields":["st|"],"x":${'['.repeat(65)}0${']'.repeat(65)}}`)).toEqual([]);
    for (const offset of [-1, 0.1, 999, NaN]) expect(queryCompletions('{"fields":[""]}', offset, context)).toEqual([]);
  });
});

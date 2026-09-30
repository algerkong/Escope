import { describe, expect, it } from 'vitest';
import { formatQueryDsl, validateQueryDsl } from '../../src/domain/query-dsl';
import {
  QUERY_DSL_CONTRACT_VERSION,
  acceptResponse,
  cancelExecution,
  createQuery,
  createSnapshot,
  createValidatedSnapshot,
  type ExecutionState,
  type QueryDocument,
} from '../../src/domain/query';

const at = new Date('2026-09-30T00:00:00.000Z');

/** Formatting may only touch whitespace, so the remaining characters must be identical. */
const withoutWhitespace = (text: string) => text.replace(/\s+/g, '');
const unsupportedDsl = '{"runtime_mappings":{"p":{"type":"long","script":{"source":"emit(9007199254740993)"}}},"query":{"script":{"script":{"lang":"painless","source":"doc[\'x\'].value > params.p","params":{"p":9223372036854775807}}}},"_source":false,"track_total_hits":false}';

describe('query DSL validation', () => {
  it('rejects empty and blank drafts', () => {
    expect(validateQueryDsl('')).toEqual({ ok: false, error: { code: 'dslEmpty' } });
    expect(validateQueryDsl('  \n\t ')).toEqual({ ok: false, error: { code: 'dslEmpty' } });
  });

  it('keeps the draft verbatim as the source of truth', () => {
    const draft = '{\n  "query": {"match_all": {}},\n  "size":25\n}';
    expect(validateQueryDsl(draft)).toEqual({ ok: true, source: draft });
  });

  it('accepts unknown but well-formed ES DSL without rewriting it', () => {
    expect(validateQueryDsl(unsupportedDsl)).toEqual({ ok: true, source: unsupportedDsl });
  });

  it.each(['[]', '[1,2]', '1', '-2.5', '1e400', '"text"', 'true', 'null'])('rejects the non-object root %s', (draft) => {
    expect(validateQueryDsl(draft)).toEqual({ ok: false, error: { code: 'dslNotObject' } });
  });

  it('reports syntax errors with a position and no draft text', () => {
    const draft = '{\n  "query": {\n    "match_all": {}\n  },\n  "size": 25,\n}';
    expect(validateQueryDsl(draft)).toEqual({ ok: false, error: { code: 'dslSyntaxError', line: 6, column: 1 } });
  });

  it('rejects conflicting duplicate keys', () => {
    const draft = '{\n  "size": 25,\n  "size": 50\n}';
    expect(validateQueryDsl(draft)).toEqual({ ok: false, error: { code: 'dslDuplicateKey', line: 3, column: 4 } });
  });

  it('flags nested duplicates without treating sibling array items as duplicates', () => {
    const siblings = '{"query":{"bool":{"should":[{"term":{"a":1}},{"term":{"a":2}}]}}}';
    expect(validateQueryDsl(siblings)).toEqual({ ok: true, source: siblings });
    const nested = '{\n  "query": {\n    "term": {\n      "id": 1,\n      "id": 2\n    }\n  }\n}';
    expect(validateQueryDsl(nested)).toEqual({ ok: false, error: { code: 'dslDuplicateKey', line: 5, column: 8 } });
  });

  it('rejects duplicate keys even when both values are equal', () => {
    expect(validateQueryDsl('{"size":25,"size":25}'))
      .toEqual({ ok: false, error: { code: 'dslDuplicateKey', line: 1, column: 13 } });
  });

  it('treats escaped keys that decode to the same name as duplicates', () => {
    expect(validateQueryDsl('{"\\u0073ize":25,"size":25}'))
      .toEqual({ ok: false, error: { code: 'dslDuplicateKey', line: 1, column: 18 } });
  });

  it('rejects comments and trailing commas that strict JSON forbids', () => {
    expect(validateQueryDsl('{"size":25} // note'))
      .toEqual({ ok: false, error: { code: 'dslSyntaxError', line: 1, column: 13 } });
    expect(validateQueryDsl('{"size":25,}'))
      .toEqual({ ok: false, error: { code: 'dslSyntaxError', line: 1, column: 12 } });
  });

  it('never leaks duplicate key names or values', () => {
    const result = validateQueryDsl('{"secret_key":"secret_value","secret_key":"secret_value"}');
    expect(result).toEqual({ ok: false, error: { code: 'dslDuplicateKey', line: 1, column: 31 } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret_key');
    expect(serialized).not.toContain('secret_value');
  });

  it('never returns parser messages or draft fragments', () => {
    const result = validateQueryDsl('{"secret_marker": @@@}');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejected draft');
    expect(result.error).toMatchObject({ code: 'dslSyntaxError' });
    expect(Object.keys(result.error).sort()).toEqual(['code', 'column', 'line']);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret_marker');
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('at position');
    expect(serialized).not.toContain('but got');
  });

  it('fails nesting beyond the parser stack as a resource failure', () => {
    const draft = `${'['.repeat(100000)}1${']'.repeat(100000)}`;
    expect(validateQueryDsl(draft)).toEqual({ ok: false, error: { code: 'dslParseFailed' } });
  });
});

describe('query DSL formatting', () => {
  it('keeps numeric text lossless for large integers, long decimals and exponents', () => {
    const draft = '{"big":9007199254740993,"longMax":9223372036854775807,"longMin":-9223372036854775808,"negative":-9007199254740993,"decimal":0.30000000000000004,"exponent":1e400,"negativeExponent":-2E-3}';
    // Control: these values are real precision hazards for JSON.parse.
    expect(JSON.parse('{"big":9007199254740993}').big).toBe(9007199254740992);
    const result = formatQueryDsl(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected formatted output');
    for (const token of ['9007199254740993', '9223372036854775807', '-9223372036854775808', '-9007199254740993', '0.30000000000000004', '1e400', '-2E-3']) {
      expect(result.formatted).toContain(token);
    }
    expect(result.source).toBe(draft);
    expect(withoutWhitespace(result.formatted)).toBe(withoutWhitespace(draft));
  });

  it('reformats nested objects, arrays and escaped strings with whitespace-only edits', () => {
    const draft = '{"a":{"b":[1,{"c":"line\\n\\t\\"quoted\\" caf\\u00e9"}]},"empty":{},"list":[]}';
    const result = formatQueryDsl(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected formatted output');
    expect(result.formatted).toBe([
      '{',
      '  "a": {',
      '    "b": [',
      '      1,',
      '      {',
      '        "c": "line\\n\\t\\"quoted\\" caf\\u00e9"',
      '      }',
      '    ]',
      '  },',
      '  "empty": {},',
      '  "list": []',
      '}',
    ].join('\n'));
    // Whitespace-only: every escape sequence and value stays byte-identical.
    expect(withoutWhitespace(result.formatted)).toBe(withoutWhitespace(draft));
    expect((JSON.parse(result.formatted) as { a: { b: [number, { c: string }] } }).a.b[1]?.c).toBe('line\n\t"quoted" café');
  });

  it('is idempotent and returns the draft untouched', () => {
    const draft = '{"query":{"match_all":{}},"size":25}';
    const once = formatQueryDsl(draft);
    expect(once.ok).toBe(true);
    if (!once.ok) throw new Error('expected formatted output');
    expect(once.formatted).toBe('{\n  "query": {\n    "match_all": {}\n  },\n  "size": 25\n}');
    expect(once.source).toBe(draft);
    const twice = formatQueryDsl(once.formatted);
    expect(twice.ok).toBe(true);
    if (!twice.ok) throw new Error('expected formatted output');
    expect(twice.formatted).toBe(once.formatted);
  });

  it('preserves unsupported ES DSL keys and values through formatting', () => {
    const result = formatQueryDsl(unsupportedDsl);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected formatted output');
    expect(result.formatted).toContain('"runtime_mappings"');
    expect(result.formatted).toContain('"painless"');
    expect(result.formatted).toContain("doc['x'].value > params.p");
    expect(result.formatted).toContain('9007199254740993');
    expect(result.formatted).toContain('9223372036854775807');
    // Independent check: the output is standard JSON with every key still present.
    expect(Object.keys(JSON.parse(result.formatted) as Record<string, unknown>)).toEqual(['runtime_mappings', 'query', '_source', 'track_total_hits']);
  });

  it('never drops or rewrites properties that a re-serializer would mishandle', () => {
    const draft = '{"__proto__":{"polluted":true},"size":25}';
    const result = formatQueryDsl(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected formatted output');
    expect(result.formatted).toContain('"__proto__"');
    expect(result.formatted).toContain('"polluted"');
    expect(withoutWhitespace(result.formatted)).toBe(withoutWhitespace(draft));
  });

  it('returns the same structured error as validation for unusable drafts', () => {
    for (const draft of ['', '  ', '{', 'nope', '[]', '{"a":1,"a":2}']) {
      const validation = validateQueryDsl(draft);
      expect(validation.ok).toBe(false);
      if (validation.ok) throw new Error('expected a rejected draft');
      expect(formatQueryDsl(draft)).toEqual({ ok: false, error: validation.error });
    }
  });
});

describe('validated execution snapshot', () => {
  const draft = '{"query":{"term":{"id":9007199254740993}}}';

  it('freezes a versioned snapshot with verbatim DSL and connection binding', () => {
    const query: QueryDocument = { ...createQuery('a'), index: 'orders-*', revision: 7, dsl: draft };
    const result = createValidatedSnapshot(query, 'r1', at);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a validated snapshot');
    expect(result.snapshot).toMatchObject({
      requestId: 'r1', queryId: query.id, connectionId: 'a', index: 'orders-*',
      rawDsl: draft, revision: 7, startedAt: '2026-09-30T00:00:00.000Z',
      dslContractVersion: QUERY_DSL_CONTRACT_VERSION,
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    query.dsl = '{}';
    query.index = 'other-*';
    query.revision = 8;
    expect(result.snapshot.rawDsl).toBe(draft);
    expect(result.snapshot.index).toBe('orders-*');
    expect(result.snapshot.revision).toBe(7);
  });

  it('rejects unusable drafts and unbound targets as structured codes', () => {
    expect(createValidatedSnapshot({ ...createQuery('a'), index: 'orders-*', dsl: '{"size": }' }, 'r1', at))
      .toEqual({ ok: false, error: { code: 'dslSyntaxError', line: 1, column: 10 } });
    expect(createValidatedSnapshot({ ...createQuery(null), dsl: '' }, 'r1', at))
      .toEqual({ ok: false, error: { code: 'dslEmpty' } });
    expect(createValidatedSnapshot(createQuery(null), 'r1', at)).toEqual({ ok: false, error: { code: 'noConnection' } });
    expect(createValidatedSnapshot({ ...createQuery('a'), index: '   ' }, 'r1', at)).toEqual({ ok: false, error: { code: 'invalidIndex' } });
  });

  it('rejects an invalid execution timestamp instead of throwing', () => {
    const query: QueryDocument = { ...createQuery('a'), index: 'orders-*' };
    expect(createValidatedSnapshot(query, 'r1', new Date(Number.NaN)))
      .toEqual({ ok: false, error: { code: 'invalidTimestamp' } });
    // The legacy path keeps throwing; the validated gate is the structured entry point.
    expect(() => createSnapshot(query, 'r1', new Date(Number.NaN))).toThrow(RangeError);
  });

  it('keeps the legacy snapshot contract and response isolation intact', () => {
    const query: QueryDocument = { ...createQuery('a'), index: 'orders-*', dsl: draft };
    const legacy = createSnapshot(query, 'r1', at);
    expect(legacy.rawDsl).toBe(draft);
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(() => createSnapshot(createQuery(null), 'r1', at)).toThrow('noConnection');
    expect(() => createSnapshot({ ...createQuery('a') }, 'r1', at)).toThrow('invalidIndex');

    const validated = createValidatedSnapshot(query, 'r2', at);
    if (!validated.ok) throw new Error('expected a validated snapshot');
    const state: ExecutionState = { status: 'running', snapshot: validated.snapshot };
    expect(acceptResponse(state, { requestId: 'r1', connectionId: 'a', rawResponse: '{}' })).toBe(state);
    expect(acceptResponse(state, { requestId: 'r2', connectionId: 'b', rawResponse: '{}' })).toBe(state);
    const cancelled = cancelExecution(state);
    expect(acceptResponse(cancelled, { requestId: 'r2', connectionId: 'a', rawResponse: '{}' })).toBe(cancelled);
    const accepted = acceptResponse(state, { requestId: 'r2', connectionId: 'a', rawResponse: '{}', partial: true });
    expect(accepted).toMatchObject({ status: 'partial', rawResponse: '{}' });
    if (accepted.status !== 'partial') throw new Error('expected a partial response');
    expect(accepted.snapshot).toBe(validated.snapshot);
  });
});

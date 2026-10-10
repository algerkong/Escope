import { describe, expect, it } from 'vitest';
import {
  MAX_COMPARISON_DEPTH, MAX_COMPARISON_FIELDS, MAX_COMPARISON_HIT_BYTES, MAX_COMPARISON_NUMBER_LENGTH,
  compareLoadedDocuments, isComparisonDifference, type ComparisonSection, type DocumentComparison,
} from '../../src/domain/document-comparison';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { parseQueryResult, sliceRaw } from '../../src/domain/query-result';
import type { ResultGridRow } from '../../src/domain/result-grid';
import type { ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { enDocumentComparison, zhDocumentComparison } from '../../src/locales/document-comparison';

function fixture(documents: readonly string[], dsl = '{}') {
  const query = { ...createQuery('connection-1'), index: 'orders-*', dsl };
  const snapshot = createSnapshot(query, 'execution-1', new Date('2026-10-10T00:00:00Z'));
  const pages: ExecutionPage[] = documents.map((raw) => {
    const rawResponse = `{"hits":{"hits":[${raw}]}}`;
    const parsed = parseQueryResult(rawResponse);
    if (!parsed.ok) throw new Error('valid fixture required');
    return { rawResponse, summary: parsed.summary, cursor: null, partial: false };
  });
  const rows: ResultGridRow[] = pages.map((page, pageIndex) => ({ hit: page.summary.hits[0]!, pageIndex, position: 0 }));
  const compare = (selection: readonly ResultGridRow[] = rows) => compareLoadedDocuments(snapshot, 'https://es.test', pages, selection);
  return { query, snapshot, pages, rows, compare };
}

function comparison(left: string, right: string, dsl = '{}'): DocumentComparison {
  const result = fixture([left, right], dsl).compare();
  if (!result.ok) throw new Error(result.code);
  return result.comparison;
}

const source = (raw: string) => `{"_source":${raw}}`;
const field = (value: DocumentComparison, name: string | null, section: ComparisonSection = 'source') => {
  const row = value.rows.find((row) => row.section === section && row.field === name);
  if (!row) throw new Error(`missing comparison row ${section}/${name}`);
  return row;
};

describe('bounded loaded document comparison', () => {
  it('retains whole-hit ranges and uses the actual received page, not duplicate IDs or source shadows', () => {
    const left = '{"_index":"orders-1","_id":"same","_source":{"_id":"shadow","n":9007199254740993}}';
    const right = '{"_index":"orders-2","_id":"same","_source":{"_id":"shadow","n":9007199254740992}}';
    const f = fixture([left, right]);
    expect(sliceRaw(f.pages[0]!.rawResponse, f.rows[0]!.hit.raw)).toBe(left);
    const result = f.compare();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comparison.left).toMatchObject({ pageIndex: 0, position: 0, raw: left, id: { raw: '"same"' }, index: { raw: '"orders-1"' } });
    expect(result.comparison.right).toMatchObject({ pageIndex: 1, position: 0, raw: right, id: { raw: '"same"' }, index: { raw: '"orders-2"' } });
    expect(field(result.comparison, '_id').left.raw).toBe('"shadow"');
    expect(field(result.comparison, '_id', 'metadata').left.raw).toBe('"same"');
    expect(field(result.comparison, 'n').status).toBe('changed');
  });

  it('does not label the positional fallback ID as a real _id or turn absent metadata into null', () => {
    const result = comparison('{}', '{"_id":null,"_index":null}');
    expect(result.left.id).toEqual({ kind: 'missing', raw: null });
    expect(result.right.id).toEqual({ kind: 'null', raw: 'null' });
    expect(result.left.index).toEqual({ kind: 'missing', raw: null });
    expect(field(result, '_id', 'metadata').status).toBe('rightOnly');
    expect(field(result, '_index', 'metadata').status).toBe('rightOnly');
  });

  it.each([
    ['9007199254740993', '9007199254740992', 'changed'],
    ['-9007199254740993', '-9007199254740992', 'changed'],
    ['1.1000000000000001', '1.1000000000000002', 'changed'],
    ['1E400', '10e399', 'equal'],
    ['1e-4000', '1e-4001', 'changed'],
    ['1.0000', '1', 'equal'],
    ['-0.0', '0', 'equal'],
    ['"1"', '1', 'typeChanged'],
    ['false', 'true', 'changed'],
    ['null', '[]', 'typeChanged'],
    ['""', 'null', 'typeChanged'],
  ] as const)('compares %s and %s without rounding or coercion', (a, b, expected) => {
    const row = field(comparison(source(`{"n":${a}}`), source(`{"n":${b}}`)), 'n');
    expect(row.status).toBe(expected);
    expect(row.left.raw).toBe(a);
    expect(row.right.raw).toBe(b);
  });

  it('compares nested objects by literal keys and arrays by order, preserving original whitespace and escapes', () => {
    const a = '{"b":9007199254740993, "a":"\\u0061"}';
    const b = '{ "a":"a", "b":9007199254740993 }';
    const result = comparison(source(`{"obj":${a},"array":[1,2,{"x":4}],"ordered":[1,2]}`),
      source(`{"obj":${b},"array":[1.0,2,{"x":4}],"ordered":[2,1]}`));
    expect(field(result, 'obj')).toMatchObject({ status: 'equal', left: { raw: a }, right: { raw: b } });
    expect(field(result, 'array').status).toBe('equal');
    expect(field(result, 'ordered').status).toBe('changed');
  });

  it('compares complete values even when the grid previews are identical', () => {
    const prefix = 'x'.repeat(1000);
    const f = fixture([source(`{"text":"${prefix}a"}`), source(`{"text":"${prefix}b"}`)]);
    expect(f.rows[0]!.hit.columns[0]!.preview).toBe(f.rows[1]!.hit.columns[0]!.preview);
    const result = f.compare();
    if (!result.ok) throw new Error(result.code);
    expect(field(result.comparison, 'text')).toMatchObject({
      status: 'changed', left: { raw: `"${prefix}a"` }, right: { raw: `"${prefix}b"` },
    });
  });

  it('distinguishes missing, null, empty arrays, empty objects and strings in the returned values', () => {
    const result = comparison(source('{"null":null,"array":[],"object":{},"text":"","boolean":false}'), source('{}'));
    for (const name of ['null', 'array', 'object', 'text', 'boolean']) {
      expect(field(result, name).right).toEqual({ kind: 'missing', raw: null });
      expect(field(result, name).status).toBe('leftOnly');
    }
    expect(field(result, 'null').left).toEqual({ kind: 'null', raw: 'null' });
    expect(field(result, 'array').left).toEqual({ kind: 'array', raw: '[]' });
    expect(field(result, 'object').left).toEqual({ kind: 'object', raw: '{}' });
  });

  it.each([
    ['{}', '{"_source":null}', 'missing', 'null', 'rightOnly'],
    ['{"_source":{}}', '{}', 'object', 'missing', 'leftOnly'],
    ['{"_source":[]}', '{"_source":{}}', 'array', 'object', 'typeChanged'],
    ['{"_source":null}', '{"_source":null}', 'null', 'null', 'equal'],
    ['{}', '{}', 'missing', 'missing', 'unavailable'],
  ] as const)('keeps non-object or absent source containers whole: %s vs %s', (a, b, left, right, status) => {
    expect(field(comparison(a, b), null)).toMatchObject({ status, left: { kind: left }, right: { kind: right } });
  });

  it('does not flatten dotted or escaped field names, or confuse them with object paths and prototype keys', () => {
    const result = comparison(source('{"a.b":1,"a":{"b":2},"__proto__":3,"constructor":4,"x/~":5,"a\\"b":6}'),
      source('{"a.b":2,"a":{"b":2},"__proto__":4,"constructor":4,"x/~":5,"a\\"b":6}'));
    expect(field(result, 'a.b').status).toBe('changed');
    expect(field(result, 'a').status).toBe('equal');
    expect(field(result, '__proto__').status).toBe('changed');
    expect(field(result, 'constructor').status).toBe('equal');
    expect(field(result, 'x/~').status).toBe('equal');
    expect(field(result, 'a"b').status).toBe('equal');
    expect(new Set(result.rows.map((row) => row.key)).size).toBe(result.rows.length);
  });

  it('compares source and fields independently and only marks runtime names from the executed DSL', () => {
    const dsl = '{"runtime_mappings":{"rank":{"type":"long","script":{"source":"emit(9007199254740993L)"}},"absent":{"type":"keyword"}}}';
    const result = comparison('{"_source":{"rank":10},"fields":{"rank":[9007199254740993],"other":[1]}}',
      '{"_source":{"rank":10},"fields":{"other":[1]}}', dsl);
    expect(field(result, 'rank')).toMatchObject({ runtime: false, status: 'equal', left: { raw: '10' } });
    expect(field(result, 'rank', 'fields')).toMatchObject({
      runtime: true, status: 'leftOnly', left: { raw: '[9007199254740993]' }, right: { kind: 'missing', raw: null },
    });
    expect(field(result, 'absent', 'fields')).toMatchObject({ runtime: true, status: 'unavailable' });
    expect(field(result, 'other', 'fields').runtime).toBe(false);
    expect(JSON.stringify(result)).not.toContain('emit(');
    expect(JSON.stringify(result)).not.toContain('rawDsl');
  });

  it('does not fill missing fields from _source or pretend that absent containers are equal values', () => {
    const result = comparison('{"_source":{"n":3}}', '{"fields":{"n":[3]}}');
    expect(field(result, 'n')).toMatchObject({ status: 'leftOnly', right: { kind: 'missing' } });
    expect(field(result, 'n', 'fields')).toMatchObject({ status: 'rightOnly', left: { kind: 'missing' } });
    expect(isComparisonDifference('unavailable')).toBe(false);
    expect(isComparisonDifference('equal')).toBe(false);
    expect(isComparisonDifference('typeChanged')).toBe(true);
  });

  it('preserves empty versus absent fields containers even when all declared runtime values are missing', () => {
    const result = comparison('{"fields":{}}', '{}', '{"runtime_mappings":{"n":{"type":"long"}}}');
    expect(field(result, null, 'fields')).toMatchObject({ status: 'leftOnly', left: { raw: '{}' }, right: { kind: 'missing' } });
    expect(field(result, 'n', 'fields')).toMatchObject({ runtime: true, status: 'unavailable' });
  });

  it('freezes a small execution origin and the complete comparison, without retaining mutable pages or current drafts', () => {
    const f = fixture([source('{"n":1}'), source('{"n":2}')]);
    f.pages[1] = { ...f.pages[1]!, partial: true };
    const result = f.compare();
    if (!result.ok) throw new Error(result.code);
    const saved = result.comparison;
    const before = JSON.stringify(saved);
    expect(saved.origin).toEqual({
      queryId: f.query.id, requestId: 'execution-1', connectionId: 'connection-1',
      endpoint: 'https://es.test', index: 'orders-*', startedAt: '2026-10-10T00:00:00.000Z',
    });
    expect(saved.right.partial).toBe(true);
    for (const item of [saved, saved.origin, saved.left, saved.left.id, saved.rows, saved.rows[0], saved.rows[0]!.left]) {
      expect(Object.isFrozen(item)).toBe(true);
    }
    f.query.index = 'other-*';
    f.pages[0] = { ...f.pages[0]!, rawResponse: '{"hits":{"hits":[]}}' };
    expect(JSON.stringify(saved)).toBe(before);
  });

  it.each([0, 1, 3])('requires exactly two records, not %s', (count) => {
    const f = fixture(['{}', '{}', '{}']);
    expect(f.compare(f.rows.slice(0, count))).toEqual({ ok: false, code: 'selection' });
  });

  it('rejects the same occurrence twice but permits distinct occurrences with the same _index and _id', () => {
    const f = fixture(['{"_index":"x","_id":"same"}', '{"_index":"x","_id":"same"}']);
    expect(f.compare([f.rows[0]!, f.rows[0]!])).toEqual({ ok: false, code: 'selection' });
    expect(f.compare().ok).toBe(true);
  });

  it('rejects an old row object even if a new page contains the same ID and position', () => {
    const f = fixture(['{"_id":"same"}', '{}']);
    const replacement = fixture(['{"_id":"same"}', '{}']);
    expect(f.compare([replacement.rows[0]!, f.rows[1]!])).toEqual({ ok: false, code: 'unavailable' });
  });

  it.each([
    { pageIndex: -1 }, { pageIndex: 1.5 }, { pageIndex: 4 }, { pageIndex: NaN },
    { position: -1 }, { position: 1.5 }, { position: 1 }, { position: Infinity },
  ])('rejects unavailable or invalid received positions %j', (patch) => {
    const f = fixture(['{}', '{}']);
    expect(f.compare([{ ...f.rows[0]!, ...patch }, f.rows[1]!])).toEqual({ ok: false, code: 'unavailable' });
  });

  it('refuses an invalid hit range instead of reading a different part of the response', () => {
    const f = fixture(['{}', '{}']);
    const hit = { ...f.rows[0]!.hit, raw: { offset: 0, length: 9999999 } };
    f.pages[0] = { ...f.pages[0]!, summary: { ...f.pages[0]!.summary, hits: [hit] } };
    expect(f.compare([{ ...f.rows[0]!, hit }, f.rows[1]!])).toEqual({ ok: false, code: 'unavailable' });
  });

  it.each(['{"n":1,"n":2}', '{"n":1,"\\u006e":2}', '{"n":1,}', '{"n":/*x*/1}', '{"n":1}suffix', '[]'])(
    'rejects ambiguous or non-object raw hits (%s)', (raw) => {
      const f = fixture(['{}', '{}']);
      const hit = { ...f.rows[0]!.hit, raw: { offset: 0, length: raw.length } };
      f.pages[0] = { ...f.pages[0]!, rawResponse: raw, summary: { ...f.pages[0]!.summary, hits: [hit] } };
      expect(f.compare([{ ...f.rows[0]!, hit }, f.rows[1]!])).toEqual({ ok: false, code: 'invalidDocument' });
    });

  it('accepts the exact byte boundary and rejects an oversized hit without partial rows', () => {
    const prefix = '{"_source":{"text":"';
    const suffix = '"}}';
    const raw = prefix + 'x'.repeat(MAX_COMPARISON_HIT_BYTES - prefix.length - suffix.length) + suffix;
    expect(fixture([raw, '{}']).compare().ok).toBe(true);
    const oversized = fixture([prefix + 'x' + raw.slice(prefix.length), '{}']).compare();
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.code).toBe('tooLarge');
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    const raw = source(`{"text":"${'\u4e2d'.repeat(Math.floor(MAX_COMPARISON_HIT_BYTES / 3))}"}`);
    expect(raw.length).toBeLessThan(MAX_COMPARISON_HIT_BYTES);
    expect(fixture([raw, '{}']).compare()).toEqual({ ok: false, code: 'tooLarge' });
  });

  it('enforces the container depth before parsing the selected hit', () => {
    const raw = (arrays: number) => source(`{"deep":${'['.repeat(arrays)}0${']'.repeat(arrays)}}`);
    expect(fixture([raw(MAX_COMPARISON_DEPTH - 2), '{}']).compare().ok).toBe(true);
    expect(fixture([raw(MAX_COMPARISON_DEPTH - 1), '{}']).compare()).toEqual({ ok: false, code: 'tooDeep' });
  });

  it('bounds token work independently of document bytes', () => {
    const raw = source(`{"array":[${Array.from({ length: 50_000 }, () => '0').join(',')}]}`);
    expect(raw.length).toBeLessThan(MAX_COMPARISON_HIT_BYTES);
    expect(fixture([raw, '{}']).compare()).toEqual({ ok: false, code: 'tooComplex' });
  });

  it('bounds numeric tokens before exact BigInt exponent work', () => {
    const raw = source(`{"n":1e${'1'.repeat(MAX_COMPARISON_NUMBER_LENGTH)}}`);
    expect(fixture([raw, '{}']).compare()).toEqual({ ok: false, code: 'tooComplex' });
    expect(fixture([source(`{"n":${'1'.repeat(MAX_COMPARISON_NUMBER_LENGTH)}}`), '{}']).compare().ok).toBe(true);
  });

  it('bounds the combined field union including unavailable container rows', () => {
    const raw = (count: number) => source(`{${Array.from({ length: count }, (_, index) => `"field-${index}":0`).join(',')}}`);
    expect(fixture([raw(MAX_COMPARISON_FIELDS - 1), '{}']).compare().ok).toBe(true);
    expect(fixture([raw(MAX_COMPARISON_FIELDS), '{}']).compare()).toEqual({ ok: false, code: 'tooComplex' });
  });

  it('keeps English and Chinese keys aligned', () => {
    expect(Object.keys(enDocumentComparison).sort()).toEqual(Object.keys(zhDocumentComparison).sort());
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_DETAIL_NODES, MAX_DOCUMENT_DETAIL_PATH_BYTES,
  documentFieldValue, inspectLoadedDocument, visibleDocumentFields, type DocumentDetail,
} from '../../src/domain/document-detail';
import {
  MAX_LOADED_DOCUMENT_BYTES, MAX_LOADED_DOCUMENT_DEPTH, MAX_LOADED_DOCUMENT_NUMBER_LENGTH,
} from '../../src/domain/loaded-document';
import { createQuery, createSnapshot } from '../../src/domain/query';
import { parseQueryResult } from '../../src/domain/query-result';
import type { ResultGridRow } from '../../src/domain/result-grid';
import type { ExecutionPage } from '../../src/features/query/useQueryExecutions';
import { enDocumentDetail, zhDocumentDetail } from '../../src/locales/document-detail';

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
  const inspect = (row = rows[0]!) => inspectLoadedDocument(snapshot, 'https://es.test', pages, row);
  return { query, snapshot, pages, rows, inspect };
}

function detail(raw: string, dsl = '{}'): DocumentDetail {
  const result = fixture([raw], dsl).inspect();
  if (!result.ok) throw new Error(result.code);
  return result.detail;
}

const source = (raw: string) => `{"_source":${raw}}`;
function field(value: DocumentDetail, path: string) {
  const row = value.rows.find((item) => item.path === path);
  if (!row) throw new Error(`missing path ${path}`);
  return { ...row, value: documentFieldValue(value, row) };
}

describe('bounded structured document detail', () => {
  it('captures the real received occurrence even when IDs and source metadata shadows match', () => {
    const a = '{"_index":"orders-a","_id":"same","_source":{"_id":"shadow","n":9007199254740993}}';
    const b = '{"_index":"orders-b","_id":"same","_source":{"_id":"shadow","n":9007199254740992}}';
    const f = fixture([a, b]);
    const result = f.inspect(f.rows[1]);
    if (!result.ok) throw new Error(result.code);
    expect(result.detail.document).toMatchObject({ raw: b, pageIndex: 1, position: 0, id: { raw: '"same"' } });
    expect(result.detail.rawResponse).toBe(f.pages[1]!.rawResponse);
    expect(field(result.detail, '/_id')).toMatchObject({ section: 'metadata', value: '"same"' });
    expect(field(result.detail, '/_source/_id')).toMatchObject({ section: 'source', value: '"shadow"' });
    expect(field(result.detail, '/_source/n').value).toBe('9007199254740992');
  });

  it('never labels a positional fallback as a real ID, and distinguishes missing/null metadata', () => {
    const missing = detail('{}');
    expect(field(missing, '/_id')).toMatchObject({ kind: 'missing', value: null });
    expect(field(missing, '/_index')).toMatchObject({ kind: 'missing', value: null });
    expect(field(missing, '/_score')).toMatchObject({ kind: 'missing', value: null });
    expect(missing.document.id).toEqual({ kind: 'missing', raw: null });
    expect(field(detail('{"_id":null}'), '/_id')).toMatchObject({ kind: 'null', value: 'null' });
  });

  it.each(['9007199254740993', '-9007199254740993', '1.1000000000000001', '1E400', '1e-4000', '-0.000', '"\\u0061"', '""', 'false'])(
    'preserves the exact token %s through directory reads', (token) => {
      const value = detail(source(`{"n":${token}}`));
      expect(field(value, '/_source/n').value).toBe(token);
    });

  it('uses lossless JSON Pointers, not flattened Elasticsearch field or nested paths', () => {
    const value = detail(source('{"a.b":1,"a":{"b":2},"arr":[{"b":3},4],"":5,"/~":6,"a\\"b":7,"__proto__":8,"constructor":9}'));
    expect(field(value, '/_source/a.b').value).toBe('1');
    expect(field(value, '/_source/a/b')).toMatchObject({ value: '2', parent: '/_source/a', depth: 2 });
    expect(field(value, '/_source/arr/0/b')).toMatchObject({ value: '3', parent: '/_source/arr/0', depth: 3 });
    expect(field(value, '/_source/arr/1').value).toBe('4');
    expect(field(value, '/_source/').value).toBe('5');
    expect(field(value, '/_source/~1~0').value).toBe('6');
    expect(field(value, '/_source/a"b').value).toBe('7');
    expect(field(value, '/_source/__proto__').value).toBe('8');
    expect(field(value, '/_source/constructor').value).toBe('9');
    expect(new Set(value.rows.map((row) => row.path)).size).toBe(value.rows.length);
  });

  it('preserves source/fields presence and actual null, empty containers and non-object values', () => {
    const value = detail('{"_source":{"n":null,"array":[],"object":{},"text":""},"fields":{"only":[1]}}');
    expect(field(value, '/_source/n')).toMatchObject({ kind: 'null', childCount: 0, value: 'null' });
    expect(field(value, '/_source/array')).toMatchObject({ kind: 'array', childCount: 0, value: '[]' });
    expect(field(value, '/_source/object')).toMatchObject({ kind: 'object', childCount: 0, value: '{}' });
    expect(field(value, '/_source/text')).toMatchObject({ kind: 'string', value: '""' });
    expect(field(value, '/fields/only/0')).toMatchObject({ section: 'fields', value: '1' });
    expect(value.rows.some((row) => row.path === '/_source/only')).toBe(false);
    expect(field(detail('{"fields":{}}'), '/_source')).toMatchObject({ kind: 'missing', value: null });
    expect(field(detail('{"_source":null}'), '/_source')).toMatchObject({ kind: 'null', value: 'null' });
    expect(field(detail('{"_source":[1]}'), '/_source/0').value).toBe('1');
    expect(field(detail('{"_source":false}'), '/_source')).toMatchObject({ kind: 'boolean', value: 'false' });
  });

  it('marks runtime only in fields from the executed DSL, and does not backfill absent returns or reveal scripts', () => {
    const dsl = '{"runtime_mappings":{"rank":{"type":"long","script":{"source":"emit(3L)"}},"absent":{"type":"keyword"}}}';
    const value = detail('{"_source":{"rank":10,"absent":"old"},"fields":{"rank":[9007199254740993],"other":[1]}}', dsl);
    expect(field(value, '/_source/rank').runtime).toBe(false);
    expect(field(value, '/fields/rank')).toMatchObject({ runtime: true, value: '[9007199254740993]' });
    expect(field(value, '/fields/rank/0')).toMatchObject({ runtime: true, value: '9007199254740993' });
    expect(field(value, '/fields/absent')).toMatchObject({ runtime: true, kind: 'missing', value: null, parent: null });
    expect(field(value, '/fields/other/0').runtime).toBe(false);
    expect(JSON.stringify(value)).not.toContain('emit(');
    expect(JSON.stringify(value)).not.toContain('rawDsl');
    expect(field(detail('{"fields":{"rank":[1]}}'), '/fields/rank').runtime).toBe(false);
  });

  it('retains the empty or absent fields container alongside missing runtime diagnostics', () => {
    const dsl = '{"runtime_mappings":{"rank":{"type":"long"}}}';
    for (const raw of ['{}', '{"fields":{}}']) {
      const value = detail(raw, dsl);
      expect(field(value, '/fields')).toMatchObject({ kind: raw === '{}' ? 'missing' : 'object', childCount: 0 });
      expect(field(value, '/fields/rank')).toMatchObject({ runtime: true, kind: 'missing' });
      expect(visibleDocumentFields(value.rows, 'fields', '', new Set()).map((row) => row.path)).toEqual(['/fields', '/fields/rank']);
    }
  });

  it('does not map declarations onto a non-object fields container or duplicate its actual array paths', () => {
    const dsl = '{"runtime_mappings":{"0":{"type":"long"}}}';
    const value = detail('{"fields":[1]}', dsl);
    expect(field(value, '/fields/0')).toMatchObject({ kind: 'number', runtime: false, value: '1' });
    expect(new Set(value.rows.map((row) => row.path)).size).toBe(value.rows.length);
    expect(detail('{"fields":null}', dsl).rows.filter((row) => row.section === 'fields')).toHaveLength(1);
  });

  it('keeps all returned metadata, including text-only highlight, without inferring a mapping or merging source', () => {
    const value = detail('{"_version":9007199254740993,"sort":[1E400],"highlight":{"msg":["<em>x</em>"]},"_source":{"_version":2}}');
    expect(field(value, '/_version')).toMatchObject({ section: 'metadata', value: '9007199254740993' });
    expect(field(value, '/sort/0')).toMatchObject({ section: 'metadata', value: '1E400' });
    expect(field(value, '/highlight/msg/0')).toMatchObject({ section: 'metadata', value: '"<em>x</em>"' });
    expect(field(value, '/_source/_version')).toMatchObject({ section: 'source', value: '2' });
  });

  it('collapses by actual parent identity and searches all loaded paths without value matches', () => {
    const value = detail(source('{"a":{"deep":[1,2]},"a.b":"value-only","UPPER":3}'));
    expect(visibleDocumentFields(value.rows, 'source', '', new Set()).map((row) => row.path)).toEqual(['/_source']);
    expect(visibleDocumentFields(value.rows, 'source', '', new Set(['/_source'])).map((row) => row.path))
      .toEqual(['/_source', '/_source/a', '/_source/a.b', '/_source/UPPER']);
    expect(visibleDocumentFields(value.rows, 'source', 'DEEP/1', new Set()).map((row) => row.path)).toEqual(['/_source/a/deep/1']);
    expect(visibleDocumentFields(value.rows, 'source', 'upper', new Set()).map((row) => row.path)).toEqual(['/_source/UPPER']);
    expect(visibleDocumentFields(value.rows, 'metadata', 'deep', new Set())).toEqual([]);
    expect(visibleDocumentFields(value.rows, 'all', 'value-only', new Set())).toEqual([]);
    expect(visibleDocumentFields(value.rows, 'source', '', new Set(value.rows.map((row) => row.path))))
      .toEqual(value.rows.filter((row) => row.section === 'source'));
  });

  it('freezes the origin, record, ranges and original page, retaining neither parser nodes nor mutable drafts', () => {
    const f = fixture([source('{"n":1}')]);
    f.pages[0] = { ...f.pages[0]!, partial: true };
    const result = f.inspect();
    if (!result.ok) throw new Error(result.code);
    const value = result.detail;
    const before = JSON.stringify(value);
    expect(value.origin).toEqual({
      queryId: f.query.id, requestId: 'execution-1', connectionId: 'connection-1', endpoint: 'https://es.test',
      index: 'orders-*', startedAt: '2026-10-10T00:00:00.000Z',
    });
    expect(value.document.partial).toBe(true);
    for (const item of [value, value.origin, value.document, value.document.id, value.rows, value.rows[0], value.rows[0]!.range]) {
      expect(Object.isFrozen(item)).toBe(true);
    }
    expect(value.rows[0]).not.toHaveProperty('children');
    expect(value.rows[0]).not.toHaveProperty('raw');
    f.query.index = 'changed';
    f.query.dsl = '{"runtime_mappings":{"n":{"type":"long"}}}';
    f.pages[0] = { ...f.pages[0]!, rawResponse: '{"hits":{"hits":[]}}' };
    expect(JSON.stringify(value)).toBe(before);
  });

  it('rejects a replaced hit object rather than accepting its identical ID and position', () => {
    const f = fixture(['{"_id":"same"}']);
    const replacement = fixture(['{"_id":"same"}']);
    expect(f.inspect(replacement.rows[0])).toEqual({ ok: false, code: 'unavailable' });
  });

  it.each([{ pageIndex: -1 }, { pageIndex: 1 }, { pageIndex: 1.5 }, { position: -1 }, { position: 1 }, { position: NaN }])(
    'rejects invalid reception identity %j', (patch) => {
      const f = fixture(['{}']);
      expect(f.inspect({ ...f.rows[0]!, ...patch })).toEqual({ ok: false, code: 'unavailable' });
    });

  it.each(['{"n":1,"n":2}', '{"n":1,"\\u006e":2}', '{"n":/*x*/1}', '{"n":1,}', '{}suffix', '[]'])(
    'rejects ambiguous or non-object hits without a partial directory: %s', (raw) => {
      const f = fixture(['{}']);
      const hit = { ...f.rows[0]!.hit, raw: { offset: 0, length: raw.length } };
      f.pages[0] = { ...f.pages[0]!, rawResponse: raw, summary: { ...f.pages[0]!.summary, hits: [hit] } };
      expect(f.inspect({ ...f.rows[0]!, hit })).toEqual({ ok: false, code: 'invalidDocument' });
    });

  it('accepts 1 MiB but rejects excessive UTF-8 bytes before building a directory', () => {
    const prefix = '{"_source":{"text":"';
    const suffix = '"}}';
    const raw = prefix + 'x'.repeat(MAX_LOADED_DOCUMENT_BYTES - prefix.length - suffix.length) + suffix;
    expect(fixture([raw]).inspect().ok).toBe(true);
    expect(fixture([prefix + 'x' + raw.slice(prefix.length)]).inspect()).toEqual({ ok: false, code: 'tooLarge' });
    expect(fixture([source(`{"text":"${'\u4e2d'.repeat(Math.floor(MAX_LOADED_DOCUMENT_BYTES / 3))}"}`)]).inspect())
      .toEqual({ ok: false, code: 'tooLarge' });
  });

  it('bounds nesting before parsing, counting both hit and source containers', () => {
    const raw = (count: number) => source(`{"n":${'['.repeat(count)}0${']'.repeat(count)}}`);
    expect(fixture([raw(MAX_LOADED_DOCUMENT_DEPTH - 2)]).inspect().ok).toBe(true);
    expect(fixture([raw(MAX_LOADED_DOCUMENT_DEPTH - 1)]).inspect()).toEqual({ ok: false, code: 'tooDeep' });
  });

  it('bounds token count and numeric length independently of the byte limit', () => {
    const manyTokens = source(`{"array":[${Array.from({ length: 50_000 }, () => '0').join(',')}]}`);
    expect(fixture([manyTokens]).inspect()).toEqual({ ok: false, code: 'tooComplex' });
    expect(fixture([source(`{"n":${'1'.repeat(MAX_LOADED_DOCUMENT_NUMBER_LENGTH)}}`)]).inspect().ok).toBe(true);
    expect(fixture([source(`{"n":1e${'1'.repeat(MAX_LOADED_DOCUMENT_NUMBER_LENGTH)}}`)]).inspect())
      .toEqual({ ok: false, code: 'tooComplex' });
  });

  it('counts every container, array member and missing diagnostic toward the node limit, rejecting the whole detail', () => {
    const raw = (count: number) => source(`{${Array.from({ length: count }, (_, index) => `"field-${index}":0`).join(',')}}`);
    expect(detail(raw(MAX_DOCUMENT_DETAIL_NODES - 5)).rows).toHaveLength(MAX_DOCUMENT_DETAIL_NODES);
    expect(fixture([raw(MAX_DOCUMENT_DETAIL_NODES - 4)]).inspect()).toEqual({ ok: false, code: 'tooComplex' });
    const array = source(`{"array":[${Array.from({ length: MAX_DOCUMENT_DETAIL_NODES - 5 }, () => '0').join(',')}]}`);
    expect(fixture([array]).inspect()).toEqual({ ok: false, code: 'tooComplex' });
    expect(fixture([raw(MAX_DOCUMENT_DETAIL_NODES - 5)], '{"runtime_mappings":{"missing":{"type":"long"}}}').inspect())
      .toEqual({ ok: false, code: 'tooComplex' });
  });

  it('bounds cumulative path storage when a long ancestor repeats across many children', () => {
    const raw = (count: number) => source(`{"${'p'.repeat(4000)}":{${Array.from({ length: count }, (_, index) => `"child-${index}":0`).join(',')}}}`);
    const accepted = detail(raw(250));
    expect(accepted.rows.length).toBeLessThan(MAX_DOCUMENT_DETAIL_NODES);
    expect(accepted.rows.reduce((total, row) => total + new TextEncoder().encode(row.path).length, 0))
      .toBeLessThan(MAX_DOCUMENT_DETAIL_PATH_BYTES);
    expect(raw(300).length).toBeLessThan(MAX_LOADED_DOCUMENT_BYTES);
    expect(fixture([raw(300)]).inspect()).toEqual({ ok: false, code: 'tooComplex' });
  });

  it('keeps bilingual keys and interpolation contracts aligned', () => {
    expect(Object.keys(zhDocumentDetail).sort()).toEqual(Object.keys(enDocumentDetail).sort());
    for (const [key, text] of Object.entries(enDocumentDetail)) {
      expect(zhDocumentDetail[key as keyof typeof enDocumentDetail].match(/\{\{.*?\}\}/g)).toEqual(text.match(/\{\{.*?\}\}/g));
    }
  });
});

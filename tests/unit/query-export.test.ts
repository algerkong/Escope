import { describe, expect, it } from 'vitest';
import {
  buildCsvExport, buildJsonlExport, compactJsonText, defaultExportFileName,
} from '../../src/domain/query-library';
import { parseQueryResult, type ResultHit } from '../../src/domain/query-result';

type ColumnKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

/** Pretty-printed response: compaction must preserve every token, including escapes. */
const RAW = '{\n'
  + '  "took": 3,\n  "timed_out": false,\n  "_shards": {"total":1,"successful":1,"skipped":0,"failed":0},\n'
  + '  "hits": {"total":{"value":2,"relation":"eq"},"max_score":1.0,"hits":[\n'
  + '    {"_index":"orders-1","_id":"1","_score":1.0,"_source":{"amount":10000000000000000000000,"name":"a,b\\"c","note":"line1\\nline2","nested":{"x":1,"y":[1,2]},"flag":true,"missing_null":null,"formula":"=SUM(A1)","guarded":"\\t@cmd"}},\n'
  + '    {"_index":"orders-1","_id":"2","_score":-1.5,"_source":{"amount":-5.0,"name":"plain"}}\n'
  + '  ]}}';

function hitsOf(raw: string): readonly ResultHit[] {
  const parsed = parseQueryResult(raw);
  if (!parsed.ok) throw new Error('fixture must parse');
  return parsed.summary.hits;
}

function hit(columns: readonly { name: string; kind: ColumnKind; text: string }[], overrides: Partial<ResultHit> = {}): ResultHit {
  return {
    raw: { offset: 0, length: 0 },
    id: '1', index: 'orders-1', score: null, source: null, fields: null, sort: null, hasSource: false,
    columns: columns.map((column) => ({
      name: column.name, preview: '', nested: false, value: { kind: column.kind, text: column.text },
    })),
    ...overrides,
  };
}

describe('loaded-result CSV export', () => {
  it('exports the union of columns with exact tokens, quoting and formula defense', () => {
    const exported = buildCsvExport(hitsOf(RAW));
    expect(exported.rows).toBe(2);
    expect(exported.columns).toEqual(['_index', '_id', 'amount', 'name', 'note', 'nested', 'flag', 'missing_null', 'formula', 'guarded']);
    const lines = exported.content.split('\r\n');
    expect(lines[0]).toBe('_index,_id,amount,name,note,nested,flag,missing_null,formula,guarded');
    // Big integer and float tokens stay byte-identical; strings are decoded and re-quoted; null
    // stays the literal token so it remains distinguishable from an absent column.
    expect(lines[1]).toBe([
      'orders-1', '1', '10000000000000000000000', '"a,b""c"', '"line1\nline2"',
      '"{""x"":1,""y"":[1,2]}"', 'true', 'null', "'=SUM(A1)", "'\t@cmd",
    ].join(','));
    expect(lines[2]).toBe('orders-1,2,-5.0,plain,,,,,,');
    expect(lines[3]).toBe('');
  });

  it('guards formula vectors and never rewrites numeric lexemes', () => {
    const exported = buildCsvExport([hit([
      { name: 'plain', kind: 'string', text: 'safe' },
      { name: 'equals', kind: 'string', text: '=1+1' },
      { name: 'spaced', kind: 'string', text: ' +2' },
      { name: 'tabbed', kind: 'string', text: '\t-3' },
      { name: 'at', kind: 'string', text: '@x' },
      { name: 'dash', kind: 'string', text: '-text' },
      { name: 'control', kind: 'string', text: '\u0001=cmd' },
      { name: 'numeric_text', kind: 'string', text: '9+9' },
      { name: 'float', kind: 'number', text: '1.10' },
      { name: 'exponent', kind: 'number', text: '1e3' },
      { name: 'bigint', kind: 'number', text: '9007199254740993' },
      { name: 'negative', kind: 'number', text: '-5' },
      { name: 'boolean', kind: 'boolean', text: 'false' },
      { name: 'nothing', kind: 'null', text: 'null' },
    ])]);
    const row = exported.content.split('\r\n')[1]!;
    expect(row).toBe([
      'orders-1', '1', 'safe', "'=1+1", "' +2", "'\t-3", "'@x", "'-text", "'\u0001=cmd", '9+9',
      '1.10', '1e3', '9007199254740993', '-5', 'false', 'null',
    ].join(','));
  });

  it('quotes a guarded value that also contains CSV delimiters and keeps absent cells empty', () => {
    const exported = buildCsvExport([hit([
      { name: 'mixed', kind: 'string', text: '=a,"b"' },
      { name: 'missing', kind: 'string', text: 'x' },
    ]), hit([{ name: 'mixed', kind: 'string', text: 'y' }])]);
    const lines = exported.content.split('\r\n');
    expect(lines[0]).toBe('_index,_id,mixed,missing');
    expect(lines[1]).toBe('orders-1,1,"\'=a,""b""",x');
    expect(lines[2]).toBe('orders-1,1,y,');
  });

  it('keeps source fields named _id/_index and literal alias collisions', () => {
    const exported = buildCsvExport([hit([
      { name: '_id', kind: 'string', text: 'source-id' },
      { name: '_index', kind: 'string', text: 'source-index' },
      { name: '_id (source)', kind: 'number', text: '9007199254740993' },
      { name: '=evil', kind: 'string', text: '=evil' },
    ])]);
    expect(exported.columns).toEqual(['_index', '_id', '_id (source)', '_index (source)', '_id (source) (source)', '=evil']);
    const lines = exported.content.split('\r\n');
    expect(lines[0]).toBe("_index,_id,_id (source),_index (source),_id (source) (source),'=evil");
    expect(lines[1]).toBe("orders-1,1,source-id,source-index,9007199254740993,'=evil");
  });

  it('exports nothing for no rows', () => {
    const exported = buildCsvExport([]);
    expect(exported.rows).toBe(0);
    expect(exported.content).toBe('');
    expect(exported.columns).toEqual(['_index', '_id']);
  });
});

describe('loaded-result JSONL export', () => {
  it('emits one raw hit per line with tokens and string escapes untouched', () => {
    const exported = buildJsonlExport([{ rawResponse: RAW }]);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.rows).toBe(2);
    const lines = exported.content.split('\n');
    expect(lines[2]).toBe('');
    expect(lines[0]!.startsWith('{"_index":"orders-1"')).toBe(true);
    expect(lines[0]).toContain('10000000000000000000000');
    expect(lines[0]).toContain('"note":"line1\\nline2"');
    expect(lines[0]).toContain('"nested":{"x":1,"y":[1,2]}');
    expect(lines[1]).toContain('"_score":-1.5');
    expect(lines[0]!.includes('\n')).toBe(false);
    for (const line of lines.slice(0, 2)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('keeps every loaded page in order and fails instead of dropping an unusable one', () => {
    const second = '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},'
      + '"hits":{"total":{"value":1,"relation":"eq"},"hits":[{"_index":"orders-1","_id":"3","_source":{"id":1}}]}}';
    const exported = buildJsonlExport([{ rawResponse: RAW }, { rawResponse: second }]);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.rows).toBe(3);
    expect(exported.content.split('\n')[2]).toContain('"_id":"3"');

    // A page or hit that cannot be sliced exactly is a failure, never a silently smaller export.
    expect(buildJsonlExport([{ rawResponse: RAW }, { rawResponse: 'not json' }]))
      .toEqual({ ok: false, code: 'invalidPage' });
    expect(buildJsonlExport([{ rawResponse: '{"hits":{"hits":[1]}}' }]))
      .toEqual({ ok: false, code: 'invalidPage' });
    expect(buildJsonlExport([{ rawResponse: '{"hits":{}}' }]))
      .toEqual({ ok: false, code: 'invalidPage' });
    expect(buildJsonlExport([{ rawResponse: '[]' }]))
      .toEqual({ ok: false, code: 'invalidPage' });
  });

  it('compacts only inter-token whitespace', () => {
    expect(compactJsonText('{\n  "a": "x y",\n  "b": [1, 2]\n}')).toBe('{"a":"x y","b":[1,2]}');
    expect(compactJsonText('"raw \\t text"')).toBe('"raw \\t text"');
  });
});

describe('export file names', () => {
  it('builds a bounded ASCII stem with a fixed timestamp', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(defaultExportFileName('orders / 2024', 'csv', now)).toBe('escope-orders-2024-20261009-120000.csv');
    expect(defaultExportFileName('', 'jsonl', now)).toBe('escope-results-20261009-120000.jsonl');
    expect(defaultExportFileName('订单', 'csv', now)).toBe('escope-results-20261009-120000.csv');
    expect(defaultExportFileName('a'.repeat(120), 'csv', now)).toHaveLength('escope-'.length + 48 + 1 + 15 + 4);
  });
});

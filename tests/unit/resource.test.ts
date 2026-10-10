import { describe, expect, it } from 'vitest';
import { fieldCapabilityStatus, parseFieldCaps, parseIndexCatalog, parseMappingFields } from '../../src/domain/resource';

const indexRaw = `{
  "indices": [
    { "name": "logs-2026", "attributes": ["open"], "aliases": ["logs"] },
    { "name": ".kibana", "attributes": ["open", "hidden"], "aliases": [] },
    { "name": "old-1", "attributes": ["closed"], "aliases": [] },
    { "name": "metrics-000001", "attributes": ["open"], "aliases": [] }
  ],
  "aliases": [ { "name": "logs", "indices": ["logs-2026"] } ],
  "data_streams": [ { "name": "metrics", "backing_indices": ["metrics-000001"], "timestamp_field": "@timestamp" } ]
}`;

const capsRaw = `{
  "indices": ["logs-2026"],
  "fields": {
    "@timestamp": { "date": { "type": "date", "metadata_field": false, "searchable": true, "aggregatable": true } },
    "message": {
      "text": { "type": "text", "searchable": true, "aggregatable": false },
      "keyword": { "type": "keyword", "searchable": true, "aggregatable": true }
    },
    "_id": { "_id": { "type": "_id", "metadata_field": true, "searchable": true, "aggregatable": false } }
  }
}`;

const mappingRaw = `{
  "logs-2026": {
    "mappings": { "properties": {
      "@timestamp": { "type": "date" },
      "user": { "properties": { "name": { "type": "keyword" }, "id": { "type": "long" } } },
      "tags": { "type": "keyword" }
    } }
  }
}`;

describe('index discovery metadata', () => {
  it('keeps indices, aliases and data streams separate with hidden/system markers', () => {
    const parsed = parseIndexCatalog(indexRaw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { indices, aliases, dataStreams } = parsed.value;
    expect(indices.map((entry) => entry.name)).toEqual(['.kibana', 'logs-2026', 'metrics-000001', 'old-1']);
    expect(indices[0]).toMatchObject({ name: '.kibana', hidden: true, system: true, closed: false, dataStream: null });
    expect(indices[1]).toMatchObject({ name: 'logs-2026', hidden: false, system: false, aliases: ['logs'] });
    expect(indices[2]?.dataStream).toBe('metrics');
    expect(indices[3]).toMatchObject({ name: 'old-1', closed: true });
    expect(aliases).toEqual([{ name: 'logs', indices: ['logs-2026'] }]);
    expect(dataStreams).toEqual([{ name: 'metrics', backingIndices: ['metrics-000001'], timestampField: '@timestamp' }]);
  });

  it('accepts an empty resolution and rejects a non-object body', () => {
    const empty = parseIndexCatalog('{"indices":[],"aliases":[],"data_streams":[]}');
    expect(empty.ok && empty.value.indices).toEqual([]);
    expect(parseIndexCatalog('[]')).toEqual({ ok: false, code: 'invalidResponse' });
  });
});

describe('field capabilities', () => {
  it('reports every type with searchable/aggregatable and marks conflicts', () => {
    const parsed = parseFieldCaps(capsRaw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.indices).toEqual(['logs-2026']);
    expect(parsed.value.fields.map((field) => field.name)).toEqual(['@timestamp', '_id', 'message']);
    const [timestamp, id, message] = parsed.value.fields;
    expect(timestamp?.conflict).toBe(false);
    expect(timestamp?.types).toMatchObject([{ type: 'date', searchable: true, aggregatable: true, metadata: false }]);
    expect(id?.types).toMatchObject([{ type: '_id', searchable: true, aggregatable: false, metadata: true }]);
    expect(message?.conflict).toBe(true);
    expect(message?.types.map((type) => type.type)).toEqual(['text', 'keyword']);
    expect(message?.types.map((type) => type.aggregatable)).toEqual([false, true]);
  });

  it('rejects a body without fields', () => {
    expect(parseFieldCaps('{}')).toEqual({ ok: false, code: 'invalidResponse' });
  });

  it.each([
    { exclusions: undefined, expected: true },
    { exclusions: [], expected: true },
    { exclusions: ['logs-2025'], expected: false },
    { exclusions: [null], expected: false },
    { exclusions: 'logs-2025', expected: false },
    { exclusions: null, expected: false },
  ])('does not hide per-index aggregation restrictions ($exclusions)', ({ exclusions, expected }) => {
    const parsed = parseFieldCaps(JSON.stringify({ fields: { value: { long: {
      type: 'long', searchable: false, aggregatable: true,
      ...(exclusions === undefined ? {} : { non_aggregatable_indices: exclusions }),
    } } } }));
    expect(parsed.ok && parsed.value.fields[0]?.types[0]).toMatchObject({ searchable: false, aggregatable: expected });
  });

  it.each(['searchable', 'aggregatable'] as const)('keeps the reported %s flag distinct from the conservative gate', (capability) => {
    const key = capability === 'searchable' ? 'non_searchable_indices' : 'non_aggregatable_indices';
    for (const flag of [true, false]) {
      const parsed = parseFieldCaps(JSON.stringify({ indices: ['a', 'b'], fields: { n: { long: {
        [capability]: flag, indices: ['a', 'b'], [key]: ['b'],
      } } } }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const type = parsed.value.fields[0]!.types[0]!;
      expect(type[capability]).toBe(false);
      expect(type.report?.[capability]).toBe(flag);
      expect(fieldCapabilityStatus(type.report, capability)).toBe('restricted');
      expect(type.report?.indices).toEqual({ status: 'reported', indices: ['a', 'b'] });
      expect(type.report?.[capability === 'searchable' ? 'nonSearchableIndices' : 'nonAggregatableIndices'])
        .toEqual({ status: 'reported', indices: ['b'] });
    }
  });

  it.each([undefined, null, 'true', 1, [], {}])('does not turn an absent or malformed flag into a reported false: %j', (flag) => {
    const parsed = parseFieldCaps(JSON.stringify({ fields: { n: { long: {
      searchable: flag, aggregatable: flag, metadata_field: flag,
    } } } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const type = parsed.value.fields[0]!.types[0]!;
    expect(type).toMatchObject({ searchable: false, aggregatable: false, metadata: false,
      report: { searchable: null, aggregatable: null, metadata: null } });
    expect(fieldCapabilityStatus(type.report, 'searchable')).toBe('unknown');
    expect(fieldCapabilityStatus(type.report, 'aggregatable')).toBe('unknown');
  });

  it.each([undefined, [], ['b'], [null], 'b', null, {}, ['b', 1], [''], ['b', 'b']])(
    'does not discard malformed search restriction members: %j', (exclusions) => {
      const parsed = parseFieldCaps(JSON.stringify({ fields: { n: { long: {
        searchable: true, aggregatable: true, non_searchable_indices: exclusions,
      } } } }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const type = parsed.value.fields[0]!.types[0]!;
      const unrestricted = exclusions === undefined || Array.isArray(exclusions) && exclusions.length === 0;
      expect(type.searchable).toBe(unrestricted);
      expect(type.aggregatable).toBe(true);
      expect(fieldCapabilityStatus(type.report, 'searchable')).toBe(unrestricted ? 'supported'
        : Array.isArray(exclusions) && exclusions.length === 1 && exclusions[0] === 'b' ? 'restricted' : 'unknown');
    });

  it('separates absent, empty and invalid index lists without backfilling a type scope', () => {
    const parsed = parseFieldCaps('{"indices":["a","b"],"fields":{"x":{"keyword":{"searchable":true,"aggregatable":false,'
      + '"non_searchable_indices":[],"non_aggregatable_indices":[null]}},"y":{}}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.indexEvidence).toEqual({ status: 'reported', indices: ['a', 'b'] });
    const type = parsed.value.fields[0]!.types[0]!;
    expect(type.report).toMatchObject({ indices: { status: 'notReported' },
      nonSearchableIndices: { status: 'reported', indices: [] }, nonAggregatableIndices: { status: 'invalid' } });
    expect(parsed.value.fields[1]).toEqual({ name: 'y', types: [], conflict: false });
    expect(parseFieldCaps('{"fields":{}}')).toMatchObject({ ok: true, value: { indices: [], indexEvidence: { status: 'notReported' } } });
    expect(parseFieldCaps('{"indices":[],"fields":{}}')).toMatchObject({ ok: true, value: { indexEvidence: { status: 'reported', indices: [] } } });
  });

  it.each([null, 'a', [null], ['a', null], ['a', 'a'], ['']])('does not publish a partial response index set: %j', (indices) => {
    expect(parseFieldCaps(JSON.stringify({ indices, fields: {} }))).toEqual({ ok: false, code: 'invalidResponse' });
  });

  it.each(['{"x":null}', '{"x":[]}', '{"x":{"long":null}}', '{"x":{"long":{"type":"keyword"}}}',
    '{"x":{"long":{"type":42}}}', '{"x":{"":{"searchable":true}}}'])('rejects ambiguous field/type structure: %s', (fields) => {
    expect(parseFieldCaps(`{"fields":${fields}}`)).toEqual({ ok: false, code: 'invalidResponse' });
  });

  it('keeps exact literal field, type and index names without interpreting paths or prototype keys', () => {
    const parsed = parseFieldCaps('{"indices":["cluster:a"],"fields":{"__proto__":{"keyword":{"searchable":true}},'
      + '"a.b/~":{"keyword":{"indices":["cluster:a"]}},"a":{"future_type":{"aggregatable":false}}}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.fields.map((field) => field.name)).toEqual(['__proto__', 'a', 'a.b/~']);
    expect(parsed.value.fields[1]!.types[0]!.type).toBe('future_type');
    expect(parsed.value.fields[2]!.types[0]!.report?.indices).toEqual({ status: 'reported', indices: ['cluster:a'] });
    expect(fieldCapabilityStatus(undefined, 'searchable')).toBe('unknown');
  });

  it('withholds both gates when the type scope itself is malformed', () => {
    const parsed = parseFieldCaps('{"fields":{"n":{"long":{"searchable":true,"aggregatable":true,"indices":["a",null]}}}}');
    expect(parsed.ok && parsed.value.fields[0]!.types[0]).toMatchObject({
      searchable: false, aggregatable: false, report: { indices: { status: 'invalid' } },
    });
  });
});

describe('mapping flattening', () => {
  it('walks nested properties into index/path/type rows', () => {
    const parsed = parseMappingFields(mappingRaw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual([
      { index: 'logs-2026', path: '@timestamp', type: 'date' },
      { index: 'logs-2026', path: 'user', type: 'object' },
      { index: 'logs-2026', path: 'user.name', type: 'keyword' },
      { index: 'logs-2026', path: 'user.id', type: 'long' },
      { index: 'logs-2026', path: 'tags', type: 'keyword' },
    ]);
  });

  it('rejects a non-object body', () => {
    expect(parseMappingFields('null')).toEqual({ ok: false, code: 'invalidResponse' });
  });
});

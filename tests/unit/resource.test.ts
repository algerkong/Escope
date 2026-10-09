import { describe, expect, it } from 'vitest';
import { parseFieldCaps, parseIndexCatalog, parseMappingFields } from '../../src/domain/resource';

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
    expect(timestamp?.types).toEqual([{ type: 'date', searchable: true, aggregatable: true, metadata: false }]);
    expect(id?.types).toEqual([{ type: '_id', searchable: true, aggregatable: false, metadata: true }]);
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

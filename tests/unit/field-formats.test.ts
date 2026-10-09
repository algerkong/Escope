import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDataViewDefinition, parseDataViewLibrary, selectDataView, sameDataView, type DataViewLibrary } from '../../src/domain/data-views';
import {
  fieldFormatEvidence, fieldFormatsPayload, formatFieldValue, MAX_FIELD_FORMATS, MAX_FIELD_FORMATS_BYTES,
  MAX_FORMAT_NUMBER_CHARS, MAX_FORMAT_OUTPUT_CHARS, parseFieldFormats, type DataViewFieldFormats, type FieldFormat,
} from '../../src/domain/field-formats';
import { createQuery, createSnapshot, createValidatedSnapshot } from '../../src/domain/query';
import { entryFromDocument, documentFromEntry, libraryPayload, parseLibraryPayload } from '../../src/domain/query-library';
import { buildQueryExchange } from '../../src/domain/query-exchange';
import { parseFieldCaps } from '../../src/domain/resource';
import { emptyRecoveryDocument, finishHistory, historyEntry, parseRecoveryDocument, restoreHistoryQuery } from '../../src/domain/workspace-recovery';

const fixture = JSON.parse(readFileSync('tests/fixtures/data-view-field-formats-v1.json', 'utf8')) as DataViewLibrary;
const definition = fixture.entries[0]!;
const formats = definition.fieldFormats!;
const number: FieldFormat = { kind: 'number', grouping: true };
const percent: FieldFormat = { kind: 'percent', grouping: false };
const bytes: FieldFormat = { kind: 'bytes', grouping: false };
const iso: FieldFormat = { kind: 'date', input: 'iso' };
const millis: FieldFormat = { kind: 'date', input: 'epoch_millis' };
const numeric = (text: string, format: FieldFormat = number) => formatFieldValue({ kind: 'number', text }, format);
const date = (text: string) => formatFieldValue({ kind: 'string', text }, iso);

describe('bounded field format definitions', () => {
  it('reads the shared Rust fixture, copies nested options and preserves old definitions without formats', () => {
    expect(parseDataViewLibrary(fixture)).toEqual(fixture);
    expect(parseFieldFormats(formats)).toEqual(formats);
    const copy = fieldFormatsPayload(formats);
    expect(copy).toEqual(formats);
    expect(copy.entries[0]!.format).not.toBe(formats.entries[0]!.format);
    const { fieldFormats: omitted, ...old } = definition;
    expect(omitted).toBeDefined();
    expect(parseDataViewDefinition(old)).toEqual(old);
    expect(sameDataView(definition, { ...definition, fieldFormats: { version: 1, entries: [] } })).toBe(false);
  });

  it.each([
    null, undefined, {}, { ...formats, version: 2 }, { ...formats, url: 'https://fixture.test' },
    { ...formats, entries: [formats.entries[0], formats.entries[0]] },
    { version: 1, entries: [{ field: 'n', format: { kind: 'number' } }] },
    { version: 1, entries: [{ field: 'n', format: { kind: 'number', grouping: 'true' } }] },
    { version: 1, entries: [{ field: 'n', format: { kind: 'number', grouping: true, decimals: 2 } }] },
    { version: 1, entries: [{ field: 'n', format: { kind: 'date', input: 'local' } }] },
    { version: 1, entries: [{ field: 'n', format: { kind: 'date', input: 'iso', timezone: 'auto' } }] },
    { version: 1, entries: [{ field: 'n', format: { kind: 'html', template: '<b>value</b>' } }] },
    { version: 1, entries: [{ field: 'n', format: { kind: 'script', source: 'fetch("/")' } }] },
    { version: 1, entries: [{ field: 'n', format: { kind: 'url', url: 'https://fixture.test' } }] },
  ])('fails closed on invalid, unknown or executable definitions: %j', (fieldFormats) => {
    expect(parseDataViewDefinition({ ...definition, fieldFormats })).toBeNull();
  });

  it('bounds unique field names, count and serialized UTF-8 bytes independently of the library limit', () => {
    for (const field of ['', ' n', 'n ', '\u007f', '\u0085', 'x'.repeat(1025), '\u4e2d'.repeat(342)]) {
      expect(parseFieldFormats({ version: 1, entries: [{ field, format: number }] })).toBeNull();
    }
    const entries = Array.from({ length: MAX_FIELD_FORMATS }, (_, index) => ({ field: `n${index}`, format: number }));
    expect(parseFieldFormats({ version: 1, entries })).not.toBeNull();
    expect(parseFieldFormats({ version: 1, entries: [...entries, { field: 'extra', format: number }] })).toBeNull();
    const large = { version: 1, entries: entries.map((entry) => ({ ...entry, field: entry.field + 'x'.repeat(600) })) };
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(MAX_FIELD_FORMATS_BYTES);
    expect(parseFieldFormats(large)).toBeNull();
    expect(parseFieldFormats({ version: 1, entries: [{ field: '__proto__', format: number }] })).not.toBeNull();
  });
});

describe('exact display-only numeric formats', () => {
  it.each([
    ['9007199254740993', '9,007,199,254,740,993'],
    ['-9007199254740993', '-9,007,199,254,740,993'],
    ['1234.000000000000000000000001', '1,234.000000000000000000000001'],
    ['1.2345678901234567890123456789e3', '1,234.5678901234567890123456789'],
    ['-1.5e-10', '-0.00000000015'], ['-0', '-0'],
  ])('formats %s without numeric rounding', (raw, expected) => {
    expect(numeric(raw)).toEqual({ status: 'formatted', text: expected });
    expect(numeric(raw, { kind: 'number', grouping: false })).toEqual({ status: 'formatted', text: expected.replaceAll(',', '') });
  });

  it.each([
    ['0.12345678901234567890123456789', '12.345678901234567890123456789%'],
    ['9007199254740993', '900719925474099300%'],
    ['1e-30', '0.0000000000000000000000000001%'], ['-0', '-0%'],
  ])('shifts the percentage exactly for %s', (raw, expected) => {
    expect(numeric(raw, percent)).toEqual({ status: 'formatted', text: expected });
  });

  it.each([
    ['0', '0 B'], ['1023', '1023 B'], ['1024', '1 KiB'], ['1536', '1.5 KiB'],
    ['1537', '1.5009765625 KiB'], ['-1536', '-1.5 KiB'],
    ['1048576', '1 MiB'], ['1152921504606846976', '1 EiB'],
    ['9007199254740993', '8.00000000000000088817841970012523233890533447265625 PiB'],
  ])('converts %s bytes using exact IEC units', (raw, expected) => {
    expect(numeric(raw, bytes)).toEqual({ status: 'formatted', text: expected });
  });

  it('bounds hostile exponents/output without expanding them or falling back to a rounded float', () => {
    for (const raw of ['1e999999999999999999999', '1e-999999999999999999999', '1e4096',
      '1'.repeat(MAX_FORMAT_NUMBER_CHARS + 1)]) {
      for (const format of [number, percent, bytes]) expect(numeric(raw, format)).toEqual({ status: 'raw', reason: 'limit' });
    }
    const largest = numeric('1e2047');
    expect(numeric('1e2048')).toEqual({ status: 'raw', reason: 'limit' });
    expect(largest.status).toBe('formatted');
    if (largest.status === 'formatted') expect(largest.text.length).toBeLessThan(MAX_FORMAT_OUTPUT_CHARS);
    for (const raw of ['NaN', 'Infinity', '1.', '01', '0x10', ' 12']) expect(numeric(raw).status).toBe('raw');
    expect(formatFieldValue({ kind: 'string', text: '9007199254740993' }, number)).toEqual({ status: 'raw', reason: 'type' });
  });
});

describe('explicit UTC date inputs', () => {
  it.each([
    ['2026-10-10T08:15:20.123456789+08:00', '2026-10-10T00:15:20.123456789Z'],
    ['2026-10-10T00:15:20.000000001Z', '2026-10-10T00:15:20.000000001Z'],
    ['2024-02-29T23:59:59-01:00', '2024-03-01T00:59:59Z'],
    ['2026-10-10T00:00:00.12Z', '2026-10-10T00:00:00.12Z'],
  ])('normalizes timezone but retains all fractional digits for %s', (raw, expected) => {
    expect(date(raw)).toEqual({ status: 'formatted', text: expected });
  });

  it.each([
    '2026-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T00:00:60Z',
    '2026-10-10T00:00:00', '2026-10-10', '10/10/2026', '2026-10-10T00:00:00+24:00',
    '2026-10-10T00:00:00+01:60', '2026-10-10T00:00:00-00:00', '2026-10-10T00:00:00.1234567890Z',
  ])('keeps ambiguous, overflowing or invalid dates raw: %s', (raw) => {
    expect(date(raw)).toEqual({ status: 'raw', reason: 'date' });
  });

  it('accepts only explicitly selected safe integer milliseconds, never truncates fractional/nanosecond tokens', () => {
    expect(numeric('0', millis)).toEqual({ status: 'formatted', text: '1970-01-01T00:00:00.000Z' });
    expect(numeric('-1', millis)).toEqual({ status: 'formatted', text: '1969-12-31T23:59:59.999Z' });
    for (const raw of ['9007199254740993', '1728000000000000000', '1.00000000000000001', '1e3', '8640000000000001']) {
      expect(numeric(raw, millis)).toEqual({ status: 'raw', reason: 'date' });
    }
    expect(formatFieldValue({ kind: 'string', text: '0' }, millis)).toEqual({ status: 'raw', reason: 'type' });
    expect(numeric('0', iso)).toEqual({ status: 'raw', reason: 'type' });
  });
});

describe('non-scalar values and type evidence', () => {
  it('formats flat scalar arrays without changing their structure or partially formatting mixed values', () => {
    const array = { kind: 'array' as const, text: '[9007199254740993, null, 0.0000000000000000001]' };
    expect(formatFieldValue(array, number)).toEqual({
      status: 'formatted', text: '["9,007,199,254,740,993", null, "0.0000000000000000001"]',
    });
    expect(array.text).toBe('[9007199254740993, null, 0.0000000000000000001]');
    expect(formatFieldValue({ kind: 'array', text: '[1,"2"]' }, number)).toEqual({ status: 'raw', reason: 'type' });
    expect(formatFieldValue({ kind: 'array', text: '[[1]]' }, number)).toEqual({ status: 'raw', reason: 'structure' });
    expect(formatFieldValue({ kind: 'array', text: '[]' }, number)).toEqual({ status: 'raw', reason: 'empty' });
    expect(formatFieldValue({ kind: 'object', text: '{"n":1}' }, number)).toEqual({ status: 'raw', reason: 'structure' });
    expect(formatFieldValue({ kind: 'null', text: 'null' }, number)).toEqual({ status: 'raw', reason: 'empty' });
    expect(formatFieldValue({ kind: 'array', text: `[${Array.from({ length: 33 }, () => '1').join(',')}]` }, number)).toEqual({ status: 'raw', reason: 'limit' });
    expect(formatFieldValue({ kind: 'array', text: '[1e2047,1e2047]' }, number)).toEqual({ status: 'raw', reason: 'limit' });
    expect(formatFieldValue({ kind: 'array', text: `[1e2000,1e1000,${Array.from({ length: 20 }, () => 'null').join(',')}]` }, number))
      .toEqual({ status: 'raw', reason: 'limit' });
  });

  it('does not equate missing or conflicting field evidence with formatting permission', () => {
    const parsed = parseFieldCaps('{"fields":{"n":{"long":{}},"date":{"date_nanos":{}},"s":{"keyword":{}},"mixed":{"long":{},"keyword":{}}}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(fieldFormatEvidence({ field: 'n', format: number })).toBe('unchecked');
    for (const [field, format, expected] of [
      ['n', number, 'valid'], ['date', iso, 'valid'], ['missing', number, 'missing'],
      ['mixed', number, 'conflict'], ['s', number, 'notNumeric'], ['n', iso, 'notDate'],
    ] as const) expect(fieldFormatEvidence({ field, format }, parsed.value)).toBe(expected);
  });
});

describe('format snapshots and persistence', () => {
  const query = { ...createQuery(definition.connectionId), index: definition.index, dataView: selectDataView(definition) };

  it('deep-freezes an independent selection before execution and rejects mismatched/invalid copies', () => {
    const draft = structuredClone(query);
    const snapshot = createSnapshot(draft, 'request', new Date('2026-10-10T00:00:00.000Z'));
    const frozen = snapshot.dataView!.definition.fieldFormats!;
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.entries)).toBe(true);
    expect(Object.isFrozen(frozen.entries[0]!.format)).toBe(true);
    Object.assign(draft.dataView!.definition.fieldFormats!.entries[0]!.format, { grouping: false });
    expect(frozen.entries[0]!.format).toEqual(number);
    expect(snapshot.rawDsl).toBe(query.dsl);
    for (const changed of [{ ...query, index: 'other' }, { ...query, connectionId: 'other' },
      { ...query, dataView: { ...query.dataView, version: 2 } }]) {
      expect(createValidatedSnapshot(changed, 'request', new Date())).toEqual({ ok: false, error: { code: 'invalidDataView' } });
      expect(() => createSnapshot(changed, 'request', new Date())).toThrow('invalidDataView');
    }
  });

  it('persists the execution copy in history and restores it without consulting the changed/deleted library', () => {
    const snapshot = createSnapshot(query, 'request', new Date('2026-10-10T00:00:00.000Z'));
    const entry = finishHistory(historyEntry(snapshot, 'Original', 'query'), 'success', null, new Date('2026-10-10T00:00:01.000Z'));
    const document = { ...emptyRecoveryDocument(), history: [entry] };
    expect(parseRecoveryDocument(document)).toEqual(document);
    const restored = restoreHistoryQuery(entry);
    expect(restored.dataView).toEqual(query.dataView);
    expect(restored.dataView).not.toBe(query.dataView);
    expect(restored.dataView!.definition.fieldFormats!.entries[0]).not.toBe(snapshot.dataView!.definition.fieldFormats!.entries[0]);
    for (const changed of [
      { ...entry, kind: 'index' },
      { ...entry, snapshot: { ...snapshot, connectionId: 'other' } },
      { ...entry, snapshot: { ...snapshot, dataView: null } },
    ]) expect(parseRecoveryDocument({ ...document, history: [changed] })).toBeNull();
    expect(JSON.stringify(entry)).not.toMatch(/rawResponse|pitId|credentialRef|endpoint/);
  });

  it('retains formats in local query drafts but excludes the entire view from definition exchange', () => {
    const entry = entryFromDocument(query, { id: 'saved', name: 'Saved', favorite: true, now: new Date('2026-10-10T00:00:00.000Z') });
    const library = libraryPayload({ version: 1, entries: [entry] });
    expect(parseLibraryPayload(library).ok).toBe(true);
    expect(documentFromEntry(entry).dataView!.definition.fieldFormats).toEqual(formats);
    expect(JSON.stringify(buildQueryExchange(library, ['saved'], []))).not.toMatch(/dataView|fieldFormats|formatted-view|connection-a/);
    const invalid: DataViewFieldFormats = { ...formats, version: 99 };
    const changed = { ...entry, dataView: selectDataView({ ...definition, fieldFormats: invalid }) };
    expect(parseLibraryPayload({ version: 1, entries: [changed] }).ok).toBe(false);
  });
});

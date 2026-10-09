import { describe, expect, it } from 'vitest';
import { createQuery, createValidatedSnapshot, createWorkspace, matchesQueryDraft, updateWorkspaceDocument } from '../../src/domain/query';
import {
  MAX_TIME_RANGE_AMOUNT, MAX_TIME_RANGE_DAYS, copyQueryTimeRange, freezeTimeRange, parseExecutionTimeRange, parseQueryTimeRange,
  parseTimeRangeDefinition, previewTimeRange, removeAppliedTimeRange, resolveTimeRange, timeRangeFieldEvidence, timeRangeLocalBound,
  validTimeRangeZone, type TimeRangeDefinition,
} from '../../src/domain/query-time-range';
import { parseFieldCaps } from '../../src/domain/resource';
import { selectDataView } from '../../src/domain/data-views';
import { prepareSnapshotExportDsl } from '../../src/domain/query-export';

const now = new Date('2026-10-10T02:00:00.123Z');
const definition: TimeRangeDefinition = {
  field: '@timestamp', fieldType: 'date', timeZone: 'Asia/Shanghai', range: { kind: 'relative', amount: 15, unit: 'minutes' },
};
const absolute = (from: string, to: string, timeZone = 'UTC', fieldType: 'date' | 'date_nanos' = 'date'): TimeRangeDefinition =>
  ({ ...definition, timeZone, fieldType, range: { kind: 'absolute', from, to } });
const source = '{"query":{"bool":{"should":[{"term":{"id":9007199254740993}},{"term":{"s":"\\u0061"}}]}},'
  + '"size":25,"min_score":1.0000000000000000001,"sort":["_shard_doc"]}';
const query = () => ({ ...createQuery('connection'), index: 'events-*', dsl: source });
function applied(input = query(), time = definition) {
  const preview = previewTimeRange(input, time, now);
  if (!preview.ok) throw new Error(preview.code);
  return { ...input, dsl: preview.dsl, timeRange: preview.timeRange };
}

describe('bounded precise time definitions', () => {
  it('resolves relative units exactly and does not use the selected display zone as a moving clock', () => {
    const result = resolveTimeRange(definition, now.toISOString());
    expect(result).toEqual({ ok: true, bounds: {
      resolvedAt: now.toISOString(), from: '2026-10-10T01:45:00.123000000Z', to: '2026-10-10T02:00:00.123000000Z',
    } });
    expect(resolveTimeRange({ ...definition, timeZone: '-05:00' }, now.toISOString())).toEqual(result);
    expect(timeRangeLocalBound('2026-10-10T01:45:00.123000001Z', 'Asia/Shanghai')).toContain('09:45:00.123000001+08:00');
  });

  it('uses fixed 24-hour days across DST, not calendar arithmetic or server-side now', () => {
    const value = resolveTimeRange({ ...definition, timeZone: 'America/New_York', range: { kind: 'relative', amount: 1, unit: 'days' } },
      '2026-03-08T12:00:00.000Z');
    expect(value).toMatchObject({ ok: true, bounds: { from: '2026-03-07T12:00:00.000000000Z', to: '2026-03-08T12:00:00.000000000Z' } });
  });

  it('keeps nanoseconds and resolves real zone offsets and leap days', () => {
    const result = resolveTimeRange(absolute('2024-02-29T08:00:00.123456789', '2024-02-29T08:00:00.123456790', '+08:00', 'date_nanos'), now.toISOString());
    expect(result).toMatchObject({ ok: true, bounds: { from: '2024-02-29T00:00:00.123456789Z', to: '2024-02-29T00:00:00.123456790Z' } });
    expect(resolveTimeRange(absolute('2026-07-01T12:00:00', '2026-07-01T13:00:00', 'America/New_York'), now.toISOString()))
      .toMatchObject({ ok: true, bounds: { from: '2026-07-01T16:00:00.000000000Z' } });
    expect(resolveTimeRange(absolute('2026-01-01T12:00:00', '2026-01-01T13:00:00', 'America/New_York'), now.toISOString()))
      .toMatchObject({ ok: true, bounds: { from: '2026-01-01T17:00:00.000000000Z' } });
  });

  it.each(['2026-03-08T02:30:00', '2026-11-01T01:30:00'])('rejects nonexistent or ambiguous local time %s', (from) => {
    expect(resolveTimeRange(absolute(from, '2026-11-02T12:00:00', 'America/New_York'), now.toISOString()))
      .toEqual({ ok: false, code: 'ambiguousTime' });
  });

  it.each(['2025-02-29T00:00:00', '2026-01-01T24:00:00', '2026-01-01T00:00:60', '0000-01-01T00:00:00',
    '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.1234567890', '2026-01-01T00:00:00[u-ca=hebrew]'])(
    'rejects incomplete, overflowing or unsupported dates %s', (from) => {
      expect(resolveTimeRange(absolute(from, '2026-11-02T12:00:00'), now.toISOString())).toEqual({ ok: false, code: 'invalidDate' });
    });

  it('rejects sub-millisecond date inputs and date_nanos outside the ES representable range', () => {
    expect(resolveTimeRange(absolute('2026-01-01T00:00:00.000000001', '2026-01-01T00:00:01'), now.toISOString()))
      .toEqual({ ok: false, code: 'precisionMismatch' });
    expect(resolveTimeRange(absolute('1969-12-31T23:59:59', '1970-01-01T00:00:01', 'UTC', 'date_nanos'), now.toISOString()))
      .toEqual({ ok: false, code: 'dateOutOfRange' });
    expect(resolveTimeRange(absolute('2262-04-11T23:47:16.854775806', '2262-04-11T23:47:16.854775807', 'UTC', 'date_nanos'), now.toISOString()).ok).toBe(true);
    expect(resolveTimeRange(absolute('2262-04-11T23:47:16.854775807', '2262-04-11T23:47:16.854775808', 'UTC', 'date_nanos'), now.toISOString()))
      .toEqual({ ok: false, code: 'dateOutOfRange' });
  });

  it.each(['0001', '9999'])('keeps millisecond dates outside the nanosecond storage range in year %s', (year) => {
    expect(resolveTimeRange(absolute(`${year}-01-01T00:00:00`, `${year}-01-02T00:00:00`), now.toISOString()))
      .toMatchObject({ ok: true, bounds: { from: `${year}-01-01T00:00:00.000000000Z`, to: `${year}-01-02T00:00:00.000000000Z` } });
  });

  it('bounds duration and rejects reversed or equal boundaries', () => {
    for (const amount of [0, -1, 1.5, MAX_TIME_RANGE_AMOUNT + 1, Number.POSITIVE_INFINITY]) {
      expect(parseTimeRangeDefinition({ ...definition, range: { kind: 'relative', amount, unit: 'minutes' } })).toBeNull();
    }
    expect(parseTimeRangeDefinition({ ...definition, range: { kind: 'relative', amount: MAX_TIME_RANGE_DAYS + 1, unit: 'days' } })).toBeNull();
    expect(parseTimeRangeDefinition({ ...definition, range: { kind: 'relative', amount: 1, unit: 'months' } })).toBeNull();
    expect(resolveTimeRange(absolute('2026-01-02T00:00:00', '2026-01-02T00:00:00'), now.toISOString())).toEqual({ ok: false, code: 'rangeOrder' });
    expect(resolveTimeRange(absolute('2026-01-03T00:00:00', '2026-01-02T00:00:00'), now.toISOString())).toEqual({ ok: false, code: 'rangeOrder' });
    expect(resolveTimeRange(absolute('2000-01-01T00:00:00', '2026-01-02T00:00:00'), now.toISOString())).toEqual({ ok: false, code: 'rangeLimit' });
  });

  it('uses a closed versioned definition without system-zone aliases, scripts or alternate keys', () => {
    for (const timeZone of ['system', 'local', '-00:00', '+24:00', '+08:60', 'Bad/Zone', ' UTC', 'utc', 'GMT+8']) {
      expect(validTimeRangeZone(timeZone), timeZone).toBe(false);
    }
    for (const timeZone of ['UTC', '+08:00', '-03:30', 'Asia/Shanghai', 'America/New_York', 'Europe/Berlin', 'Etc/GMT+8']) {
      expect(validTimeRangeZone(timeZone), timeZone).toBe(true);
    }
    for (const value of [null, {}, { ...definition, unknown: true }, { ...definition, field: '$param' },
      { ...definition, field: 'a*' }, { ...definition, field: '_source' }, { ...definition, field: 'x'.repeat(1025) },
      { ...definition, fieldType: 'long' }, { ...definition, range: { ...definition.range, script: 'now' } }]) {
      expect(parseTimeRangeDefinition(value)).toBeNull();
    }
  });
});

describe('explicit lossless time application', () => {
  it('preserves scoring, implicit bool OR defaults, raw numeric and escaped tokens under a new wrapper', () => {
    const input = query();
    const result = applied(input);
    expect(input.dsl).toBe(source);
    expect(result.dsl).toContain('"must":[{"bool":{"should"');
    expect(result.dsl).toContain('"filter":[{"range"');
    for (const token of ['9007199254740993', '1.0000000000000000001', '\\u0061']) expect(result.dsl).toContain(token);
    expect(JSON.parse(result.dsl).query.bool.must[0]).toEqual(JSON.parse(source).query);
    expect(parseQueryTimeRange(result.timeRange, input.connectionId, input.index, result.dsl)).toEqual(result.timeRange);
    expect(removeAppliedTimeRange(result)).toBe(source);
    expect(prepareSnapshotExportDsl(result.dsl, 100).ok).toBe(true);
  });

  it.each(['{}', '{"size":25}', '{ "sort":["_shard_doc"] }'])('preserves the no-query scoring default and removes only its own member from %s', (dsl) => {
    const result = applied({ ...query(), dsl });
    expect(result.timeRange.hadQuery).toBe(false);
    expect(JSON.parse(result.dsl).query.bool.must).toEqual([{ match_all: {} }]);
    expect(JSON.parse(removeAppliedTimeRange(result)!)).toEqual(JSON.parse(dsl));
  });

  it('unwraps the no-query wrapper in any root position and handles escaped field names exactly', () => {
    const result = applied({ ...query(), dsl: '{"size":25,"track_total_hits":true}' });
    const wrapper = JSON.stringify(JSON.parse(result.dsl).query);
    for (const dsl of [`{"query":${wrapper},"size":25,"track_total_hits":true}`,
      `{"size":25,"query":${wrapper},"track_total_hits":true}`, `{"size":25,"track_total_hits":true,"query":${wrapper}}`]) {
      expect(JSON.parse(removeAppliedTimeRange({ ...result, dsl })!)).toEqual({ size: 25, track_total_hits: true });
    }
    const escaped = applied(query(), { ...definition, field: 'a"\\b' });
    expect(parseQueryTimeRange(escaped.timeRange, escaped.connectionId, escaped.index, escaped.dsl)).toEqual(escaped.timeRange);
    expect(removeAppliedTimeRange(escaped)).toBe(source);
  });

  it('updates a managed range without nesting a second wrapper or rewriting unrelated query text', () => {
    const first = applied();
    const next = previewTimeRange(first, { ...definition, range: { kind: 'relative', amount: 1, unit: 'hours' } }, now);
    if (!next.ok) throw new Error(next.code);
    expect(JSON.parse(next.dsl).query.bool.must[0]).toEqual(JSON.parse(source).query);
    expect(next.dsl).toContain('2026-10-10T01:00:00.123000000Z');
    expect((next.dsl.match(/"gte"/g) ?? []).length).toBe(1);
  });

  it('never replaces a handwritten same-field range, even in nested bool or post_filter', () => {
    for (const dsl of [
      '{"query":{"range":{"@timestamp":{"gte":"now-1d"}}}}',
      '{"query":{"bool":{"must_not":[{"range":{"@timestamp":{"lt":"2020"}}}]}}}',
      '{"post_filter":{"range":{"@timestamp":{"gte":"2020"}}}}',
    ]) expect(previewTimeRange({ ...query(), dsl }, definition, now)).toEqual({ ok: false, code: 'manualConflict' });
    expect(previewTimeRange({ ...query(), dsl: '{"query":{"range":{"other":{"gt":9007199254740993}}}}' }, definition, now).ok).toBe(true);
  });

  it('refuses hybrid retrieval, unknown root semantics, unresolved parameters, invalid JSON and over-limit text', () => {
    for (const dsl of ['{"knn":{}}', '{"retriever":{}}', '{"custom":true}']) {
      expect(previewTimeRange({ ...query(), dsl }, definition, now)).toEqual({ ok: false, code: 'unsupportedDsl' });
    }
    for (const dsl of ['[]', '{"query":1}', '{"size":1,"\\u0073ize":2}', '{"query":{"term":{"id":{"$param":"id"}}}}', '{broken',
      '{"query":'.repeat(66) + '{}' + '}'.repeat(66), ' '.repeat(256 * 1024) + '{}']) {
      expect(previewTimeRange({ ...query(), dsl }, definition, now).ok).toBe(false);
    }
  });

  it('freezes each explicit execution but never mutates the draft, and rejects forged or stale associations', () => {
    const input = applied();
    const later = new Date('2026-10-11T02:00:00.456Z');
    const frozen = freezeTimeRange(input, later);
    if (!frozen.ok) throw new Error(frozen.code);
    expect(frozen.dsl).toContain('2026-10-11T01:45:00.456000000Z');
    expect(input.dsl).toContain('2026-10-10T01:45:00.123000000Z');
    const snapshot = createValidatedSnapshot(input, 'request', later);
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    expect(snapshot.snapshot.rawDsl).toBe(frozen.dsl);
    for (const value of [snapshot.snapshot.timeRange, snapshot.snapshot.timeRange?.bounds, snapshot.snapshot.timeRange?.definition,
      snapshot.snapshot.timeRange?.definition.range]) expect(Object.isFrozen(value)).toBe(true);
    expect(snapshot.snapshot.timeRange?.definition).not.toBe(input.timeRange.definition);
    expect(parseExecutionTimeRange(snapshot.snapshot.timeRange, snapshot.snapshot.rawDsl)).toEqual(snapshot.snapshot.timeRange);
    for (const patch of [{ index: 'other' }, { connectionId: 'other' }, { dsl: '{}' }]) {
      expect(createValidatedSnapshot({ ...input, ...patch }, 'request', now)).toMatchObject({ ok: false, error: { code: 'invalidTimeRange' } });
    }
    for (const timeRange of [null, { ...input.timeRange, version: 2 }, { ...input.timeRange, extra: true },
      { ...input.timeRange, bounds: { ...input.timeRange.bounds, to: '2026-10-10T02:00:00.123000001Z' } },
      { ...input.timeRange, definition: { ...definition, field: 'other' } }, { ...input.timeRange, hadQuery: false }]) {
      expect(parseQueryTimeRange(timeRange, input.connectionId, input.index, input.dsl)).toBeNull();
    }
    expect(copyQueryTimeRange(input.timeRange)).toEqual(input.timeRange);
  });

  it('detaches managed behavior on manual DSL or target edits while preserving its last literal range', () => {
    const input = applied();
    const workspace = { ...createWorkspace(input.connectionId), activeTabId: input.id, tabs: [{ kind: 'query' as const, document: input }] };
    const changed = updateWorkspaceDocument(workspace, input.id, { dsl: `${input.dsl} ` }).tabs[0]!.document;
    expect(changed.timeRange).toBeUndefined();
    expect(freezeTimeRange(changed, new Date('2026-10-11T00:00:00Z'))).toEqual({ ok: true, dsl: `${input.dsl} ` });
    expect(updateWorkspaceDocument(workspace, input.id, { index: 'other' }).tabs[0]!.document.timeRange).toBeUndefined();
    expect(updateWorkspaceDocument(workspace, input.id, { name: 'Renamed' }).tabs[0]!.document.timeRange).toEqual(input.timeRange);
    expect(updateWorkspaceDocument(workspace, input.id, { resultView: 'json' }).tabs[0]!.document.timeRange).toEqual(input.timeRange);
    expect(matchesQueryDraft({ ...input, timeRange: undefined }, input)).toBe(false);
    const locked = { ...workspace, tabs: [{ kind: 'index' as const, document: query() }] };
    expect(updateWorkspaceDocument(locked, locked.tabs[0]!.document.id, { timeRange: input.timeRange }).tabs[0]!.document.timeRange).toBeUndefined();
  });
});

describe('time field evidence is never execution permission', () => {
  const parsed = parseFieldCaps('{"fields":{"valid":{"date":{"searchable":true}},"nanos":{"date_nanos":{"searchable":true}},'
    + '"blocked":{"date":{"searchable":false}},"mixed":{"date":{},"keyword":{}},"text":{"keyword":{}},"events":{"nested":{}}}}');
  if (!parsed.ok) throw new Error('fixture');
  const catalog = parsed.value;
  it('distinguishes unavailable, missing, conflicts, non-date, nested and not searchable', () => {
    expect(timeRangeFieldEvidence(query(), definition)).toBe('unchecked');
    for (const [field, expected] of [['valid', 'valid'], ['blocked', 'fieldNotSearchable'], ['mixed', 'fieldConflict'],
      ['text', 'fieldNotDate'], ['absent', 'missing'], ['events.time', 'fieldNested'], ['nanos', 'fieldNotDate']] as const) {
      expect(timeRangeFieldEvidence(query(), { ...definition, field }, catalog)).toBe(expected);
    }
    expect(timeRangeFieldEvidence(query(), { ...definition, field: 'nanos', fieldType: 'date_nanos' }, catalog)).toBe('valid');
  });

  it('requires applied DSL for a runtime date, never an unapplied local definition or field caps', () => {
    const input = { ...query(), dataView: selectDataView({
      id: 'view', connectionId: 'connection', index: 'events-*', name: 'View', defaultTimeField: 'valid',
      runtimeFields: { version: 1, entries: [{ field: 'valid', type: 'date' }] },
    }) };
    const selected = { ...definition, field: 'valid' };
    expect(timeRangeFieldEvidence(input, selected, catalog)).toBe('runtimeNotApplied');
    expect(previewTimeRange(input, selected, now, catalog)).toEqual({ ok: false, code: 'runtimeNotApplied' });
    input.dsl = '{"runtime_mappings":{"valid":{"type":"date"}}}';
    expect(timeRangeFieldEvidence(input, selected, catalog)).toBe('runtime');
    expect(previewTimeRange(input, selected, now, catalog).ok).toBe(true);
    expect(timeRangeFieldEvidence(input, { ...selected, fieldType: 'date_nanos' }, catalog)).toBe('fieldNotDate');
    input.dsl = '{"runtime_mappings":{"valid":{"type":"long"}}}';
    expect(timeRangeFieldEvidence(input, selected, catalog)).toBe('fieldNotDate');
    input.dsl = '{"runtime_mappings":{"events.time":{"type":"date"}}}';
    const nested = { ...definition, field: 'events.time' };
    expect(timeRangeFieldEvidence(input, nested, catalog)).toBe('fieldNested');
    expect(previewTimeRange(input, nested, now, catalog)).toEqual({ ok: false, code: 'fieldNested' });
  });
});

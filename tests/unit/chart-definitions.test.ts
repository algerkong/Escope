import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/chart-definitions-v1.json';
import {
  CHART_DEFINITION_VERSION, MAX_CHART_DEFINITIONS, MAX_CHART_DEFINITIONS_BYTES,
  chartDefinitionPayload, emptyChartDefinitions, freezeChartDefinitionSelection, parseChartDefinition,
  parseChartDefinitionForTarget, parseChartDefinitionLibrary, parseChartDefinitionRecord,
  sameChartDefinition, selectChartDefinition,
  type ChartDefinition,
} from '../../src/domain/chart-definitions';
import { validateAggregationDraft, type AggregationBuildDraft } from '../../src/domain/query-aggregation-build';
import { previewAggregationBuild } from '../../src/domain/query-aggregation-build';
import { createQuery, type QueryDocument } from '../../src/domain/query';
import { parseFieldCaps } from '../../src/domain/resource';

const library = parseChartDefinitionLibrary(fixture);
const entries = (library ? library.entries : []) as readonly ChartDefinition[];
const source: QueryDocument = { ...createQuery('connection'), id: 'query', index: 'logs-*', dsl: '{"query":{"match_all":{}}}' };
const parsed = parseFieldCaps('{"fields":{"bytes":{"long":{"searchable":true,"aggregatable":true}},'
  + '"latency":{"double":{"searchable":true,"aggregatable":true}},"host":{"keyword":{"searchable":true,"aggregatable":true}},'
  + '"@timestamp":{"date":{"searchable":true,"aggregatable":true}}}}');
if (!parsed.ok) throw new Error('fixture');
const catalog = parsed.value;

function draftOf(definition: ChartDefinition): AggregationBuildDraft {
  return definition.draft;
}

describe('chart definition documents', () => {
  it('parses the shared fixture and keeps it versioned and buildable', () => {
    expect(library).not.toBeNull();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.id)).toEqual(['chart-latency-by-day', 'chart-top-hosts', 'chart-single-average']);
    for (const entry of entries) expect(validateAggregationDraft(entry.draft)).toBeNull();
    expect(chartDefinitionPayload(entries[0]!)).toEqual(entries[0]);
    expect(JSON.parse(JSON.stringify(library))).toEqual(fixture);
  });

  it('keeps group literals as written and never rewrites the size token', () => {
    const group = entries[1]!.draft.group;
    if (!group || group.type !== 'terms') throw new Error('fixture');
    expect(group.size).toBe('20');
    const histogram = entries[0]!.draft.group;
    if (!histogram || histogram.type !== 'date_histogram') throw new Error('fixture');
    expect([histogram.interval, histogram.intervalValue, histogram.timeZone]).toEqual(['fixed_interval', '30d', 'UTC']);
  });

  it('reports an empty library as the versioned default', () => {
    expect(emptyChartDefinitions()).toEqual({ version: CHART_DEFINITION_VERSION, entries: [] });
    expect(parseChartDefinitionLibrary({ version: 1, entries: [] })).toEqual(emptyChartDefinitions());
    expect(parseChartDefinitionRecord({ revision: 0, library: emptyChartDefinitions() })).toEqual({ revision: 0, library: emptyChartDefinitions() });
  });

  it.each([
    ['a missing key', { id: 'a', name: 'N', connectionId: 'c1', index: 'logs-*', draft: { group: null, metrics: [] } }],
    ['an endpoint key', { ...fixture.entries[0], endpoint: 'https://leak.test' }],
    ['a result key', { ...fixture.entries[0], lastValue: 42 }],
    ['an evidence key', { ...fixture.entries[0], fieldType: 'long' }],
    ['a credential key', { ...fixture.entries[0], credentialRef: 'keychain:x' }],
    ['a time boundary key', { ...fixture.entries[0], from: '2026-10-10T00:00:00Z' }],
    ['a bad connection id', { ...fixture.entries[0], connectionId: 'has space' }],
    ['a bad definition id', { ...fixture.entries[0], id: '' }],
    ['a padded name', { ...fixture.entries[0], name: ' Padded' }],
    ['a control character in the name', { ...fixture.entries[0], name: 'Line\nbreak' }],
    ['a target outside the grammar', { ...fixture.entries[0], index: '../etc' }],
    ['a non-string metric field', { ...fixture.entries[0], draft: { group: null, metrics: [{ name: 'a', type: 'sum', field: 5 }] }, measure: 'a' }],
    ['a non-string group option', { ...fixture.entries[0], draft: { group: { type: 'terms', name: 'g', field: 'f', size: 20 }, metrics: [] }, measure: 'doc_count' }],
    ['a metric outside the shape', { ...fixture.entries[0], draft: { group: null, metrics: [{ name: 'a', type: 'percentiles', field: 'f' }] }, measure: 'a' }],
    ['a group with extra options', { ...fixture.entries[0], draft: { group: { type: 'terms', name: 'g', field: 'f', size: '', order: '_count' }, metrics: [] }, measure: 'doc_count' }],
    ['a histogram carrying size', { ...fixture.entries[0], draft: { group: { type: 'date_histogram', name: 'g', field: 'f', interval: 'fixed_interval', intervalValue: '1d', timeZone: '', size: '' }, metrics: [] }, measure: 'doc_count' }],
    ['a missing measure', { ...fixture.entries[0], measure: 'absent' }],
    ['doc_count without a group', { ...fixture.entries[2], measure: 'doc_count' }],
    ['an empty draft', { ...fixture.entries[2], draft: { group: null, metrics: [] }, measure: 'average' }],
    ['duplicate row names', { ...fixture.entries[0], draft: { group: null, metrics: [{ name: 'a', type: 'sum', field: 'f' }, { name: 'a', type: 'avg', field: 'f' }] }, measure: 'a' }],
  ])('refuses %s as a corrupt definition instead of repairing it', (_label, value) => {
    expect(parseChartDefinition(value)).toBeNull();
    expect(parseChartDefinitionLibrary({ version: 1, entries: [value] })).toBeNull();
  });

  it('refuses wrong versions, duplicate ids, oversized counts and oversized documents', () => {
    expect(parseChartDefinitionLibrary({ version: 2, entries: [] })).toBeNull();
    expect(parseChartDefinitionLibrary({ version: 1, entries: {} })).toBeNull();
    expect(parseChartDefinitionLibrary({ version: 1, entries: [entries[0], entries[0]] })).toBeNull();
    const tooMany = { version: 1, entries: Array.from({ length: MAX_CHART_DEFINITIONS + 1 }, () => entries[0]) };
    expect(parseChartDefinitionLibrary(tooMany)).toBeNull();
    const wide = (index: number): ChartDefinition => {
      const metrics = Array.from({ length: 31 }, (_, position) => ({
        name: `m${index}${position}${'x'.repeat(900)}`, type: 'sum' as const, field: 'y'.repeat(900),
      }));
      return {
        id: `chart-${index}`, name: `${index}${'n'.repeat(110)}`,
        connectionId: (fixture.entries[0] as ChartDefinition).connectionId,
        index: 'logs-*', draft: { group: null, metrics }, measure: metrics[0]!.name,
      };
    };
    const crowded: ChartDefinition[] = [];
    while (JSON.stringify({ version: 1, entries: crowded }).length <= MAX_CHART_DEFINITIONS_BYTES) crowded.push(wide(crowded.length));
    expect(crowded.length).toBeLessThan(MAX_CHART_DEFINITIONS);
    expect(parseChartDefinitionLibrary({ version: 1, entries: crowded })).toBeNull();
  });

  it('validates the record revision without inventing one', () => {
    expect(parseChartDefinitionRecord({ revision: -1, library: emptyChartDefinitions() })).toBeNull();
    expect(parseChartDefinitionRecord({ revision: 1.5, library: emptyChartDefinitions() })).toBeNull();
    expect(parseChartDefinitionRecord({ revision: Number.MAX_SAFE_INTEGER + 1, library: emptyChartDefinitions() })).toBeNull();
    expect(parseChartDefinitionRecord({ revision: 0, library })).toBeNull();
    expect(parseChartDefinitionRecord({ revision: '4', library })).toBeNull();
    expect(parseChartDefinitionRecord({ revision: 4, library, extra: 1 })).toBeNull();
    expect(parseChartDefinitionRecord({ revision: 7, library })?.revision).toBe(7);
  });
});

describe('chart definition reuse', () => {
  it('binds reuse to the exact connection id and target it was saved for', () => {
    const definition = entries[0]!;
    const selection = selectChartDefinition(definition);
    expect(parseChartDefinitionForTarget(selection, definition.connectionId, definition.index)).toEqual(selection);
    expect(parseChartDefinitionForTarget(selection, 'other-connection', definition.index)).toBeNull();
    expect(parseChartDefinitionForTarget(selection, definition.connectionId, 'other-*')).toBeNull();
    expect(parseChartDefinitionForTarget(selection, null, definition.index)).toBeNull();
    expect(parseChartDefinitionForTarget({ version: 2, definition }, definition.connectionId, definition.index)).toBeNull();
    expect(parseChartDefinitionForTarget({ version: 1, definition: { ...definition, measure: 'absent' } },
      definition.connectionId, definition.index)).toBeNull();
  });

  it('freezes a reuse copy so later library edits never change an opened review', () => {
    const selection = freezeChartDefinitionSelection(selectChartDefinition(entries[0]!));
    const before = JSON.stringify(selection);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.definition)).toBe(true);
    expect(Object.isFrozen(selection.definition.draft)).toBe(true);
    expect(Object.isFrozen(selection.definition.draft.metrics)).toBe(true);
    expect(Object.isFrozen(selection.definition.draft.group)).toBe(true);
    const mutated = selection.definition as { name: string };
    expect(() => { mutated.name = 'Later edit'; }).toThrow();
    expect(JSON.stringify(selection)).toBe(before);
    expect(sameChartDefinition(selection.definition, entries[0]!)).toBe(true);
  });

  it('seeds the aggregation builder with the stored shape and still needs a preview and apply', () => {
    const selection = selectChartDefinition(entries[0]!);
    const draft = draftOf(selection.definition);
    const result = previewAggregationBuild({ ...source, dsl: '{"query":{"match_all":{}}}' }, draft, catalog);
    if (!result.ok) throw new Error(result.code);
    expect(result.changed).toBe(true);
    expect(result.dsl).toContain('"per_day":{"date_histogram":{"field":"@timestamp","fixed_interval":"30d","time_zone":"UTC"},');
    expect(result.dsl).toContain('"total":{"sum":{"field":"bytes"}}');
    expect(result.dsl).toContain('"query":{"match_all":{}}');
    expect(parseChartDefinitionLibrary({ version: 1, entries: [entries[0]!] })).toEqual({ version: 1, entries: [entries[0]!] });
  });

  it('keeps a dotted stored field a gate refusal rather than a rewrite', () => {
    const value = { ...entries[2]!, draft: { group: null, metrics: [{ name: 'average', type: 'avg' as const, field: 'latency.ms' }] } };
    const stored = parseChartDefinition(value);
    if (!stored) throw new Error('fixture');
    expect(stored.draft.metrics[0]!.field).toBe('latency.ms');
    expect(previewAggregationBuild(source, stored.draft, catalog)).toMatchObject({ ok: false, code: 'fieldPath' });
  });

  it('refuses to re-select a definition the parser would not accept', () => {
    expect(() => selectChartDefinition({ ...entries[0]!, measure: 'absent' })).toThrow();
    expect(() => chartDefinitionPayload({ ...entries[0]!, id: '' })).toThrow();
  });
});

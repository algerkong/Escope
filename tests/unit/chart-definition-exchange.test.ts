import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_CHART_EXCHANGE_BYTES, buildChartDefinitionExchange, importChartDefinitionExchange,
  parseChartDefinitionExchange, parseChartDefinitionExchangeText, validateChartConnectionMappings,
  type ChartConnectionMapping, type ChartDefinitionExchange,
} from '../../src/domain/chart-definition-exchange';
import {
  MAX_CHART_DEFINITIONS, MAX_CHART_DEFINITIONS_BYTES, emptyChartDefinitions, parseChartDefinitionLibrary,
  type ChartDefinition, type ChartDefinitionLibrary,
} from '../../src/domain/chart-definitions';
import type { ConnectionProfile } from '../../src/domain/connection';
import { enChartDefinitions, zhChartDefinitions } from '../../src/locales/chart-definitions';

/** Test candidates are edited freely; every parser accepts only `unknown` input anyway. */
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

const raw = readFileSync('tests/fixtures/chart-definition-exchange-v1.json', 'utf8');
const bundle = (): ChartDefinitionExchange => parseChartDefinitionExchangeText(raw);
const draft = (): Mutable<ChartDefinitionExchange> => structuredClone(bundle()) as unknown as Mutable<ChartDefinitionExchange>;
type Local = Pick<ConnectionProfile, 'id' | 'endpoint'>;
type Named = Local & { displayName: string };
const profiles: readonly Named[] = [
  { id: 'local-one', displayName: 'Alpha', endpoint: 'https://one.test' },
  { id: 'local-two', displayName: 'Beta', endpoint: 'https://two.test' },
];
const locals: readonly Local[] = profiles.map(({ id, endpoint }) => ({ id, endpoint }));
const mapping = (sourceKey: string, local: Local): ChartConnectionMapping => ({
  sourceKey, target: { connectionId: local.id, endpoint: local.endpoint },
});
const mappings = (): ChartConnectionMapping[] => [mapping('connection-1', locals[0]!), mapping('connection-2', locals[1]!)];
const error = (action: () => unknown, code: string) => {
  try { action(); throw new Error('expected failure'); } catch (failure) { expect(failure).toMatchObject({ code }); }
};

const stored = (id: string, connectionId: string, name: string): ChartDefinition => ({
  id, name, connectionId, index: 'logs-*', measure: 'average',
  draft: { group: null, metrics: [{ name: 'average', type: 'avg', field: 'bytes' }] },
});

/** Near-longest literals inside one definition, used to reach the library byte cap. */
function wide(id: string, prefix: string): ChartDefinition {
  const metrics = Array.from({ length: 31 }, (_, index) => ({
    name: `${prefix}${index}${'n'.repeat(900)}`, type: 'sum' as const, field: 'f'.repeat(900),
  }));
  return { id, name: 'Wide', connectionId: 'local-one', index: 'logs-*', measure: metrics[0]!.name,
    draft: { group: null, metrics } };
}

/** One definition with the longest metrics the shape allows, inside a single-source document. */
function wideDocument(): Mutable<ChartDefinitionExchange> {
  const crowded = draft();
  crowded.definitions = [crowded.definitions[0]!];
  crowded.connections = [crowded.connections[0]!];
  const metrics = Array.from({ length: 31 }, (_, index) => ({
    name: `w${index}${'n'.repeat(900)}`, type: 'sum' as const, field: 'f'.repeat(900),
  }));
  crowded.definitions[0]!.draft = { group: null, metrics };
  crowded.definitions[0]!.measure = metrics[0]!.name;
  return crowded;
}

describe('chart definition exchange', () => {
  it('reads the shared fixture and keeps every literal unchanged', () => {
    const parsed = bundle();
    expect(parsed.definitions).toHaveLength(3);
    expect(parsed.connections).toHaveLength(2);
    expect(JSON.stringify(parsed)).toContain('"intervalValue":"30d"');
    expect(JSON.stringify(parsed)).toContain('"timeZone":"UTC"');
    expect(JSON.stringify(parsed)).toContain('"size":"20"');
    expect(JSON.stringify(parsed)).toContain('"measure":"doc_count"');
    expect(parseChartDefinitionExchangeText(JSON.stringify(parsed))).toEqual(parsed);
    // A dotted path is a stored literal: the build gate, not the document, refuses it later.
    expect(parsed.definitions[2]!.draft.metrics[0]!.field).toBe('bytes.total');
  });

  it('exports only definition bodies and opaque source labels', () => {
    const library: ChartDefinitionLibrary = { version: 1, entries: [
      stored('local-chart-a', 'local-one', 'Daily latency'),
      stored('local-chart-b', 'local-two', 'Top hosts'),
      stored('local-chart-c', 'local-one', 'Average bytes'),
    ] };
    const built = buildChartDefinitionExchange(library, ['local-chart-a', 'local-chart-b', 'local-chart-c'],
      [{ ...profiles[0]!, credentialRef: 'must-not-export' } as unknown as ConnectionProfile, profiles[1]!]);
    const encoded = JSON.stringify(built);
    for (const absent of ['local-one', 'local-two', 'local-chart-a', 'local-chart-b', 'must-not-export',
      'credentialRef', 'endpoint', 'authentication', 'https://', 'updatedAt', 'revision']) {
      expect(encoded).not.toContain(absent);
    }
    expect(encoded).toContain('Alpha');
    expect(encoded).toContain('Beta');
    // Two definitions on one connection share one source label, and the document re-parses.
    expect(built.connections).toHaveLength(2);
    expect(built.definitions.map(({ key }) => key)).toEqual(['chart-1', 'chart-2', 'chart-3']);
    expect(built.definitions[2]!.connectionKey).toBe(built.definitions[0]!.connectionKey);
    expect(parseChartDefinitionExchange(JSON.parse(encoded))).toEqual(built);
  });

  it('refuses an export with no, repeated, unknown or unparseable selection', () => {
    const library: ChartDefinitionLibrary = { version: 1, entries: [stored('local-chart-a', 'local-one', 'Daily latency')] };
    error(() => buildChartDefinitionExchange(library, [], profiles), 'exchangeInvalid');
    error(() => buildChartDefinitionExchange(library, ['local-chart-a', 'local-chart-a'], profiles), 'exchangeInvalid');
    error(() => buildChartDefinitionExchange(library, ['absent'], profiles), 'chartDefinitionConflict');
    error(() => buildChartDefinitionExchange({ version: 2, entries: library.entries } as unknown as ChartDefinitionLibrary, ['local-chart-a'], profiles), 'exchangeInvalid');
    error(() => buildChartDefinitionExchange({ version: 1, entries: [{ id: 'local-chart-a' }] } as unknown as ChartDefinitionLibrary, ['local-chart-a'], profiles), 'exchangeInvalid');
  });

  it('labels a removed connection by its opaque key and still needs a real target on import', () => {
    const built = buildChartDefinitionExchange({ version: 1, entries: [stored('local-chart-a', 'deleted-id', 'Daily latency')] },
      ['local-chart-a'], profiles);
    expect(built.connections).toEqual([{ key: 'connection-1', label: 'connection-1' }]);
    expect(importChartDefinitionExchange(built, [mapping('connection-1', locals[0]!)], emptyChartDefinitions(), locals)
      .entries[0]!.connectionId).toBe('local-one');
    error(() => importChartDefinitionExchange(built, mappings(), emptyChartDefinitions(), locals), 'exchangeMappingRequired');
  });

  it('requires an explicit local target for every source and never maps by name', () => {
    error(() => validateChartConnectionMappings(bundle(), [], locals), 'exchangeMappingRequired');
    error(() => validateChartConnectionMappings(bundle(), [mappings()[0]!], locals), 'exchangeMappingRequired');
    error(() => validateChartConnectionMappings(bundle(), [mappings()[0]!, mappings()[0]!], locals), 'exchangeMappingRequired');
    error(() => validateChartConnectionMappings(bundle(), [mapping('connection-9', locals[0]!), mappings()[1]!], locals), 'exchangeMappingRequired');
    error(() => validateChartConnectionMappings(bundle(), [
      { sourceKey: 'connection-1', target: null }, mappings()[1]!,
    ] as unknown as ChartConnectionMapping[], locals), 'exchangeMappingRequired');
    error(() => validateChartConnectionMappings(bundle(), [
      { sourceKey: 'connection-1', target: { connectionId: 'local-one', endpoint: 'https://one.test', credentialRef: 'x' } }, mappings()[1]!,
    ] as unknown as ChartConnectionMapping[], locals), 'exchangeMappingRequired');
    error(() => validateChartConnectionMappings(bundle(), [mapping('connection-1', { id: 'has space', endpoint: 'https://one.test' }), mappings()[1]!], locals), 'exchangeMappingRequired');
    // A same-named but different connection, a moved endpoint and a removed connection all invalidate.
    error(() => validateChartConnectionMappings(bundle(), mappings(), [{ id: 'other', endpoint: 'https://one.test' }]), 'exchangeTargetChanged');
    error(() => validateChartConnectionMappings(bundle(), mappings(), [{ id: 'local-one', endpoint: 'https://moved.test' }, locals[1]!]), 'exchangeTargetChanged');
    error(() => validateChartConnectionMappings(bundle(), mappings(), []), 'exchangeTargetChanged');
    expect(validateChartConnectionMappings(bundle(), mappings(), locals).size).toBe(2);
  });

  it('imports as new definitions without touching stored entries, names or bindings', () => {
    const base: ChartDefinitionLibrary = { version: 1, entries: [stored('chart-existing', 'local-one', 'Top hosts')] };
    const snapshot = JSON.stringify(base);
    let issued = 0;
    const imported = importChartDefinitionExchange(bundle(), mappings(), base, locals, () => `imported-${++issued}`);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(imported.entries).toHaveLength(4);
    expect(imported.entries[0]).toEqual(base.entries[0]);
    expect(new Set(imported.entries.map(({ id }) => id)).size).toBe(4);
    // The document repeats a stored name: import appends, it never overwrites.
    expect(imported.entries.map(({ name }) => name)).toEqual(['Top hosts', 'Latency per day', 'Top hosts', 'Average bytes']);
    expect(imported.entries[1]!.connectionId).toBe('local-one');
    expect(imported.entries[2]!.connectionId).toBe('local-two');
    expect(imported.entries[3]!.connectionId).toBe('local-one');
    expect(imported.entries[1]!.draft).toEqual(bundle().definitions[0]!.draft);
    expect(imported.entries[2]!.measure).toBe('doc_count');
    expect(parseChartDefinitionLibrary(imported)).toEqual(imported);
    // The imported rows are the reviewer's copies, not aliases of the document under review.
    const document = draft();
    const detached = importChartDefinitionExchange(document, mappings(), emptyChartDefinitions(), locals);
    document.definitions[0]!.name = 'Rewritten afterwards';
    document.definitions[0]!.draft.group = null;
    expect(detached.entries[0]!.name).toBe('Latency per day');
    expect(detached.entries[0]!.draft.group).not.toBeNull();
    expect(imported.entries[1]!.name).toBe('Latency per day');
  });

  it('refuses an import that would exceed the library cap, without a partial append', () => {
    const filled: ChartDefinitionLibrary = { version: 1, entries: Array.from(
      { length: MAX_CHART_DEFINITIONS - 2 }, (_, index) => stored(`chart-${index}`, 'local-one', 'Saved')) };
    error(() => importChartDefinitionExchange(bundle(), mappings(), filled, locals), 'exchangeTooLarge');
    expect(filled.entries).toHaveLength(MAX_CHART_DEFINITIONS - 2);
    const byteBounded: ChartDefinitionLibrary = { version: 1, entries: [
      wide('chart-wide-1', 'm'), wide('chart-wide-2', 'm'), wide('chart-wide-3', 'm'), wide('chart-wide-4', 'm')] };
    expect(JSON.stringify(byteBounded).length).toBeLessThan(MAX_CHART_DEFINITIONS_BYTES);
    expect(parseChartDefinitionLibrary(byteBounded)).not.toBeNull();
    const crowded = wideDocument();
    expect(JSON.stringify(crowded).length).toBeLessThan(MAX_CHART_EXCHANGE_BYTES);
    error(() => importChartDefinitionExchange(crowded, [mapping('connection-1', locals[0]!)], byteBounded, locals), 'exchangeTooLarge');
    expect(byteBounded.entries).toHaveLength(4);
    error(() => importChartDefinitionExchange(bundle(), mappings(), { version: 2, entries: [] } as unknown as ChartDefinitionLibrary, locals), 'chartDefinitionConflict');
  });

  it('refuses future versions, duplicate keys and any unknown field', () => {
    const parsed = bundle();
    error(() => parseChartDefinitionExchangeText(raw.replace('"version": 1', '"version": 9')), 'exchangeVersion');
    error(() => parseChartDefinitionExchangeText(raw.replace('"version": 1', '"version": 1, "version": 1')), 'exchangeInvalid');
    error(() => parseChartDefinitionExchangeText(`${raw}x`), 'exchangeInvalid');
    error(() => parseChartDefinitionExchangeText(' '.repeat(MAX_CHART_EXCHANGE_BYTES + 1)), 'exchangeTooLarge');
    error(() => parseChartDefinitionExchange({ ...parsed, format: 'escope-query-definitions' }), 'exchangeInvalid');
    error(() => parseChartDefinitionExchange({ ...parsed, version: '1' }), 'exchangeInvalid');
    for (const field of ['dsl', 'results', 'history', 'endpoint', 'timeRange', 'fieldCaps', 'revision', 'timeBoundary']) {
      error(() => parseChartDefinitionExchange({ ...parsed, [field]: 'not-allowed' }), 'exchangeInvalid');
      error(() => parseChartDefinitionExchange({ ...parsed, definitions: [
        { ...parsed.definitions[0], [field]: 'not-allowed' }, parsed.definitions[1], parsed.definitions[2]] }), 'exchangeInvalid');
      error(() => parseChartDefinitionExchange({ ...parsed, connections: [
        { ...parsed.connections[0], [field]: 'not-allowed' }, parsed.connections[1]] }), 'exchangeInvalid');
    }
  });

  it.each(['credentialRef', 'authorization', 'api-key', 'password', 'headers', 'auth'])('blocks the sensitive key %s at any depth', (key) => {
    const parsed = draft();
    error(() => parseChartDefinitionExchange({ ...parsed, [key]: 'fixture-only' }), 'exchangeSensitive');
    error(() => parseChartDefinitionExchange({ ...parsed, definitions: [
      { ...parsed.definitions[0], [key]: 'fixture-only' }, parsed.definitions[1], parsed.definitions[2]] }), 'exchangeSensitive');
    error(() => parseChartDefinitionExchange({ ...parsed, definitions: [{ ...parsed.definitions[0], draft: {
      ...parsed.definitions[0]!.draft, metrics: [{ ...parsed.definitions[0]!.draft.metrics[0], [key]: 'fixture-only' },
        parsed.definitions[0]!.draft.metrics[1]!] },
    }, parsed.definitions[1], parsed.definitions[2]] }), 'exchangeSensitive');
  });

  it.each(['Bearer fixture-only', 'Authorization: fixture-only', '-----BEGIN RSA PRIVATE KEY-----', 'credential:fixture'])(
    'blocks the authentication-like literal %s in any field', (literal) => {
      const parsed = draft();
      const first = parsed.definitions[1]!;
      for (const candidate of [
        { ...parsed, definitions: [{ ...first, name: literal }, parsed.definitions[0], parsed.definitions[2]] },
        { ...parsed, definitions: [{ ...first, index: literal }, parsed.definitions[0], parsed.definitions[2]] },
        { ...parsed, definitions: [{ ...first, measure: literal }, parsed.definitions[0], parsed.definitions[2]] },
        { ...parsed, definitions: [{ ...first, draft: { ...first.draft,
          group: { ...first.draft.group!, field: literal } } }, parsed.definitions[0], parsed.definitions[2]] },
        { ...parsed, connections: [{ ...parsed.connections[0]!, label: literal }, parsed.connections[1]] },
      ]) error(() => parseChartDefinitionExchange(candidate), 'exchangeSensitive');
      error(() => parseChartDefinitionExchangeText(JSON.stringify(
        { ...parsed, definitions: [{ ...first, measure: literal }, parsed.definitions[0], parsed.definitions[2]] })), 'exchangeSensitive');
      error(() => buildChartDefinitionExchange({ version: 1, entries: [stored('chart-a', 'local-one', literal)] }, ['chart-a'],
        [{ id: 'local-one', displayName: literal }]), 'exchangeSensitive');
    });

  it('refuses unbuildable, ambiguous or over-limit documents instead of repairing them', () => {
    const mutate = (change: (document: Mutable<ChartDefinitionExchange>) => void) => {
      const candidate = draft();
      change(candidate);
      return candidate;
    };
    for (const change of [
      (document: Mutable<ChartDefinitionExchange>) => { document.definitions[0]!.measure = 'absent'; },
      (document: Mutable<ChartDefinitionExchange>) => { document.definitions[2]!.draft = { group: null, metrics: [] }; },
      (document: Mutable<ChartDefinitionExchange>) => {
        document.definitions[1]!.draft = { group: { name: 'by_host', type: 'terms', field: 'host', size: '0' }, metrics: [] };
      },
      (document: Mutable<ChartDefinitionExchange>) => {
        document.definitions[0]!.draft = { group: null, metrics: [{ name: 'p', type: 'percentiles' as never, field: 'bytes' }] };
      },
      (document: Mutable<ChartDefinitionExchange>) => { document.definitions[1]!.key = document.definitions[0]!.key; },
      (document: Mutable<ChartDefinitionExchange>) => { document.definitions[0]!.connectionKey = 'connection-9'; },
      (document: Mutable<ChartDefinitionExchange>) => { document.definitions = []; },
      (document: Mutable<ChartDefinitionExchange>) => { document.connections = []; },
      // a source nobody references means the document was rewritten on the way out
      (document: Mutable<ChartDefinitionExchange>) => { document.definitions = [document.definitions[0]!]; },
      (document: Mutable<ChartDefinitionExchange>) => { document.connections[1]!.label = ''; },
      (document: Mutable<ChartDefinitionExchange>) => { document.definitions[1]!.name = ' Padded'; },
      (document: Mutable<ChartDefinitionExchange>) => { document.definitions[1]!.index = '../etc'; },
      (document: Mutable<ChartDefinitionExchange>) => {
        document.definitions[1]!.draft = { group: { name: 'by_host', type: 'terms', field: 'host', size: 20 as never }, metrics: [] };
      },
    ]) error(() => parseChartDefinitionExchange(mutate(change)), 'exchangeInvalid');
    error(() => parseChartDefinitionExchange({ ...bundle(), definitions: Array.from(
      { length: MAX_CHART_DEFINITIONS + 1 }, (_, index) => ({ ...bundle().definitions[1], key: `chart-${index}` })) }), 'exchangeTooLarge');
  });

  it('keeps the exchange and the library boundaries independent', () => {
    const imported = importChartDefinitionExchange(bundle(), mappings(), emptyChartDefinitions(), locals);
    expect(emptyChartDefinitions().entries).toHaveLength(0);
    expect(imported.version).toBe(1);
    // Reuse still needs an exact connection and target, so an import alone can never run anything.
    expect(JSON.stringify(imported)).not.toContain('https://');
    expect(JSON.stringify(imported)).not.toContain('endpoint');
    expect(imported.entries.every((entry) => /^[A-Za-z0-9_-]{1,64}$/.test(entry.connectionId))).toBe(true);
  });

  it('keeps English and Chinese exchange keys aligned', () => {
    const en = Object.keys(enChartDefinitions);
    expect(Object.keys(zhChartDefinitions).sort()).toEqual([...en].sort());
    for (const key of en.filter((name) => name.startsWith('exchange'))) {
      expect(enChartDefinitions[key as keyof typeof enChartDefinitions]).toBeTruthy();
      expect(zhChartDefinitions[key as keyof typeof zhChartDefinitions]).toBeTruthy();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { selectConnection, validateConnection, type ConnectionProfile } from '../../src/domain/connection';
import { defaultPreferences, parsePreferences, resolveLocale } from '../../src/domain/preferences';
import { acceptResponse, cancelExecution, createQuery, createSnapshot, switchConnection, type ExecutionState } from '../../src/domain/query';
import { createSessionStorage } from '../../src/services/storage';
import { en } from '../../src/locales/en-US';
import { zh } from '../../src/locales/zh-CN';
import { executeQuery } from '../../src/services/ipc';

const profiles: ConnectionProfile[] = [
  { id: 'a', displayName: 'Zulu', endpoint: 'https://a.example.test', environment: 'development', sortOrder: 0, auth: 'none' },
  { id: 'b', displayName: 'Alpha', endpoint: 'https://b.example.test', environment: 'production', sortOrder: 1, auth: 'none' },
];
describe('connection identity', () => {
  it('handles zero, single and multiple connections without sorting by name', () => {
    expect(selectConnection([], 'missing')).toBeNull();
    expect(selectConnection(profiles.slice(0, 1), null)).toBe('a');
    expect(selectConnection([...profiles].reverse(), null)).toBe('a');
    expect(selectConnection(profiles, 'b')).toBe('b');
    expect(selectConnection(profiles, 'missing')).toBe('a');
  });
  it('renaming does not affect selection and deletion falls back', () => {
    expect(selectConnection(profiles.map((p) => ({ ...p, displayName: 'Renamed' })), 'b')).toBe('b');
    expect(selectConnection(profiles.slice(0, 1), 'b')).toBe('a');
  });
  it.each(['file:///tmp/a', 'javascript:alert(1)', 'https://u:p@example.test', 'https://example.test/?token=secret', 'https://example.test/#secret', 'not an endpoint'])('rejects unsafe endpoint %s', (endpoint) => {
    expect(() => validateConnection({ displayName: 'Test', endpoint, environment: 'development' })).toThrow('invalidEndpoint');
  });
  it('preserves path prefixes and trims names', () => {
    expect(validateConnection({ displayName: ' Test ', endpoint: 'https://example.test/es/', environment: 'development' })).toEqual({
      displayName: 'Test', endpoint: 'https://example.test/es', environment: 'development',
    });
  });
});
describe('execution and workspace isolation', () => {
  it('keeps raw DSL, large numbers and immutable execution metadata', () => {
    const query = { ...createQuery('a'), index: 'orders-*', dsl: '{"query":{"term":{"id":9007199254740993}}}' };
    const snapshot = createSnapshot(query, 'r1', new Date('2026-09-30T00:00:00Z'));
    query.dsl = '{}'; query.index = 'other';
    expect(snapshot.rawDsl).toContain('9007199254740993');
    expect(snapshot.index).toBe('orders-*');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it('rejects no connection and no index', () => {
    expect(() => createSnapshot(createQuery(null), 'r1', new Date())).toThrow('noConnection');
    expect(() => createSnapshot(createQuery('a'), 'r1', new Date())).toThrow('invalidIndex');
  });
  it('rejects stale, other-connection and cancelled responses', () => {
    const snapshot = createSnapshot({ ...createQuery('a'), index: 'orders-*' }, 'r2', new Date());
    const state: ExecutionState = { status: 'running', snapshot };
    expect(acceptResponse(state, { requestId: 'r1', connectionId: 'a', rawResponse: '{}' })).toBe(state);
    expect(acceptResponse(state, { requestId: 'r2', connectionId: 'b', rawResponse: '{}' })).toBe(state);
    const cancelled = cancelExecution(state);
    expect(acceptResponse(cancelled, { requestId: 'r2', connectionId: 'a', rawResponse: '{}' })).toBe(cancelled);
    expect(acceptResponse(state, { requestId: 'r2', connectionId: 'a', rawResponse: '{}', partial: true }).status).toBe('partial');
  });
  it('switches without rebinding an existing query or losing drafts', () => {
    const query = { ...createQuery('a'), dsl: 'untouched', revision: 3 };
    const initial = { activeConnectionId: 'a', activeQueryId: query.id, queries: [query] };
    const second = switchConnection(initial, 'b', 'json');
    expect(second.queries[0]).toBe(query);
    expect(second.queries[1]?.connectionId).toBe('b');
    expect(switchConnection(second, 'a', 'table').activeQueryId).toBe(query.id);
  });
  it('unimplemented execution never produces mock results', async () => {
    await expect(executeQuery({ requestId: 'r', connectionId: 'a', index: 'orders', rawDsl: '{}' })).rejects.toMatchObject({ code: 'unsupported' });
  });
});
describe('preference validation and translation parity', () => {
  it.each([null, [], 'bad', { mode: 'red', accent: 'pink', uiSize: 999, codeSize: -1, grouping: 'true' }])('recovers invalid preferences without trusting arbitrary CSS (%j)', (input) => {
    expect(parsePreferences(input)).toEqual(defaultPreferences);
  });
  it('selects locale independently of query values', () => {
    expect(resolveLocale({ ...defaultPreferences }, 'zh-TW')).toBe('zh-CN');
    expect(resolveLocale({ ...defaultPreferences }, 'fr-FR')).toBe('en-US');
    expect(resolveLocale({ ...defaultPreferences, locale: 'en-US' }, 'zh-CN')).toBe('en-US');
  });
  for (const mode of ['light', 'dark'] as const) {
    for (const accent of ['graphite', 'jade', 'blue', 'violet'] as const) {
      for (const locale of ['zh-CN', 'en-US'] as const) {
        it(`accepts ${mode}/${accent}/${locale}`, () => {
          expect(parsePreferences({ mode, accent, locale })).toMatchObject({ mode, accent, locale });
        });
      }
    }
  }
  it('maintains matching namespaces, keys and interpolation placeholders', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en));
    for (const namespace of Object.keys(en) as (keyof typeof en)[]) {
      expect(Object.keys(zh[namespace])).toEqual(Object.keys(en[namespace]));
      for (const [key, text] of Object.entries(en[namespace])) {
        const translated = (zh[namespace] as Record<string, string>)[key]!;
        expect(translated.match(/\{\{.*?\}\}/g)).toEqual(text.match(/\{\{.*?\}\}/g));
      }
    }
  });
});
describe('explicit session storage', () => {
  it('does not use browser persistence and preserves metadata identity', async () => {
    const service = createSessionStorage();
    expect(service.kind).toBe('session');
    const a = await service.saveConnection({ displayName: 'A', endpoint: 'https://a.test', environment: 'development' });
    const b = await service.saveConnection({ displayName: 'B', endpoint: 'https://b.test', environment: 'production' });
    await service.selectConnection(b.id);
    const renamed = await service.saveConnection({ displayName: 'Other', endpoint: b.endpoint, environment: b.environment }, b.id);
    expect(renamed.id).toBe(b.id);
    const snapshot = await service.load();
    snapshot.connections.length = 0;
    expect((await service.load()).connections).toHaveLength(2);
    await service.deleteConnection(b.id);
    expect((await service.load()).activeConnectionId).toBe(a.id);
    expect((await createSessionStorage().load()).connections).toHaveLength(0);
  });
});

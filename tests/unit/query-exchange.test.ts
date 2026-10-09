import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_EXCHANGE_BYTES, buildQueryExchange, importQueryExchange, parseQueryExchange,
  parseQueryExchangeText, validateConnectionMappings, type ConnectionMapping, type QueryExchange,
} from '../../src/domain/query-exchange';
import { createEmptyLibrary, entryFromDocument, parseLibraryPayload, type SavedQueryLibrary } from '../../src/domain/query-library';
import { createQuery, createValidatedSnapshot } from '../../src/domain/query';
import { documentFromEntry } from '../../src/domain/query-library';
import type { ConnectionProfile } from '../../src/domain/connection';
import { enQueryParameters, zhQueryParameters } from '../../src/locales/query-parameters';
import { enQueryExchange, zhQueryExchange } from '../../src/locales/query-exchange';

const raw = readFileSync('tests/fixtures/query-exchange-v1.json', 'utf8');
const bundle = (): QueryExchange => parseQueryExchangeText(raw);
const target: ConnectionProfile = { id: 'local-a', displayName: 'Fixture source', endpoint: 'https://local.test/',
  environment: 'development', sortOrder: 0, auth: 'none' };
const mapping: ConnectionMapping[] = [{ sourceKey: 'source-a', target: { connectionId: target.id, endpoint: target.endpoint } }];
const error = (action: () => unknown, code: string) => {
  try { action(); throw new Error('expected failure'); } catch (failure) { expect(failure).toMatchObject({ code }); }
};

describe('query definition exchange', () => {
  it('reads the shared v1 fixture and preserves exact DSL, templates and escapes', () => {
    const parsed = bundle();
    expect(parsed.queries[0]!.parameters?.template).toContain('1.234567890123456789');
    expect(parsed.queries[1]!.dsl).toContain('900719925474099312345');
    expect(parsed.queries[1]!.dsl).toContain('\\u0061');
    expect(parseQueryExchangeText(JSON.stringify(parsed))).toEqual(parsed);
  });

  it('exports only explicit query definitions and source labels, without applied parameter values', () => {
    const parameters = bundle().queries[0]!.parameters!;
    const document = { ...createQuery(target.id), name: 'Saved', index: 'orders-*', parameters,
      dsl: parameters.template.replace('{"$param":"minimum"}', '987654321234567890') };
    const entry = entryFromDocument(document, { id: 'local-entry', name: document.name, favorite: true, now: new Date() });
    const library = { version: 1, entries: [entry] };
    const encoded = JSON.stringify(buildQueryExchange(library, [entry.id], [{ ...target, credentialRef: 'must-not-export' } as ConnectionProfile]));
    for (const excluded of [target.id, target.endpoint, entry.id, 'must-not-export', '987654321234567890', 'credentialRef', 'updatedAt']) {
      expect(encoded).not.toContain(excluded);
    }
    expect(encoded).toContain('$param');
    expect(encoded).toContain(target.displayName);
    expect(document.dsl).toContain('987654321234567890');
    error(() => buildQueryExchange(library, [], [target]), 'exchangeInvalid');
    error(() => buildQueryExchange(library, ['absent'], [target]), 'libraryConflict');
    error(() => buildQueryExchange(library, [entry.id, entry.id], [target]), 'exchangeInvalid');
  });

  it('never maps by name or current selection, and can explicitly leave a source unbound', () => {
    error(() => validateConnectionMappings(bundle(), [], [target]), 'exchangeMappingRequired');
    error(() => validateConnectionMappings(bundle(), [{ sourceKey: 'source-a', target: { connectionId: 'source-a', endpoint: target.endpoint } }], [target]), 'exchangeTargetChanged');
    error(() => validateConnectionMappings(bundle(), mapping, [{ ...target, id: 'same-name' }]), 'exchangeTargetChanged');
    error(() => validateConnectionMappings(bundle(), mapping, [{ ...target, endpoint: 'https://changed.test/' }]), 'exchangeTargetChanged');
    error(() => validateConnectionMappings(bundle(), mapping, []), 'exchangeTargetChanged');
    const unbound = importQueryExchange(bundle(), [{ sourceKey: 'source-a', target: null }], createEmptyLibrary(), [target]);
    expect(unbound.entries.every((entry) => entry.connectionId === null)).toBe(true);
    const explicit = importQueryExchange(bundle(), mapping, createEmptyLibrary(), [target]);
    expect(explicit.entries[0]!.connectionId).toBe(target.id);
    expect(explicit.entries[1]!.connectionId).toBeNull();
  });

  it('appends fresh IDs and keeps local names, drafts and parameter execution state untouched', () => {
    const base: SavedQueryLibrary = { version: 1, entries: [{
      id: 'existing', name: 'Amount threshold', connectionId: 'old-connection', index: 'original-*',
      dsl: '{', resultView: 'table', favorite: false, updatedAt: '2026-10-09T01:00:00.000Z',
    }] };
    const imported = importQueryExchange(bundle(), mapping, base, [target]);
    expect(imported.entries[0]).toEqual(base.entries[0]);
    expect(imported.entries).toHaveLength(3);
    expect(new Set(imported.entries.map(({ id }) => id)).size).toBe(3);
    expect(base.entries).toHaveLength(1);
    expect(parseLibraryPayload(imported).ok).toBe(true);
    const query = documentFromEntry(imported.entries[1]!);
    expect(createValidatedSnapshot(query, 'r1', new Date())).toMatchObject({ ok: false, error: { code: 'dslUnresolvedParameters' } });
  });

  it.each(['credentialRef', 'credentials', 'auth', 'headers', 'results', 'history', 'endpoint'])('refuses the unknown wrapper field %s', (field) => {
    error(() => parseQueryExchange({ ...bundle(), [field]: 'not-allowed' }), 'exchangeInvalid');
    const parsed = bundle();
    error(() => parseQueryExchange({ ...parsed, queries: [{ ...parsed.queries[0], [field]: 'not-allowed' }, parsed.queries[1]] }), 'exchangeInvalid');
    error(() => parseQueryExchange({ ...parsed, connections: [{ ...parsed.connections[0], [field]: 'not-allowed' }] }), 'exchangeInvalid');
  });

  it.each(['authorization', 'Authorization', 'credential_ref', 'api-key', 'password', 'headers', 'privateKey'])('blocks sensitive DSL key %s, including escaped spelling', (key) => {
    const parsed = bundle();
    error(() => parseQueryExchange({ ...parsed, queries: [{ ...parsed.queries[1], dsl: JSON.stringify({ query: { term: { [key]: 'fixture-only' } } }) }], connections: [] }), 'exchangeSensitive');
    error(() => parseQueryExchange({ ...parsed, queries: [{ ...parsed.queries[1], dsl: '{"query":{"term":{"\\u0061uthorization":"fixture-only"}}}' }], connections: [] }), 'exchangeSensitive');
  });

  it.each(['Bearer fixture-only', 'Authorization: fixture-only', '-----BEGIN RSA PRIVATE KEY-----', 'credential:fixture'])('blocks authentication-like literal %s', (literal) => {
    const query = bundle().queries[1]!;
    const dsl = JSON.stringify({ query: { term: { value: literal } } });
    error(() => parseQueryExchange({ ...bundle(), connections: [], queries: [{ ...query, dsl }] }), 'exchangeSensitive');
  });

  it('rejects future versions, duplicates, malformed templates, unknown types and parameter defaults', () => {
    error(() => parseQueryExchangeText(raw.replace('"version": 1', '"version": 9')), 'exchangeVersion');
    error(() => parseQueryExchangeText(raw.replace('"version": 1', '"version": 1, "version": 1')), 'exchangeInvalid');
    error(() => parseQueryExchangeText(raw + 'x'), 'exchangeInvalid');
    const parsed = bundle();
    error(() => parseQueryExchange({ ...parsed, queries: [...parsed.queries, parsed.queries[0]] }), 'exchangeInvalid');
    error(() => parseQueryExchange({ ...parsed, queries: [{ ...parsed.queries[0], parameters: { ...parsed.queries[0]!.parameters, values: { minimum: 'secret' } } }] }), 'exchangeInvalid');
    error(() => parseQueryExchange({ ...parsed, queries: [{ ...parsed.queries[0], dsl: '{}' }] }), 'exchangeInvalid');
    error(() => parseQueryExchange({ ...parsed, queries: [{ ...parsed.queries[0], parameters: null }] }), 'exchangeInvalid');
    error(() => parseQueryExchange({ ...parsed, queries: [{ ...parsed.queries[1], connectionKey: 'unknown' }] }), 'exchangeInvalid');
    error(() => parseQueryExchange({ ...parsed, version: '1' }), 'exchangeInvalid');
  });

  it('treats private number-parser keys as ordinary JSON fields, never as a validation bypass', () => {
    const query = bundle().queries[1]!;
    for (const dsl of [
      '{"$serde_json::private::Number":"1","authorization":"fixture"}',
      '{"query":{"$serde_json::private::Number":"1","authorization":"fixture"}}',
    ]) {
      error(() => parseQueryExchange({ ...bundle(), connections: [], queries: [{ ...query, dsl }] }), 'exchangeSensitive');
    }
  });

  it('refuses over-limit files or combined libraries without partial import', () => {
    error(() => parseQueryExchangeText(' '.repeat(MAX_QUERY_EXCHANGE_BYTES + 1)), 'exchangeTooLarge');
    const parsed = bundle();
    error(() => parseQueryExchange({ ...parsed, queries: Array.from({ length: 101 }, (_, index) => ({ ...parsed.queries[1], key: `q${index}` })) }), 'exchangeTooLarge');
    const original = importQueryExchange(parsed, mapping, createEmptyLibrary(), [target]);
    const full = { version: 1, entries: Array.from({ length: 99 }, (_, index) => ({ ...original.entries[1]!, id: `q${index}` })) };
    error(() => importQueryExchange(parsed, mapping, full, [target]), 'exchangeTooLarge');
    expect(full.entries).toHaveLength(99);
  });

  it('keeps parameter and exchange locale keys aligned', () => {
    expect(Object.keys(zhQueryParameters).sort()).toEqual(Object.keys(enQueryParameters).sort());
    expect(Object.keys(zhQueryExchange).sort()).toEqual(Object.keys(enQueryExchange).sort());
  });
});

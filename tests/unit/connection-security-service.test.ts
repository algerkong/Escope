import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { createSessionStorage, createStorage } from '../../src/services/storage';
import { requireConnectionSecurity, type ConnectionSecurityChange } from '../../src/domain/connection';
import { parsePreferences } from '../../src/domain/preferences';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const input = { displayName: 'Fixture', endpoint: 'https://es.test', environment: 'development' as const };
const profile = { ...input, id: '1ed43afe-c318-4fe6-8cce-aa2a82be27be', sortOrder: 0,
  auth: 'basic', hasCredential: true, hasCustomCa: true };

beforeEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });

describe('connection management contract', () => {
  it('loads authenticated metadata without requesting or returning a credential', async () => {
    vi.mocked(invoke).mockResolvedValue({
      preferences: parsePreferences(null), connections: [profile], activeConnectionId: profile.id, credentialCleanupPending: true,
    });
    expect(await createStorage().load()).toMatchObject({ connections: [profile], credentialCleanupPending: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connections_load');
  });

  it.each(['credentialRef', 'password', 'pem'])('rejects a metadata payload with %s', async (key) => {
    vi.mocked(invoke).mockResolvedValue({
      preferences: parsePreferences(null), connections: [{ ...profile, [key]: 'must-not-return' }], activeConnectionId: profile.id,
    });
    await expect(createStorage().load()).rejects.toMatchObject({ code: 'invalidInput' });
  });

  it.each([
    { kind: 'basic', username: 'reader', password: 'fixture-password' },
    { kind: 'apiKey', id: 'fixture-id', key: 'fixture-key' },
    { kind: 'bearer', token: 'fixture-token' },
    { kind: 'clear' },
  ] as const)('submits $kind separately from metadata and preserves cleanup outcome', async (credential) => {
    const outcome = { profile, credentialDetached: true, cleanup: { status: 'pending', remaining: 1, abandoned: 0 } };
    vi.mocked(invoke).mockResolvedValue(outcome);
    const result = await createStorage().saveConnectionSecure!(input, profile.id, { credential, ca: { kind: 'keep' } });
    expect(result).toEqual(outcome);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connections_save', { input, id: profile.id, credential, ca: { kind: 'keep' } });
    expect(JSON.stringify(result)).not.toContain('fixture-token');
    expect(JSON.stringify(result)).not.toContain('fixture-password');
  });

  it('keeps incomplete cleanup distinct from a failed mutation and retries without a reference', async () => {
    const cleanup = { status: 'incomplete', remaining: null, abandoned: 0 };
    const storage = createStorage();
    vi.mocked(invoke).mockResolvedValueOnce({ cleanup }).mockResolvedValueOnce(cleanup);
    expect(await storage.deleteConnectionSecure!(profile.id)).toEqual({ cleanup });
    expect(await storage.cleanupCredentials!()).toEqual(cleanup);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['connections_delete', { id: profile.id }], ['connections_cleanup'],
    ]);
  });

  it('rejects extra credential fields, bad lengths and header injection before invoking', async () => {
    for (const credential of [
      { kind: 'keep', credentialRef: 'foreign' },
      { kind: 'basic', username: 'name:bad', password: 'p' },
      { kind: 'basic', username: '字'.repeat(86), password: 'p' },
      { kind: 'bearer', token: 'bad\r\nheader' },
      { kind: 'apiKey', id: 'id', key: '' },
    ]) {
      expect(() => requireConnectionSecurity({ credential, ca: { kind: 'keep' } } as ConnectionSecurityChange))
        .toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('never keeps authentication material in the browser session or falls back after a desktop failure', async () => {
    const session = createSessionStorage();
    const security: ConnectionSecurityChange = { credential: { kind: 'bearer', token: 'fixture-secret' }, ca: { kind: 'keep' } };
    await expect(session.saveConnectionSecure!(input, undefined, security)).rejects.toMatchObject({ code: 'unsupported' });
    expect((await session.load()).connections).toEqual([]);
    vi.mocked(invoke).mockRejectedValue({ code: 'credentialUnavailable' });
    await expect(createStorage().saveConnectionSecure!(input, undefined, security)).rejects.toMatchObject({ code: 'credentialUnavailable' });
    expect((await session.load()).connections).toEqual([]);
  });
});

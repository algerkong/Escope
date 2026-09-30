import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { testConnection, type ConnectionIdentity, type ConnectionProbe } from '../../src/services/ipc';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const probe: ConnectionProbe = {
  requestId: '1e2e7932-7362-42ce-9ba6-55c0133164fd',
  connectionId: '2c729dd7-b9e6-422b-b1b2-b3365a5ff222',
};
const identity: ConnectionIdentity = {
  ...probe, endpoint: 'http://fixture.test', clusterName: 'Fixture', clusterUuid: 'fixture-uuid',
  version: '7.17.25', testedVersion: true, elapsedMs: 1,
};

describe('read-only connection IPC', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
  });

  it('sends only stable IDs and never forwards caller URLs, methods or headers', async () => {
    vi.mocked(invoke).mockResolvedValue(identity);
    const input = { ...probe, url: 'https://other.test', method: 'DELETE', headers: { Authorization: 'fixture-secret' } };
    await expect(testConnection(input)).resolves.toEqual(identity);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connection_test', { probe });
  });

  it('browser preview remains unsupported and does not invoke a network fallback', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(testConnection(probe)).rejects.toEqual({ code: 'unsupported', requestId: probe.requestId, retryable: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves a desktop failure without retrying or substituting fixture results', async () => {
    const error = { code: 'serverForbidden', requestId: probe.requestId, retryable: false };
    vi.mocked(invoke).mockRejectedValue(error);
    await expect(testConnection(probe)).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['requestId', 'connectionId'] as const)('rejects mismatched %s responses', async (key) => {
    vi.mocked(invoke).mockResolvedValue({ ...identity, [key]: crypto.randomUUID() });
    await expect(testConnection(probe)).rejects.toMatchObject({ code: 'invalidResponse', requestId: probe.requestId });
  });

  it('captures IDs before awaiting so caller mutation cannot rebind the response', async () => {
    let resolve!: (value: ConnectionIdentity) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const input = { ...probe };
    const pending = testConnection(input);
    input.connectionId = crypto.randomUUID();
    input.requestId = crypto.randomUUID();
    resolve(identity);
    await expect(pending).resolves.toEqual(identity);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connection_test', { probe });
  });
});

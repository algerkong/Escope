import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { desktopClusterBackend, readCluster, type ClusterReadRequest } from '../../src/services/cluster';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const request: ClusterReadRequest = {
  requestId: '3f2f2c9a-5b1e-4c6d-9a70-1b2c3d4e5f60',
  connectionId: '8d1c0f5e-2a3b-4c5d-8e9f-0a1b2c3d4e5f',
  resource: 'clusterHealth',
};
const response = {
  requestId: request.requestId,
  connectionId: request.connectionId,
  endpoint: 'http://fixture.test:9200',
  rawResponse: '{"status":"green"}',
};

describe('read-only cluster metadata IPC', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
  });

  it('sends one closed resource kind and never a caller URL, path or method', async () => {
    vi.mocked(invoke).mockResolvedValue(response);
    await expect(readCluster(request)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('resource_read', { request });
    expect(Object.keys(vi.mocked(invoke).mock.calls[0]![1] as object)).toEqual(['request']);
  });

  it('omits the index key for kinds that take no target and sends the target for the others', async () => {
    vi.mocked(invoke).mockResolvedValue(response);
    await readCluster({ ...request, resource: 'indices' });
    expect(invoke).toHaveBeenLastCalledWith('resource_read', {
      request: { requestId: request.requestId, connectionId: request.connectionId, resource: 'indices' },
    });
    await readCluster({ ...request, resource: 'mapping', index: 'orders-*' });
    expect(invoke).toHaveBeenLastCalledWith('resource_read', {
      request: { requestId: request.requestId, connectionId: request.connectionId, resource: 'mapping', index: 'orders-*' },
    });
  });

  it('keeps the browser preview unsupported without falling back to fixture data', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(readCluster(request)).rejects.toEqual({ code: 'unsupported', requestId: request.requestId, retryable: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves a desktop failure instead of retrying it', async () => {
    const failure = { code: 'serverForbidden', requestId: request.requestId, retryable: false };
    vi.mocked(invoke).mockRejectedValue(failure);
    await expect(readCluster(request)).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['requestId', 'connectionId'] as const)('drops a response bound to another %s', async (key) => {
    vi.mocked(invoke).mockResolvedValue({ ...response, [key]: crypto.randomUUID() });
    await expect(readCluster(request)).rejects.toMatchObject({ code: 'invalidResponse', requestId: request.requestId });
  });

  it('rejects a response without a verbatim body or endpoint', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...response, rawResponse: 42 });
    await expect(readCluster(request)).rejects.toMatchObject({ code: 'invalidResponse' });
    vi.mocked(invoke).mockResolvedValue({ ...response, endpoint: null });
    await expect(readCluster(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('cancels through the shared request_cancel command and reports the backend answer', async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    await expect(desktopClusterBackend.cancel({ requestId: request.requestId, connectionId: request.connectionId })).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('request_cancel', {
      request: { requestId: request.requestId, connectionId: request.connectionId },
    });
  });
});

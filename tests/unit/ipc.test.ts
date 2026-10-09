import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { openPit, closePit,
  cancelRequest, errorCode, executeQuery, readResource, testConnection,
  type ConnectionIdentity, type ConnectionProbe, type IpcError, type QueryRequest, type ResourceRequest,
} from '../../src/services/ipc';

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
    const input = {
      ...probe, url: 'https://other.test', method: 'DELETE', headers: { Authorization: 'fixture-secret' },
      credentialRef: 'caller-selected-reference', username: 'fixture-user', password: 'fixture-password',
    };
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

const resourceRequest: ResourceRequest = {
  requestId: '5f0b1d3a-6f39-4a4c-9a3f-2b6c2a7e1d10',
  connectionId: probe.connectionId,
  resource: 'fieldCaps',
  index: 'orders-*',
};
const queryRequest: QueryRequest = { requestId: 'q-1', connectionId: probe.connectionId, index: 'orders-*', rawDsl: '{"size":1}' };

describe('connection credential failure contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
  });

  it.each(['credentialNotFound', 'credentialUnavailable', 'credentialFailure'] as const)(
    'preserves %s across every read family without retries or fallback',
    async (code) => {
      const error = { code, requestId: probe.requestId, retryable: false } satisfies IpcError;
      vi.mocked(invoke).mockRejectedValue(error);
      const calls = [
        () => testConnection(probe),
        () => readResource({ ...resourceRequest, requestId: probe.requestId }),
        () => executeQuery({ ...queryRequest, requestId: probe.requestId }),
        () => openPit({ ...probe, index: 'orders-*' }),
        () => closePit({ ...probe, pitId: 'pit-fixture' }),
      ];
      for (const call of calls) await expect(call()).rejects.toBe(error);
      expect(invoke).toHaveBeenCalledTimes(calls.length);
      expect(errorCode(error, 'unexpected')).toBe(code);
    },
  );
});

describe('read-only resource and query IPC', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
  });

  it('sends the resource request unchanged and keeps the verbatim response', async () => {
    const response = { requestId: resourceRequest.requestId, connectionId: probe.connectionId, endpoint: 'http://fixture.test', rawResponse: '{"indices":[]}' };
    vi.mocked(invoke).mockResolvedValue(response);
    await expect(readResource(resourceRequest)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('resource_read', { request: resourceRequest });
  });

  it('omits the index scope for index discovery', async () => {
    const request = { requestId: 'r-2', connectionId: probe.connectionId, resource: 'indices' as const };
    vi.mocked(invoke).mockResolvedValue({ ...request, endpoint: 'http://fixture.test', rawResponse: '{}' });
    await readResource(request);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('resource_read', { request });
  });

  it('rejects a resource response bound to another connection or missing its body', async () => {
    vi.mocked(invoke).mockResolvedValue({ requestId: resourceRequest.requestId, connectionId: crypto.randomUUID(), endpoint: 'http://x', rawResponse: '{}' });
    await expect(readResource(resourceRequest)).rejects.toMatchObject({ code: 'invalidResponse' });
    vi.mocked(invoke).mockResolvedValue({ requestId: resourceRequest.requestId, connectionId: probe.connectionId, endpoint: 'http://x' });
    await expect(readResource(resourceRequest)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('executes a frozen snapshot and keeps the partial flag', async () => {
    const response = { requestId: queryRequest.requestId, connectionId: probe.connectionId, endpoint: 'http://fixture.test', rawResponse: '{"hits":{}}', partial: true, pitId: null };
    vi.mocked(invoke).mockResolvedValue(response);
    await expect(executeQuery(queryRequest)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('query_execute', { request: queryRequest });
  });

  it('rejects a query response without a boolean partial flag', async () => {
    vi.mocked(invoke).mockResolvedValue({ requestId: queryRequest.requestId, connectionId: probe.connectionId, endpoint: 'http://x', rawResponse: '{}', partial: 'yes' });
    await expect(executeQuery(queryRequest)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it.each([undefined, null, 42])('rejects a query response with a non-string endpoint: %s', async (endpoint) => {
    vi.mocked(invoke).mockResolvedValue({
      requestId: queryRequest.requestId, connectionId: probe.connectionId, endpoint, rawResponse: '{}', partial: false,
    });
    await expect(executeQuery(queryRequest)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('cancels a request and rejects a non-boolean answer', async () => {
    const request = { requestId: queryRequest.requestId, connectionId: probe.connectionId };
    vi.mocked(invoke).mockResolvedValue(false);
    await expect(cancelRequest(request)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('request_cancel', { request });
    vi.mocked(invoke).mockResolvedValue('done');
    await expect(cancelRequest(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('forwards the continuation cursor and keeps the newest snapshot id', async () => {
    const continued = { ...queryRequest, pitId: 'pit-1', searchAfter: '[1]' };
    vi.mocked(invoke).mockResolvedValue({
      requestId: continued.requestId, connectionId: probe.connectionId, endpoint: 'http://fixture.test',
      rawResponse: '{"hits":{}}', partial: false, pitId: 'pit-2',
    });
    await expect(executeQuery(continued)).resolves.toMatchObject({ pitId: 'pit-2' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('query_execute', { request: continued });
    // A malformed snapshot id is refused instead of being echoed back.
    vi.mocked(invoke).mockResolvedValue({
      requestId: queryRequest.requestId, connectionId: probe.connectionId, endpoint: 'http://fixture.test',
      rawResponse: '{"hits":{}}', partial: false, pitId: 42,
    });
    await expect(executeQuery(queryRequest)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('supports the first PIT page and never silently drops a cursor without its snapshot', async () => {
    const first = { ...queryRequest, pitId: 'p'.repeat(608) };
    vi.mocked(invoke).mockResolvedValue({
      requestId: first.requestId, connectionId: first.connectionId, endpoint: 'http://fixture.test',
      rawResponse: '{"hits":{}}', partial: false, pitId: first.pitId,
    });
    await executeQuery(first);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('query_execute', { request: first });
    vi.mocked(invoke).mockClear();
    await expect(executeQuery({ ...queryRequest, searchAfter: '[9007199254740993]' })).rejects.toMatchObject({ code: 'invalidQuery' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('opens and closes snapshots through the typed commands', async () => {
    const open = { requestId: 'p-1', connectionId: probe.connectionId, index: 'orders-*' };
    vi.mocked(invoke).mockResolvedValue({ ...open, endpoint: 'http://fixture.test', pitId: 'pit-9' });
    await expect(openPit(open)).resolves.toMatchObject({ pitId: 'pit-9' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('pit_open', { request: open });
    const close = { requestId: 'p-2', connectionId: probe.connectionId, pitId: 'pit-9' };
    vi.mocked(invoke).mockResolvedValue({ requestId: close.requestId, connectionId: close.connectionId });
    await expect(closePit(close)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith('pit_close', { request: close });
    // An empty id must not be handed back as a usable snapshot.
    vi.mocked(invoke).mockResolvedValue({ ...open, endpoint: 'http://fixture.test', pitId: '' });
    await expect(openPit(open)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('keeps every live call unsupported in the browser preview', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(readResource(resourceRequest)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(executeQuery(queryRequest)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(cancelRequest({ requestId: queryRequest.requestId, connectionId: probe.connectionId })).rejects.toMatchObject({ code: 'unsupported' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('error code mapping', () => {
  it('keeps storageUnavailable as the default fallback for unrecognized failures', () => {
    for (const failure of [new Error('boom'), 'command not found', null, undefined, 42, { requestId: 'x' }, { code: 42 }]) {
      expect(errorCode(failure)).toBe('storageUnavailable');
    }
  });

  it('uses the caller fallback for unrecognized failures without weakening structured codes', () => {
    for (const failure of [new Error('boom'), 'command not found', null, undefined, { code: 42 }]) {
      expect(errorCode(failure, 'unexpected')).toBe('unexpected');
    }
    expect(errorCode({ code: 'timeout' }, 'unexpected')).toBe('timeout');
    expect(errorCode(new Error('notFound'), 'unexpected')).toBe('notFound');
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../src/locales';
import { ConnectionAccess } from '../../src/features/connections/ConnectionAccess';
import { readConnectionAccess, type ConnectionAccessRequest, type ConnectionAccessResponse } from '../../src/services/connection-access';
import type { ConnectionProfile } from '../../src/domain/connection';
import fixture from '../fixtures/connection-access-v1.json';
import { enConnectionAccess, zhConnectionAccess } from '../../src/locales/connection-access';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const profile: ConnectionProfile = {
  id: '1ed43afe-c318-4fe6-8cce-aa2a82be27be', displayName: 'Reader', endpoint: 'https://es.test',
  environment: 'development', auth: 'basic', hasCredential: true, sortOrder: 0,
};
const request: ConnectionAccessRequest = {
  requestId: 'f3228da9-8e0a-4ab8-9c3b-d633c60ea8d2', connectionId: profile.id, index: 'orders-*',
};
const available = { status: 'available' as const, code: null };
function answer(sent: ConnectionAccessRequest): ConnectionAccessResponse {
  return {
    ...structuredClone(fixture) as ConnectionAccessResponse,
    requestId: sent.requestId, connectionId: sent.connectionId, endpoint: profile.endpoint, index: sent.index ?? null,
    checkedAtMs: Date.now(),
  };
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  await i18n.changeLanguage('en-US');
});
afterEach(() => { vi.useRealTimers(); });

describe('restricted access diagnostics IPC', () => {
  it('sends no arbitrary API/body and separates permissions from unverified reports', async () => {
    vi.mocked(invoke).mockResolvedValue(answer(request));
    const response = await readConnectionAccess({ ...request, headers: 'not forwarded' } as ConnectionAccessRequest);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connection_access', { request });
    expect(response.privileges.monitor.status).toBe('denied');
    expect(response.privileges.read.status).toBe('available');
    expect(response.capabilities.search.status).toBe('unknown');
    expect(response.capabilities.pit.status).toBe('unknown');
    expect(response.capabilities.graph.status).toBe('unlicensed');
    expect(response.capabilities.sql.status).toBe('reported');
    expect(response.operationVerification).toBe('notRun');
  });
  it.each(['requestId', 'connectionId', 'index'])('rejects a mismatched %s', async (key) => {
    vi.mocked(invoke).mockResolvedValue({ ...answer(request), [key]: 'foreign' });
    await expect(readConnectionAccess(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });
  it('does not return extra secret properties or unregistered error text', async () => {
    const value = { ...answer(request), password: 'fixture-secret' };
    vi.mocked(invoke).mockResolvedValue(value);
    expect(JSON.stringify(await readConnectionAccess(request))).not.toContain('fixture-secret');
    vi.mocked(invoke).mockResolvedValue({ ...value, identity: { ...value.identity, code: 'fixture-secret' } });
    await expect(readConnectionAccess(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });
  it('is explicitly unavailable in browser preview', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(readConnectionAccess(request)).rejects.toMatchObject({ code: 'unsupported' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('shares the exact sanitized Rust fixture and forwards only the explicit refresh flag', async () => {
    vi.mocked(invoke).mockResolvedValue(fixture);
    expect(await readConnectionAccess({ ...request, refresh: true, cacheKey: 'forged' } as ConnectionAccessRequest)).toEqual(fixture);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connection_access', { request: { ...request, refresh: true } });
  });
  it.each([
    ['server', 'deployment', 'hosted'],
    ['server', 'versionKind', 'tested'],
    ['server', 'buildFlavor', 'serverless'],
    ['server', 'version', '7.17.25-SNAPSHOT'],
    ['license', 'expiryTimeMs', 9007199254740992],
    ['license', 'expiryTimeMs', '18446744073709551616'],
    ['license', 'expiryTimeMs', '-1'],
    ['license', 'kind', 'fixture-secret'],
    ['license', 'state', 'future'],
    ['license', 'code', 'serverForbidden'],
    ['reports', 'source', 'persistent'],
    ['reports', 'ageMs', -1],
    ['reports', 'checkedAtMs', 1.5],
    ['reports', 'ttlMs', 60001],
  ])('rejects an invalid %s.%s value', async (section, field, value) => {
    const response = answer(request);
    (response[section as keyof ConnectionAccessResponse] as unknown as Record<string, unknown>)[field as string] = value;
    vi.mocked(invoke).mockResolvedValue(response);
    await expect(readConnectionAccess(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });
  it.each(['available', 'reported', 'unsupported'])('rejects %s search claims unsupported by operation evidence', async (status) => {
    const response = answer(request);
    vi.mocked(invoke).mockResolvedValue({ ...response, capabilities: { ...response.capabilities,
      search: { status, source: 'version', reason: 'notProbed', code: null } } });
    await expect(readConnectionAccess(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });
  it('does not accept a license or feature result as a successful target probe', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...answer(request), operationVerification: 'passed' });
    await expect(readConnectionAccess(request)).rejects.toMatchObject({ code: 'invalidResponse' });
    const response = answer(request);
    response.capabilities.graph.status = 'reported';
    vi.mocked(invoke).mockResolvedValue(response);
    await expect(readConnectionAccess(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });
  it('retains exact expiry digits and omits license identifiers, owners and unknown feature fields', async () => {
    const response = answer(request);
    vi.mocked(invoke).mockResolvedValue({ ...response,
      license: { ...response.license, expiryTimeMs: '18446744073709551615', uid: 'private-uid', issuedTo: 'fixture-secret' },
      featureReport: { ...response.featureReport, privateFeature: 'fixture-secret' },
      server: { ...response.server, buildHash: 'fixture-secret' },
    });
    const result = await readConnectionAccess(request);
    expect(result.license.expiryTimeMs).toBe('18446744073709551615');
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|private-uid/);
  });
  it('classifies a license 404 as unknown while retaining index privileges', async () => {
    const response = answer(request);
    response.license = { status: 'unknown', code: 'notFound', kind: null, state: null, expiryTimeMs: null };
    vi.mocked(invoke).mockResolvedValue(response);
    expect((await readConnectionAccess(request)).privileges.read).toEqual(available);
    response.license.status = 'unsupported';
    vi.mocked(invoke).mockResolvedValue(response);
    await expect(readConnectionAccess(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });
  it('requires a boolean refresh and never invokes with malformed request options', async () => {
    await expect(readConnectionAccess({ ...request, refresh: 'true' } as unknown as ConnectionAccessRequest))
      .rejects.toMatchObject({ code: 'invalidInput' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('uses exact traditional release bounds but not Serverless compatibility versions', async () => {
    const response = answer(request);
    response.server.version = '7.9.3';
    response.capabilities.pit = { status: 'unsupported', source: 'version', reason: 'versionTooOld', code: null };
    vi.mocked(invoke).mockResolvedValue(response);
    expect((await readConnectionAccess(request)).capabilities.pit.status).toBe('unsupported');
    response.server = { ...response.server, deployment: 'serverless', buildFlavor: 'serverless', versionKind: 'serverless' };
    response.capabilities.pit = { status: 'unknown', source: 'none', reason: 'notProbed', code: null };
    response.capabilities.graph = { status: 'unsupported', source: 'deployment', reason: 'serverless', code: null };
    vi.mocked(invoke).mockResolvedValue(response);
    expect((await readConnectionAccess(request)).server.versionKind).toBe('serverless');
  });
});

describe('explicit access diagnostics', () => {
  it('does not run on open and shows index read even when monitor is denied', async () => {
    const inspect = vi.fn(async (sent: ConnectionAccessRequest) => answer(sent));
    render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    expect(inspect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Index or pattern'), { target: { value: 'orders-*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await screen.findByText('reader');
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
    expect(screen.getAllByText('Available')).toHaveLength(3);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('cancels on target change and ignores a late result without an automatic replacement request', async () => {
    let resolve!: (value: ConnectionAccessResponse) => void;
    const inspect = vi.fn<(request: ConnectionAccessRequest) => Promise<ConnectionAccessResponse>>(
      () => new Promise((done) => { resolve = done; }),
    );
    const cancel = vi.fn(async () => true);
    const view = render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} cancel={cancel} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Inspecting' }).closest('form')!);
    expect(inspect).toHaveBeenCalledTimes(1);
    view.rerender(<I18nextProvider i18n={i18n}><ConnectionAccess profile={{ ...profile, endpoint: 'https://new.test' }}
      available inspect={inspect} cancel={cancel} /></I18nextProvider>);
    expect(cancel).toHaveBeenCalledWith({ requestId: inspect.mock.calls[0]![0].requestId, connectionId: profile.id });
    await act(async () => { resolve(answer(inspect.mock.calls[0]![0])); });
    expect(screen.queryByText('reader')).not.toBeInTheDocument();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Inspect' })).toBeEnabled();
  });
  it('sanitizes thrown diagnostics and never displays raw details', async () => {
    const inspect = vi.fn().mockRejectedValue({ code: 'not-in-catalog', detail: 'fixture-secret' });
    render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Diagnostics could not be completed.'));
    expect(document.body).not.toHaveTextContent('fixture-secret');
    expect(document.body).not.toHaveTextContent('not-in-catalog');
  });
  it('distinguishes a deleted connection from a diagnostic endpoint returning 404', async () => {
    let attempts = 0;
    const inspect = vi.fn(async (sent: ConnectionAccessRequest) => {
      if (attempts++ === 0) throw { code: 'notFound' };
      const response = answer(sent);
      response.license = { status: 'unknown', code: 'notFound', kind: null, state: null, expiryTimeMs: null };
      return response;
    });
    render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This connection no longer exists.');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByTitle('This diagnostic endpoint returned 404. Support is not determined.')).toHaveTextContent('Unknown');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('shows report provenance and untested operations, and refreshes only on an explicit command', async () => {
    const inspect = vi.fn(async (sent: ConnectionAccessRequest) => ({
      ...answer(sent), reports: { ...answer(sent).reports, source: 'cache' as const },
    }));
    render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await screen.findByText('Session cache');
    expect(screen.getByText('Reported ready')).toBeInTheDocument();
    expect(screen.getByText('License unavailable')).toBeInTheDocument();
    expect(screen.getByText('Not enabled')).toBeInTheDocument();
    expect(screen.getByText('Not run')).toBeInTheDocument();
    expect(screen.getByText('Not determined')).toBeInTheDocument();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByText('会话缓存')).toBeInTheDocument();
    expect(inspect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重新读取许可与能力报告' }));
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    expect(inspect.mock.calls[1]![0].refresh).toBe(true);
  });
  it('marks expiry without a background request and keeps the original observation time', async () => {
    vi.useFakeTimers();
    const inspect = vi.fn(async (sent: ConnectionAccessRequest) => ({ ...answer(sent),
      reports: { ...answer(sent).reports, source: 'cache' as const, ageMs: 59_000 },
    }));
    render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Inspect' })); });
    expect(screen.queryByText('The report validity window has elapsed.')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('The report validity window has elapsed.')).toBeInTheDocument();
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('does not renew report validity while its IPC response waits for delivery', async () => {
    vi.useFakeTimers();
    const inspect = vi.fn(async (sent: ConnectionAccessRequest) => ({
      ...answer(sent), checkedAtMs: Date.now() - 61_000,
    }));
    render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Inspect' })); });
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('The report validity window has elapsed.')).toBeInTheDocument();
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('does not show old index privileges as the edited target and does not inspect on close or reopen', async () => {
    const inspect = vi.fn(async (sent: ConnectionAccessRequest) => answer(sent));
    render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await screen.findByText('reader');
    fireEvent.change(screen.getByLabelText('Index or pattern'), { target: { value: 'different-*' } });
    expect(screen.queryByText('reader')).not.toBeInTheDocument();
    expect(screen.getByText('Connection or index changed. Previous diagnostics are out of date.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('cancels and ignores late diagnostics on explicit cancel and unmount', async () => {
    let resolve!: (response: ConnectionAccessResponse) => void;
    const inspect = vi.fn<(sent: ConnectionAccessRequest) => Promise<ConnectionAccessResponse>>(
      () => new Promise((done) => { resolve = done; }),
    );
    const cancel = vi.fn(async () => true);
    const view = render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} cancel={cancel} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { resolve(answer(inspect.mock.calls[0]![0])); });
    expect(screen.queryByText('reader')).not.toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
    await act(async () => { resolve(answer(inspect.mock.calls[1]![0])); });
  });
  it('renders oversized exact expiry digits without rounding or throwing', async () => {
    const inspect = vi.fn(async (sent: ConnectionAccessRequest) => {
      const response = answer(sent);
      response.license.expiryTimeMs = '18446744073709551615';
      return response;
    });
    render(<I18nextProvider i18n={i18n}><ConnectionAccess profile={profile} available inspect={inspect} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect identity and permissions: Reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText('18446744073709551615')).toBeInTheDocument();
  });
});

it('keeps every diagnostic label and evidence reason in both languages', () => {
  function leaves(value: Record<string, unknown>, prefix = ''): string[] {
    return Object.entries(value).flatMap(([key, entry]) => typeof entry === 'string'
      ? (expect(entry.trim()).not.toBe(''), `${prefix}${key}`)
      : leaves(entry as Record<string, unknown>, `${prefix}${key}.`));
  }
  expect(leaves(zhConnectionAccess).sort()).toEqual(leaves(enConnectionAccess).sort());
});

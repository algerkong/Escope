import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../src/locales';
import { ConnectionAccess } from '../../src/features/connections/ConnectionAccess';
import { readConnectionAccess, type ConnectionAccessRequest, type ConnectionAccessResponse } from '../../src/services/connection-access';
import type { ConnectionProfile } from '../../src/domain/connection';

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
    requestId: sent.requestId, connectionId: sent.connectionId, endpoint: profile.endpoint, index: sent.index ?? null,
    identity: { ...available, username: 'reader', roles: ['orders_reader'] },
    privileges: { monitor: { status: 'denied', code: null }, read: available, viewIndexMetadata: available },
    capabilities: { search: { status: 'unknown', code: 'serverForbidden' }, pit: { status: 'unsupported', code: null } },
    version: null,
  };
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  await i18n.changeLanguage('en-US');
});

describe('restricted access diagnostics IPC', () => {
  it('sends no arbitrary API/body and keeps all four states distinct', async () => {
    vi.mocked(invoke).mockResolvedValue(answer(request));
    const response = await readConnectionAccess({ ...request, headers: 'not forwarded' } as ConnectionAccessRequest);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connection_access', { request });
    expect(response.privileges.monitor.status).toBe('denied');
    expect(response.privileges.read.status).toBe('available');
    expect(response.capabilities.search.status).toBe('unknown');
    expect(response.capabilities.pit.status).toBe('unsupported');
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
});

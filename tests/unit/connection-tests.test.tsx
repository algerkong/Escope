import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { i18n } from '../../src/locales';
import { useConnectionTests } from '../../src/features/connections/useConnectionTests';
import { ConnectionTestResult } from '../../src/features/connections/ConnectionTestResult';
import { executionErrorKey, resourceErrorKey } from '../../src/features/query/error-message';
import { clusterErrorKey } from '../../src/features/cluster/error-message';
import type { ConnectionProfile } from '../../src/domain/connection';
import type { ConnectionIdentity, ConnectionProbe } from '../../src/services/ipc';
import { createSessionStorage } from '../../src/services/storage';

const profile: ConnectionProfile = {
  id: '2c729dd7-b9e6-422b-b1b2-b3365a5ff222', displayName: 'Fixture A',
  endpoint: 'https://a.test', environment: 'development', auth: 'none', sortOrder: 0,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function identity(probe: ConnectionProbe, endpoint = profile.endpoint): ConnectionIdentity {
  return { ...probe, endpoint, clusterName: 'Fixture cluster', clusterUuid: 'fixture-cluster-uuid',
    version: '7.17.25', testedVersion: true, elapsedMs: 12 };
}

describe('connection test lifecycle', () => {
  it('is manual, deduplicates pending requests and permits retry', async () => {
    const response = deferred<ConnectionIdentity>();
    const probe = vi.fn(() => response.promise);
    const { result } = renderHook(() => useConnectionTests(probe));
    expect(probe).not.toHaveBeenCalled();
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(profile); void result.current.run(profile); });
    expect(probe).toHaveBeenCalledTimes(1);
    const state = result.current.results[profile.id]!;
    expect(state.status).toBe('running');
    await act(async () => {
      response.resolve(identity({ requestId: (state as { requestId: string }).requestId, connectionId: profile.id }));
      await pending;
    });
    expect(result.current.results[profile.id]?.status).toBe('success');
    await act(async () => { await result.current.run(profile); });
    expect(probe).toHaveBeenCalledTimes(2);
    // A retried call must not accept the previous request's response.
    expect(result.current.results[profile.id]).toMatchObject({ status: 'error', code: 'invalidResponse' });
  });

  it.each(['resolve', 'reject'] as const)('ignores a late %s after endpoint invalidation and a newer request', async (completion) => {
    const old = deferred<ConnectionIdentity>();
    const probe = vi.fn<(input: ConnectionProbe) => Promise<ConnectionIdentity>>()
      .mockImplementationOnce(() => old.promise)
      .mockImplementation(async (input) => identity(input, 'https://new.test'));
    const { result } = renderHook(() => useConnectionTests(probe));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(profile); });
    act(() => result.current.invalidate(profile.id));
    expect(result.current.results[profile.id]).toEqual({ status: 'stale' });
    await act(async () => { await result.current.run({ ...profile, endpoint: 'https://new.test' }); });
    const latest = result.current.results[profile.id];
    await act(async () => {
      if (completion === 'resolve') old.resolve(identity(probe.mock.calls[0]![0]));
      else old.reject({ code: 'timeout' });
      await pending;
    });
    expect(result.current.results[profile.id]).toBe(latest);
    expect(latest).toMatchObject({ status: 'success', endpoint: 'https://new.test' });
  });

  it('does not recreate a deleted connection when its response arrives', async () => {
    const response = deferred<ConnectionIdentity>();
    const probe = vi.fn<(input: ConnectionProbe) => Promise<ConnectionIdentity>>(() => response.promise);
    const { result } = renderHook(() => useConnectionTests(probe));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(profile); });
    act(() => result.current.invalidate(profile.id, true));
    await act(async () => { response.resolve(identity(probe.mock.calls[0]![0])); await pending; });
    expect(result.current.results).toEqual({});
  });

  it('records nothing when a connection without a result is invalidated', () => {
    const probe = vi.fn<(input: ConnectionProbe) => Promise<ConnectionIdentity>>();
    const { result } = renderHook(() => useConnectionTests(probe));
    act(() => { result.current.invalidate(profile.id); result.current.invalidate('unknown', true); });
    expect(result.current.results).toEqual({});
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps independent connections isolated even when responses arrive out of order', async () => {
    const a = deferred<ConnectionIdentity>();
    const b = deferred<ConnectionIdentity>();
    const probe = vi.fn<(input: ConnectionProbe) => Promise<ConnectionIdentity>>()
      .mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const { result } = renderHook(() => useConnectionTests(probe));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.run(profile);
      second = result.current.run({ ...profile, id: 'b', endpoint: 'https://b.test' });
    });
    await act(async () => { b.resolve(identity(probe.mock.calls[1]![0], 'https://b.test')); await second; });
    expect(result.current.results[profile.id]?.status).toBe('running');
    await act(async () => { a.reject({ code: 'serverForbidden' }); await first; });
    expect(result.current.results.b).toMatchObject({ status: 'success', endpoint: 'https://b.test' });
    expect(result.current.results[profile.id]).toMatchObject({ status: 'error', code: 'serverForbidden' });
  });

  it('invalidates pending callbacks on unmount', async () => {
    const response = deferred<ConnectionIdentity>();
    const probe = vi.fn<(input: ConnectionProbe) => Promise<ConnectionIdentity>>(() => response.promise);
    const { result, unmount } = renderHook(() => useConnectionTests(probe));
    let pending!: Promise<void>;
    act(() => { pending = result.current.run(profile); });
    const before = result.current.results;
    unmount();
    await act(async () => { response.resolve(identity(probe.mock.calls[0]![0])); await pending; });
    expect(result.current.results).toBe(before);
  });

  it.each(['requestId', 'connectionId', 'endpoint'] as const)('rejects a mismatched response %s', async (key) => {
    const probe = vi.fn(async (input: ConnectionProbe) => ({ ...identity(input), [key]: 'wrong' }));
    const { result } = renderHook(() => useConnectionTests(probe));
    await act(async () => { await result.current.run(profile); });
    expect(result.current.results[profile.id]).toMatchObject({ status: 'error', code: 'invalidResponse' });
  });

  it('maps non-structured failures to the localized unexpected code instead of a storage error', async () => {
    const failures = ['command connection_test not found', new Error('ECONNREFUSED 127.0.0.1:9200'), null, undefined, { requestId: 'x' }];
    for (const failure of failures) {
      const probe = vi.fn<(input: ConnectionProbe) => Promise<ConnectionIdentity>>(async () => { throw failure; });
      const { result } = renderHook(() => useConnectionTests(probe));
      await act(async () => { await result.current.run(profile); });
      expect(result.current.results[profile.id]).toEqual({
        status: 'error', requestId: expect.any(String), endpoint: profile.endpoint, code: 'unexpected',
      });
    }
  });
});

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

async function mount(desktop = true) {
  const memory = createSessionStorage();
  const a = await memory.saveConnection({ displayName: 'A', endpoint: 'https://a.test', environment: 'development' });
  const b = await memory.saveConnection({ displayName: 'B', endpoint: 'https://b.test', environment: 'development' });
  const service = { ...memory, kind: desktop ? 'desktop' as const : 'session' as const };
  const initial = await service.load();
  initial.preferences.locale = 'zh-CN';
  const pending = deferred<ConnectionIdentity>();
  const probe = vi.fn<(input: ConnectionProbe) => Promise<ConnectionIdentity>>(() => pending.promise);
  render(<I18nextProvider i18n={i18n}><App service={service} initial={initial} connectionProbe={probe} /></I18nextProvider>);
  const user = userEvent.setup();
  await user.click(screen.getAllByRole('tab')[1]!);
  fireEvent.change(screen.getByLabelText('查询 DSL'), { target: { value: '{"id":9007199254740993}' } });
  await user.click(screen.getAllByRole('button', { name: '设置' })[0]!);
  await user.click(screen.getByRole('button', { name: '连接中心' }));
  return { user, service, a, b, probe, pending };
}

describe('connection test UI', () => {
  it('preserves a manual result across selection, settings, appearance and language changes without running queries', async () => {
    const { user, a, b, probe, pending } = await mount();
    expect(probe).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '测试连接 A' }));
    const testButton = screen.getByRole('button', { name: '测试连接 A' });
    expect(testButton).toHaveAttribute('aria-disabled', 'true');
    expect(testButton).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('contentinfo')).getByRole('status')).toHaveTextContent(i18n.t('connections:testing'));
    expect(within(screen.getByRole('article', { name: 'A' })).getByText('正在测试已保存的地址')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('当前连接'), b.id);
    await user.click(screen.getByRole('button', { name: '常规' }));
    await user.click(screen.getByRole('button', { name: '外观' }));
    await user.click(screen.getByRole('button', { name: '夜间' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', { name: '常规' }));
    await user.selectOptions(screen.getByLabelText('语言'), 'en-US');
    await act(async () => { pending.resolve(identity(probe.mock.calls[0]![0])); });
    await user.click(screen.getByRole('button', { name: 'Connections' }));
    expect(within(screen.getByRole('article', { name: 'A' })).getByText('Identity confirmed')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'B' })).getByText('Not tested')).toBeInTheDocument();
    expect(screen.getByLabelText('Active connection')).toHaveValue(b.id);
    await user.click(screen.getByRole('button', { name: 'Back to query' }));
    expect(within(screen.getByRole('complementary')).getByText('Not tested')).toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo')).queryByText('Not tested')).not.toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo')).getByRole('img', { name: 'Read-only' })).toHaveAttribute('title', 'Read-only');
    expect(within(screen.getByRole('contentinfo')).queryByText('Read-only')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByLabelText('Active connection')).toHaveValue(a.id);
    expect(within(screen.getByRole('complementary')).getByText('Identity confirmed')).toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo')).getByText('Identity confirmed')).toBeInTheDocument();
    expect(screen.getByLabelText('Query DSL')).toHaveValue('{"id":9007199254740993}');
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Connections' }));
    expect(screen.getByText('Fixture cluster')).toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('keeps rename results but invalidates changed endpoints only after a successful save', async () => {
    const { user, service, probe, pending } = await mount();
    await user.click(screen.getByRole('button', { name: '测试连接 A' }));
    await act(async () => { pending.resolve(identity(probe.mock.calls[0]![0])); });
    await user.click(screen.getByRole('button', { name: '编辑 A' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Renamed' } });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const renamedRow = screen.getByRole('article', { name: 'Renamed' });
    expect(within(renamedRow).getByText('身份已确认')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '编辑 Renamed' }));
    fireEvent.change(screen.getByLabelText('Elasticsearch 地址'), { target: { value: 'https://changed.test' } });
    const save = service.saveConnectionSecure;
    service.saveConnectionSecure = vi.fn().mockRejectedValue({ code: 'storageUnavailable' });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert')).toBeInTheDocument());
    expect(within(renamedRow).getByText('身份已确认')).toBeInTheDocument();
    service.saveConnectionSecure = save;
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('地址已更改，请重新测试。')).toBeInTheDocument();
    expect(within(screen.getByRole('contentinfo')).getByRole('status')).toHaveTextContent(i18n.t('connections:testStaleShort'));
    expect(screen.queryByText('Fixture cluster')).not.toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('ignores a late %s after deleting the tested connection', async (completion) => {
    const { user, b, probe, pending } = await mount();
    await user.click(screen.getByRole('button', { name: '测试连接 A' }));
    await user.click(screen.getByRole('button', { name: '删除 A' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await act(async () => {
      if (completion === 'resolve') pending.resolve(identity(probe.mock.calls[0]![0]));
      else pending.reject({ code: 'timeout' });
    });
    expect(screen.queryByRole('article', { name: 'A' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'B' })).getByText('未测试')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'B' })).toHaveAttribute('data-selected', 'true');
    expect(b.id).not.toBe(probe.mock.calls[0]![0].connectionId);
  });

  it('expires an in-flight test when the saved endpoint changes and rejects the late response on retest', async () => {
    const { user, probe, pending } = await mount();
    await user.click(screen.getByRole('button', { name: '测试连接 A' }));
    await user.click(screen.getByRole('button', { name: '编辑 A' }));
    fireEvent.change(screen.getByLabelText('Elasticsearch 地址'), { target: { value: 'https://changed.test' } });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const row = () => within(screen.getByRole('article', { name: 'A' }));
    expect(row().getByText('地址已更改，请重新测试。')).toBeInTheDocument();
    await act(async () => { pending.resolve(identity(probe.mock.calls[0]![0])); });
    expect(row().queryByText('Fixture cluster')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '测试连接 A' }));
    await waitFor(() => expect(row().getByText('身份测试失败')).toBeInTheDocument());
    expect(row().getByText('服务返回的身份响应无效。')).toBeInTheDocument();
    expect(screen.queryByText('Fixture cluster')).not.toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shows permission failures and allows an explicit retry without showing the server body', async () => {
    const { user, probe, pending } = await mount();
    await user.click(screen.getByRole('button', { name: '测试连接 A' }));
    await act(async () => { pending.reject({ code: 'serverForbidden', body: 'fixture-secret' }); });
    expect(screen.getByRole('alert')).toHaveTextContent('仍可能有权搜索已授权的索引');
    expect(within(screen.getByRole('contentinfo')).getByRole('status')).toHaveTextContent(i18n.t('connections:testFailed'));
    expect(screen.queryByText(/fixture-secret/)).not.toBeInTheDocument();
    probe.mockImplementation(async (input) => ({ ...identity(input), version: '9.0.0', testedVersion: false }));
    await user.click(screen.getByRole('button', { name: '测试连接 A' }));
    await within(screen.getByRole('article', { name: 'A' })).findByText('身份已确认');
    expect(screen.getByText('此 Elasticsearch 版本尚未经过验证。')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shows the generic message for a non-structured failure without echoing the raw rejection', async () => {
    const { user, pending } = await mount();
    await user.click(screen.getByRole('button', { name: '测试连接 A' }));
    await act(async () => { pending.reject('command connection_test not found'); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('身份测试失败');
    expect(alert).toHaveTextContent('工作区出现错误。');
    expect(alert).not.toHaveTextContent('command connection_test not found');
    expect(screen.queryByText('本地存储不可用或包含无效数据，原有数据未被覆盖。')).not.toBeInTheDocument();
  });

  it('keeps tests disabled in the explicit browser session adapter', async () => {
    const { probe } = await mount(false);
    for (const button of screen.getAllByRole('button', { name: '连接测试仅在桌面应用中可用。' })) {
      expect(button).toBeDisabled();
    }
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('connection test result', () => {
  it.each(['zh-CN', 'en-US'])('renders credential errors in %s without raw details', async (locale) => {
    await i18n.changeLanguage(locale);
    const { rerender } = render(<></>);
    for (const code of ['credentialNotFound', 'credentialUnavailable', 'credentialFailure']) {
      const key = `errors:${code}`;
      expect(i18n.exists(key)).toBe(true);
      expect(executionErrorKey(code, (entry) => i18n.exists(entry))).toBe(key);
      expect(resourceErrorKey(code, (entry) => i18n.exists(entry))).toBe(key);
      expect(clusterErrorKey(code, (entry) => i18n.exists(entry))).toBe(key);
      const result = {
        status: 'error' as const, requestId: 'request', endpoint: profile.endpoint, code,
        detail: 'fixture-vault-detail', credentialRef: 'fixture-reference',
      };
      rerender(<I18nextProvider i18n={i18n}><ConnectionTestResult timeZone="system" result={result} /></I18nextProvider>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(i18n.t(key));
      expect(alert).not.toHaveTextContent(i18n.t('errors:notFound'));
      expect(alert).not.toHaveTextContent(i18n.t('errors:unexpected'));
      expect(alert).not.toHaveTextContent('fixture-vault-detail');
      expect(alert).not.toHaveTextContent('fixture-reference');
      expect(alert).not.toHaveTextContent(code);
    }
  });

  it('falls back to a generic message for an error code without a localized entry', () => {
    render(<I18nextProvider i18n={i18n}><ConnectionTestResult timeZone="system"
      result={{ status: 'error', requestId: 'request', endpoint: profile.endpoint, code: 'tlsHandshakeFailed' }} /></I18nextProvider>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('身份测试失败');
    expect(alert).toHaveTextContent('工作区出现错误。');
    expect(alert).not.toHaveTextContent('tlsHandshakeFailed');
  });

  it('renders the confirmed identity in the configured time zone', () => {
    const completedAt = '2026-09-30T12:00:00.000Z';
    render(<I18nextProvider i18n={i18n}><ConnectionTestResult timeZone="UTC"
      result={{ status: 'success', requestId: 'request', endpoint: profile.endpoint, completedAt,
        identity: identity({ requestId: 'request', connectionId: profile.id }) }} /></I18nextProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('身份已确认');
    const time = document.querySelector('time')!;
    expect(time).toHaveAttribute('datetime', completedAt);
    expect(time).toHaveTextContent('12:00');
  });
});

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseClusterHealth } from '../../src/domain/cluster';
import { useClusterRead } from '../../src/features/cluster/useClusterResources';
import { i18n } from '../../src/locales';
import { enCluster, zhCluster } from '../../src/locales/cluster';
import type { ClusterBackend, ClusterCancelRequest, ClusterReadRequest, ClusterReadResponse } from '../../src/services/cluster';

i18n.addResourceBundle('zh-CN', 'cluster', zhCluster);
i18n.addResourceBundle('en-US', 'cluster', enCluster);

const CONNECTION = '8d1c0f5e-2a3b-4c5d-8e9f-0a1b2c3d4e5f';
const ENDPOINT = 'http://fixture.test:9200';
const OTHER_ENDPOINT = 'http://other.test:9200';
const BODY = '{"cluster_name":"fixture","status":"green","number_of_nodes":1}';
const OTHER_BODY = '{"cluster_name":"other","status":"red","number_of_nodes":2}';

function response(request: ClusterReadRequest, endpoint: string, rawResponse: string): ClusterReadResponse {
  return { requestId: request.requestId, connectionId: request.connectionId, endpoint, rawResponse };
}

/** Exposes one read's state so the contract rules can be asserted without any panel chrome. */
function Harness({ connectionId, endpoint, enabled, backend }:
  { connectionId: string | null; endpoint: string | null; enabled: boolean; backend: ClusterBackend }) {
  const { state, refresh, cancel } = useClusterRead({
    kind: 'clusterHealth', connectionId, endpoint, enabled, parse: parseClusterHealth, backend,
  });
  return <div>
    <span data-testid="status">{state.status}</span>
    <span data-testid="confirmed">{state.status === 'cancelled' ? String(state.confirmed) : ''}</span>
    <span data-testid="cluster">{state.status === 'ready' ? state.data.clusterName : ''}</span>
    <span data-testid="code">{state.status === 'error' ? state.code : ''}</span>
    <button type="button" onClick={refresh}>refresh</button>
    <button type="button" onClick={cancel}>cancel</button>
  </div>;
}

const renderHarness = (props: Partial<Parameters<typeof Harness>[0]> = {}) => render(
  <I18nextProvider i18n={i18n}>
    <Harness connectionId={CONNECTION} endpoint={ENDPOINT} enabled backend={props.backend!} {...props} />
  </I18nextProvider>,
);

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('cluster read contract', () => {
  it('refuses a response that belongs to another request, connection or endpoint', async () => {
    const requests: ClusterReadRequest[] = [];
    const backend: ClusterBackend = {
      read: (request) => {
        requests.push(request);
        return Promise.resolve({
          ...response(request, ENDPOINT, BODY),
          requestId: 'not-this-request',
          connectionId: CONNECTION,
        });
      },
      cancel: () => Promise.resolve(true),
    };
    renderHarness({ backend });
    await waitFor(() => expect(screen.getByTestId('code')).toHaveTextContent('invalidResponse'));
    expect(screen.getByTestId('status')).toHaveTextContent('error');
    expect(requests).toHaveLength(1);
  });

  it('refuses a response that names another endpoint than the one it was started for', async () => {
    const backend: ClusterBackend = {
      read: (request) => Promise.resolve(response(request, OTHER_ENDPOINT, BODY)),
      cancel: () => Promise.resolve(true),
    };
    renderHarness({ backend });
    await waitFor(() => expect(screen.getByTestId('code')).toHaveTextContent('invalidResponse'));
    expect(screen.getByTestId('cluster')).toHaveTextContent('');
  });

  it('applies a response only when the request, connection and endpoint all match', async () => {
    const backend: ClusterBackend = {
      read: (request) => Promise.resolve(response(request, ENDPOINT, BODY)),
      cancel: () => Promise.resolve(true),
    };
    renderHarness({ backend });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('cluster')).toHaveTextContent('fixture');
  });

  it('never sends a request while the read is disabled, not even on an explicit refresh', async () => {
    const user = userEvent.setup();
    const requests: ClusterReadRequest[] = [];
    const backend: ClusterBackend = {
      read: (request) => { requests.push(request); return Promise.resolve(response(request, ENDPOINT, BODY)); },
      cancel: () => Promise.resolve(true),
    };
    renderHarness({ backend, enabled: false });
    await user.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('idle'));
    expect(requests).toHaveLength(0);
  });
});

describe('cluster read cancellation', () => {
  /** A read and a cancel whose resolutions the test controls. */
  function controlled() {
    const requests: ClusterReadRequest[] = [];
    const cancelled: ClusterCancelRequest[] = [];
    let resolveRead: ((raw: string) => void) | null = null;
    let resolveCancel: ((confirmed: boolean) => void) | null = null;
    const backend: ClusterBackend = {
      read: (request) => new Promise<ClusterReadResponse>((resolve) => {
        requests.push(request);
        resolveRead = (raw) => resolve(response(request, ENDPOINT, raw));
      }),
      cancel: (request) => {
        cancelled.push(request);
        return new Promise<boolean>((resolve) => { resolveCancel = resolve; });
      },
    };
    return { backend, requests, cancelled, resolve: (raw: string) => resolveRead!(raw), ack: (confirmed: boolean) => resolveCancel!(confirmed) };
  }

  it('stops waiting immediately and refines the wording when the backend answers', async () => {
    const user = userEvent.setup();
    const control = controlled();
    renderHarness({ backend: control.backend });
    await screen.findByText('loading');
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    // The wait ends here, before the backend has answered.
    expect(screen.getByTestId('status')).toHaveTextContent('cancelled');
    expect(screen.getByTestId('confirmed')).toHaveTextContent('false');
    expect(control.cancelled).toHaveLength(1);
    await act(async () => { control.ack(true); });
    await waitFor(() => expect(screen.getByTestId('confirmed')).toHaveTextContent('true'));
    // The discarded response is never applied.
    await act(async () => { control.resolve(BODY); });
    expect(screen.getByTestId('status')).toHaveTextContent('cancelled');
    expect(screen.getByTestId('cluster')).toHaveTextContent('');
  });

  it('keeps a cancelled read cancelled when the backend reports nothing was in flight', async () => {
    const user = userEvent.setup();
    const control = controlled();
    renderHarness({ backend: control.backend });
    await screen.findByText('loading');
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    await act(async () => { control.ack(false); });
    expect(screen.getByTestId('status')).toHaveTextContent('cancelled');
    expect(screen.getByTestId('confirmed')).toHaveTextContent('false');
  });

  it('never lets a late cancel answer overwrite a newer result', async () => {
    const user = userEvent.setup();
    const control = controlled();
    renderHarness({ backend: control.backend });
    await screen.findByText('loading');
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    await user.click(screen.getByRole('button', { name: 'refresh' }));
    await act(async () => { control.resolve(OTHER_BODY); });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('cluster')).toHaveTextContent('other');
    await act(async () => { control.ack(true); });
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('cluster')).toHaveTextContent('other');
  });
});

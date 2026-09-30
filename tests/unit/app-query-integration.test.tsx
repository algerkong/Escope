import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { i18n } from '../../src/locales';
import { createSessionStorage, type StorageService } from '../../src/services/storage';
import type { QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';

const endpoint = 'https://fixture.test';
const response = '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},'
  + '"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}';

async function mount(kind: StorageService['kind'] = 'desktop') {
  const session = createSessionStorage();
  const profile = await session.saveConnection({ displayName: 'Fixture', endpoint, environment: 'development' });
  await session.selectConnection(profile.id);
  const initial = await session.load();
  initial.preferences.locale = 'en-US';
  const backend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint, rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"orders","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : '{"indices":["orders"],"fields":{}}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({ ...request, endpoint, rawResponse: response, partial: false })),
    cancel: vi.fn(async () => true),
  } satisfies QueryBackend;
  render(<I18nextProvider i18n={i18n}><App service={{ ...session, kind }} initial={initial} queryBackend={backend} /></I18nextProvider>);
  return { backend, profile, user: userEvent.setup() };
}

describe('app query integration', () => {
  it('runs the command palette action and retains the result across settings without another execution', async () => {
    const { backend, profile, user } = await mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Index or pattern' }), { target: { value: 'orders' } });
    await user.click(screen.getByRole('button', { name: 'Command palette' }));
    const action = screen.getByRole('option', { name: 'Run query' });
    expect(action).toHaveAttribute('aria-disabled', 'false');
    await user.click(action);
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      connectionId: profile.id, index: 'orders',
    }));
    expect(screen.getByLabelText('Execution target')).toHaveTextContent(endpoint);
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await user.click(screen.getByRole('switch', { name: 'Expand AI on next launch' }));
    await user.click(screen.getByRole('button', { name: 'Back to query' }));
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the hidden workspace command disabled while settings are open', async () => {
    const { backend, user } = await mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Index or pattern' }), { target: { value: 'orders' } });
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Command palette' }));
    const action = screen.getByRole('option', { name: /Run query/ });
    expect(action).toHaveAttribute('aria-disabled', 'true');
    await user.click(action);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('never grants a session preview a live backend, even when one is injected', async () => {
    const { backend } = await mount('session');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled());
    expect(backend.readResource).not.toHaveBeenCalled();
    expect(backend.execute).not.toHaveBeenCalled();
  });
});

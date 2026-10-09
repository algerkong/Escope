import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { i18n } from '../../src/locales';
import { createSessionStorage, type StorageService } from '../../src/services/storage';
import type { PitOpenRequest, QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';

const endpoint = 'https://fixture.test';
const response = '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},'
  + '"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}';

async function mount(kind: StorageService['kind'] = 'desktop', twoConnections = false) {
  const session = createSessionStorage();
  const profile = await session.saveConnection({ displayName: 'Fixture', endpoint, environment: 'development' });
  const second = twoConnections
    ? await session.saveConnection({ displayName: 'Second', endpoint, environment: 'development' }) : null;
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
    execute: vi.fn(async (request: QueryRequest) => ({
      requestId: request.requestId, connectionId: request.connectionId, endpoint, rawResponse: response, partial: false, pitId: null,
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({
      requestId: request.requestId, connectionId: request.connectionId, endpoint, pitId: 'pit-fixture',
    })),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  render(<I18nextProvider i18n={i18n}><App service={{ ...session, kind }} initial={initial} queryBackend={backend} /></I18nextProvider>);
  return { backend, profile, second, user: userEvent.setup() };
}

describe('app query integration', () => {
  it('previews only on index activation and keeps it across settings and connection switches', async () => {
    const { backend, profile, second, user } = await mount('desktop', true);
    expect(screen.getByRole('tab', { name: 'Data preview' })).toHaveAttribute('aria-selected', 'true');
    expect(backend.execute).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'orders' }));
    expect(await within(screen.getByRole('region', { name: 'Data preview' })).findByRole('img', { name: 'Completed' })).toBeVisible();
    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.execute.mock.calls[0]![0]).toMatchObject({ connectionId: profile.id, index: 'orders', pitId: 'pit-fixture' });
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    await user.click(screen.getByRole('button', { name: 'Back to query' }));
    expect(screen.getByRole('img', { name: 'Completed' })).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Active connection'), second!.id);
    expect(screen.getByRole('textbox', { name: 'Preview index' })).toHaveValue('');
    expect(screen.getByText('No index selected')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Active connection'), profile.id);
    expect(screen.queryByRole('textbox', { name: 'Preview index' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'orders (Fixture)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('img', { name: 'Completed' })).toBeVisible();
    await user.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByRole('textbox', { name: 'Index or pattern' })).toHaveValue('');
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('runs the command palette action and retains the result across settings without another execution', async () => {
    const { backend, profile, user } = await mount();
    await user.click(screen.getAllByRole('tab')[1]!);
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
    await user.click(screen.getAllByRole('tab')[1]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Index or pattern' }), { target: { value: 'orders' } });
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Command palette' }));
    const action = screen.getByRole('option', { name: /Run query/ });
    expect(action).toHaveAttribute('aria-disabled', 'true');
    await user.click(action);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('never grants a session preview a live backend, even when one is injected', async () => {
    const { backend, user } = await mount('session');
    await user.click(screen.getAllByRole('tab')[1]!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled());
    expect(backend.readResource).not.toHaveBeenCalled();
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('keeps an executed result bound to its original snapshot after parameter application', async () => {
    const { backend, user } = await mount();
    await user.click(screen.getAllByRole('tab')[1]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Index or pattern' }), { target: { value: 'orders' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Query DSL' }), { target: { value: '{"size":25}' } });
    await user.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('Completed');
    const executed = backend.execute.mock.calls[0]![0].rawDsl;
    fireEvent.click(screen.getByRole('button', { name: 'Query parameters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Type 1' }), { target: { value: 'number' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Template DSL' }), { target: { value: '{"size":{"$param":"param1"}}' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Value 1' }), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Query DSL' })).toHaveValue('{"size":50}'));
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.execute.mock.calls[0]![0].rawDsl).toBe(executed);
    expect(executed).toBe('{"size":25}');
  });
});

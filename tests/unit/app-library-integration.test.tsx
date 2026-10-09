import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { i18n } from '../../src/locales';
import { createSessionStorage } from '../../src/services/storage';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import type { QueryBackend, ResourceRequest } from '../../src/services/ipc';

async function mount(deleted = false, parameterized = false) {
  const service = createSessionStorage();
  const original = await service.saveConnection({ displayName: 'Original', endpoint: 'https://original.test', environment: 'development' });
  const other = await service.saveConnection({ displayName: 'Other', endpoint: 'https://other.test', environment: 'development' });
  await service.selectConnection(other.id);
  if (deleted) await service.deleteConnection(original.id);
  const library = createSessionQueryLibraryService();
  const dsl = '{"query":{"term":{"value":9007199254740993}}}';
  await library.save({ version: 1, entries: [{
    id: 'saved-draft', name: 'Saved draft', connectionId: original.id, index: 'orders-*', dsl,
    resultView: 'json', favorite: true, updatedAt: '2026-10-09T12:00:00.000Z',
    ...(parameterized ? { parameters: { version: 1, template: '{"query":{"term":{"value":{"$param":"value"}}}}',
      definitions: [{ name: 'value', type: 'number' as const }] } } : {}),
  }] }, await library.load());
  const initial = await service.load();
  initial.preferences.locale = 'en-US';
  const backend: QueryBackend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: request.connectionId === original.id ? original.endpoint : other.endpoint,
      rawResponse: '{"indices":[],"aliases":[],"data_streams":[]}',
    })),
    execute: vi.fn(), cancel: vi.fn(async () => true), openPit: vi.fn(), closePit: vi.fn(async () => {}),
  };
  render(<I18nextProvider i18n={i18n}><App service={{ ...service, kind: 'desktop' }} initial={initial}
    queryBackend={backend} queryLibraryService={library} /></I18nextProvider>);
  fireEvent.click(screen.getAllByRole('tab')[1]!);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('queryLibrary:open') }));
  const dialog = await screen.findByRole('dialog', { name: i18n.t('queryLibrary:title') });
  await within(dialog).findByText('Saved draft');
  return { library, backend, original, other, dsl, dialog };
}

describe('saved queries in the app', () => {
  it('restores into a fresh tab under its original connection without executing or rounding', async () => {
    const { backend, original, dsl, dialog } = await mount();
    fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('queryLibrary:restore') }));
    await waitFor(() => expect(screen.getByLabelText('Query DSL')).toHaveValue(dsl));
    expect(screen.getByRole('tab', { name: 'Saved draft' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Active connection')).toHaveValue(original.id);
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('orders-*');
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.openPit).not.toHaveBeenCalled();
  });

  it('keeps a deleted connection ID instead of rebinding to the selected connection', async () => {
    const { backend, dsl, dialog } = await mount(true);
    expect(within(dialog).getByText(/Removed connection/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('queryLibrary:restore') }));
    await waitFor(() => expect(screen.getByLabelText('Query DSL')).toHaveValue(dsl));
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(screen.getByText('The original connection was removed. This draft has not been reassigned.')).toBeInTheDocument();
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.openPit).not.toHaveBeenCalled();
  });

  it('restores parameter definitions, then applies only a reviewed final draft without executing', async () => {
    const { backend, dialog, library, dsl } = await mount(false, true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.getByLabelText('Query DSL')).toHaveValue(dsl));
    fireEvent.click(screen.getByRole('button', { name: 'Query parameters' }));
    expect(screen.getByRole('textbox', { name: 'Value 1' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Value 1' }), { target: { value: '987654321234567890' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview final DSL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
    await waitFor(() => expect(screen.getByLabelText('Query DSL')).toHaveValue('{"query":{"term":{"value":987654321234567890}}}'));
    expect((await library.load()).entries[0]!.dsl).toBe(dsl);
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.openPit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Query parameters' }));
    expect(screen.getByRole('textbox', { name: 'Value 1' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Template DSL' })).toHaveValue('{"query":{"term":{"value":{"$param":"value"}}}}');
  });
});

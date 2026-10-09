import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../../src/domain/connection';
import { type DataViewDefinition } from '../../src/domain/data-views';
import { DataViewsDialog } from '../../src/features/query/DataViews';
import { useDataViews } from '../../src/features/query/useDataViews';
import { useQueryResources } from '../../src/features/query/useQueryResources';
import { i18n } from '../../src/locales';
import { createSessionDataViewService, type DataViewService } from '../../src/services/data-views';
import type { QueryBackend, ResourceRequest, ResourceResponse } from '../../src/services/ipc';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });
const profiles: ConnectionProfile[] = [
  { id: 'a', displayName: 'Same name', endpoint: 'https://a.test', environment: 'development', auth: 'none', sortOrder: 0 },
  { id: 'b', displayName: 'Same name', endpoint: 'https://b.test', environment: 'development', auth: 'none', sortOrder: 1 },
];
const definition: DataViewDefinition = { id: 'view', connectionId: 'a', name: 'Events', index: 'events-*', defaultTimeField: '@timestamp' };
function api() {
  return {
    available: true, readResource: vi.fn(async (request: ResourceRequest): Promise<ResourceResponse> => ({
      ...request, endpoint: profiles.find((profile) => profile.id === request.connectionId)!.endpoint,
      rawResponse: '{"indices":["events-1"],"fields":{"@timestamp":{"date":{"searchable":true}}}}',
    })),
    execute: vi.fn(), cancel: vi.fn(async () => true), openPit: vi.fn(), closePit: vi.fn(),
  } satisfies QueryBackend;
}
function Harness({ service, backend, activeId = 'a', connections = profiles, onOpen = vi.fn(), onClose = vi.fn() }:
  { service: DataViewService; backend: QueryBackend; activeId?: string; connections?: ConnectionProfile[];
    onOpen?: (entry: DataViewDefinition) => void; onClose?: () => void }) {
  const library = useDataViews(service);
  const resources = useQueryResources(backend);
  return <I18nextProvider i18n={i18n}><DataViewsDialog library={library} kind={service.kind} profiles={connections}
    initialConnectionId={activeId} available={backend.available} fieldsFor={resources.fieldsFor}
    inspectFields={resources.refreshFields} onOpenQuery={onOpen} onClose={onClose} /></I18nextProvider>;
}
const manager = () => screen.getByRole('dialog');
const clickNew = async () => {
  await waitFor(() => expect(screen.getByRole('button', { name: 'New data view' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New data view' }));
};
function fill() {
  fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Events' } });
  fireEvent.change(screen.getByLabelText('Index, alias, data stream or pattern'), { target: { value: 'events-*' } });
  fireEvent.change(screen.getByLabelText('Default time field'), { target: { value: '@timestamp' } });
}

describe('Data View definition editor', () => {
  it('creates only a local definition, reads fields only on request, and exposes explicit new-query opening', async () => {
    const service = createSessionDataViewService();
    const backend = api();
    const onOpen = vi.fn();
    render(<Harness service={service} backend={backend} onOpen={onOpen} />);
    await clickNew();
    fill();
    expect(backend.readResource).not.toHaveBeenCalled();
    expect(screen.getByText('Time field not verified')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data view fields' }));
    expect(await screen.findByText('Searchable date field')).toBeVisible();
    expect(backend.readResource).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'a', resource: 'fieldCaps', index: 'events-*' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Data Views' });
    expect((await service.load()).library.entries[0]).toMatchObject({ name: 'Events', connectionId: 'a', defaultTimeField: '@timestamp' });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open as new query' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.openPit).not.toHaveBeenCalled();
  });

  it('does not adopt a new active connection or a late field result belonging to the previous scope', async () => {
    const service = createSessionDataViewService();
    const backend = api();
    let resolve!: (response: ResourceResponse) => void;
    backend.readResource.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<Harness service={service} backend={backend} />);
    await clickNew();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data view fields' }));
    const request = backend.readResource.mock.calls[0]![0];
    view.rerender(<Harness service={service} backend={backend} activeId="b" />);
    expect(screen.getByLabelText('Connection')).toHaveValue('a');
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'b' } });
    await act(async () => { resolve({ ...request, endpoint: profiles[0]!.endpoint,
      rawResponse: '{"indices":["events-1"],"fields":{"@timestamp":{"date":{"searchable":true}}}}' }); });
    expect(screen.getByText('Time field not verified')).toBeVisible();
    expect(screen.queryByText('Searchable date field')).not.toBeInTheDocument();
    expect(backend.readResource).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Data Views' });
    expect((await service.load()).library.entries[0]!.connectionId).toBe('b');
  });

  it.each([
    ['{"date":{"searchable":true},"keyword":{"searchable":true}}', 'Time field has conflicting types across the target'],
    ['{"keyword":{"searchable":true}}', 'Time field must be date or date_nanos'],
    ['{"date":{"searchable":false}}', 'Time field is not searchable'],
    ['{}', 'Time field absent from the returned catalog'],
  ])('blocks a known invalid default (%s) without changing Mapping', async (types, message) => {
    const service = createSessionDataViewService();
    const backend = api();
    backend.readResource.mockImplementation(async (request) => ({ ...request, endpoint: profiles[0]!.endpoint,
      rawResponse: `{"indices":["events-1"],"fields":{"@timestamp":${types}}}` }));
    render(<Harness service={service} backend={backend} />);
    await clickNew();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data view fields' }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Default time field'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect((await service.load()).library.entries).toEqual([]);
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.readResource.mock.calls.map(([request]) => request.resource)).toEqual(['fieldCaps']);
  });

  it('shows failed field refresh as unverified instead of reusing old successful evidence', async () => {
    const backend = api();
    render(<Harness service={createSessionDataViewService()} backend={backend} />);
    await clickNew();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data view fields' }));
    await screen.findByText('Searchable date field');
    backend.readResource.mockRejectedValueOnce({ code: 'serverForbidden' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data view fields' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Time field not verified')).toBeVisible();
    expect(screen.queryByText('Searchable date field')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Default time field')).toHaveValue('@timestamp');
  });

  it('explains invalid or oversized time field names before any IPC', async () => {
    const backend = api();
    render(<Harness service={createSessionDataViewService()} backend={backend} />);
    await clickNew();
    fill();
    for (const value of [' @timestamp', 'x'.repeat(1025)]) {
      fireEvent.change(screen.getByLabelText('Default time field'), { target: { value } });
      expect(screen.getByLabelText('Default time field')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('The time field must be at most 1,024 bytes, without control characters or leading/trailing spaces.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    }
    expect(backend.readResource).not.toHaveBeenCalled();
  });

  it('retains form values on save failure and requires explicit reload rather than repeated writes', async () => {
    const memory = createSessionDataViewService();
    const service: DataViewService = { ...memory, save: vi.fn(async () => { throw { code: 'dataViewConflict' }; }) };
    render(<Harness service={service} backend={api()} />);
    await clickNew();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('The saved data views changed. Reload and review them before saving again.');
    expect(screen.getByLabelText('View name')).toHaveValue('Events');
    expect(screen.getByLabelText('Default time field')).toHaveValue('@timestamp');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(service.save).toHaveBeenCalledTimes(1);
    expect((await memory.load()).library.entries).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits and reload' }));
    await screen.findByText('No data views');
    expect(screen.queryByLabelText('View name')).not.toBeInTheDocument();
    expect(service.save).toHaveBeenCalledTimes(1);
  });

  it('locks connection identity on edit, blocks deleted connections and confirms local deletion', async () => {
    const service = createSessionDataViewService();
    await service.save(0, { version: 1, entries: [definition] });
    const backend = api();
    const view = render(<Harness service={service} backend={backend} />);
    await screen.findByText('Events');
    fireEvent.click(screen.getByRole('button', { name: 'Edit data view' }));
    expect(screen.getByLabelText('Connection')).toBeDisabled();
    view.rerender(<Harness service={service} backend={backend} connections={[profiles[1]!]} activeId="b" />);
    expect(screen.getByLabelText('Connection')).toHaveValue('a');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Open as new query' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete data view' }));
    expect((await service.load()).library.entries).toHaveLength(1);
    expect(within(manager()).getByText(/Existing drafts and results keep their original targets/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Delete data view' }));
    await screen.findByText('No data views');
    expect((await service.load()).library.entries).toEqual([]);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('supports keyboard-close and preserves an invalid store without inventing an empty writable library', async () => {
    const service: DataViewService = { kind: 'desktop', load: vi.fn(async () => { throw { code: 'invalidResponse' }; }), save: vi.fn() };
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness service={service} backend={api()} onClose={onClose} />);
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'New data view' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(service.save).not.toHaveBeenCalled();
  });
});

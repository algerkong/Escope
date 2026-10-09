import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { i18n } from '../../src/locales';
import { createSessionStorage } from '../../src/services/storage';
import * as windowService from '../../src/services/window';
import type { PitOpenRequest, PitOpenResponse, QueryBackend, QueryRequest, QueryResponse, ResourceRequest } from '../../src/services/ipc';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function body(index: string, count = 2, marker = index) {
  const rows = Array.from({ length: count }, (_, n) =>
    `{"_index":"${index}","_id":"${marker}-${n}","_source":{"rank":${9007199254740993n + BigInt(n)},"label":"${marker}-row-${n}"},"sort":[${n}]}`
  ).join(',');
  return `{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":${count},"relation":"eq"},"hits":[${rows}]}}`;
}

async function mount(count = 2) {
  const store = createSessionStorage();
  const a = await store.saveConnection({ displayName: 'Alpha', endpoint: 'https://a.test', environment: 'development' });
  const b = await store.saveConnection({ displayName: 'Beta', endpoint: 'https://b.test', environment: 'staging' });
  await store.selectConnection(a.id);
  const initial = await store.load();
  initial.preferences.locale = 'en-US';
  const target = (id: string) => id === a.id ? a.endpoint : b.endpoint;
  const backend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: target(request.connectionId),
      rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"orders","attributes":["open"],"aliases":[]},{"name":"events","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : '{"indices":[],"fields":{"rank":{"long":{"type":"long","searchable":true,"aggregatable":true}}}}',
    })),
    execute: vi.fn(async (request: QueryRequest): Promise<QueryResponse> => ({
      ...request, endpoint: target(request.connectionId), rawResponse: body(request.index, count), partial: false, pitId: request.pitId ?? null,
    })),
    openPit: vi.fn(async (request: PitOpenRequest): Promise<PitOpenResponse> => ({
      ...request, endpoint: target(request.connectionId), pitId: `pit-${request.requestId}`,
    })),
    cancel: vi.fn(async () => true),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  const service = { ...store, kind: 'desktop' as const };
  render(<I18nextProvider i18n={i18n}><App service={service} initial={initial} queryBackend={backend} /></I18nextProvider>);
  return { backend, user: userEvent.setup(), a, b, target, store, service };
}

const indexTab = (index: string, connection = 'Alpha') => screen.getByRole('tab', { name: `${index} (${connection})` });
const closeIndex = (index: string, connection = 'Alpha') => screen.getByRole('button', { name: `Close ${index} (${connection})` });
const open = async (user: ReturnType<typeof userEvent.setup>, index: string) => {
  await user.click(await screen.findByRole('button', { name: index }));
  await screen.findByText(`${index}-row-0`);
};

describe('independent index tabs', () => {
  it('keeps row selection isolated by tab through JSON and settings but clears it when refreshed', async () => {
    const { backend, user } = await mount();
    await open(user, 'orders');
    await user.click(screen.getByText('orders-row-0'));
    expect(screen.getByText('orders-row-0').closest('tr')).toHaveAttribute('aria-selected', 'true');
    await open(user, 'events');
    expect(screen.getByText('events-row-0').closest('tr')).toHaveAttribute('aria-selected', 'false');
    await user.click(screen.getByText('events-row-1'));
    await user.click(indexTab('orders'));
    expect(screen.getByText('orders-row-0').closest('tr')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('orders-row-1').closest('tr')).toHaveAttribute('aria-selected', 'false');
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    await user.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByText('orders-row-0').closest('tr')).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Back to query' }));
    expect(screen.getByText('orders-row-0').closest('tr')).toHaveAttribute('aria-selected', 'true');
    expect(backend.execute).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Refresh index' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(3));
    expect((await screen.findByText('orders-row-0')).closest('tr')).toHaveAttribute('aria-selected', 'false');
    await user.click(indexTab('events'));
    expect(screen.getByText('events-row-1').closest('tr')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps preview metadata in one toolbar and table controls in one footer', async () => {
    const { backend, user, a } = await mount(65);
    await open(user, 'orders');
    const toolbar = screen.getByRole('form', { name: 'Preview toolbar' });
    expect(within(toolbar).getByText('Alpha')).toBeVisible();
    expect(within(toolbar).getByText('orders')).toBeVisible();
    expect(within(toolbar).getByText('65 hits')).toBeVisible();
    expect(within(toolbar).getByText('1 ms')).toBeVisible();
    expect(within(toolbar).getByRole('img', { name: 'Completed' })).toHaveAttribute('title', 'Completed');
    expect(within(toolbar).queryByText('Completed')).not.toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(toolbar).getByRole('button', { name: 'Refresh index' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Data preview' })).not.toBeInTheDocument();
    expect(screen.queryByText(a.endpoint)).not.toBeInTheDocument();
    expect(document.querySelector('.ql-result-origin')).toBeNull();
    expect(document.querySelector('.results-toolbar')).toBeNull();
    expect(document.querySelector('.rg-toolbar')).toBeNull();
    const footer = document.querySelector<HTMLElement>('.rg-footer')!;
    expect(within(footer).getByText('65 loaded rows')).toBeVisible();
    expect(screen.getAllByText('65 loaded rows')).toHaveLength(1);
    expect(within(footer).getByText('Page 1 of 2')).toBeVisible();
    expect(within(footer).getByRole('button', { name: 'Next page' })).toBeEnabled();
    expect(within(footer).getByRole('button', { name: 'Columns' })).toBeEnabled();
    expect(within(footer).getByRole('img', { name: 'All matching documents loaded.' })).toHaveAttribute('title', 'All matching documents loaded.');
    expect(footer.textContent).not.toContain('snapshot');
    await user.click(within(toolbar).getByRole('button', { name: 'JSON' }));
    expect(document.querySelector('.rg-footer')).toBeNull();
    const jsonFooter = document.querySelector<HTMLElement>('.ql-result-footer')!;
    expect(within(jsonFooter).getByText('65 loaded rows')).toBeVisible();
    expect(within(jsonFooter).getByRole('button', { name: 'Copy raw response' })).toBeEnabled();
    expect(within(jsonFooter).getByRole('img', { name: 'All matching documents loaded.' })).toBeVisible();
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('opens an ordered tab per index and repeated activation only selects the existing result', async () => {
    const { backend, user } = await mount();
    expect(backend.execute).not.toHaveBeenCalled();
    await open(user, 'orders');
    await open(user, 'events');
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label') ?? tab.textContent))
      .toEqual(['Data preview', 'Untitled query 1', 'orders (Alpha)', 'events (Alpha)']);
    await user.dblClick(screen.getByRole('button', { name: 'orders' }));
    expect(indexTab('orders')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('orders-row-0')).toBeVisible();
    expect(screen.queryByText('events-row-0')).not.toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(2);
    expect(backend.openPit).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Refresh index' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(3));
    expect(backend.execute.mock.calls[2]?.[0].index).toBe('orders');
  });

  it('keeps sort, width, order, visibility, page, views and scroll separate across index tabs', async () => {
    const { backend, user } = await mount(65);
    await open(user, 'orders');
    const resizer = screen.getByRole('separator', { name: 'Resize column rank' });
    const width = Number(resizer.getAttribute('aria-valuenow'));
    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    await user.click(screen.getByRole('button', { name: 'Sort by rank' }));
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    await user.click(screen.getByRole('button', { name: 'Move rank left' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show column Index (_index)' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    const grid = screen.getByRole('region', { name: 'Document grid' });
    fireEvent.scroll(grid, { target: { scrollTop: 140, scrollLeft: 120 } });
    await open(user, 'events');
    expect(screen.getByRole('separator', { name: 'Resize column rank' })).toHaveAttribute('aria-valuenow', String(width));
    expect(screen.getByText('Page 1 of 2')).toBeVisible();
    await user.click(indexTab('orders'));
    expect(screen.getByText('Page 2 of 2')).toBeVisible();
    expect(screen.getByRole('separator', { name: 'Resize column rank' })).toHaveAttribute('aria-valuenow', String(width + 12));
    expect(screen.queryByRole('separator', { name: 'Resize column Index (_index)' })).not.toBeInTheDocument();
    expect([...screen.getByRole('region', { name: 'Document grid' }).querySelectorAll('th')].map((th) => th.dataset.columnId))
      .toEqual(['meta:row', 'field:rank', 'meta:id', 'field:label']);
    expect(screen.getByRole('region', { name: 'Document grid' })).toHaveProperty('scrollLeft', 120);
    expect(screen.getByRole('region', { name: 'Document grid' })).toHaveProperty('scrollTop', 140);
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    const json = document.querySelector<HTMLPreElement>('.ql-results-body > pre')!;
    fireEvent.scroll(json, { target: { scrollTop: 80, scrollLeft: 45 } });
    await user.click(indexTab('events'));
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(indexTab('orders'));
    expect(screen.getByRole('button', { name: 'JSON' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('.ql-results-body > pre')).toHaveProperty('scrollTop', 80);
    await user.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByText('Page 2 of 2')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Document grid' })).toHaveProperty('scrollLeft', 120);
    expect(backend.execute).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('isolates the same index on two connections and restores the previously selected tab without executing', async () => {
    const { backend, user, a, b } = await mount();
    await open(user, 'orders');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Active connection' }), b.id);
    expect(screen.getByRole('tab', { name: 'Data preview' })).toHaveAttribute('aria-selected', 'true');
    await open(user, 'orders');
    expect(indexTab('orders', 'Beta')).toHaveAttribute('aria-selected', 'true');
    expect(indexTab('orders', 'Alpha')).toHaveAttribute('aria-selected', 'false');
    expect(backend.execute.mock.calls.map(([request]) => request.connectionId)).toEqual([a.id, b.id]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Active connection' }), a.id);
    expect(indexTab('orders')).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('form', { name: 'Preview toolbar' })).getByText(a.displayName)).toBeVisible();
    expect(screen.queryByLabelText('Execution target')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    await user.click(screen.getByRole('button', { name: 'Back to query' }));
    await waitFor(() => expect(indexTab('orders')).toHaveFocus());
    expect(backend.execute).toHaveBeenCalledTimes(2);
  });

  it('opens typed targets in a new locked tab and creates a separate bound query on demand', async () => {
    const { backend, user, a } = await mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Preview index' }), { target: { value: 'manual-*' } });
    await user.click(screen.getByRole('button', { name: 'Open index' }));
    await screen.findByText('manual-*-row-0');
    expect(indexTab('manual-*')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('textbox', { name: 'Preview index' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New query for manual-*' }));
    expect(screen.getByRole('textbox', { name: 'Index or pattern' })).toHaveValue('manual-*');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Query DSL' })).toHaveFocus());
    expect(backend.execute).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Run query' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(2));
    expect(backend.execute.mock.calls[1]?.[0]).toMatchObject({ connectionId: a.id, index: 'manual-*' });
    expect(indexTab('manual-*')).toBeInTheDocument();
  });

  it('synchronizes the connection when directly selecting a tab and binds new queries to that connection', async () => {
    const { backend, user, a, b, store } = await mount();
    await open(user, 'orders');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Active connection' }), b.id);
    await open(user, 'orders');
    await user.click(indexTab('orders', 'Alpha'));
    expect(screen.getByRole('combobox', { name: 'Active connection' })).toHaveValue(a.id);
    await user.click(indexTab('orders', 'Beta'));
    expect(screen.getByRole('combobox', { name: 'Active connection' })).toHaveValue(b.id);
    expect(within(screen.getByRole('form', { name: 'Preview toolbar' })).getByText(b.displayName)).toBeVisible();
    expect(screen.queryByLabelText('Execution target')).not.toBeInTheDocument();
    await waitFor(async () => expect((await store.load()).activeConnectionId).toBe(b.id));
    await user.click(screen.getByRole('button', { name: 'New query' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Index or pattern' }), { target: { value: 'orders' } });
    await user.click(screen.getByRole('button', { name: 'Run query' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(3));
    expect(backend.execute.mock.calls[2]?.[0].connectionId).toBe(b.id);
  });

  it('does not let a delayed connection selection override a newer tab activation', async () => {
    const { backend, user, a, b, service, store } = await mount();
    await open(user, 'orders');
    const pending = deferred<void>();
    const select = service.selectConnection;
    service.selectConnection = vi.fn().mockImplementationOnce(async (id: string) => {
      await pending.promise;
      await select(id);
    }).mockImplementation((id: string) => select(id));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Active connection' }), b.id);
    await user.click(indexTab('orders'));
    await act(async () => { pending.resolve(); await pending.promise; });
    await waitFor(async () => expect((await store.load()).activeConnectionId).toBe(a.id));
    expect(screen.getByRole('combobox', { name: 'Active connection' })).toHaveValue(a.id);
    expect(indexTab('orders')).toHaveAttribute('aria-selected', 'true');
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps focus in the editor when middle-closing a background tab and ignores shortcuts outside documents', async () => {
    const { backend, user } = await mount();
    await open(user, 'orders');
    await open(user, 'events');
    await user.click(screen.getAllByRole('tab')[1]!);
    const editor = screen.getByRole('textbox', { name: 'Query DSL' });
    editor.focus();
    fireEvent(indexTab('orders'), new MouseEvent('auxclick', { button: 1, bubbles: true }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(editor).toHaveFocus();
    expect(indexTab('events')).toBeInTheDocument();
    const filter = screen.getByRole('textbox', { name: 'Filter indices' });
    filter.focus();
    fireEvent.keyDown(filter, { key: 'w', ctrlKey: true });
    fireEvent.keyDown(filter, { key: 'Enter', ctrlKey: true });
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(backend.execute).toHaveBeenCalledTimes(2);
  });

  it('closes background snapshots independently, chooses a neighbor and returns focus after active close', async () => {
    const { backend, user } = await mount();
    await open(user, 'orders');
    const firstPit = backend.execute.mock.calls[0]![0].pitId!;
    await open(user, 'events');
    await user.click(closeIndex('orders'));
    expect(indexTab('events')).toHaveAttribute('aria-selected', 'true');
    expect(backend.closePit).toHaveBeenCalledWith(expect.objectContaining({ pitId: firstPit }));
    fireEvent.keyDown(indexTab('events'), { key: 'w', ctrlKey: true });
    expect(screen.queryByRole('tab', { name: 'events (Alpha)' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('tab', { selected: true })).toHaveFocus());
    expect(screen.getByRole('textbox', { name: 'Index or pattern' })).toHaveValue('');
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'Delete' });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByText('No index selected')).toBeVisible();
    expect(backend.execute).toHaveBeenCalledTimes(2);
  });

  it('preserves macOS Control-W text editing and uses Command-W for tab close', async () => {
    const { user } = await mount();
    await open(user, 'orders');
    const platform = vi.spyOn(windowService, 'detectWindowPlatform').mockReturnValue('macos');
    try {
      fireEvent.keyDown(indexTab('orders'), { key: 'w', ctrlKey: true });
      expect(indexTab('orders')).toBeInTheDocument();
      fireEvent.keyDown(indexTab('orders'), { key: 'w', metaKey: true });
      expect(screen.queryByRole('tab', { name: 'orders (Alpha)' })).not.toBeInTheDocument();
    } finally {
      platform.mockRestore();
    }
  });

  it('discards a closed request even when the same index has been reopened', async () => {
    const { backend, user, target } = await mount();
    const slow = deferred<QueryResponse>();
    backend.execute.mockReturnValueOnce(slow.promise);
    await user.click(await screen.findByRole('button', { name: 'orders' }));
    await waitFor(() => expect(backend.execute).toHaveBeenCalledTimes(1));
    const request = backend.execute.mock.calls[0]![0];
    const oldTabId = indexTab('orders').id;
    await user.click(closeIndex('orders'));
    expect(backend.cancel).toHaveBeenCalledWith({ requestId: request.requestId, connectionId: request.connectionId });
    await open(user, 'orders');
    expect(indexTab('orders').id).not.toBe(oldTabId);
    await act(async () => {
      slow.resolve({ ...request, endpoint: target(request.connectionId), rawResponse: body('orders', 2, 'late'), partial: false, pitId: 'late-pit' });
      await slow.promise;
    });
    expect(screen.getByText('orders-row-0')).toBeVisible();
    expect(screen.queryByText('late-row-0')).not.toBeInTheDocument();
    expect(backend.closePit).toHaveBeenCalledWith(expect.objectContaining({ pitId: 'late-pit' }));
  });

  it('releases an opening PIT after the tab is closed without starting its search', async () => {
    const { backend, user, target } = await mount();
    const slow = deferred<PitOpenResponse>();
    backend.openPit.mockReturnValueOnce(slow.promise);
    await user.click(await screen.findByRole('button', { name: 'orders' }));
    await waitFor(() => expect(backend.openPit).toHaveBeenCalledTimes(1));
    const request = backend.openPit.mock.calls[0]![0];
    await user.click(closeIndex('orders'));
    await act(async () => {
      slow.resolve({ ...request, endpoint: target(request.connectionId), pitId: 'late-opening-pit' });
      await slow.promise;
    });
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.closePit).toHaveBeenCalledWith(expect.objectContaining({ pitId: 'late-opening-pit' }));
  });

  it('retains incomplete visual drafts through index tabs and confirms before discarding them', async () => {
    const { backend, user } = await mount();
    const queryTab = screen.getAllByRole('tab')[1]!;
    await user.click(queryTab);
    fireEvent.change(screen.getByRole('textbox', { name: 'Index or pattern' }), { target: { value: 'orders' } });
    const originalDsl = (screen.getByRole('textbox', { name: 'Query DSL' }) as HTMLTextAreaElement).value;
    await user.click(screen.getByRole('button', { name: 'Visual' }));
    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Field 1' }), { target: { value: 'rank' } });
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    await open(user, 'events');
    await user.click(queryTab);
    expect(screen.getByRole('combobox', { name: 'Field 1' })).toHaveValue('rank');
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Field 1' }), { key: 'Enter', ctrlKey: true });
    expect(backend.execute).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'DSL' }));
    expect(screen.getByRole('textbox', { name: 'Query DSL' })).toHaveValue(originalDsl);
    await user.click(screen.getByRole('button', { name: 'Visual' }));
    fireEvent.keyDown(queryTab, { key: 'w', ctrlKey: true, isComposing: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(queryTab, { key: 'w', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeVisible();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(queryTab).toBeInTheDocument();
    fireEvent.keyDown(queryTab, { key: 'Delete' });
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(indexTab('events')).toHaveFocus());
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('supports roving tab focus without executing queries and exposes index tabs to quick jump', async () => {
    const { backend, user } = await mount();
    await open(user, 'orders');
    await open(user, 'events');
    fireEvent.keyDown(indexTab('events'), { key: 'ArrowLeft' });
    expect(indexTab('orders')).toHaveFocus();
    fireEvent.keyDown(indexTab('orders'), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Data preview' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Data preview' }), { key: 'End' });
    expect(indexTab('events')).toHaveFocus();
    expect(screen.getAllByRole('tab').filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Quick navigation' }));
    await user.click(screen.getByRole('option', { name: 'orders (Alpha)' }));
    await waitFor(() => expect(indexTab('orders')).toHaveFocus());
    expect(backend.execute).toHaveBeenCalledTimes(2);
  });
});

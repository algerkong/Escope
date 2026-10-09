import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createWorkspace } from '../../src/domain/query';
import { DATA_PREVIEW_DSL } from '../../src/domain/query-pagination';
import { previewTimeRange } from '../../src/domain/query-time-range';
import { recoveryWorkspace } from '../../src/domain/workspace-recovery';
import { i18n } from '../../src/locales';
import { enQuerySort } from '../../src/locales/query-sort';
import type { PitOpenRequest, QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionStorage } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

async function fixture(timed = false) {
  const storage = createSessionStorage();
  const a = await storage.saveConnection({ displayName: 'Alpha', endpoint: 'https://a.test', environment: 'development' });
  const b = await storage.saveConnection({ displayName: 'Beta', endpoint: 'https://b.test', environment: 'development' });
  await storage.selectConnection(a.id);
  const workspace = createWorkspace(a.id);
  const query = workspace.tabs[0]!.document;
  query.name = 'Sort draft';
  query.index = 'events';
  query.dsl = '{"query":{"term":{"original":9007199254740993}},"sort":["_score"],"size":25}';
  if (timed) {
    const time = previewTimeRange(query, { field: 'date', fieldType: 'date', timeZone: 'UTC',
      range: { kind: 'relative', amount: 15, unit: 'minutes' } }, new Date('2026-10-10T00:00:00.000Z'));
    if (!time.ok) throw new Error(time.code);
    query.dsl = time.dsl;
    query.timeRange = time.timeRange;
  }
  workspace.activeTabId = query.id;
  const recovery = { ...createSessionWorkspaceRecoveryService(), kind: 'desktop' as const };
  await recovery.save(0, { version: 1, workspace: recoveryWorkspace(workspace), history: [] });
  const library = createSessionQueryLibraryService();
  const initial = await storage.load();
  initial.preferences.locale = 'en-US';
  const endpoint = (id: string) => id === a.id ? a.endpoint : b.endpoint;
  const backend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: endpoint(request.connectionId), rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"events","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : '{"indices":["events"],"fields":{"n":{"long":{"searchable":true,"aggregatable":true}},"date":{"date":{"searchable":true,"aggregatable":true}}}}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({
      ...request, endpoint: endpoint(request.connectionId), pitId: request.pitId ?? null, partial: false,
      rawResponse: '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":4,"relation":"eq"},'
        + '"hits":[{"_index":"events","_id":"first","_source":{"n":9007199254740993},"sort":[1,"first",9007199254740993]},'
        + '{"_index":"events","_id":"second","_source":{"n":2},"sort":[2,"second",9007199254740995]}]}}',
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({ ...request, endpoint: endpoint(request.connectionId), pitId: 'fixture-pit' })),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  const mount = () => render(<I18nextProvider i18n={i18n}><App initial={initial} service={{ ...storage, kind: 'desktop' }}
    queryBackend={backend} workspaceRecoveryService={recovery} queryLibraryService={library} /></I18nextProvider>);
  const saved = () => waitFor(() => expect(screen.getByText('Workspace saved')).toBeVisible());
  return { a, b, query, backend, recovery, library, mount, saved, user: userEvent.setup() };
}
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Server sort' }));
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview sorted DSL' }));
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply sort to draft' }));
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const final = () => (screen.getByLabelText('Final sorted DSL') as HTMLTextAreaElement).value;
async function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Check sort field capabilities' }));
  await screen.findByText('long (Field capabilities)');
}

describe('server sort in the workspace', () => {
  it('leaves header sorting local, preserves managed time and old results, and applies new sort only on an explicit run', async () => {
    const f = await fixture(true);
    const mounted = f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('9007199254740993', { selector: '.rg-cell' });
    const executed = f.backend.execute.mock.calls[0]![0].rawDsl;
    fireEvent.click(screen.getByRole('button', { name: 'Sort by n' }));
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    const reads = f.backend.readResource.mock.calls.length;
    open();
    expect(f.backend.readResource).toHaveBeenCalledTimes(reads);
    change('Sort field 1', 'n');
    change('Sort order 1', 'desc');
    await inspect();
    fireEvent.click(screen.getByRole('button', { name: 'Add sort field' }));
    change('Sort field 2', 'date');
    change('Missing values 2', '_last');
    preview();
    const reviewed = final();
    expect(reviewed).toContain('9007199254740993');
    apply();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(reviewed);
    expect(screen.getByText('9007199254740993', { selector: '.rg-cell' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Managed time' })).toBeVisible();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(2));
    expect(f.backend.execute.mock.calls[1]![0]).toMatchObject({ rawDsl: executed, searchAfter: '[2,"second",9007199254740995]' });
    expect(f.backend.openPit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run query' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(3));
    const rerun = f.backend.execute.mock.calls[2]![0];
    expect(JSON.parse(rerun.rawDsl).sort).toEqual(JSON.parse(reviewed).sort);
    expect(rerun.rawDsl).toContain('9007199254740993');
    expect(rerun).not.toHaveProperty('searchAfter');
    expect(f.backend.openPit).toHaveBeenCalledTimes(2);
    await f.saved();
    const stored = (await f.recovery.load()).document;
    expect(stored.workspace!.tabs[0]!.document).toMatchObject({ dsl: reviewed, timeRange: f.query.timeRange });
    expect(stored.workspace!.tabs[0]!.document).not.toHaveProperty('sort');
    expect(stored.history.find((entry) => entry.kind === 'continuation')!.snapshot.rawDsl).toBe(executed);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await f.library.load()).entries[0]?.dsl).toBe(reviewed));
    mounted.unmount();
    f.mount();
    await f.saved();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(reviewed);
    expect(f.backend.execute).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('group', { name: 'Managed time' })).toBeVisible();
  });

  it('keeps changes local on cancel and preserves applied sort through settings, language and connection changes', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    open();
    change('Sort order 1', 'asc');
    preview();
    expect(f.backend.execute).not.toHaveBeenCalled();
    await f.user.keyboard('{Escape}');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    open();
    expect(screen.getByLabelText('Sort order 1')).toHaveValue('desc');
    change('Sort order 1', 'asc');
    preview();
    const reviewed = final();
    apply();
    await f.user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await f.user.click(screen.getByRole('button', { name: 'Appearance' }));
    await f.user.click(screen.getByRole('button', { name: 'Dark' }));
    await f.user.click(screen.getByRole('button', { name: 'Back to query' }));
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('button', { name: '服务器排序' })).toBeVisible();
    await act(async () => { await i18n.changeLanguage('en-US'); });
    await f.user.selectOptions(screen.getByLabelText('Active connection'), f.b.id);
    await f.user.selectOptions(screen.getByLabelText('Active connection'), f.a.id);
    await f.user.click(screen.getByRole('tab', { name: 'Sort draft' }));
    expect(screen.getByLabelText('Query DSL')).toHaveValue(reviewed);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(f.backend.openPit).not.toHaveBeenCalled();
    await f.saved();
  });

  it('keeps index sort locked and uses the existing explicit new-query entry', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    fireEvent.click(await screen.findByRole('button', { name: 'events' }));
    await screen.findByText('9007199254740993', { selector: '.rg-cell' });
    expect(screen.queryByRole('button', { name: 'Server sort' })).not.toBeInTheDocument();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'New query for events' }));
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('events');
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Remove all sort fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add sort field' }));
    change('Sort field 1', 'n');
    preview();
    apply();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.saved();
    const tabs = (await f.recovery.load()).document.workspace!.tabs;
    expect(tabs.find((tab) => tab.kind === 'index')!.document.dsl).toBe(DATA_PREVIEW_DSL);
    expect(tabs.at(-1)!.document.connectionId).toBe(f.a.id);
    expect(tabs.at(-1)!.document.dsl).toContain('"n"');
    fireEvent.click(screen.getByRole('tab', { name: 'events (Alpha)' }));
    expect(screen.getByText('9007199254740993', { selector: '.rg-cell' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Server sort' })).not.toBeInTheDocument();
  });

  it('blocks sorting while cell filters are pending and cannot bypass an invalid visual draft', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('9007199254740993', { selector: '.rg-cell' });
    fireEvent.click(within(screen.getByText('9007199254740993', { selector: '.rg-cell' }).closest('td')!).getByRole('button', { name: 'Filter n' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check field capabilities' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add to pending filters' }));
    await f.user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Server sort' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard pending filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    change('Value 1', 'invalid');
    expect(screen.getByRole('button', { name: 'Server sort' })).toBeDisabled();
    change('Value 1', '9007199254740993');
    open();
    change('Sort order 1', 'asc');
    preview();
    expect(screen.getByRole('button', { name: 'Apply sort to draft' })).toBeEnabled();
    change('Value 1', 'invalid');
    expect(screen.getByRole('button', { name: 'Apply sort to draft' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(enQuerySort.draftChanged);
    await f.user.keyboard('{Escape}');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.saved();
  });

  it('cannot run from a keyboard shortcut or save the old DSL during a sort review', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    open();
    change('Sort order 1', 'asc');
    preview();
    await f.user.keyboard('{Control>}{Enter}{/Control}');
    const run = document.querySelector<HTMLButtonElement>('.run-button')!;
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', enQuerySort.reviewOpen);
    fireEvent.click(run);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Save draft"]')).toBeDisabled();
    await f.user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Run query' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    await f.saved();
  });
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createWorkspace } from '../../src/domain/query';
import { selectDataView } from '../../src/domain/data-views';
import { DATA_PREVIEW_DSL } from '../../src/domain/query-pagination';
import { previewTimeRange } from '../../src/domain/query-time-range';
import { recoveryWorkspace } from '../../src/domain/workspace-recovery';
import { i18n } from '../../src/locales';
import { enQueryFilters } from '../../src/locales/query-filters';
import { createSessionDataViewService } from '../../src/services/data-views';
import type { QueryBackend, QueryRequest, ResourceRequest, PitOpenRequest } from '../../src/services/ipc';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionStorage } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

async function fixture(timed = false, runtime = false, paged = false) {
  const storage = createSessionStorage();
  const a = await storage.saveConnection({ displayName: 'Alpha', endpoint: 'https://a.test', environment: 'development' });
  const b = await storage.saveConnection({ displayName: 'Beta', endpoint: 'https://b.test', environment: 'development' });
  await storage.selectConnection(a.id);
  const workspace = createWorkspace(a.id);
  const query = workspace.tabs[0]!.document;
  query.index = 'events';
  query.name = 'Filter draft';
  query.dsl = '{"query":{"term":{"original":9007199254740993}},"size":25'
    + (paged ? ',"sort":[{"n":"desc"},"_score"]' : '')
    + (runtime ? ',"runtime_mappings":{"n":{"type":"long","script":{"source":"emit(9007199254740995L);"}}},"fields":["n"]' : '') + '}';
  const dataViews = createSessionDataViewService();
  const view = { id: 'view', connectionId: a.id, name: 'View', index: 'events', defaultTimeField: 'date',
    fieldFormats: { version: 1, entries: [{ field: 'n', format: { kind: 'number' as const, grouping: true } }] } };
  await dataViews.save(0, { version: 1, entries: [view] });
  query.dataView = selectDataView(view);
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
        : '{"indices":["events"],"fields":{"n":{"long":{"searchable":true}},"status":{"keyword":{"searchable":true}},"date":{"date":{"searchable":true}}}}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({
      ...request, endpoint: endpoint(request.connectionId), pitId: request.pitId ?? null, partial: false,
      rawResponse: '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":'
        + (paged ? '4' : '2') + ',"relation":"eq"},'
        + '"hits":[{"_index":"events","_id":"first","_source":{"n":9007199254740993,"status":"ready"},'
        + (runtime ? '"fields":{"n":[9007199254740995]},' : '') + '"sort":[1]},'
        + '{"_index":"events","_id":"second","_source":{"n":2,"status":"other"},"sort":[2]}]}}',
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({ ...request, endpoint: endpoint(request.connectionId), pitId: 'fixture-pit' })),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  const mount = () => render(<I18nextProvider i18n={i18n}><App service={{ ...storage, kind: 'desktop' }} initial={initial}
    queryBackend={backend} workspaceRecoveryService={recovery} queryLibraryService={library} dataViewService={dataViews} /></I18nextProvider>);
  const saved = () => waitFor(() => expect(screen.getByText('Workspace saved')).toBeVisible());
  const clickCell = (text: string, field: string) =>
    fireEvent.click(within(screen.getByText(text).closest('td')!).getByRole('button', { name: `Filter ${field}` }));
  return { a, b, query, backend, recovery, library, mount, saved, clickCell, user: userEvent.setup() };
}
const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add to pending filters' }));
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview filtered DSL' }));
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply filters to draft' }));
const any = (label: string) => fireEvent.click(within(screen.getByRole('radiogroup', { name: label })).getByRole('radio', { name: 'Any (OR)' }));
async function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Check field capabilities' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeEnabled());
}

describe('cell filters in the workspace', () => {
  it('preserves pending state across settings and connections, applies exact originals without executing, and restores only applied DSL', async () => {
    const f = await fixture(true);
    const mounted = f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('9,007,199,254,740,993');
    const executed = f.backend.execute.mock.calls[0]![0].rawDsl;
    f.clickCell('9,007,199,254,740,993', 'n');
    expect(screen.getByLabelText('Original JSON value')).toHaveValue('9007199254740993');
    await inspect();
    add();
    any('Group 1 operator');
    await f.user.keyboard('{Escape}');
    expect(screen.getByRole('group', { name: '1 pending filters' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await f.saved();
    expect((await f.recovery.load()).document.workspace!.tabs[0]!.document.dsl).toBe(f.query.dsl);
    await f.user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    await f.user.click(screen.getByRole('button', { name: 'Appearance' }));
    await f.user.click(screen.getByRole('button', { name: 'Dark' }));
    await f.user.click(screen.getByRole('button', { name: 'Back to query' }));
    await f.user.selectOptions(screen.getByLabelText('Active connection'), f.b.id);
    expect(screen.queryByRole('group', { name: '1 pending filters' })).not.toBeInTheDocument();
    await f.user.selectOptions(screen.getByLabelText('Active connection'), f.a.id);
    await f.user.click(screen.getByRole('tab', { name: 'Filter draft' }));
    expect(screen.getByRole('group', { name: '1 pending filters' })).toBeVisible();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByRole('group', { name: '1 项待应用筛选' })).toBeVisible();
    await act(async () => { await i18n.changeLanguage('en-US'); });
    fireEvent.click(screen.getByRole('button', { name: 'Review pending filters' }));
    expect(within(screen.getByRole('radiogroup', { name: 'Group 1 operator' })).getByRole('radio', { name: 'Any (OR)' })).toBeChecked();
    preview();
    const final = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    expect(final).toContain('"n": 9007199254740993');
    apply();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(screen.queryByRole('group', { name: '1 pending filters' })).not.toBeInTheDocument();
    expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run query' })).toBeEnabled();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    expect(f.backend.execute.mock.calls[0]![0].rawDsl).toBe(executed);
    await f.saved();
    const stored = (await f.recovery.load()).document;
    const updated = stored.workspace!.tabs[0]!.document;
    expect(updated.timeRange).toEqual(f.query.timeRange);
    expect(updated).not.toHaveProperty('filters');
    expect(updated).not.toHaveProperty('composition');
    expect(stored.history[0]!.snapshot.rawDsl).toBe(executed);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await f.library.load()).entries[0]?.dsl).toBe(final));
    mounted.unmount();
    f.mount();
    await f.saved();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(screen.getByRole('group', { name: 'Managed time' })).toBeVisible();
    expect(screen.queryByRole('group', { name: '1 pending filters' })).not.toBeInTheDocument();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
  });

  it('creates a filtered query from a locked index without changing the index tab or running it', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    fireEvent.click(await screen.findByRole('button', { name: 'events' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    f.clickCell('ready', 'status');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeEnabled());
    add();
    any('Group 1 operator');
    preview();
    const final = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole('button', { name: 'Open filtered query' }));
    expect(screen.getByLabelText('Query DSL')).toHaveValue(final);
    expect(screen.getByLabelText('Index or pattern')).toHaveValue('events');
    expect(screen.getByRole('heading', { name: i18n.t('query:noResults') })).toBeVisible();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.saved();
    const tabs = (await f.recovery.load()).document.workspace!.tabs;
    expect(tabs.find((tab) => tab.kind === 'index')!.document.dsl).toBe(DATA_PREVIEW_DSL);
    expect(tabs.at(-1)!.document).toMatchObject({ index: 'events', connectionId: f.a.id, dsl: final });
    await f.user.click(screen.getByRole('tab', { name: 'events (Alpha)' }));
    expect(screen.getByText('ready', { selector: '.rg-cell' })).toBeVisible();
    expect(screen.queryByLabelText('Index or pattern')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '1 pending filters' })).not.toBeInTheDocument();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
  });

  it('uses runtime fields instead of formatted values or old _source and rejects changed scripts', async () => {
    const f = await fixture(false, true);
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('["9,007,199,254,740,995"]');
    f.clickCell('["9,007,199,254,740,995"]', 'n');
    expect(screen.getByLabelText('Original JSON value')).toHaveValue('9007199254740995');
    expect(screen.getByText(enQueryFilters.runtimeBoundary)).toBeVisible();
    add();
    preview();
    const final = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    expect(final).toContain('"n": 9007199254740995');
    apply();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Query DSL'), { target: { value: final.replace('emit(9007199254740995L)', 'emit(2L)') } });
    f.clickCell('["9,007,199,254,740,995"]', 'n');
    expect(screen.getByText(enQueryFilters.runtimeChanged)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeDisabled();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.user.keyboard('{Escape}');
    await f.saved();
  });

  it('keeps changed-target pending filters inert, discards them explicitly, and does not restore session-only entries', async () => {
    const f = await fixture();
    const mounted = f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    f.clickCell('ready', 'status');
    await inspect();
    add();
    await f.user.keyboard('{Escape}');
    fireEvent.change(screen.getByLabelText('Index or pattern'), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review pending filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.draftChanged);
    expect(screen.getByRole('button', { name: 'Apply filters to draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard pending filters' }));
    f.clickCell('ready', 'status');
    expect(screen.getByText(enQueryFilters.targetChanged)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeDisabled();
    await f.user.keyboard('{Escape}');
    fireEvent.change(screen.getByLabelText('Index or pattern'), { target: { value: 'events' } });
    f.clickCell('ready', 'status');
    add();
    await f.user.keyboard('{Escape}');
    await f.saved();
    mounted.unmount();
    f.mount();
    await f.saved();
    expect(screen.queryByRole('group', { name: '1 pending filters' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
  });

  it('accumulates independently selected values from the same partial execution without changing the result', async () => {
    const f = await fixture();
    const original = f.backend.execute.getMockImplementation()!;
    f.backend.execute.mockImplementation(async (request) => ({ ...await original(request), partial: true }));
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('9,007,199,254,740,993');
    f.clickCell('9,007,199,254,740,993', 'n');
    await inspect();
    add();
    await f.user.keyboard('{Escape}');
    f.clickCell('other', 'status');
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'exclude' } });
    add();
    expect(screen.getByRole('list', { name: '2 pending filters' })).toBeVisible();
    preview();
    const final = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    expect(final).toContain('"n": 9007199254740993');
    expect(final).toContain('"status": "other"');
    expect(final).toContain('"must_not"');
    apply();
    expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
    expect(screen.getByText('other', { selector: '.rg-cell' })).toBeVisible();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.saved();
    expect((await f.recovery.load()).document.history[0]!.status).toBe('partial');
  });

  it('confirms discarding pending index filters on close and never attaches them to the reopened index', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    fireEvent.click(await screen.findByRole('button', { name: 'events' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    f.clickCell('ready', 'status');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeEnabled());
    add();
    await f.user.keyboard('{Escape}');
    expect(screen.getByRole('tab', { name: 'events (Alpha)' }).querySelector('.draft-dot')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh index' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh index' })).toHaveAttribute('title', enQueryFilters.pendingAction);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh index' }));
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('queryLive:closeIndex', { index: 'events', connection: 'Alpha' }) }));
    const confirmation = screen.getByRole('dialog', { name: i18n.t('query:closeTitle') });
    expect(confirmation).toHaveTextContent('events');
    fireEvent.click(within(confirmation).getByRole('button', { name: i18n.t('query:discard') }));
    expect(screen.queryByRole('tab', { name: 'events (Alpha)' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'events' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    expect(screen.queryByRole('group', { name: '1 pending filters' })).not.toBeInTheDocument();
    expect(f.backend.execute).toHaveBeenCalledTimes(2);
    expect(f.backend.execute.mock.calls[1]![0].rawDsl).toBe(DATA_PREVIEW_DSL);
    await f.saved();
  });

  it('cannot apply pending filters over an invalid visual draft whose raw DSL has not changed', async () => {
    const f = await fixture();
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('ready', { selector: '.rg-cell' });
    f.clickCell('ready', 'status');
    await inspect();
    add();
    any('Group 1 operator');
    await f.user.keyboard('{Escape}');
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'not-a-number' } });
    expect(screen.getByLabelText('Value 1')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    fireEvent.click(screen.getByRole('button', { name: 'Review pending filters' }));
    preview();
    expect(screen.getByRole('button', { name: 'Apply filters to draft' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryFilters.draftChanged);
    await f.user.keyboard('{Escape}');
    expect(screen.getByLabelText('Value 1')).toHaveValue('not-a-number');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(f.query.dsl);
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.saved();
  });

  it('applies two groups only after review, preserves time and sort, and keeps the old PIT unchanged', async () => {
    const f = await fixture(true, false, true);
    f.mount();
    await f.saved();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await screen.findByText('9,007,199,254,740,993');
    const executed = f.backend.execute.mock.calls[0]![0].rawDsl;
    f.clickCell('9,007,199,254,740,993', 'n');
    await inspect();
    add();
    await f.user.keyboard('{Escape}');
    f.clickCell('other', 'status');
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'exclude' } });
    fireEvent.change(screen.getByLabelText('Add to group'), { target: { value: 'new' } });
    add();
    any('Between groups');
    preview();
    const reviewed = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
    await f.user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Run query' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Server sort' })).toBeDisabled();
    await f.user.keyboard('{Control>}{Enter}{/Control}');
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    await f.saved();
    expect((await f.recovery.load()).document.workspace!.tabs[0]!.document.dsl).toBe(f.query.dsl);
    fireEvent.click(screen.getByRole('button', { name: 'Review pending filters' }));
    expect(screen.getByRole('button', { name: 'Apply filters to draft' })).toBeDisabled();
    expect(within(screen.getByRole('radiogroup', { name: 'Between groups' })).getByRole('radio', { name: 'Any (OR)' })).toBeChecked();
    preview();
    apply();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(reviewed);
    expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(reviewed).sort).toEqual(JSON.parse(f.query.dsl).sort);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(2));
    expect(f.backend.execute.mock.calls[1]![0]).toMatchObject({ rawDsl: executed, searchAfter: '[2]' });
    expect(f.backend.openPit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run query' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(3));
    const rerun = f.backend.execute.mock.calls[2]![0];
    expect(JSON.parse(rerun.rawDsl).query.bool.must).toEqual(JSON.parse(reviewed).query.bool.must);
    expect(JSON.parse(rerun.rawDsl).sort).toEqual(JSON.parse(reviewed).sort);
    expect(rerun.rawDsl).toContain('9007199254740993');
    expect(rerun).not.toHaveProperty('composition');
    expect(f.backend.openPit).toHaveBeenCalledTimes(2);
    await f.saved();
    const stored = (await f.recovery.load()).document;
    expect(stored.workspace!.tabs[0]!.document).toMatchObject({ dsl: reviewed, timeRange: f.query.timeRange });
    expect(stored.workspace!.tabs[0]!.document).not.toHaveProperty('composition');
    expect(stored.history.find((entry) => entry.kind === 'continuation')!.snapshot.rawDsl).toBe(executed);
  });
});

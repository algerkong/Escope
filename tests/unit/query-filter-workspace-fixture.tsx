import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { expect, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createWorkspace } from '../../src/domain/query';
import { selectDataView } from '../../src/domain/data-views';
import type { PinnedFilterDefinition } from '../../src/domain/pinned-filters';
import { previewTimeRange } from '../../src/domain/query-time-range';
import { recoveryWorkspace } from '../../src/domain/workspace-recovery';
import { i18n } from '../../src/locales';
import { createSessionDataViewService } from '../../src/services/data-views';
import { createSessionPinnedFilterService } from '../../src/services/pinned-filters';
import type { QueryBackend, QueryRequest, ResourceRequest, PitOpenRequest } from '../../src/services/ipc';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionStorage } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

export async function fixture(timed = false, runtime = false, paged = false, parameterized = false) {
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
  if (parameterized) query.parameters = { version: 1, template: '{"query":{"term":{"status":{"$param":"status"}}}}',
    definitions: [{ name: 'status', type: 'string' }] };
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
  const pinned = createSessionPinnedFilterService();
  const initial = await storage.load();
  initial.preferences.locale = 'en-US';
  const endpoint = (id: string) => id === a.id ? a.endpoint : b.endpoint;
  const backend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: endpoint(request.connectionId), rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"events","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : request.resource === 'mapping'
          ? '{"events":{"mappings":{"properties":{"comments":{"type":"nested","properties":{"author":{"type":"keyword"},"n":{"type":"long"}}}}}}}'
          : '{"indices":["events"],"fields":{"n":{"long":{"searchable":true}},"status":{"keyword":{"searchable":true}},"date":{"date":{"searchable":true}},"comments.author":{"keyword":{"searchable":true}},"comments.n":{"long":{"searchable":true}}}}',
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
    queryBackend={backend} workspaceRecoveryService={recovery} queryLibraryService={library} dataViewService={dataViews}
    pinnedFilterService={pinned} /></I18nextProvider>);
  const saved = () => waitFor(() => expect(screen.getByText('Workspace saved')).toBeVisible());
  const clickCell = (text: string, field: string) =>
    fireEvent.click(within(screen.getByText(text).closest('td')!).getByRole('button', { name: `Filter ${field}` }));
  return { a, b, query, backend, recovery, library, pinned, mount, saved, clickCell, user: userEvent.setup() };
}

export const add = () => fireEvent.click(screen.getByRole('button', { name: 'Add to pending filters' }));
export function savedFilterSet(connectionId: string): PinnedFilterDefinition {
  return { id: 'saved', name: 'Saved set', connectionId, index: 'events',
    filters: [
      { id: 'n', field: 'n', fieldType: 'long', operation: 'include', value: '9007199254740993', enabled: true },
      { id: 'status', field: 'status', fieldType: 'keyword', operation: 'exclude', value: '"other"', enabled: false },
    ], composition: { mode: 'any', groups: [{ id: 'g', mode: 'any', filterIds: ['n', 'status'] }] } };
}
export const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Preview filtered DSL' }));
export const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply filters to draft' }));
export async function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Check field capabilities' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add to pending filters' })).toBeEnabled());
}
export async function applyStatusFilter(f: Awaited<ReturnType<typeof fixture>>) {
  fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
  await screen.findByText('ready', { selector: '.rg-cell' });
  f.clickCell('ready', 'status');
  await inspect();
  add();
  preview();
  const final = (screen.getByLabelText('Final filtered DSL') as HTMLTextAreaElement).value;
  apply();
  return final;
}

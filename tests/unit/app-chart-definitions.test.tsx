import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createWorkspace } from '../../src/domain/query';
import { recoveryWorkspace } from '../../src/domain/workspace-recovery';
import { i18n } from '../../src/locales';
import { enChartDefinitions } from '../../src/locales/chart-definitions';
import { enQueryAggregationBuild } from '../../src/locales/query-aggregation-build';
import type { PitOpenRequest, QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';
import { createSessionChartDefinitionService, type ChartDefinitionService } from '../../src/services/chart-definitions';
import { createSessionDataViewService } from '../../src/services/data-views';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionStorage, type StorageService } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

async function context(supplied?: ChartDefinitionService) {
  await i18n.changeLanguage('en-US');
  const storage = createSessionStorage();
  const a = await storage.saveConnection({ displayName: 'Alpha', endpoint: 'https://a.test', environment: 'development' });
  await storage.selectConnection(a.id);
  const workspace = createWorkspace(a.id);
  const query = workspace.tabs[0]!.document;
  query.name = 'Chart draft';
  query.index = 'events';
  query.dsl = '{"query":{"term":{"original":9007199254740993}},"sort":[{"n":"desc"}],"size":25}';
  workspace.activeTabId = query.id;
  const recovery = { ...createSessionWorkspaceRecoveryService(), kind: 'desktop' as const };
  await recovery.save(0, { version: 1, workspace: recoveryWorkspace(workspace), history: [] });
  const library = createSessionQueryLibraryService();
  const dataViews = createSessionDataViewService();
  const service = supplied ?? createSessionChartDefinitionService();
  const backend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: a.endpoint, rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"events","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : '{"indices":["events"],"fields":{"n":{"long":{"searchable":true,"aggregatable":true}},'
          + '"host":{"keyword":{"searchable":true,"aggregatable":true}},"bytes":{"long":{"searchable":true,"aggregatable":true}}}}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({
      ...request, endpoint: a.endpoint, pitId: request.pitId ?? null, partial: false,
      rawResponse: '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":1,"relation":"eq"},'
        + '"hits":[{"_index":"events","_id":"first","_source":{"n":1}}]}}',
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({ ...request, endpoint: a.endpoint, pitId: 'fixture-pit' })),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  // A remount reads the store again, the way a real app start does, so deleted connections are gone.
  const app = (state: Awaited<ReturnType<StorageService['load']>>): ReactElement => (
    <I18nextProvider i18n={i18n}><App initial={state} service={{ ...storage, kind: 'desktop' } as StorageService}
      queryBackend={backend} workspaceRecoveryService={recovery} queryLibraryService={library} dataViewService={dataViews}
      chartDefinitionService={service} /></I18nextProvider>);
  return { connectionId: a.id, storage, backend, service, mount: async () => {
    const fresh = await storage.load();
    fresh.preferences.locale = 'en-US';
    const view = render(app(fresh));
    await waitFor(() => expect(screen.getByText('Workspace saved')).toBeVisible());
    return () => view.unmount();
  } };
}

const dsl = () => (screen.getByLabelText('Query DSL') as HTMLTextAreaElement).value;
const saveButton = () => screen.getByRole('button', { name: enChartDefinitions.saveAction });
const reuse = (row: HTMLElement) => within(row).getByRole('button', { name: enChartDefinitions.reuse });

/** Terms grouping over `host` plus one metric, saved under `name` and then closed. */
async function buildAndSave(name: string) {
  fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.open }));
  fireEvent.change(screen.getByLabelText(enQueryAggregationBuild.groupType), { target: { value: 'terms' } });
  fireEvent.change(screen.getByLabelText(enQueryAggregationBuild.groupField), { target: { value: 'host' } });
  fireEvent.click(screen.getByLabelText(enQueryAggregationBuild.inspect));
  await screen.findByText('keyword (Field capabilities)');
  fireEvent.click(screen.getByText(enChartDefinitions.saveTitle));
  fireEvent.change(screen.getByLabelText(enChartDefinitions.saveName), { target: { value: name } });
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());
  await screen.findByText(enChartDefinitions.saved);
}

describe('chart definitions in the query workspace', () => {
  it('saves a build as a definition without executing and applies only on an explicit review', async () => {
    const ctx = await context();
    const unmount = await ctx.mount();
    const executed = ctx.backend.execute.mock.calls.length;
    await buildAndSave('Top hosts');
    expect(ctx.backend.execute).toHaveBeenCalledTimes(executed);
    expect(ctx.backend.openPit).not.toHaveBeenCalled();
    // Saving a definition did not touch the draft: the reviewed DSL is still to be applied.
    expect(dsl()).not.toContain('"aggs"');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.open }));
    await screen.findByText('Top hosts');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(reuse(screen.getAllByRole('listitem')[0]!));

    expect(screen.getByLabelText(enQueryAggregationBuild.groupField)).toHaveValue('host');
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.preview }));
    const reviewed = (screen.getByLabelText(enQueryAggregationBuild.finalDsl) as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.apply }));
    expect(dsl()).toBe(reviewed);
    expect(JSON.parse(dsl()).aggs).toEqual({ by_host: { terms: { field: 'host' } } });
    expect(dsl()).toContain('9007199254740993');
    expect(ctx.backend.execute).toHaveBeenCalledTimes(executed);
    expect(ctx.backend.openPit).not.toHaveBeenCalled();
    expect((await ctx.service.load()).library.entries).toHaveLength(1);
    unmount();
  });

  it('keeps definitions across a restart, runs nothing on restore, and unbinds a deleted connection', async () => {
    const ctx = await context();
    const firstUnmount = await ctx.mount();
    await buildAndSave('Kept shape');
    expect(ctx.backend.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    firstUnmount();

    const secondUnmount = await ctx.mount();
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.open }));
    await screen.findByText('Kept shape');
    expect(ctx.backend.execute).not.toHaveBeenCalled();
    expect(ctx.backend.openPit).not.toHaveBeenCalled();
    // The restored draft is the stored text: a restart neither reformats it nor applies the definition.
    expect(dsl()).toContain('"sort":[{"n":"desc"}]');
    expect(dsl()).not.toContain('"aggs"');

    // Deleting the connection keeps the definition and its historical identity, unbound and unusable.
    await ctx.storage.deleteConnection(ctx.connectionId);
    secondUnmount();
    const thirdUnmount = await ctx.mount();
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.open }));
    await screen.findByText('Kept shape');
    const row = screen.getAllByRole('listitem')[0]!;
    expect(within(row).getByText(`${i18n.t('removedConnection')}: events`)).toBeVisible();
    expect(reuse(row)).toBeDisabled();
    expect((await ctx.service.load()).library.entries[0]!.connectionId).toBe(ctx.connectionId);
    expect(ctx.backend.execute).not.toHaveBeenCalled();
    thirdUnmount();
  });
});

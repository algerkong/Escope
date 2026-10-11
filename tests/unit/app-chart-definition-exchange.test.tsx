import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { readFileSync } from 'node:fs';
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
import { createSessionChartDefinitionExchangeService, type ChartDefinitionExchangeService } from '../../src/services/chart-definition-exchange';
import { parseChartDefinitionExchangeText } from '../../src/domain/chart-definition-exchange';
import { createSessionDataViewService } from '../../src/services/data-views';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionStorage, type StorageService } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

const bundleText = readFileSync('tests/fixtures/chart-definition-exchange-v1.json', 'utf8');
const mapLabel = (label: string, key: string) => enChartDefinitions.exchangeMapTarget.replace('{{label}}', label).replace('{{key}}', key);

async function context(service: ChartDefinitionService, readFile: ChartDefinitionExchangeService['readFile']) {
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
  // jsdom has no File.arrayBuffer and no native picker, so only the file read is a seam here.
  const exchange = { ...createSessionChartDefinitionExchangeService(service), readFile };
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
  const app = (state: Awaited<ReturnType<StorageService['load']>>): ReactElement => (
    <I18nextProvider i18n={i18n}><App initial={state} service={{ ...storage, kind: 'desktop' } as StorageService}
      queryBackend={backend} workspaceRecoveryService={recovery} queryLibraryService={createSessionQueryLibraryService()}
      dataViewService={createSessionDataViewService()} chartDefinitionService={service} chartExchangeService={exchange} /></I18nextProvider>);
  return { connectionId: a.id, storage, backend, mount: async () => {
    const fresh = await storage.load();
    fresh.preferences.locale = 'en-US';
    const view = render(app(fresh));
    await waitFor(() => expect(screen.getByText('Workspace saved')).toBeVisible());
    return () => view.unmount();
  } };
}

const dsl = () => (screen.getByLabelText('Query DSL') as HTMLTextAreaElement).value;
const saveButton = () => screen.getByRole('button', { name: enChartDefinitions.saveAction });
const rows = () => screen.getAllByRole('listitem');
const previewBox = () => screen.getByLabelText(enChartDefinitions.exchangeReviewDocument) as HTMLTextAreaElement;
const chooseFile = async (text: string) => {
  const input = await waitFor(() => {
    const element = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    if (!element) throw new Error('the import view has not mounted yet');
    return element;
  });
  fireEvent.change(input, { target: { files: [new File([text], 'definitions.json', { type: 'application/json' })] } });
};

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
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
}

const loadedReadFile = () => vi.fn<ChartDefinitionExchangeService['readFile']>(async () => ({
  status: 'loaded', bundle: parseChartDefinitionExchangeText(bundleText),
}));

describe('chart definition exchange in the query workspace', () => {
  it('exports a saved definition as a reviewable document and runs nothing', async () => {
    const service = createSessionChartDefinitionService();
    const ctx = await context(service, loadedReadFile());
    const unmount = await ctx.mount();
    const executed = ctx.backend.execute.mock.calls.length;
    await buildAndSave('Top hosts');
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.open }));
    await screen.findByText('Top hosts');
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.exportDefinitions }));
    await screen.findByText(enChartDefinitions.exportDefinitions);
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeSelectAll }));
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.exchangePreview }));
    await waitFor(() => expect(previewBox().value).toContain('escope-chart-definitions'));
    expect(previewBox().value).toContain('"index": "events"');
    expect(previewBox().value).toContain('"type": "terms"');
    expect(previewBox().value).toContain('"field": "host"');
    for (const absent of [ctx.connectionId, 'https://a.test', 'endpoint', 'credentialRef', 'dsl', 'results']) {
      expect(previewBox().value).not.toContain(absent);
    }
    const save = screen.getByRole('button', { name: enChartDefinitions.exchangeSaveAction });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeReviewed }));
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeDownloadRequested)).toBeVisible());
    // Exporting neither executed anything nor changed the stored definition.
    expect(ctx.backend.execute).toHaveBeenCalledTimes(executed);
    expect(ctx.backend.openPit).not.toHaveBeenCalled();
    expect((await service.load()).library.entries.map(({ name }) => name)).toEqual(['Top hosts']);
    unmount();
  });

  it('imports definitions without executing, then applies them only through an explicit reuse and review', async () => {
    const service = createSessionChartDefinitionService();
    const ctx = await context(service, loadedReadFile());
    const unmount = await ctx.mount();
    const executed = ctx.backend.execute.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.open }));
    await waitFor(() => expect(screen.getByText(enChartDefinitions.empty)).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.importDefinitions }));
    await screen.findByText(enChartDefinitions.importDefinitions);
    await chooseFile(bundleText);
    const importAction = screen.getByRole('button', { name: /Import \d+ new definitions/ });
    expect(importAction).toBeDisabled();
    fireEvent.change(await screen.findByLabelText(mapLabel('Fixture source', 'connection-1')), { target: { value: ctx.connectionId } });
    fireEvent.change(await screen.findByLabelText(mapLabel('实验室 观察', 'connection-2')), { target: { value: ctx.connectionId } });
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeMapped }));
    expect(importAction).toBeEnabled();
    fireEvent.click(importAction);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.sessionImported)).toBeVisible());
    expect(ctx.backend.execute).toHaveBeenCalledTimes(executed);
    expect(ctx.backend.openPit).not.toHaveBeenCalled();
    const entries = (await service.load()).library.entries;
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.connectionId === ctx.connectionId)).toBe(true);
    expect(ctx.backend.execute).toHaveBeenCalledTimes(executed);
    // Returning to the panel shows the imported rows; the draft is still the untouched original.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    await screen.findByText('Average bytes');
    expect(rows()).toHaveLength(3);
    expect(dsl()).not.toContain('"aggs"');
    // Only the row whose target matches this tab offers reuse: 'events' on this connection.
    const target = rows().find((row) => row.textContent?.includes('events'));
    expect(target).toBeDefined();
    fireEvent.click(within(target!).getByRole('button', { name: enChartDefinitions.reuse }));
    expect(ctx.backend.execute).toHaveBeenCalledTimes(executed);
    expect(screen.getByLabelText(enQueryAggregationBuild.groupField)).toHaveValue('host');
    // The reuse seeded the rows but not the evidence: the field check still runs against this tab.
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.inspect }));
    await screen.findByText('keyword (Field capabilities)');
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.preview }));
    const reviewed = (screen.getByLabelText(enQueryAggregationBuild.finalDsl) as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.apply }));
    expect(dsl()).toBe(reviewed);
    expect(JSON.parse(dsl()).aggs).toEqual({ by_host: { terms: { field: 'host', size: 20 } } });
    expect(dsl()).toContain('9007199254740993');
    // Applying the reviewed DSL still does not run a query: only an explicit run would.
    expect(ctx.backend.execute).toHaveBeenCalledTimes(executed);
    expect(ctx.backend.openPit).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps imported definitions across a restart and unbinds a deleted connection', async () => {
    const service = createSessionChartDefinitionService();
    const ctx = await context(service, loadedReadFile());
    const unmount = await ctx.mount();
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.open }));
    await screen.findByText(enChartDefinitions.empty);
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.importDefinitions }));
    await chooseFile(bundleText);
    fireEvent.change(await screen.findByLabelText(mapLabel('Fixture source', 'connection-1')), { target: { value: ctx.connectionId } });
    fireEvent.change(await screen.findByLabelText(mapLabel('实验室 观察', 'connection-2')), { target: { value: ctx.connectionId } });
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeMapped }));
    fireEvent.click(screen.getByRole('button', { name: /Import \d+ new definitions/ }));
    await waitFor(() => expect(screen.getByText(enChartDefinitions.sessionImported)).toBeVisible());
    unmount();

    const secondUnmount = await ctx.mount();
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.open }));
    await screen.findByText('Average bytes');
    // Restoring shows the imported rows again: nothing was executed to bring them back.
    expect(ctx.backend.execute).not.toHaveBeenCalled();
    expect(ctx.backend.openPit).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(3);
    secondUnmount();

    await ctx.storage.deleteConnection(ctx.connectionId);
    const thirdUnmount = await ctx.mount();
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.open }));
    await screen.findByText('Average bytes');
    const removed = i18n.t('removedConnection');
    expect(within(rows()[0]!).getByText(`${removed}: logs-*`)).toBeVisible();
    expect(within(rows()[0]!).getByRole('button', { name: enChartDefinitions.reuse })).toBeDisabled();
    expect((await service.load()).library.entries.every((entry) => entry.connectionId === ctx.connectionId)).toBe(true);
    expect(ctx.backend.execute).not.toHaveBeenCalled();
    thirdUnmount();
  });
});

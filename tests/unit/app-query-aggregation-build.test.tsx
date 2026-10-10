import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createWorkspace } from '../../src/domain/query';
import { previewTimeRange } from '../../src/domain/query-time-range';
import { recoveryWorkspace } from '../../src/domain/workspace-recovery';
import { i18n } from '../../src/locales';
import { enQueryAggregationBuild } from '../../src/locales/query-aggregation-build';
import type { PitOpenRequest, QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionStorage } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

async function fixture(timed = false) {
  await i18n.changeLanguage('en-US');
  const storage = createSessionStorage();
  const a = await storage.saveConnection({ displayName: 'Alpha', endpoint: 'https://a.test', environment: 'development' });
  await storage.selectConnection(a.id);
  const workspace = createWorkspace(a.id);
  const query = workspace.tabs[0]!.document;
  query.name = 'Aggregation draft';
  query.index = 'events';
  query.dsl = '{"query":{"term":{"original":9007199254740993}},"sort":[{"n":"desc"}],"size":25}';
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
  const backend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: a.endpoint, rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"events","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : '{"indices":["events"],"fields":{"n":{"long":{"searchable":true,"aggregatable":true}},'
          + '"date":{"date":{"searchable":true,"aggregatable":true}},"k":{"keyword":{"searchable":true,"aggregatable":true}}}}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({
      ...request, endpoint: a.endpoint, pitId: request.pitId ?? null, partial: false,
      rawResponse: '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"hits":{"total":{"value":1,"relation":"eq"},'
        + '"hits":[{"_index":"events","_id":"first","_source":{"n":9007199254740993}}]}}',
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({ ...request, endpoint: a.endpoint, pitId: 'fixture-pit' })),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  const mount = () => render(<I18nextProvider i18n={i18n}><App initial={initial} service={{ ...storage, kind: 'desktop' }}
    queryBackend={backend} workspaceRecoveryService={recovery} queryLibraryService={library} /></I18nextProvider>);
  await mount();
  await waitFor(() => expect(screen.getByText('Workspace saved')).toBeVisible());
  return { a, query, backend, user: userEvent.setup() };
}
const open = () => fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.open }));
const preview = () => fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.preview }));
const apply = () => screen.getByRole('button', { name: enQueryAggregationBuild.apply });
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const final = () => (screen.getByLabelText(enQueryAggregationBuild.finalDsl) as HTMLTextAreaElement).value;
const dsl = () => (screen.getByLabelText('Query DSL') as HTMLTextAreaElement).value;

describe('aggregation build in the workspace', () => {
  it('reviews a group with metrics and writes only the drafted DSL, without running or opening a PIT', async () => {
    const { backend, query } = await fixture();
    const executed = backend.execute.mock.calls.length;
    open();
    expect(screen.queryByRole('alert')).toBeNull();
    change(enQueryAggregationBuild.groupType, 'terms');
    change(enQueryAggregationBuild.groupField, 'k');
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.add }));
    change('Metric name 1', 'total');
    change('Metric field 1', 'n');
    expect(apply()).toBeDisabled();
    fireEvent.click(screen.getByLabelText(enQueryAggregationBuild.inspect));
    await screen.findByText('keyword (Field capabilities)');
    preview();
    const reviewed = final();
    expect(reviewed).toContain('"by_host"');
    expect(reviewed).toContain('"terms"');
    expect(reviewed).toContain('"total": {');
    expect(reviewed).toContain('"original": 9007199254740993');
    expect(reviewed).toContain('"sort": [');
    // An open review keeps the old results and blocks running or saving the pre-build DSL.
    // The modal marks the background inert, so these reachable-only-by-name queries need hidden.
    const run = () => screen.getByRole('button', { name: 'Run query', hidden: true });
    expect(run()).toHaveAttribute('title', enQueryAggregationBuild.reviewOpen);
    expect(run()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft', hidden: true })).toBeDisabled();
    fireEvent.click(apply());
    expect(dsl()).toBe(reviewed);
    expect(JSON.parse(dsl()).aggs).toEqual({ by_host: { terms: { field: 'k' }, aggs: { total: { sum: { field: 'n' } } } } });
    expect(backend.execute).toHaveBeenCalledTimes(executed);
    expect(backend.openPit).not.toHaveBeenCalled();
    expect(query.dsl).toBe('{"query":{"term":{"original":9007199254740993}},"sort":[{"n":"desc"}],"size":25}');
    await waitFor(() => expect(run()).toBeEnabled());
    // A second review seeds from the applied block, so re-applying the same build changes nothing.
    open();
    expect(screen.getByLabelText(enQueryAggregationBuild.groupField)).toHaveValue('k');
    expect(screen.getByLabelText('Metric name 1')).toHaveValue('total');
    preview();
    expect(screen.getByText(enQueryAggregationBuild.unchanged)).toBeVisible();
    expect(apply()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dsl()).toBe(reviewed);
    expect(backend.execute).toHaveBeenCalledTimes(executed);
  });

  it('keeps a managed time binding through an applied build without running', async () => {
    const { backend } = await fixture(true);
    open();
    change(enQueryAggregationBuild.groupType, 'date_histogram');
    expect(screen.getByLabelText(enQueryAggregationBuild.groupName)).toHaveValue('per_day');
    change(enQueryAggregationBuild.groupField, 'date');
    fireEvent.click(screen.getByLabelText(enQueryAggregationBuild.inspect));
    await screen.findByText('date (Field capabilities)');
    change(enQueryAggregationBuild.intervalValue, '30d');
    preview();
    const reviewed = final();
    expect(reviewed).toContain('"fixed_interval": "30d"');
    fireEvent.click(apply());
    expect(dsl()).toBe(reviewed);
    expect(screen.getByRole('group', { name: 'Managed time' })).toBeVisible();
    expect(JSON.parse(dsl()).aggs.per_day.date_histogram).toEqual({ field: 'date', fixed_interval: '30d' });
    expect(backend.execute).not.toHaveBeenCalled();
    expect(backend.openPit).not.toHaveBeenCalled();
  });

  it('keeps a handwritten aggregation verbatim and refuses to reuse its name', async () => {
    const handwritten = '{"p":{"percentiles":{"field":"n","tdigest":{"compression":200}}}}';
    const { backend } = await fixture();
    fireEvent.change(screen.getByLabelText('Query DSL'), { target: { value: `{"query":{"match_all":{}},"aggs":${handwritten},"size":5}` } });
    open();
    change(enQueryAggregationBuild.groupType, 'terms');
    change(enQueryAggregationBuild.groupField, 'k');
    fireEvent.click(screen.getByLabelText(enQueryAggregationBuild.inspect));
    await screen.findByText('keyword (Field capabilities)');
    preview();
    expect(final()).toContain('"percentiles"');
    change(enQueryAggregationBuild.groupName, 'p');
    preview();
    expect(screen.getByRole('alert')).toHaveTextContent(enQueryAggregationBuild.nameConflict);
    expect(apply()).toBeDisabled();
    change(enQueryAggregationBuild.groupName, 'by_host');
    preview();
    fireEvent.click(apply());
    expect(dsl()).toContain('"compression": 200');
    expect(dsl()).toContain('"by_host": {');
    expect(JSON.parse(dsl()).aggs).toMatchObject({
      by_host: { terms: { field: 'k' } }, p: { percentiles: { field: 'n', tdigest: { compression: 200 } } },
    });
    expect(backend.execute).not.toHaveBeenCalled();
  });
});

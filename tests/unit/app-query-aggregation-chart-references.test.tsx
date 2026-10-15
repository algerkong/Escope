import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { createWorkspace } from '../../src/domain/query';
import { recoveryWorkspace } from '../../src/domain/workspace-recovery';
import { i18n } from '../../src/locales';
import { enQueryAggregationCharts as text } from '../../src/locales/query-aggregation-charts';
import { createSessionChartDefinitionService } from '../../src/services/chart-definitions';
import { createSessionDataViewService } from '../../src/services/data-views';
import type { PitOpenRequest, QueryBackend, QueryRequest, ResourceRequest } from '../../src/services/ipc';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionStorage } from '../../src/services/storage';
import { createSessionWorkspaceRecoveryService } from '../../src/services/workspace-recovery';

const DSL = '{"size":0,"query":{"term":{"original":9007199254740993}},'
  + '"aggs":{"kinds":{"terms":{"field":"kind","size":5},"aggs":{"amount":{"sum":{"field":"amount"}}}}}}';

async function context() {
  await i18n.changeLanguage('en-US');
  const storage = createSessionStorage();
  const profile = await storage.saveConnection({ displayName: 'Fixture', endpoint: 'https://fixture.test', environment: 'development' });
  await storage.selectConnection(profile.id);
  const workspace = createWorkspace(profile.id);
  const query = workspace.tabs[0]!.document;
  query.name = 'Reference fixture';
  query.index = 'events';
  query.dsl = DSL;
  workspace.activeTabId = query.id;
  const memory = createSessionWorkspaceRecoveryService();
  await memory.save(0, { version: 1, workspace: recoveryWorkspace(workspace), history: [] });
  const recovery = { ...memory, kind: 'desktop' as const, save: vi.fn(memory.save) };
  const definitions = createSessionChartDefinitionService();
  const saveDefinition = vi.spyOn(definitions, 'save');
  const library = createSessionQueryLibraryService();
  const views = createSessionDataViewService();
  const backend = {
    available: true,
    readResource: vi.fn(async (request: ResourceRequest) => ({
      ...request, endpoint: profile.endpoint, rawResponse: request.resource === 'indices'
        ? '{"indices":[{"name":"events","attributes":["open"],"aliases":[]}],"aliases":[],"data_streams":[]}'
        : '{"indices":["events"],"fields":{"kind":{"keyword":{"searchable":true,"aggregatable":true}},'
          + '"amount":{"long":{"searchable":true,"aggregatable":true}}}}',
    })),
    execute: vi.fn(async (request: QueryRequest) => ({
      ...request, endpoint: profile.endpoint, pitId: request.pitId ?? null, partial: false,
      rawResponse: '{"took":1,"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},'
        + '"hits":{"total":0,"hits":[]},"aggregations":{"kinds":{"buckets":[{"key":"a","doc_count":10,"amount":{"value":100}}]}}}',
    })),
    cancel: vi.fn(async () => true),
    openPit: vi.fn(async (request: PitOpenRequest) => ({ ...request, endpoint: profile.endpoint, pitId: 'unchanged-pit' })),
    closePit: vi.fn(async () => {}),
  } satisfies QueryBackend;
  return {
    backend, recovery, definitions, saveDefinition, library,
    mount: async () => {
      const initial = await storage.load();
      initial.preferences.locale = 'en-US';
      const view = render(<I18nextProvider i18n={i18n}>
        <App initial={initial} service={{ ...storage, kind: 'desktop' }} queryBackend={backend}
          workspaceRecoveryService={recovery} queryLibraryService={library} dataViewService={views}
          chartDefinitionService={definitions} />
      </I18nextProvider>);
      await screen.findByText('Workspace saved');
      return view;
    },
  };
}

async function openChart() {
  fireEvent.click(await screen.findByRole('button', { name: 'Aggregations' }));
  fireEvent.click(screen.getByRole('button', { name: text.open }));
  await screen.findByRole('img', { name: /Bar chart/ });
}

function editor(raw: string) {
  fireEvent.click(screen.getByRole('button', { name: text.referenceAdd }));
  fireEvent.change(screen.getByRole('combobox', { name: text.referenceAxis }), { target: { value: 'left' } });
  fireEvent.change(screen.getByRole('textbox', { name: text.referenceValue }), { target: { value: raw } });
}

describe('reference lines in the real workspace component', () => {
  it('does not query, run through modified Enter, change DSL/PIT, or write any recovery/library definition', async () => {
    const f = await context();
    await f.mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await openChart();
    await waitFor(async () => expect((await f.recovery.load()).document.history).toHaveLength(1));
    const before = await f.recovery.load();
    const libraryBefore = await f.library.load();
    const definitionsBefore = await f.definitions.load();
    const methods = [f.backend.execute, f.backend.openPit, f.backend.closePit, f.backend.cancel, f.backend.readResource];
    const calls = methods.map((method) => method.mock.calls.length);
    f.recovery.save.mockClear();
    const request = JSON.stringify(f.backend.execute.mock.calls[0]);
    editor('7.000');
    const input = screen.getByRole('textbox', { name: text.referenceValue });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(methods.map((method) => method.mock.calls.length)).toEqual(calls);
    fireEvent.click(screen.getByRole('button', { name: text.referenceApply }));
    expect(screen.getByRole('listitem', { name: 'Reference 1' })).toHaveTextContent('7.000');
    fireEvent.click(screen.getByRole('button', { name: 'Edit reference line 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: text.referenceValue }), { target: { value: '8.000' } });
    fireEvent.click(screen.getByRole('button', { name: text.referenceCancel }));
    expect(screen.getByRole('listitem', { name: 'Reference 1' })).toHaveTextContent('7.000');
    expect(screen.getByLabelText('Query DSL')).toHaveValue(DSL);
    expect(methods.map((method) => method.mock.calls.length)).toEqual(calls);
    expect(JSON.stringify(f.backend.execute.mock.calls[0])).toBe(request);
    expect(f.recovery.save).not.toHaveBeenCalled();
    expect(f.saveDefinition).not.toHaveBeenCalled();
    expect(await f.recovery.load()).toEqual(before);
    expect(await f.library.load()).toEqual(libraryBefore);
    expect(await f.definitions.load()).toEqual(definitionsBefore);
    fireEvent.click(screen.getByRole('button', { name: 'Delete reference line 1' }));
    expect(methods.map((method) => method.mock.calls.length)).toEqual(calls);
    expect(f.recovery.save).not.toHaveBeenCalled();
  });

  it('clears references across settings and restart, while retaining the query and never re-executing on restore', async () => {
    const f = await context();
    const first = await f.mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    await openChart();
    editor('7.000');
    fireEvent.click(screen.getByRole('button', { name: text.referenceApply }));
    expect(screen.getByRole('listitem', { name: 'Reference 1' })).toBeVisible();
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to query' }));
    await openChart();
    expect(first.container.querySelector('.qac-reference-row')).toBeNull();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(DSL);
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    editor('9.000');
    fireEvent.click(screen.getByRole('button', { name: text.referenceApply }));
    await waitFor(async () => expect((await f.recovery.load()).document.history).toHaveLength(1));
    first.unmount();
    const second = await f.mount();
    expect(screen.getByLabelText('Query DSL')).toHaveValue(DSL);
    expect(second.container.querySelector('.qac-reference-row, .qac-reference-line')).toBeNull();
    expect(f.backend.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await f.recovery.load())).not.toMatch(/7\.000|9\.000|references|secondary/);
    expect(f.saveDefinition).not.toHaveBeenCalled();
  });
});

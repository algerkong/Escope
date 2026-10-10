import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/chart-definitions-v1.json';
import { QueryAggregationBuildDialog } from '../../src/features/query/QueryAggregationBuildDialog';
import { useChartDefinitions } from '../../src/features/query/useChartDefinitions';
import { createSessionChartDefinitionService, type ChartDefinitionService } from '../../src/services/chart-definitions';
import { freezeChartDefinitionSelection, parseChartDefinitionLibrary, selectChartDefinition, type ChartDefinition } from '../../src/domain/chart-definitions';
import { createQuery, type QueryDocument } from '../../src/domain/query';
import { parseFieldCaps, type FieldCatalog } from '../../src/domain/resource';
import type { Loadable } from '../../src/features/query/useQueryResources';
import { i18n } from '../../src/locales';
import { enChartDefinitions } from '../../src/locales/chart-definitions';
import { enQueryAggregationBuild } from '../../src/locales/query-aggregation-build';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });

const blank = createSessionChartDefinitionService();
const library = parseChartDefinitionLibrary(fixture);
if (!library) throw new Error('fixture');
const grouped = library.entries[0]!;
const flat = library.entries[2]!;
const parsed = parseFieldCaps('{"fields":{"bytes":{"long":{"searchable":true,"aggregatable":true}},'
  + '"host":{"keyword":{"searchable":true,"aggregatable":true}},"@timestamp":{"date":{"searchable":true,"aggregatable":true}},'
  + '"latency":{"double":{"searchable":true,"aggregatable":true}}}}');
if (!parsed.ok) throw new Error('fixture');
const ready: Loadable<FieldCatalog> = { status: 'ready', data: parsed.value };

/** Reuse only applies on the definition's own connection and target, so build that tab. */
const documentFor = (definition?: ChartDefinition, dsl = '{"query":{"match_all":{}},"size":25}'): QueryDocument => ({
  ...createQuery(definition?.connectionId ?? '11111111-1111-4111-8111-111111111111'),
  id: 'query', index: definition?.index ?? 'logs-*', dsl,
});
const seedOf = (definition: ChartDefinition) => freezeChartDefinitionSelection(selectChartDefinition(definition));

async function hydrate(entries: readonly ChartDefinition[]): Promise<ChartDefinitionService> {
  const service = createSessionChartDefinitionService();
  if (entries.length > 0) await service.save(0, { version: 1, entries });
  return service;
}

type Commit = Parameters<typeof QueryAggregationBuildDialog>[0]['onCommit'];
function Harness({ service = blank, source = documentFor(), seed, onCommit = vi.fn<() => boolean>(() => true) }: {
  service?: ChartDefinitionService; source?: QueryDocument; seed?: ReturnType<typeof seedOf>; onCommit?: Commit;
}) {
  const controller = useChartDefinitions(service);
  return <I18nextProvider i18n={i18n}><QueryAggregationBuildDialog source={source} current={source} endpoint="https://alpha.test"
    fields={ready} targetCurrent canInspect onInspect={vi.fn()} onCommit={onCommit} onClose={vi.fn()}
    definitions={controller} onSaveDefinition={(definition) => controller.save(definition)} seed={seed} /></I18nextProvider>;
}

const openSave = () => fireEvent.click(screen.getByText(enChartDefinitions.saveTitle));
const preview = () => fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.preview }));
const apply = () => screen.getByRole('button', { name: enQueryAggregationBuild.apply });
const saveButton = () => screen.getByRole('button', { name: enChartDefinitions.saveAction });
const nameInput = () => screen.getByLabelText(enChartDefinitions.saveName);
const measureSelect = () => screen.getByLabelText(enChartDefinitions.saveMeasure);
/** The library loads asynchronously, so an enabled save button is only meaningful once it answers. */
const saveReady = async () => { await waitFor(() => expect(saveButton()).toBeEnabled()); };

describe('saving a build as a chart definition', () => {
  it('stores the reviewed shape without touching the draft DSL or running anything', async () => {
    const service = await hydrate([]);
    const onCommit = vi.fn(() => true);
    render(<Harness service={service} onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText(enQueryAggregationBuild.groupType), { target: { value: 'terms' } });
    fireEvent.change(screen.getByLabelText(enQueryAggregationBuild.groupField), { target: { value: 'host' } });
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.add }));
    // A real edit to the stored shape makes the previous confirmation stale again.
    fireEvent.change(screen.getByLabelText('Metric field 1'), { target: { value: 'bytes' } });
    openSave();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(enChartDefinitions.saveNeedsName)).toBeVisible();
    fireEvent.change(nameInput(), { target: { value: 'Top hosts by bytes' } });
    await saveReady();
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText(enChartDefinitions.saved)).toBeVisible());
    const stored = (await service.load()).library.entries;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.name).toBe('Top hosts by bytes');
    expect(stored[0]!.connectionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(stored[0]!.index).toBe('logs-*');
    expect(stored[0]!.draft).toEqual({ group: { type: 'terms', name: 'by_host', field: 'host', size: '' },
      metrics: [{ name: 'metric1', type: 'sum', field: 'bytes' }] });
    expect(stored[0]!.measure).toBe('doc_count');
    // Saving a definition is not an apply: no reviewed DSL was produced and nothing was committed.
    expect(onCommit).not.toHaveBeenCalled();
    expect(() => screen.getByLabelText(enQueryAggregationBuild.finalDsl)).toThrow();
  });

  it('offers doc_count only when a grouping exists and follows the chosen measure', async () => {
    const service = await hydrate([]);
    render(<Harness service={service} source={documentFor(flat)} seed={seedOf(flat)} />);
    openSave();
    expect(screen.getByText(enChartDefinitions.seededFrom.replace('{{name}}', 'Average latency'))).toBeVisible();
    expect(within(measureSelect()).getAllByRole('option').map((option) => option.textContent)).toEqual(['average']);
    expect(nameInput()).toHaveValue('Average latency');
    await saveReady();
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText(enChartDefinitions.saved)).toBeVisible());
    const stored = (await service.load()).library.entries[0]!;
    expect(stored.measure).toBe('average');
    expect(stored.draft.group).toBeNull();
    expect(stored.index).toBe('metrics-*');
  });

  it('refuses to save an unbuildable rows set and keeps the library empty', async () => {
    const service = await hydrate([]);
    render(<Harness service={service} />);
    openSave();
    fireEvent.change(nameInput(), { target: { value: 'Nothing' } });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(enChartDefinitions.saveNeedsDraft)).toBeVisible();
    expect((await service.load()).library.entries).toHaveLength(0);
  });

  it('stops adding once the library holds the maximum number of definitions', async () => {
    const many: ChartDefinition[] = Array.from({ length: 100 }, (_, index) => ({
      ...flat, id: `chart-${index}`, name: `Chart ${index}`,
    }));
    const service = await hydrate(many);
    render(<Harness service={service} source={documentFor(flat)} seed={seedOf(flat)} />);
    openSave();
    // The cap only becomes visible once the library has answered with its stored rows.
    await waitFor(() => expect(screen.getByText(enChartDefinitions.limit.replace('{{count}}', '100'))).toBeVisible());
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect((await service.load()).library.entries).toHaveLength(100);
  });

  it('clears the saved note when the rows change after saving', async () => {
    const service = await hydrate([]);
    render(<Harness service={service} source={documentFor(flat)} seed={seedOf(flat)} />);
    openSave();
    await saveReady();
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText(enChartDefinitions.saved)).toBeVisible());
    fireEvent.change(screen.getByLabelText('Metric field 1'), { target: { value: 'bytes' } });
    expect(screen.queryByText(enChartDefinitions.saved)).toBeNull();
    expect((await service.load()).library.entries).toHaveLength(1);
  });

  it('applies the reused shape as a normal review without writing the definition again', async () => {
    const service = await hydrate([grouped]);
    const onCommit = vi.fn(() => true);
    render(<Harness service={service} onCommit={onCommit} seed={seedOf(grouped)} />);
    expect(screen.getByLabelText(enQueryAggregationBuild.groupField)).toHaveValue('@timestamp');
    expect(screen.getByLabelText('Metric name 1')).toHaveValue('total');
    expect(screen.getByLabelText('Metric name 3')).toHaveValue('hosts');
    // Reuse seeds rows only: applying still goes through the ordinary preview and commit path.
    preview();
    const text = (screen.getByLabelText(enQueryAggregationBuild.finalDsl) as HTMLTextAreaElement).value;
    expect(text).toContain('"per_day"');
    expect(text).toContain('"cardinality"');
    expect(text).toContain('"size": 25');
    fireEvent.click(apply());
    expect(onCommit).toHaveBeenCalledOnce();
    expect((await service.load()).library.entries).toEqual([grouped]);
  });

  it('names the real reason when only the tab target is unusable', async () => {
    const service = await hydrate([]);
    render(<Harness service={service} source={{ ...documentFor(), index: 'bad target' }} />);
    openSave();
    // Buildable rows plus a usable name, so the only refusal left is the target itself.
    fireEvent.change(screen.getByLabelText(enQueryAggregationBuild.groupType), { target: { value: 'terms' } });
    fireEvent.change(screen.getByLabelText(enQueryAggregationBuild.groupField), { target: { value: 'host' } });
    fireEvent.click(screen.getByRole('button', { name: enQueryAggregationBuild.add }));
    fireEvent.change(screen.getByLabelText('Metric field 1'), { target: { value: 'bytes' } });
    fireEvent.change(nameInput(), { target: { value: 'Bad target' } });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(enChartDefinitions.saveNeedsTarget)).toBeVisible();
    expect(screen.queryByText(enChartDefinitions.saveNeedsDraft)).toBeNull();
    expect((await service.load()).library.entries).toHaveLength(0);
  });

  it('ignores a reuse copy that names a different target and starts from the draft instead', () => {
    render(<Harness source={documentFor()} seed={seedOf(flat)} />);
    expect(screen.queryByText(enChartDefinitions.seededFrom.replace('{{name}}', 'Average latency'))).toBeNull();
    expect(screen.getByLabelText(enQueryAggregationBuild.groupType)).toHaveValue('none');
    openSave();
    expect(nameInput()).toHaveValue('');
  });
});

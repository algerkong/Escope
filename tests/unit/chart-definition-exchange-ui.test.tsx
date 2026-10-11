import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import definitionsFixture from '../fixtures/chart-definitions-v1.json';
import { ChartDefinitionExchangeDialog } from '../../src/features/query/ChartDefinitionExchangeDialog';
import { ChartDefinitionsDialog } from '../../src/features/query/ChartDefinitionsDialog';
import { useChartDefinitions } from '../../src/features/query/useChartDefinitions';
import { createSessionChartDefinitionService, type ChartDefinitionService } from '../../src/services/chart-definitions';
import { createSessionChartDefinitionExchangeService, type ChartDefinitionExchangeService } from '../../src/services/chart-definition-exchange';
import { parseChartDefinitionExchangeText } from '../../src/domain/chart-definition-exchange';
import { parseChartDefinitionLibrary, type ChartDefinition } from '../../src/domain/chart-definitions';
import type { ConnectionProfile } from '../../src/domain/connection';
import { i18n } from '../../src/locales';
import { enChartDefinitions, zhChartDefinitions } from '../../src/locales/chart-definitions';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });

const bundleText = readFileSync('tests/fixtures/chart-definition-exchange-v1.json', 'utf8');
const library = parseChartDefinitionLibrary(definitionsFixture);
if (!library) throw new Error('fixture');
const connection = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Alpha', endpoint: 'https://alpha.test' } as ConnectionProfile;
const other = { id: '22222222-2222-4222-8222-222222222222', displayName: 'Beta', endpoint: 'https://beta.test' } as ConnectionProfile;
// A stored single-value definition; the document carries another definition with the same name.
const mine: ChartDefinition = { ...library.entries[2]!, connectionId: connection.id, name: 'Top hosts' };
const mapLabel = (label: string, key: string) => enChartDefinitions.exchangeMapTarget.replace('{{label}}', label).replace('{{key}}', key);
const sourceOne = mapLabel('Fixture source', 'connection-1');
const sourceTwo = mapLabel('实验室 观察', 'connection-2');

async function hydrate(entries: readonly ChartDefinition[]): Promise<ChartDefinitionService> {
  const service = createSessionChartDefinitionService();
  if (entries.length > 0) await service.save(0, { version: 1, entries });
  return service;
}

/** Reads a document through the same strict parser the desktop and browser adapters use. */
const readerFor = (text: () => string) => vi.fn<ChartDefinitionExchangeService['readFile']>(async () => ({
  status: 'loaded', bundle: parseChartDefinitionExchangeText(text()),
}));

interface Props {
  mode: 'export' | 'import';
  service: ChartDefinitionService;
  profiles?: readonly ConnectionProfile[];
  readFile?: ChartDefinitionExchangeService['readFile'];
  saveFile?: ChartDefinitionExchangeService['saveFile'];
  onClose?: () => void;
}

function Harness({ mode, service, profiles: given = [connection, other], readFile, saveFile, onClose = vi.fn() }: Props) {
  const controller = useChartDefinitions(service);
  // The store write stays real; only the file and dialog seam is stubbed, as jsdom has no native picker.
  const exchange: ChartDefinitionExchangeService = { ...createSessionChartDefinitionExchangeService(service),
    ...(readFile ? { readFile } : {}), ...(saveFile ? { saveFile } : {}) };
  // The app only opens exchange from a ready library panel, so the reviewed record is frozen on open.
  return <I18nextProvider i18n={i18n}>{controller.record ? <ChartDefinitionExchangeDialog mode={mode} library={controller}
    kind={exchange.kind} profiles={given} service={exchange} record={controller.record} onClose={onClose} /> : null}</I18nextProvider>;
}

const preview = () => screen.getByLabelText(enChartDefinitions.exchangeReviewDocument) as HTMLTextAreaElement;
const choose = async (text: string) => {
  const input = await waitFor(() => {
    const element = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    if (!element) throw new Error('the exchange dialog has not mounted yet');
    return element;
  });
  fireEvent.change(input, { target: { files: [new File([text], 'definitions.json', { type: 'application/json' })] } });
};
const importName = /Import \d+ new definitions/;
const rowBox = (index = 0) => within(screen.getAllByRole('listitem')[index]!).getByRole('checkbox');

describe('chart definition exchange dialog', () => {
  it('exports a selected definition as a document without endpoints or real connection ids', async () => {
    const service = await hydrate([mine]);
    const saveFile = vi.fn<ChartDefinitionExchangeService['saveFile']>(async () => ({ status: 'downloadRequested' }));
    render(<Harness mode="export" service={service} saveFile={saveFile} />);
    expect(await screen.findByText('Top hosts')).toBeVisible();
    expect(screen.getByText(`${mine.index} · Alpha · ${mine.measure}`)).toBeVisible();
    const save = screen.getByRole('button', { name: enChartDefinitions.exchangeSaveAction });
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.exchangePreview }));
    // Nothing is selected, so there is no document to review and nothing can be saved.
    expect(screen.queryByLabelText(enChartDefinitions.exchangeReviewDocument)).toBeNull();
    expect(save).toBeDisabled();
    expect(saveFile).not.toHaveBeenCalled();
    fireEvent.click(rowBox());
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.exchangePreview }));
    await waitFor(() => expect(preview().value).toContain('escope-chart-definitions'));
    expect(preview().value).toContain('"name": "Top hosts"');
    for (const absent of ['https://', 'endpoint', connection.id, 'credentialRef', 'authentication']) {
      expect(preview().value).not.toContain(absent);
    }
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeReviewed }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeDownloadRequested)).toBeVisible());
    expect(saveFile).toHaveBeenCalledOnce();
    expect(saveFile.mock.calls[0]![1]).toBe(true);
    expect(saveFile.mock.calls[0]![0].definitions).toHaveLength(1);
    expect(screen.getByText(enChartDefinitions.session)).toBeVisible();
    // An export never changes the library.
    expect((await service.load()).library.entries).toEqual([mine]);
  });

  it('selects every definition at once and voids a review when the selection changes', async () => {
    const service = await hydrate([library.entries[0]!, mine]);
    render(<Harness mode="export" service={service} />);
    await screen.findByText('Latency per day');
    const selectAll = screen.getByRole('checkbox', { name: enChartDefinitions.exchangeSelectAll });
    fireEvent.click(selectAll);
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.exchangePreview }));
    await waitFor(() => expect(preview().value).toContain('chart-2'));
    const reviewed = screen.getByRole('checkbox', { name: enChartDefinitions.exchangeReviewed });
    fireEvent.click(reviewed);
    expect(screen.getByRole('button', { name: enChartDefinitions.exchangeSaveAction })).toBeEnabled();
    fireEvent.click(selectAll);
    // Clearing the selection withdraws the document and its review: nothing stale stays on screen.
    expect(screen.queryByLabelText(enChartDefinitions.exchangeReviewDocument)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: enChartDefinitions.exchangeReviewed })).toBeNull();
    expect(screen.getByRole('button', { name: enChartDefinitions.exchangeSaveAction })).toBeDisabled();
    // Re-selecting offers a fresh document that must be reviewed again before it can be saved.
    fireEvent.click(selectAll);
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.exchangePreview }));
    await waitFor(() => expect(preview().value).toContain('chart-2'));
    expect(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeReviewed })).not.toBeChecked();
    expect(screen.getByRole('button', { name: enChartDefinitions.exchangeSaveAction })).toBeDisabled();
  });

  it('says there is nothing to export instead of inventing a document', async () => {
    const service = await hydrate([]);
    render(<Harness mode="export" service={service} />);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeEmpty)).toBeVisible());
    expect(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeSelectAll })).toBeDisabled();
    expect(screen.getByRole('button', { name: enChartDefinitions.exchangePreview })).toBeDisabled();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('requires an explicit local connection for every source before importing', async () => {
    const service = await hydrate([mine]);
    render(<Harness mode="import" service={service} readFile={readerFor(() => bundleText)} />);
    await choose(bundleText);
    const first = await screen.findByLabelText(sourceOne);
    const importAction = screen.getByRole('button', { name: importName });
    expect(importAction).toBeDisabled();
    // No affordance to import a chart definition unbound: it could never be reused or rebound.
    const options = within(first.closest('label')!).getAllByRole('option').map((option) => option.textContent ?? '');
    expect(options.some((name) => /unbound|keep unbound/i.test(name))).toBe(false);
    fireEvent.change(first, { target: { value: connection.id } });
    const second = await screen.findByLabelText(sourceTwo);
    fireEvent.change(second, { target: { value: other.id } });
    expect(second).toHaveValue(other.id);
    expect(screen.getByText(other.endpoint)).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeMapped }));
    expect(importAction).toBeEnabled();
    fireEvent.click(importAction);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.sessionImported)).toBeVisible());
    const entries = (await service.load()).library.entries;
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual(mine);
    // The document repeats the stored name: import appends a second definition, it never overwrites.
    expect(entries.slice(1).map(({ name }) => name)).toEqual(['Latency per day', 'Top hosts', 'Average bytes']);
    expect(entries.filter(({ name }) => name === 'Top hosts')).toHaveLength(2);
    expect(entries[1]!.connectionId).toBe(connection.id);
    expect(entries[2]!.connectionId).toBe(other.id);
    expect(new Set(entries.map(({ id }) => id)).size).toBe(4);
    // A second click on a finished review cannot append twice.
    fireEvent.click(importAction);
    expect((await service.load()).library.entries).toHaveLength(4);
  });

  it('voids the review when a mapped connection changes or disappears', async () => {
    const service = await hydrate([mine]);
    const readFile = readerFor(() => bundleText);
    const view = render(<Harness mode="import" service={service} readFile={readFile} />);
    await choose(bundleText);
    fireEvent.change(await screen.findByLabelText(sourceOne), { target: { value: connection.id } });
    fireEvent.change(await screen.findByLabelText(sourceTwo), { target: { value: other.id } });
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeMapped }));
    expect(screen.getByRole('button', { name: importName })).toBeEnabled();
    view.rerender(<Harness mode="import" service={service} readFile={readFile}
      profiles={[{ ...connection, endpoint: 'https://moved.test' }, other]} />);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeTargetChanged)).toBeVisible());
    expect(screen.getByRole('button', { name: importName })).toBeDisabled();
    view.rerender(<Harness mode="import" service={service} readFile={readFile} profiles={[other]} />);
    expect(screen.getByRole('button', { name: importName })).toBeDisabled();
    expect((await service.load()).library.entries).toEqual([mine]);
  });

  it('refuses documents it cannot read and imports nothing', async () => {
    const service = await hydrate([mine]);
    let text = '{ not json';
    render(<Harness mode="import" service={service} readFile={readerFor(() => text)} />);
    await choose(text);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeInvalid)).toBeVisible());
    expect(screen.getByRole('alert')).toBeVisible();
    const document = JSON.parse(bundleText);
    text = JSON.stringify({ ...document, version: 4 });
    await choose(text);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeVersion)).toBeVisible());
    text = JSON.stringify({ ...document, definitions: [
      ...document.definitions, { ...document.definitions[0], key: 'chart-9', name: 'Bearer fixture-only' },
    ] });
    await choose(text);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeSensitive)).toBeVisible());
    expect((await service.load()).library.entries).toEqual([mine]);
  });

  it('reports a cancelled file choice without touching the library', async () => {
    const service = await hydrate([mine]);
    const onClose = vi.fn();
    const readFile = vi.fn<ChartDefinitionExchangeService['readFile']>(async () => ({ status: 'cancelled' }));
    render(<Harness mode="import" service={service} readFile={readFile} onClose={onClose} />);
    await choose('anything');
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeCancelled)).toBeVisible());
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(onClose).toHaveBeenCalledOnce();
    expect((await service.load()).library.entries).toEqual([mine]);
  });

  it('does not apply an import whose reviewed library moved underneath it', async () => {
    const service = await hydrate([mine]);
    render(<Harness mode="import" service={service} readFile={readerFor(() => bundleText)} />);
    await choose(bundleText);
    fireEvent.change(await screen.findByLabelText(sourceOne), { target: { value: connection.id } });
    fireEvent.change(await screen.findByLabelText(sourceTwo), { target: { value: other.id } });
    fireEvent.click(screen.getByRole('checkbox', { name: enChartDefinitions.exchangeMapped }));
    // Another tab writes first, so this frozen record is no longer current.
    const record = await service.load();
    await service.save(record.revision, { ...record.library, entries: [...record.library.entries, library.entries[0]!] });
    fireEvent.click(screen.getByRole('button', { name: importName }));
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeConflict)).toBeVisible());
    expect((await service.load()).library.entries.map(({ name }) => name)).toEqual(['Top hosts', 'Latency per day']);
  });

  it('switches to Chinese without changing what is exchanged', async () => {
    const service = await hydrate([mine]);
    render(<Harness mode="import" service={service} readFile={readerFor(() => bundleText)} />);
    await choose(bundleText);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.exchangeMapping)).toBeVisible());
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByText(zhChartDefinitions.exchangeMapping)).toBeVisible();
    expect(screen.getByRole('button', { name: /导入 \d+ 个新定义/ })).toBeDisabled();
    expect(screen.getByLabelText(zhChartDefinitions.exchangeReviewDocument)).toContainHTML('escope-chart-definitions');
    expect((await service.load()).library.entries).toEqual([mine]);
  });
});

describe('definition library exchange entries', () => {
  it('offers export and import from the definitions panel', async () => {
    const service = await hydrate([mine]);
    const onExchange = vi.fn();
    render(<Panel service={service} onExchange={onExchange} />);
    expect(await screen.findByText('Top hosts')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.exportDefinitions }));
    expect(onExchange).toHaveBeenCalledWith('export');
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.importDefinitions }));
    expect(onExchange).toHaveBeenCalledWith('import');
  });

  it('stops offering exchange while the library is not usable', async () => {
    const service = await hydrate([mine]);
    vi.spyOn(service, 'load').mockRejectedValue({ code: 'invalidResponse' });
    render(<Panel service={service} onExchange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.invalidStorage)).toBeVisible());
    expect(screen.getByRole('button', { name: enChartDefinitions.exportDefinitions })).toBeDisabled();
    expect(screen.getByRole('button', { name: enChartDefinitions.importDefinitions })).toBeDisabled();
  });
});

function Panel({ service, onExchange }: { service: ChartDefinitionService; onExchange: (mode: 'export' | 'import') => void }) {
  const controller = useChartDefinitions(service);
  return <I18nextProvider i18n={i18n}>
    <ChartDefinitionsDialog library={controller} kind="session" profiles={[connection]}
      activeTarget={{ connectionId: connection.id, index: mine.index }}
      onReuse={() => {}} onExchange={onExchange} onClose={() => {}} />
  </I18nextProvider>;
}

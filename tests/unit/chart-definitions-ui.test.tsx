import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/chart-definitions-v1.json';
import { ChartDefinitionsDialog } from '../../src/features/query/ChartDefinitionsDialog';
import { useChartDefinitions } from '../../src/features/query/useChartDefinitions';
import { createSessionChartDefinitionService, type ChartDefinitionService } from '../../src/services/chart-definitions';
import { parseChartDefinitionLibrary, type ChartDefinition } from '../../src/domain/chart-definitions';
import type { ConnectionProfile } from '../../src/domain/connection';
import { i18n } from '../../src/locales';
import { enChartDefinitions, zhChartDefinitions } from '../../src/locales/chart-definitions';

beforeEach(async () => { await i18n.changeLanguage('en-US'); });

const library = parseChartDefinitionLibrary(fixture);
if (!library) throw new Error('fixture');
const connection = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Alpha', endpoint: 'https://alpha.test' } as ConnectionProfile;
const target = { connectionId: connection.id, index: 'logs-*' };

async function hydrate(entries: readonly ChartDefinition[]): Promise<ChartDefinitionService> {
  const service = createSessionChartDefinitionService();
  if (entries.length > 0) await service.save(0, { version: 1, entries });
  return service;
}

interface HarnessProps {
  service: ChartDefinitionService;
  onExchange?: (mode: 'export' | 'import') => void;
  onReuse?: (definition: ChartDefinition) => void;
  activeTarget?: { connectionId: string | null; index: string } | null;
  profiles?: readonly ConnectionProfile[];
  onClose?: () => void;
}

function Harness({ service, onExchange = vi.fn(), onReuse = vi.fn(), activeTarget = target, profiles: given = [connection], onClose = vi.fn() }: HarnessProps) {
  const controller = useChartDefinitions(service);
  return <I18nextProvider i18n={i18n}><ChartDefinitionsDialog library={controller} kind={service.kind}
    profiles={given} activeTarget={activeTarget} onReuse={onReuse} onExchange={onExchange} onClose={onClose} /></I18nextProvider>;
}

const items = () => screen.queryAllByRole('listitem');
/** The library loads asynchronously; every interaction first waits for at least one row. */
const ready = async () => { await waitFor(() => expect(items().length).toBeGreaterThan(0)); };
const rowAction = (name: string, index = 0) =>
  fireEvent.click(within(screen.getAllByRole('listitem')[index]!).getByRole('button', { name }));

/** A second controller over the same service, standing in for another tab that writes first. */
function OtherTab({ service, onReady }: { service: ChartDefinitionService; onReady: (save: (entry: ChartDefinition) => Promise<boolean>) => void }) {
  const controller = useChartDefinitions(service);
  if (controller.status === 'ready') onReady(controller.save);
  return null;
}

describe('chart definition library panel', () => {
  it('loads the stored definitions and shows their saved target and shape', async () => {
    const service = await hydrate([library.entries[0]!, library.entries[1]!]);
    render(<Harness service={service} />);
    await screen.findByText('Latency per day');
    expect(items()).toHaveLength(2);
    expect(screen.getByText('date_histogram · 3')).toBeVisible();
    expect(screen.getByText('terms · 0')).toBeVisible();
    expect(screen.getByText(/Plotted measure doc_count/)).toBeVisible();
    expect(screen.getByTitle(enChartDefinitions.scopeBoundary)).toHaveTextContent(enChartDefinitions.scope);
    expect(screen.getByText('Alpha: logs-*')).toBeVisible();
    // The second entry belongs to a connection this panel was not given, so it stays listed unbound.
    expect(screen.getByText(`${i18n.t('removedConnection')}: events`)).toBeVisible();
  });

  it('labels a single-value definition by its grouping absence, not by an invented chart kind', async () => {
    const service = await hydrate([library.entries[1]!, library.entries[2]!]);
    render(<Harness service={service} />);
    await screen.findByText('Top hosts');
    // terms with no metrics and a lone avg both state the stored shape, never a plot type.
    expect(screen.getByText('terms · 0')).toBeVisible();
    expect(screen.getByText(`${enChartDefinitions.shapeNoGroup} · 1`)).toBeVisible();
  });

  it('says the library is empty rather than inventing a definition', async () => {
    const service = await hydrate([]);
    render(<Harness service={service} />);
    await waitFor(() => expect(screen.getByText(enChartDefinitions.empty)).toBeVisible());
    expect(items()).toHaveLength(0);
  });

  it('reuses only on the matching tab and hands the panel entry to the builder', async () => {
    const service = await hydrate([library.entries[0]!]);
    const onReuse = vi.fn();
    const view = render(<Harness service={service} onReuse={onReuse} />);
    const reuse = await screen.findByRole('button', { name: enChartDefinitions.reuse });
    expect(reuse).toBeEnabled();
    fireEvent.click(reuse);
    expect(onReuse).toHaveBeenCalledExactlyOnceWith(library.entries[0]);

    const other = vi.fn();
    view.rerender(<Harness service={service} onReuse={other} activeTarget={{ connectionId: connection.id, index: 'other-*' }} />);
    const disabled = screen.getByRole('button', { name: enChartDefinitions.reuse });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute('title', enChartDefinitions.reuseOtherTarget);
    fireEvent.click(disabled);
    expect(other).not.toHaveBeenCalled();
  });

  it('copies an entry as a separate definition and leaves the original untouched', async () => {
    const service = await hydrate([library.entries[2]!]);
    render(<Harness service={service} />);
    await ready();
    rowAction(enChartDefinitions.copy);
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(screen.getByText(`Average latency (${enChartDefinitions.copySuffix})`)).toBeVisible();
    expect(screen.getByText('Average latency')).toBeVisible();
    const stored = (await service.load()).library.entries;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual(library.entries[2]);
    expect(stored[1]).toEqual({ ...library.entries[2], id: stored[1]!.id, name: `Average latency (${enChartDefinitions.copySuffix})` });
    expect(stored[1]!.id).not.toBe(stored[0]!.id);
  });

  it('renames without moving the connection, target or shape, and refuses an unusable name', async () => {
    const service = await hydrate([library.entries[2]!]);
    render(<Harness service={service} />);
    await ready();
    rowAction(enChartDefinitions.rename);
    const input = screen.getByLabelText(enChartDefinitions.name);
    const save = screen.getByRole('button', { name: enChartDefinitions.renameSave });
    expect(input).toHaveValue('Average latency');
    expect(save).toBeDisabled();
    expect(screen.getByText(enChartDefinitions.identityBound)).toBeVisible();
    fireEvent.change(input, { target: { value: '  ' } });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Nightly average' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText('Nightly average')).toBeVisible());
    const stored = (await service.load()).library.entries[0]!;
    expect(stored.name).toBe('Nightly average');
    expect(stored.connectionId).toBe(library.entries[2]!.connectionId);
    expect(stored.index).toBe(library.entries[2]!.index);
    expect(stored.draft).toEqual(library.entries[2]!.draft);
    expect(stored.measure).toBe(library.entries[2]!.measure);
  });

  it('keeps the definition when the rename is cancelled', async () => {
    const service = await hydrate([library.entries[2]!]);
    render(<Harness service={service} />);
    await ready();
    rowAction(enChartDefinitions.rename);
    fireEvent.change(screen.getByLabelText(enChartDefinitions.name), { target: { value: 'Not saved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(screen.getByText('Average latency')).toBeVisible();
    expect((await service.load()).library.entries[0]!.name).toBe('Average latency');
  });

  it('asks before deleting and only then removes the stored definition', async () => {
    const service = await hydrate([library.entries[0]!, library.entries[2]!]);
    render(<Harness service={service} />);
    await screen.findByText('Latency per day');
    await ready();
    rowAction(enChartDefinitions.delete);
    expect(screen.getByText(enChartDefinitions.deleteDetail.replace('{{name}}', 'Latency per day'))).toBeVisible();
    expect(screen.getByText(enChartDefinitions.deleteBoundaryHint)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(items()).toHaveLength(2));
    rowAction(enChartDefinitions.delete);
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.deleteConfirm }));
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(screen.getByText('Average latency')).toBeVisible();
    expect((await service.load()).library.entries).toHaveLength(1);
  });

  it('shows a removed connection without rebinding the definition', async () => {
    const service = await hydrate([library.entries[0]!]);
    render(<Harness service={service} profiles={[]} activeTarget={{ connectionId: null, index: 'logs-*' }} />);
    await screen.findByText('Latency per day');
    expect(screen.getByText(`${i18n.t('removedConnection')}: logs-*`)).toBeVisible();
    expect(screen.getByRole('button', { name: enChartDefinitions.reuse })).toBeDisabled();
    const stored = (await service.load()).library.entries[0]!;
    expect(stored.connectionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('reports a stale write instead of overwriting, then recovers on reload', async () => {
    const service = await hydrate([library.entries[2]!]);
    let other: ((entry: ChartDefinition) => Promise<boolean>) | undefined;
    render(<OtherTab service={service} onReady={(save) => { other = other ?? save; }} />);
    await waitFor(() => expect(other).toBeDefined());
    render(<Harness service={service} />);
    await screen.findByText('Average latency');
    // Another tab writes first; this panel still holds the older revision.
    await other!({ ...library.entries[0]!, id: 'chart-added' });
    await ready();
    rowAction(enChartDefinitions.rename);
    fireEvent.change(screen.getByLabelText(enChartDefinitions.name), { target: { value: 'Stale rename' } });
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.renameSave }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: enChartDefinitions.discardAndReload }));
    await waitFor(() => expect(screen.getByText('Latency per day')).toBeVisible());
    expect(screen.queryByText('Stale rename')).toBeNull();
    expect((await service.load()).library.entries.map((entry) => entry.name)).toEqual(['Average latency', 'Latency per day']);
  });

  it('switches to Chinese without changing the stored content', async () => {
    const service = await hydrate([library.entries[2]!]);
    render(<Harness service={service} />);
    await screen.findByText('Average latency');
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByText(zhChartDefinitions.title)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: zhChartDefinitions.copy }));
    await waitFor(() => expect(screen.getByText(`Average latency (${zhChartDefinitions.copySuffix})`)).toBeVisible());
    const stored = (await service.load()).library.entries;
    expect(stored[1]!.name).toBe(`Average latency (${zhChartDefinitions.copySuffix})`);
    expect(stored[0]!.draft).toEqual(library.entries[2]!.draft);
  });
});

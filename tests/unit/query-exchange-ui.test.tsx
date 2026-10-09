import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryExchangeDialog } from '../../src/features/query/QueryExchangeDialog';
import { QueryLibraryDialog, useQueryLibrary } from '../../src/features/query/QueryLibrary';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionQueryExchangeService, type QueryExchangeService } from '../../src/services/query-exchange';
import { createEmptyLibrary, entryFromDocument, type SavedQueryLibrary } from '../../src/domain/query-library';
import type { QueryDocument } from '../../src/domain/query';
import { importQueryExchange, parseQueryExchangeText } from '../../src/domain/query-exchange';
import type { ConnectionProfile } from '../../src/domain/connection';
import { i18n } from '../../src/locales';

const bundle = parseQueryExchangeText(readFileSync('tests/fixtures/query-exchange-v1.json', 'utf8'));
const profile: ConnectionProfile = { id: 'local-a', displayName: 'Fixture source', endpoint: 'https://local.test/',
  environment: 'development', sortOrder: 0, auth: 'none' };
beforeEach(async () => { await i18n.changeLanguage('en-US'); });

async function mount(mode: 'export' | 'import' = 'import', initialLibrary?: SavedQueryLibrary) {
  const store = createSessionQueryLibraryService();
  if (initialLibrary) await store.save(initialLibrary, createEmptyLibrary());
  else if (mode === 'export') {
    const initial = importQueryExchange(bundle, [{ sourceKey: 'source-a', target: { connectionId: profile.id, endpoint: profile.endpoint } }], createEmptyLibrary(), [profile]);
    await store.save({ ...initial, entries: initial.entries.map((entry) => entry.parameters ? {
      ...entry, dsl: entry.dsl.replace('{"$param":"minimum"}', '987654321234567890'),
    } : entry) }, createEmptyLibrary());
  }
  const session = createSessionQueryExchangeService(store);
  const readFile = vi.fn<QueryExchangeService['readFile']>(async () => ({ status: 'loaded', bundle }));
  const saveFile = vi.fn<QueryExchangeService['saveFile']>(async () => ({ status: 'saved' }));
  const importDefinitions = vi.fn(session.importDefinitions);
  const exchange: QueryExchangeService = { ...session, kind: 'desktop', readFile, saveFile, importDefinitions };
  const onClose = vi.fn();
  function Harness({ profiles }: { profiles: ConnectionProfile[] }) {
    const library = useQueryLibrary(store);
    const [open, setOpen] = useState(false);
    const [libraryVisible, setLibraryVisible] = useState(false);
    return <I18nextProvider i18n={i18n}>
      <button disabled={library.status !== 'ready'} onClick={() => setOpen(true)}>open exchange</button>
      <output data-testid="count">{library.entries.length}</output>
      {open ? <QueryExchangeDialog mode={mode} service={exchange} library={library} profiles={profiles}
        onClose={() => { onClose(); setOpen(false); setLibraryVisible(true); }} /> : null}
      {libraryVisible ? <QueryLibraryDialog open kind="session" status={library.status} loadError={library.loadError}
        entries={library.entries} saveStatus={library.saveStatus} profiles={profiles} onClose={() => setLibraryVisible(false)}
        onDelete={library.deleteEntry} onToggleFavorite={(entry) => library.setFavorite(entry.id, !entry.favorite)}
        onRetrySave={library.retrySave} onReload={library.reload} /> : null}
    </I18nextProvider>;
  }
  const view = render(<Harness profiles={[profile]} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'open exchange' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'open exchange' }));
  return { store, exchange, readFile, saveFile, importDefinitions, onClose, view, Harness };
}
async function chooseFile() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose JSON file' }));
  await screen.findByRole('textbox', { name: 'Definition JSON' });
}
function mapAndReview() {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: profile.id } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the target mappings. Import as new queries.' }));
}

describe('query definition exchange UI', () => {
  it('requires separate acknowledgment before excluding local managed time from an exchange file', async () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/query-time-range-v1.json', 'utf8')) as { draft: QueryDocument };
    const entry = entryFromDocument(fixture.draft, { id: 'time', name: 'Time draft', favorite: false, now: new Date() });
    const { saveFile } = await mount('export', { version: 1, entries: [entry] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all queries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review definitions' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the definitions and their literals for sensitive content.' }));
    expect(screen.getByRole('button', { name: 'Save JSON file' })).toBeDisabled();
    const confirmation = screen.getByRole('checkbox', { name: /I accept that time management is excluded/ });
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole('button', { name: 'Review definitions' }));
    expect(confirmation).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the definitions and their literals for sensitive content.' }));
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole('button', { name: 'Save JSON file' }));
    await screen.findByText('Definition file saved.');
    expect(saveFile.mock.calls[0]![0].queries[0]!.dsl).toBe(fixture.draft.dsl);
    expect(saveFile.mock.calls[0]![0].queries[0]).not.toHaveProperty('timeRange');
  });

  it('requires file review and explicit mapping even for identical connection names', async () => {
    const { importDefinitions, store } = await mount();
    await chooseFile();
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(importDefinitions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the target mappings. Import as new queries.' }));
    expect(screen.getByRole('button', { name: 'Import 2 new queries' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: profile.id } });
    expect(screen.getByRole('button', { name: 'Import 2 new queries' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the target mappings. Import as new queries.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 new queries' }));
    await screen.findByText('Imported into the local query library. No query was executed.');
    expect((await store.load()).entries[0]!.connectionId).toBe(profile.id);
    expect(screen.getByTestId('count')).toHaveTextContent('2');
    expect(importDefinitions).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Import 2 new queries' })).toBeDisabled();
  });

  it('blocks endpoint changes after review instead of rebinding the import', async () => {
    const { view, Harness, importDefinitions } = await mount();
    await chooseFile();
    mapAndReview();
    view.rerender(<Harness profiles={[{ ...profile, endpoint: 'https://changed.test/' }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('A selected local connection changed');
    expect(screen.getByRole('button', { name: 'Import 2 new queries' })).toBeDisabled();
    expect(importDefinitions).not.toHaveBeenCalled();
  });

  it('exports only reviewed selections and invalidates review after selection changes', async () => {
    const { saveFile } = await mount('export');
    expect(screen.getByRole('button', { name: 'Review definitions' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all queries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review definitions' }));
    const preview = screen.getByRole('textbox', { name: 'Definition JSON' }) as HTMLTextAreaElement;
    expect(preview.value).toContain('$param');
    expect(preview.value).not.toContain('987654321234567890');
    expect(preview.value).not.toContain(profile.endpoint);
    expect(screen.getByRole('button', { name: 'Save JSON file' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the definitions and their literals for sensitive content.' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Exact literals/ }));
    expect(screen.queryByRole('textbox', { name: 'Definition JSON' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save JSON file' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review definitions' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the definitions and their literals for sensitive content.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save JSON file' }));
    await screen.findByText('Definition file saved.');
    expect(saveFile).toHaveBeenCalledOnce();
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({ queries: [expect.objectContaining({ name: 'Amount threshold' })] });
  });

  it('keeps all close paths blocked while native work is pending', async () => {
    const { readFile, onClose } = await mount();
    let resolve!: (value: Awaited<ReturnType<QueryExchangeService['readFile']>>) => void;
    const pending = new Promise<Awaited<ReturnType<QueryExchangeService['readFile']>>>((done) => { resolve = done; });
    readFile.mockImplementationOnce(() => pending);
    fireEvent.click(screen.getByRole('button', { name: 'Choose JSON file' }));
    for (const close of screen.getAllByRole('button', { name: 'Close' })) fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { resolve({ status: 'cancelled' }); await pending; });
    await screen.findByText('File selection cancelled.');
  });

  it('does not report a failed or unknown import as complete, and stale retry cannot duplicate it', async () => {
    const { store, importDefinitions } = await mount();
    const original = importDefinitions.getMockImplementation()!;
    importDefinitions.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw { code: 'invalidResponse' };
    });
    await chooseFile();
    mapAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 new queries' }));
    await screen.findByText('The outcome could not be verified. Reload the local library before retrying an import.');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 new queries' }));
    await screen.findByText('The local query library changed or has unsaved changes. Reload it, then review this import again.');
    const loaded: SavedQueryLibrary = await store.load();
    expect(loaded.entries).toHaveLength(2);
    expect(screen.queryByText('Imported into the local query library. No query was executed.')).not.toBeInTheDocument();
  });

  it('offers an explicit reload after closing an unconfirmed import and recovers the committed entries once', async () => {
    const { importDefinitions } = await mount();
    const original = importDefinitions.getMockImplementation()!;
    importDefinitions.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw { code: 'invalidResponse' };
    });
    await chooseFile();
    mapAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 new queries' }));
    await screen.findByText('The outcome could not be verified. Reload the local library before retrying an import.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]!);
    await screen.findByRole('dialog', { name: 'Saved queries' });
    expect(screen.getByRole('alert')).toHaveTextContent('The import outcome is unconfirmed.');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByText('Amount threshold')).toBeInTheDocument();
    expect(importDefinitions).toHaveBeenCalledOnce();
  });

  it('keeps a definite pre-write rejection distinct from an unknown commit outcome', async () => {
    const { importDefinitions, store } = await mount();
    importDefinitions.mockRejectedValueOnce({ code: 'exchangeTargetChanged' });
    await chooseFile();
    mapAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 new queries' }));
    await screen.findByText('A mapped local connection changed or was removed. Select and review it again.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]!);
    await screen.findByRole('dialog', { name: 'Saved queries' });
    expect(screen.queryByText('The import outcome is unconfirmed. Reload the local query library before continuing.')).not.toBeInTheDocument();
    expect((await store.load()).entries).toHaveLength(0);
  });
});

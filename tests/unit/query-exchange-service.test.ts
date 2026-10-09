import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { importQueryExchange, parseQueryExchangeText, type ConnectionMapping, type QueryExchange } from '../../src/domain/query-exchange';
import { createEmptyLibrary, type SavedQueryLibrary } from '../../src/domain/query-library';
import { createSessionQueryLibraryService } from '../../src/services/query-library';
import { createSessionQueryExchangeService, desktopQueryExchangeService as desktop } from '../../src/services/query-exchange';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const bundle = parseQueryExchangeText(readFileSync('tests/fixtures/query-exchange-v1.json', 'utf8'));
const mappings: ConnectionMapping[] = [{ sourceKey: 'source-a', target: null }];
beforeEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });

describe('definition exchange IPC', () => {
  it('opens only the native picker and strictly reads loaded/cancelled outcomes', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 'cancelled' });
    await expect(desktop.readFile()).resolves.toEqual({ status: 'cancelled' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('query_exchange_read');
    vi.mocked(invoke).mockResolvedValue({ status: 'loaded', bundle });
    await expect(desktop.readFile()).resolves.toEqual({ status: 'loaded', bundle });
    vi.mocked(invoke).mockResolvedValue({ status: 'loaded', bundle, path: 'not-a-permitted-field' });
    await expect(desktop.readFile()).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('requires review and sends only a validated bundle, never a path', async () => {
    await expect(desktop.saveFile(bundle, false)).rejects.toMatchObject({ code: 'exchangeInvalid' });
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValue({ status: 'saved' });
    await expect(desktop.saveFile(bundle, true)).resolves.toEqual({ status: 'saved' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('query_exchange_save', { request: { bundle, reviewed: true } });
    vi.mocked(invoke).mockResolvedValue({ status: 'downloadRequested' });
    await expect(desktop.saveFile(bundle, true)).rejects.toMatchObject({ code: 'invalidResponse' });
    vi.mocked(invoke).mockResolvedValue({ status: 'cancelled' });
    await expect(desktop.saveFile(bundle, true)).resolves.toEqual({ status: 'cancelled' });
  });

  it('verifies the whole imported append and target binding, not merely a success flag', async () => {
    type Request = { bundle: QueryExchange; mappings: ConnectionMapping[]; expected: SavedQueryLibrary; updatedAt: string };
    vi.mocked(invoke).mockImplementation(async (_command, payload) => {
      const { request } = payload as { request: Request };
      return importQueryExchange(request.bundle, request.mappings, request.expected, undefined, new Date(request.updatedAt));
    });
    const imported = await desktop.importDefinitions(bundle, mappings, createEmptyLibrary());
    expect(imported.entries).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith('query_exchange_import', { request: {
      bundle, mappings, expected: createEmptyLibrary(), updatedAt: expect.any(String),
    } });
    vi.mocked(invoke).mockImplementation(async (_command, payload) => {
      const { request } = payload as { request: Request };
      const result = importQueryExchange(request.bundle, request.mappings, request.expected, undefined, new Date(request.updatedAt));
      return { ...result, entries: result.entries.map((entry) => ({ ...entry, connectionId: 'unreviewed-target' })) };
    });
    await expect(desktop.importDefinitions(bundle, mappings, createEmptyLibrary())).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('refuses absent mappings before IPC and never falls back after desktop failure', async () => {
    await expect(desktop.importDefinitions(bundle, [], createEmptyLibrary())).rejects.toMatchObject({ code: 'exchangeMappingRequired' });
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockRejectedValue({ code: 'storageUnavailable' });
    await expect(desktop.importDefinitions(bundle, mappings, createEmptyLibrary())).rejects.toMatchObject({ code: 'storageUnavailable' });
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(desktop.readFile()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(desktop.saveFile(bundle, true)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('explicit session exchange', () => {
  it('uses only the selected file and rejects invalid UTF-8 or excess bytes', async () => {
    const service = createSessionQueryExchangeService(createSessionQueryLibraryService());
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const file = { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } as File;
    await expect(service.readFile(file)).resolves.toEqual({ status: 'loaded', bundle });
    await expect(service.readFile()).resolves.toEqual({ status: 'cancelled' });
    await expect(service.readFile({ size: 5 * 1024 * 1024 } as File)).rejects.toMatchObject({ code: 'exchangeTooLarge' });
    await expect(service.readFile({ size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer } as File)).rejects.toMatchObject({ code: 'exchangeInvalid' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses CAS for all imports and ordinary saves, so a lost completion cannot duplicate entries', async () => {
    const library = createSessionQueryLibraryService();
    const service = createSessionQueryExchangeService(library);
    const base = await library.load();
    const next = await service.importDefinitions(bundle, mappings, base);
    await expect(service.importDefinitions(bundle, mappings, base)).rejects.toMatchObject({ code: 'libraryConflict' });
    await expect(library.save(base, base)).rejects.toMatchObject({ code: 'libraryConflict' });
    expect(await library.load()).toEqual(next);
    const read = await library.load();
    (read.entries[0]!.parameters!.definitions as { name: string; type: string }[])[0]!.name = 'changed-elsewhere';
    expect((await library.load()).entries[0]!.parameters!.definitions[0]!.name).toBe('minimum');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports browser download requested, not saved to disk', async () => {
    const create = vi.fn(() => 'blob:fixture');
    const revoke = vi.fn();
    class FixtureURL extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }
    vi.stubGlobal('URL', FixtureURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const service = createSessionQueryExchangeService(createSessionQueryLibraryService());
      await expect(service.saveFile(bundle, true)).resolves.toEqual({ status: 'downloadRequested' });
      expect(create).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(revoke).toHaveBeenCalledWith('blob:fixture');
    } finally { click.mockRestore(); vi.unstubAllGlobals(); }
  });
});

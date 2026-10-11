import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  importChartDefinitionExchange, parseChartDefinitionExchangeText,
  type ChartConnectionMapping, type ChartDefinitionExchange,
} from '../../src/domain/chart-definition-exchange';
import { emptyChartDefinitions, type ChartDefinitionRecord } from '../../src/domain/chart-definitions';
import { createSessionChartDefinitionService } from '../../src/services/chart-definitions';
import {
  createSessionChartDefinitionExchangeService, desktopChartDefinitionExchangeService as desktop,
} from '../../src/services/chart-definition-exchange';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const bundle = parseChartDefinitionExchangeText(readFileSync('tests/fixtures/chart-definition-exchange-v1.json', 'utf8'));
const mappings: ChartConnectionMapping[] = [
  { sourceKey: 'connection-1', target: { connectionId: 'local-one', endpoint: 'https://one.test' } },
  { sourceKey: 'connection-2', target: { connectionId: 'local-two', endpoint: 'https://two.test' } },
];
const base: ChartDefinitionRecord = { revision: 3, library: emptyChartDefinitions() };
/** The append a reviewer would compute locally: fresh ids, existing rows carried verbatim. */
const append = (record: ChartDefinitionRecord): ChartDefinitionRecord => {
  let issued = 0;
  return { revision: record.revision + 1,
    library: importChartDefinitionExchange(bundle, mappings, record.library, undefined, () => `imported-${++issued}`) };
};
const session = () => createSessionChartDefinitionExchangeService(createSessionChartDefinitionService());
beforeEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });

describe('chart definition exchange IPC', () => {
  it('opens only the native picker and reads loaded or cancelled outcomes strictly', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 'cancelled' });
    await expect(desktop.readFile()).resolves.toEqual({ status: 'cancelled' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('chart_definition_exchange_read');
    vi.mocked(invoke).mockResolvedValue({ status: 'loaded', bundle });
    await expect(desktop.readFile()).resolves.toEqual({ status: 'loaded', bundle });
    // A response carrying anything besides the reviewed document (a path, for instance) is refused.
    vi.mocked(invoke).mockResolvedValue({ status: 'loaded', bundle, path: 'not-a-permitted-field' });
    await expect(desktop.readFile()).rejects.toMatchObject({ code: 'invalidResponse' });
    await expect(desktop.readFile({ size: 1 } as File)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('requires review before saving and never passes a path to the backend', async () => {
    await expect(desktop.saveFile(bundle, false)).rejects.toMatchObject({ code: 'exchangeInvalid' });
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValue({ status: 'saved' });
    await expect(desktop.saveFile(bundle, true)).resolves.toEqual({ status: 'saved' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('chart_definition_exchange_save', { request: { bundle, reviewed: true } });
    // The native dialog only ever answers saved or cancelled; a browser-style status is not a disk write.
    vi.mocked(invoke).mockResolvedValue({ status: 'downloadRequested' });
    await expect(desktop.saveFile(bundle, true)).rejects.toMatchObject({ code: 'invalidResponse' });
    vi.mocked(invoke).mockResolvedValue({ status: 'cancelled' });
    await expect(desktop.saveFile(bundle, true)).resolves.toEqual({ status: 'cancelled' });
  });

  it('verifies the whole imported append, not merely a success flag', async () => {
    type Request = { bundle: ChartDefinitionExchange; mappings: ChartConnectionMapping[]; expectedRevision: number };
    vi.mocked(invoke).mockImplementation(async (_command, payload) => {
      const { request } = payload as { request: Request };
      let issued = 0;
      return { revision: request.expectedRevision + 1,
        library: importChartDefinitionExchange(request.bundle, request.mappings, base.library, undefined, () => `imported-${++issued}`) };
    });
    await expect(desktop.importDefinitions(bundle, mappings, base)).resolves.toEqual(append(base));
    expect(invoke).toHaveBeenCalledWith('chart_definition_exchange_import', {
      request: { bundle, mappings, expectedRevision: 3 },
    });
    // A silently re-bound row is an unverified outcome, not an import.
    vi.mocked(invoke).mockImplementation(async (_command, payload) => {
      const { request } = payload as { request: Request };
      let issued = 0;
      const library = importChartDefinitionExchange(request.bundle, request.mappings, base.library, undefined, () => `imported-${++issued}`);
      return { revision: request.expectedRevision + 1,
        library: { ...library, entries: library.entries.map((entry) => ({ ...entry, connectionId: 'unreviewed-target' })) } };
    });
    await expect(desktop.importDefinitions(bundle, mappings, base)).rejects.toMatchObject({ code: 'invalidResponse' });
    // An unknown completion (the old revision, or the right revision with the wrong rows) never
    // reports success; the caller has to reload before retrying.
    vi.mocked(invoke).mockResolvedValue({ revision: 3, library: emptyChartDefinitions() });
    await expect(desktop.importDefinitions(bundle, mappings, base)).rejects.toMatchObject({ code: 'invalidResponse' });
    vi.mocked(invoke).mockResolvedValue({ revision: 4, library: emptyChartDefinitions() });
    await expect(desktop.importDefinitions(bundle, mappings, base)).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('refuses absent mappings before IPC and never falls back to memory after a desktop failure', async () => {
    await expect(desktop.importDefinitions(bundle, [], base)).rejects.toMatchObject({ code: 'exchangeMappingRequired' });
    // Unbound is not expressible: a null target cannot reach the backend at all.
    await expect(desktop.importDefinitions(bundle, [
      { sourceKey: 'connection-1', target: null }, mappings[1],
    ] as unknown as ChartConnectionMapping[], base)).rejects.toMatchObject({ code: 'exchangeMappingRequired' });
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockRejectedValue({ code: 'storageUnavailable' });
    await expect(desktop.importDefinitions(bundle, mappings, base)).rejects.toMatchObject({ code: 'storageUnavailable' });
    vi.mocked(invoke).mockRejectedValue({ code: 'exchangeTargetChanged' });
    await expect(desktop.importDefinitions(bundle, mappings, base)).rejects.toMatchObject({ code: 'exchangeTargetChanged' });
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(desktop.readFile()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(desktop.saveFile(bundle, true)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(desktop.importDefinitions(bundle, mappings, base)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('explicit session exchange', () => {
  it('reads only the chosen file and rejects invalid UTF-8 or excess bytes', async () => {
    const service = session();
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const file = { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } as File;
    await expect(service.readFile(file)).resolves.toEqual({ status: 'loaded', bundle });
    await expect(service.readFile()).resolves.toEqual({ status: 'cancelled' });
    await expect(service.readFile({ size: 2 * 1024 * 1024 } as File)).rejects.toMatchObject({ code: 'exchangeTooLarge' });
    await expect(service.readFile({ size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer } as File))
      .rejects.toMatchObject({ code: 'exchangeInvalid' });
    await expect(service.readFile({ size: 4, arrayBuffer: async () => new TextEncoder().encode('{}').buffer } as File))
      .rejects.toMatchObject({ code: 'exchangeInvalid' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('appends through the library CAS so a lost completion cannot duplicate entries', async () => {
    const definitions = createSessionChartDefinitionService();
    const service = createSessionChartDefinitionExchangeService(definitions);
    const record = await definitions.load();
    const first = await service.importDefinitions(bundle, mappings, record);
    expect(first.revision).toBe(record.revision + 1);
    expect(first.library.entries).toHaveLength(3);
    // Replaying the same review against the replaced revision conflicts instead of duplicating.
    await expect(service.importDefinitions(bundle, mappings, record)).rejects.toMatchObject({ code: 'chartDefinitionConflict' });
    expect((await definitions.load()).library.entries).toHaveLength(3);
    const second = await service.importDefinitions(bundle, mappings, first);
    expect(second.library.entries).toHaveLength(6);
    expect(second.library.entries.slice(0, 3)).toEqual(first.library.entries);
    expect(new Set(second.library.entries.map(({ id }) => id)).size).toBe(6);
    // The store hands out detached copies: reaching into one cannot rewrite the library.
    const detached = (await definitions.load()).library.entries as unknown as { name: string }[];
    detached[0]!.name = 'changed-elsewhere';
    expect((await definitions.load()).library.entries[0]!.name).not.toBe('changed-elsewhere');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports a browser download request, not a verified disk write', async () => {
    const create = vi.fn(() => 'blob:fixture');
    const revoke = vi.fn();
    class FixtureURL extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }
    vi.stubGlobal('URL', FixtureURL);
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    try {
      const service = session();
      await expect(service.saveFile(bundle, true)).resolves.toEqual({ status: 'downloadRequested' });
      expect(create).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect(names).toEqual(['escope-chart-definitions.json']);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(revoke).toHaveBeenCalledWith('blob:fixture');
      await expect(service.saveFile(bundle, false)).rejects.toMatchObject({ code: 'exchangeInvalid' });
    } finally { click.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('refuses to export a document a later reader would have to repair', async () => {
    const service = session();
    const tampered = structuredClone(bundle);
    (tampered.definitions[0] as unknown as { measure: string }).measure = 'absent';
    await expect(service.saveFile(tampered, true)).rejects.toMatchObject({ code: 'exchangeInvalid' });
    expect(service.kind).toBe('session');
  });
});

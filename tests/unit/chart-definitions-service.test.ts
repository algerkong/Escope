import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/chart-definitions-v1.json';
import { createSessionChartDefinitionService, desktopChartDefinitionService } from '../../src/services/chart-definitions';
import { MAX_CHART_DEFINITIONS, emptyChartDefinitions, parseChartDefinitionLibrary, type ChartDefinition } from '../../src/domain/chart-definitions';

const library = parseChartDefinitionLibrary(fixture);
if (!library) throw new Error('fixture');
const first = library.entries[0]!;

describe('session chart definition service', () => {
  it('starts empty, increments revisions and keeps loaded copies independent', async () => {
    const service = createSessionChartDefinitionService();
    expect(service.kind).toBe('session');
    expect(await service.load()).toEqual({ revision: 0, library: emptyChartDefinitions() });
    expect(await service.save(0, { version: 1, entries: [first] })).toBe(1);
    const loaded = await service.load();
    expect(loaded.revision).toBe(1);
    // Every load hands out a detached copy, so no caller can reach into the store's objects.
    const again = await service.load();
    expect(again).not.toBe(loaded);
    expect(again.library.entries[0]).not.toBe(loaded.library.entries[0]);
    expect(again.library.entries[0]).toEqual(loaded.library.entries[0]);
    expect(again.library.entries[0]!.name).toBe(first.name);
  });

  it('refuses a stale revision and a moved connection without touching the store', async () => {
    const service = createSessionChartDefinitionService();
    await service.save(0, { version: 1, entries: [first] });
    await expect(service.save(0, { version: 1, entries: [] })).rejects.toMatchObject({ code: 'chartDefinitionConflict' });
    await expect(service.save(1, { version: 1, entries: [{ ...first, connectionId: 'other-connection' }] }))
      .rejects.toMatchObject({ code: 'invalidInput' });
    expect((await service.load()).library.entries).toEqual([first]);
  });

  it('validates the document before writing and never accepts a corrupt library', async () => {
    const service = createSessionChartDefinitionService();
    await expect(service.save(0, { version: 2, entries: [] } as unknown as typeof library))
      .rejects.toMatchObject({ code: 'invalidInput' });
    await expect(service.save(0, { version: 1, entries: [{ id: 'x' }] } as unknown as typeof library))
      .rejects.toMatchObject({ code: 'invalidInput' });
    await expect(service.save(-1, { version: 1, entries: [] })).rejects.toMatchObject({ code: 'invalidInput' });
    await expect(service.save(1.5, { version: 1, entries: [] })).rejects.toMatchObject({ code: 'invalidInput' });
    expect(await service.load()).toEqual({ revision: 0, library: emptyChartDefinitions() });
  });

  it('keeps every entry when appending up to the cap and refuses past it', async () => {
    const service = createSessionChartDefinitionService();
    const many: ChartDefinition[] = Array.from({ length: MAX_CHART_DEFINITIONS }, (_, index) => ({
      ...first, id: `chart-${index}`, name: `Chart ${index}`,
    }));
    expect(await service.save(0, { version: 1, entries: many })).toBe(1);
    await expect(service.save(1, { version: 1, entries: [...many, { ...first, id: 'one-too-many' }] }))
      .rejects.toMatchObject({ code: 'invalidInput' });
    expect((await service.load()).library.entries).toHaveLength(MAX_CHART_DEFINITIONS);
  });

  it('never answers a desktop call from memory and needs the Tauri runtime', async () => {
    await expect(desktopChartDefinitionService.load()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(desktopChartDefinitionService.save(0, { version: 1, entries: [] })).rejects.toMatchObject({ code: 'unsupported' });
    expect(desktopChartDefinitionService.kind).toBe('desktop');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  createEmptyLibrary, documentFromEntry, entryFromDocument, entryLimitViolation, libraryLimitViolation,
  libraryPayload, parseLibraryPayload, removeEntry, serializeLibrary, setEntryFavorite, upsertEntry,
  utf8ByteLength, MAX_ENTRY_DSL_BYTES, MAX_EXPORT_CONTENT_BYTES, MAX_SAVED_ENTRIES, QUERY_LIBRARY_VERSION,
  type SavedQueryEntry, type SavedQueryLibrary,
} from '../../src/domain/query-library';
import { createSessionQueryLibraryService, desktopQueryLibraryService } from '../../src/services/query-library';
import type { QueryDocument } from '../../src/domain/query';
import { enQueryLibrary, zhQueryLibrary } from '../../src/locales/query-library';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const NOW = new Date('2026-10-09T12:00:00.000Z');

/** A draft with an exact numeric literal that must never pass through `Number`. */
const DOC: QueryDocument = {
  id: 'q1', connectionId: 'c1', name: '  Orders draft  ', index: 'orders-1',
  dsl: '{"query":{"range":{"total":{"gte":9007199254740993}}},"size":25}',
  revision: 4, resultView: 'table',
};

function entry(id: string, name = `Draft ${id}`, favorite = false): SavedQueryEntry {
  return {
    id, name, connectionId: 'c1', index: 'orders-1', dsl: '{"query":{"match_all":{}}}',
    resultView: 'table', favorite, updatedAt: NOW.toISOString(),
  };
}

function library(entries: readonly SavedQueryEntry[]): SavedQueryLibrary {
  return { version: QUERY_LIBRARY_VERSION, entries };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('query library domain', () => {
  it('snapshots a document by value and restores it under a fresh query ID', () => {
    const saved = entryFromDocument(DOC, { id: 'e1', name: ' Orders draft ', favorite: true, now: NOW });
    expect(saved).toEqual({
      id: 'e1', name: 'Orders draft', connectionId: 'c1', index: 'orders-1', dsl: DOC.dsl,
      resultView: 'table', favorite: true, updatedAt: NOW.toISOString(),
    });
    const restored = documentFromEntry(saved);
    expect(restored.id).not.toBe('e1');
    expect(documentFromEntry(saved, 'q2').id).toBe('q2');
    expect(restored).toMatchObject({
      connectionId: 'c1', index: 'orders-1', dsl: DOC.dsl, revision: 0, resultView: 'table',
    });
  });

  it('keeps a deleted connection ID and never rebinds an unbound entry', () => {
    const orphan = entryFromDocument({ ...DOC, connectionId: 'gone' }, { id: 'e2', name: 'Orphan', favorite: false, now: NOW });
    expect(documentFromEntry(orphan).connectionId).toBe('gone');
    const unbound = entryFromDocument({ ...DOC, connectionId: null }, { id: 'e3', name: 'Unbound', favorite: false, now: NOW });
    expect(documentFromEntry(unbound).connectionId).toBeNull();
  });

  it('saves incomplete drafts and preserves the exact DSL text', () => {
    const broken = entryFromDocument({ ...DOC, dsl: '{ "query": ' }, { id: 'e4', name: 'Broken', favorite: false, now: NOW });
    const lib = upsertEntry(createEmptyLibrary(), broken);
    const roundTrip = parseLibraryPayload(JSON.parse(serializeLibrary(lib)));
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.library.entries[0]!.dsl).toBe('{ "query": ');
    const complete = upsertEntry(createEmptyLibrary(), entryFromDocument(DOC, { id: 'e5', name: 'Complete', favorite: false, now: NOW }));
    expect(serializeLibrary(complete)).toContain('9007199254740993');
  });

  it('enforces entry bounds without validating the DSL', () => {
    const empty = createEmptyLibrary();
    expect(entryLimitViolation(empty, entry('e1'))).toBeNull();
    expect(entryLimitViolation(empty, { ...entry('e2'), dsl: 'x'.repeat(MAX_ENTRY_DSL_BYTES + 1) })).toBe('dslTooLarge');
    expect(entryLimitViolation(empty, { ...entry('e3'), name: 'n'.repeat(121) })).toBe('nameTooLong');
    expect(entryLimitViolation(empty, { ...entry('bad id!') })).toBe('invalidEntryId');
    expect(entryLimitViolation(empty, { ...entry('e4'), updatedAt: 'x'.repeat(41) })).toBe('invalidTimestamp');
    expect(entryLimitViolation(empty, { ...entry('e5'), updatedAt: 'not a timestamp' })).toBe('invalidTimestamp');
    expect(entryLimitViolation(empty, { ...entry('e6'), connectionId: 'c'.repeat(65) })).toBe('connectionIdTooLong');

    const full = library(Array.from({ length: MAX_SAVED_ENTRIES }, (_, index) => entry(`e${index}`)));
    expect(entryLimitViolation(full, entry('one-more'))).toBe('tooManyEntries');
    expect(entryLimitViolation(full, { ...entry('e0'), name: 'Renamed' })).toBeNull();
    expect(libraryLimitViolation(full)).toBeNull();
    expect(libraryLimitViolation(library([...full.entries, entry('overflow')]))).toBe('tooManyEntries');
    expect(libraryLimitViolation(library([entry('dup'), entry('dup')]))).toBe('invalidEntryId');
  });

  it('upserts, removes and favorites entries without mutating the previous library', () => {
    const base = library([entry('e1'), entry('e2')]);
    const updated = upsertEntry(base, { ...entry('e1'), name: 'Renamed' });
    expect(updated.entries[0]!.name).toBe('Renamed');
    expect(base.entries[0]!.name).toBe('Draft e1');
    expect(upsertEntry(base, entry('e3')).entries.map((item) => item.id)).toEqual(['e1', 'e2', 'e3']);
    expect(removeEntry(base, 'e1').entries.map((item) => item.id)).toEqual(['e2']);
    expect(removeEntry(base, 'missing')).toEqual(base);
    expect(setEntryFavorite(base, 'e2', true).entries[1]!.favorite).toBe(true);
  });

  it('refuses a stored payload this build cannot explain', () => {
    const valid = libraryPayload(library([entry('e1')]));
    expect(parseLibraryPayload(valid).ok).toBe(true);
    expect(parseLibraryPayload(null).ok).toBe(false);
    expect(parseLibraryPayload(valid.entries.slice()).ok).toBe(false);
    expect(parseLibraryPayload({ ...valid, version: QUERY_LIBRARY_VERSION + 1 }).ok).toBe(false);
    expect(parseLibraryPayload({ ...valid, extra: true }).ok).toBe(false);
    expect(parseLibraryPayload({ entries: valid.entries }).ok).toBe(false);
    expect(parseLibraryPayload({ ...valid, entries: [{ ...valid.entries[0], extra: 1 }] }).ok).toBe(false);
    expect(parseLibraryPayload({ ...valid, entries: [{ ...valid.entries[0], favorite: 'yes' }] }).ok).toBe(false);
    expect(parseLibraryPayload({ ...valid, entries: [{ ...valid.entries[0], resultView: 'csv' }] }).ok).toBe(false);
    expect(parseLibraryPayload({ ...valid, entries: [{ ...valid.entries[0], dsl: 'x'.repeat(MAX_ENTRY_DSL_BYTES + 1) }] }).ok).toBe(false);
    expect(parseLibraryPayload({ ...valid, entries: [valid.entries[0], { ...valid.entries[0] }] }).ok).toBe(false);
    expect(parseLibraryPayload({ ...valid, entries: Array.from({ length: MAX_SAVED_ENTRIES + 1 }, (_, index) => ({ ...valid.entries[0], id: `e${index}` })) }).ok).toBe(false);
  });

  it('counts UTF-8 bytes the same way the backend does', () => {
    expect(utf8ByteLength('orders-1')).toBe(8);
    expect(utf8ByteLength('中')).toBe(3);
    expect(enQueryLibrary.open).toBeTruthy();
    expect(Object.keys(zhQueryLibrary).sort()).toEqual(Object.keys(enQueryLibrary).sort());
  });
});

describe('desktop query library IPC', () => {
  it('loads through saved_queries_load and refuses an unexplained payload', async () => {
    const stored = libraryPayload(library([entry('e1', 'Saved', true)]));
    vi.mocked(invoke).mockResolvedValue(stored);
    const loaded = await desktopQueryLibraryService.load();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('saved_queries_load');
    expect(loaded.entries).toEqual(stored.entries);

    vi.mocked(invoke).mockResolvedValue({ ...stored, entries: [{ ...stored.entries[0], unknown: 1 }] });
    await expect(desktopQueryLibraryService.load()).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('saves the canonical document and refuses over-limit libraries before IPC', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const lib = library([entry('e1', 'Saved')]);
    await desktopQueryLibraryService.save(lib, createEmptyLibrary());
    expect(invoke).toHaveBeenCalledExactlyOnceWith('saved_queries_save', { library: libraryPayload(lib), expected: createEmptyLibrary() });

    vi.mocked(invoke).mockClear();
    const oversized = library([{ ...entry('e2'), dsl: 'x'.repeat(MAX_ENTRY_DSL_BYTES + 1) }]);
    await expect(desktopQueryLibraryService.save(oversized, createEmptyLibrary())).rejects.toMatchObject({ code: 'invalidInput' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stays unsupported outside the desktop shell instead of degrading', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(desktopQueryLibraryService.load()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(desktopQueryLibraryService.save(createEmptyLibrary(), createEmptyLibrary())).rejects.toMatchObject({ code: 'unsupported' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exports through the typed dialogs contract only', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 'saved' });
    const request = { format: 'csv' as const, fileName: 'escope-orders-20261009-120000.csv', content: 'a\r\n' };
    await expect(desktopQueryLibraryService.saveExportFile(request)).resolves.toEqual({ status: 'saved' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('saved_queries_export', { request });

    vi.mocked(invoke).mockResolvedValue({ status: 'cancelled' });
    await expect(desktopQueryLibraryService.saveExportFile(request)).resolves.toEqual({ status: 'cancelled' });

    vi.mocked(invoke).mockResolvedValue({ status: 'downloaded' });
    await expect(desktopQueryLibraryService.saveExportFile(request)).rejects.toMatchObject({ code: 'invalidResponse' });

    vi.mocked(invoke).mockClear();
    await expect(desktopQueryLibraryService.saveExportFile({ ...request, content: '' }))
      .rejects.toMatchObject({ code: 'invalidInput' });
    await expect(desktopQueryLibraryService.saveExportFile({ ...request, content: '中'.repeat(Math.ceil(MAX_EXPORT_CONTENT_BYTES / 3) + 1) }))
      .rejects.toMatchObject({ code: 'invalidInput' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('session query library adapter', () => {
  it('is explicit memory only and bounded like the desktop contract', async () => {
    const service = createSessionQueryLibraryService();
    expect(service.kind).toBe('session');
    await expect(service.load()).resolves.toEqual(createEmptyLibrary());
    await service.save(library([entry('e1', 'Session draft')]), createEmptyLibrary());
    const loaded = await service.load();
    expect(loaded.entries.map((item) => item.name)).toEqual(['Session draft']);
    (loaded.entries as SavedQueryEntry[]).push(entry('e9'));
    expect((await service.load()).entries).toHaveLength(1);
    await expect(service.save(library([{ ...entry('e2'), dsl: 'x'.repeat(MAX_ENTRY_DSL_BYTES + 1) }]), await service.load()))
      .rejects.toMatchObject({ code: 'invalidInput' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports a browser download request without claiming a disk save', async () => {
    const service = createSessionQueryLibraryService();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    // An environment without object URLs cannot request a download: explicit unsupported.
    Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true });
    try {
      await expect(service.saveExportFile({ format: 'csv', fileName: 'x.csv', content: 'a\r\n' }))
        .rejects.toMatchObject({ code: 'unsupported' });
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else delete (URL as unknown as Record<string, unknown>).createObjectURL;
    }

    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return 'blob:fixture';
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const outcome = await service.saveExportFile({ format: 'jsonl', fileName: 'x.jsonl', content: '{"a":1}\n' });
      expect(outcome).toEqual({ status: 'downloadRequested' });
      expect(click).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]![0];
      expect(blob.type).toBe('application/x-ndjson;charset=utf-8');
      expect(blob.size).toBe(8);
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });
});

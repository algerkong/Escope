import { invoke, isTauri } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  desktopSnapshotExportService, parseSnapshotExportOutcome, parseSnapshotExportProgress,
} from '../../src/services/query-export';
import type { SnapshotExportOutcome, SnapshotExportRequest } from '../../src/domain/query-export';
import fixture from '../fixtures/query-export-v1.json';

const { channels } = vi.hoisted(() => ({ channels: [] as { onmessage: (value: unknown) => void }[] }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(), isTauri: vi.fn(),
  Channel: class {
    onmessage: (value: unknown) => void;
    constructor(onmessage: (value: unknown) => void) {
      this.onmessage = onmessage;
      channels.push(this);
    }
  },
}));
const request = fixture.request as SnapshotExportRequest;
const outcome = fixture.outcome as SnapshotExportOutcome;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { resolve, reject, promise };
}

function start() {
  const response = deferred<unknown>();
  vi.mocked(invoke).mockImplementation(async (command) => command === 'query_export' ? response.promise : true);
  const onProgress = vi.fn();
  const pending = desktopSnapshotExportService.run(request, onProgress);
  return { response, pending, onProgress, channel: channels.at(-1)! };
}

beforeEach(() => {
  vi.resetAllMocks();
  channels.length = 0;
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('restricted full export IPC', () => {
  it('sends only the frozen allowed fields and an owned progress channel', async () => {
    const input = { ...request, path: 'do-not-forward', pitId: 'ui-pit', headers: { extra: 'do-not-forward' } };
    const response = deferred<unknown>();
    vi.mocked(invoke).mockReturnValue(response.promise);
    const onProgress = vi.fn();
    const pending = desktopSnapshotExportService.run(input, onProgress);
    input.index = 'mutated';
    expect(invoke).toHaveBeenCalledExactlyOnceWith('query_export', { request, onEvent: channels[0] });
    const handler = channels[0]!.onmessage;
    handler(fixture.progress);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(fixture.progress);
    response.resolve(outcome);
    await expect(pending).resolves.toEqual(outcome);
    handler({ ...fixture.progress, rows: 3 });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(channels[0]!.onmessage).not.toBe(handler);
  });

  it('never falls back to an in-memory or browser full scan', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(desktopSnapshotExportService.run(request, vi.fn())).rejects.toMatchObject({ code: 'unsupported' });
    await expect(desktopSnapshotExportService.cancel(request)).rejects.toMatchObject({ code: 'unsupported' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects invalid bounds and caller-owned PIT before IPC', async () => {
    for (const patch of [{ maxRows: 0 }, { fileName: '../target.jsonl' }, { rawDsl: '{"pit":{"id":"ui"}}' }]) {
      await expect(desktopSnapshotExportService.run({ ...request, ...patch }, vi.fn())).rejects.toMatchObject({ code: 'invalidInput' });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    { requestId: 'other' }, { connectionId: 'other' }, { phase: 'finished' }, { rows: -1 }, { bytes: 1.5 },
    { rows: request.maxRows + 1 }, { extra: 'not allowed' }, { phase: ['writing'] },
  ])('cancels its own request and refuses a malformed or foreign event: %s', async (patch) => {
    const job = start();
    job.channel.onmessage({ ...fixture.progress, ...patch });
    expect(job.onProgress).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith('query_export_cancel', {
      request: { requestId: request.requestId, connectionId: request.connectionId },
    });
    job.response.resolve(outcome);
    await expect(job.pending).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it.each([{ rows: 1 }, { bytes: 1 }, { phase: 'opening' }])('refuses regressing progress: %s', async (patch) => {
    const job = start();
    job.channel.onmessage(fixture.progress);
    job.channel.onmessage({ ...fixture.progress, ...patch });
    expect(job.onProgress).toHaveBeenCalledTimes(1);
    job.response.resolve(outcome);
    await expect(job.pending).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('reports a terminal outcome, not a cancel acknowledgement, as the file result', async () => {
    const job = start();
    await expect(desktopSnapshotExportService.cancel(request)).resolves.toBe(true);
    const cancelled = { ...outcome, status: 'cancelled', reason: 'cancelled', fileState: 'partial', fileName: 'export.jsonl.partial-fixture' };
    job.response.resolve(cancelled);
    await expect(job.pending).resolves.toEqual(cancelled);
    expect(invoke).toHaveBeenLastCalledWith('query_export_cancel', {
      request: { requestId: request.requestId, connectionId: request.connectionId },
    });
  });

  it('does not invent a terminal file state if IPC fails', async () => {
    const job = start();
    job.response.reject({ code: 'networkError', requestId: request.requestId, retryable: false });
    await expect(job.pending).rejects.toMatchObject({ code: 'networkError' });
    expect(job.onProgress).not.toHaveBeenCalled();
  });

  it('strictly parses shared fixtures, partial files, zero-hit files and cleanup uncertainty', () => {
    expect(parseSnapshotExportProgress(fixture.progress, request)).toEqual(fixture.progress);
    expect(parseSnapshotExportOutcome(outcome, request)).toEqual(outcome);
    expect(parseSnapshotExportOutcome({ ...outcome, rows: 0, bytes: 0, pitCleanup: 'pending' }, request).status).toBe('saved');
    expect(parseSnapshotExportOutcome({
      ...outcome, status: 'limited', reason: 'rowLimit', fileState: 'partial', fileName: 'out.jsonl.partial-fixture',
    }, request).status).toBe('limited');
    expect(parseSnapshotExportOutcome({
      ...outcome, status: 'cancelled', reason: 'cancelled', rows: 0, bytes: 0, fileState: 'none', fileName: null, pitCleanup: 'notOpened',
    }, request).status).toBe('cancelled');
  });

  it.each([
    { requestId: 'other' }, { connectionId: 'other' }, { status: 'downloadRequested' }, { reason: 'secret error' },
    { rows: request.maxRows + 1 }, { bytes: request.maxBytes + 1 }, { fileState: 'partial' }, { reason: 'cancelled' },
    { pitCleanup: 'notOpened' }, { fileName: '../out.jsonl' }, { extra: true },
    { status: 'cancelled', reason: 'cancelled' }, { status: 'partial', reason: 'partialResponse' },
    { status: 'limited', reason: 'networkError', fileState: 'partial' },
    { status: 'cancelled', reason: 'cancelled', fileState: ['partial'], fileName: 'out.partial-fixture' },
    { status: 'cancelled', reason: 'cancelled', fileState: 'partial', fileName: 'out.jsonl' },
    { pitCleanup: ['closed'] },
    { fileState: 'none', fileName: null, rows: 0, bytes: 0 },
  ])('cannot describe an inconsistent response as a completed export: %s', (patch) => {
    expect(() => parseSnapshotExportOutcome({ ...outcome, ...patch }, request)).toThrow();
  });

  it('rejects a terminal count lower than the last accepted progress', async () => {
    const job = start();
    job.channel.onmessage(fixture.progress);
    job.response.resolve({ ...outcome, rows: 1 });
    await expect(job.pending).rejects.toMatchObject({ code: 'invalidResponse' });
  });

  it('refuses non-boolean cancellation responses', async () => {
    vi.mocked(invoke).mockResolvedValue({ cancelled: true });
    await expect(desktopSnapshotExportService.cancel(request)).rejects.toMatchObject({ code: 'invalidResponse' });
  });
});

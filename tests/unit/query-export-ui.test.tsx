import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryResults } from '../../src/features/query/QueryResults';
import type { ExecutionEntry } from '../../src/features/query/useQueryExecutions';
import { parseQueryResult } from '../../src/domain/query-result';
import type { ExecutionSnapshot, QueryDocument } from '../../src/domain/query';
import { i18n } from '../../src/locales';
import { enQueryLibrary, zhQueryLibrary } from '../../src/locales/query-library';
import { enLive, zhLive } from '../../src/locales/query-live';
import { enResultGrid, zhResultGrid } from '../../src/locales/result-grid';
import type { QueryLibraryService } from '../../src/services/query-library';

i18n.addResourceBundle('zh-CN', 'queryLibrary', zhQueryLibrary);
i18n.addResourceBundle('en-US', 'queryLibrary', enQueryLibrary);
i18n.addResourceBundle('zh-CN', 'queryLive', zhLive);
i18n.addResourceBundle('en-US', 'queryLive', enLive);
i18n.addResourceBundle('zh-CN', 'resultGrid', zhResultGrid);
i18n.addResourceBundle('en-US', 'resultGrid', enResultGrid);

const RAW = '{"took":3,"timed_out":false,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},'
  + '"hits":{"total":{"value":1,"relation":"eq"},"max_score":1.0,"hits":['
  + '{"_index":"orders-1","_id":"1","_score":1.0,"_source":{"id":9007199254740993,"name":"a,b"}}]}}';

const parsed = parseQueryResult(RAW);
if (!parsed.ok) throw new Error('fixture must parse');
const summary = parsed.summary;

const snapshot: ExecutionSnapshot = {
  requestId: 'r1', queryId: 'q1', connectionId: 'c1', index: 'orders-1',
  rawDsl: '{}', revision: 0, startedAt: '2026-10-09T12:00:00.000Z',
};

// The draft index is deliberately different from the execution snapshot index: export names come
// from the snapshot, never from the mutable draft.
const DOC: QueryDocument = { id: 'q1', connectionId: 'c1', name: '', index: 'draft-changed', dsl: '{}', revision: 0, resultView: 'table' };

function execution(partial = false, pageRaw = RAW): ExecutionEntry {
  return {
    state: partial ? { status: 'partial', snapshot, rawResponse: pageRaw } : { status: 'success', snapshot, rawResponse: pageRaw },
    parsed: { ok: true, summary },
    endpoint: 'https://es.test', rawResponse: pageRaw,
    pages: [{ rawResponse: pageRaw, summary, partial, cursor: null }],
    pitId: null, continuing: false, continuationError: null,
  };
}

function running(): ExecutionEntry {
  return {
    state: { status: 'running', snapshot }, parsed: null, endpoint: 'https://es.test',
    rawResponse: null, pages: [], pitId: null, continuing: false, continuationError: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fakeExport(impl: (request: { format: 'csv' | 'jsonl'; fileName: string; content: string }) => Promise<{ status: 'saved' | 'cancelled' | 'downloadRequested' }>): QueryLibraryService {
  return {
    kind: 'session',
    load: vi.fn(async () => ({ version: 1, entries: [] })),
    save: vi.fn(async () => {}),
    saveExportFile: vi.fn(impl),
  };
}

function renderResults(exportService: QueryLibraryService | undefined, entry: ExecutionEntry) {
  return <I18nextProvider i18n={i18n}>
    <QueryResults query={DOC} entry={entry} available stale={false} endpointChanged={false}
      onCancel={() => {}} onRun={() => {}} onViewChange={() => {}} onLoadMore={() => {}}
      exportService={exportService} />
  </I18nextProvider>;
}

function setup(exportService?: QueryLibraryService, partial = false, pageRaw: string = RAW) {
  const view = render(renderResults(exportService, execution(partial, pageRaw)));
  return {
    user: userEvent.setup(),
    show: (next: ExecutionEntry) => view.rerender(renderResults(exportService, next)),
  };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '导出已加载结果' }));
  return screen.findByRole('dialog', { name: '导出已加载结果' });
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('loaded-result export dialog', () => {
  it('keeps export invisible without an injected service', async () => {
    setup();
    expect(screen.queryByRole('button', { name: '导出已加载结果' })).not.toBeInTheDocument();
  });

  it('exports the loaded CSV with the exact numeric token and reports the disk result', async () => {
    const service = fakeExport(async () => ({ status: 'saved' }));
    const { user } = setup(service);
    const dialog = await openDialog(user);
    expect(within(dialog).getByText('1 行')).toBeVisible();
    const name = within(dialog).getByLabelText('文件名') as HTMLInputElement;
    expect(name.value).toMatch(/^escope-orders-1-\d{8}-\d{6}\.csv$/);
    expect(within(dialog).getByRole('button', { name: 'CSV' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    await waitFor(() => expect(service.saveExportFile).toHaveBeenCalledTimes(1));
    const request = vi.mocked(service.saveExportFile).mock.calls[0]![0];
    expect(request.format).toBe('csv');
    expect(request.fileName).toBe(name.value);
    expect(request.content).toContain('9007199254740993');
    expect(request.content).toContain('"a,b"');
    expect(request.content.split('\r\n')[0]).toBe('_index,_id,id,name');
    expect(await within(dialog).findByText('文件已保存。')).toBeVisible();
  });

  it('switches to JSONL and exports one raw hit per line from the loaded page only', async () => {
    const service = fakeExport(async () => ({ status: 'saved' }));
    const { user } = setup(service);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'JSONL' }));
    const name = within(dialog).getByLabelText('文件名') as HTMLInputElement;
    expect(name.value).toMatch(/\.jsonl$/);
    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    await waitFor(() => expect(service.saveExportFile).toHaveBeenCalledTimes(1));
    const request = vi.mocked(service.saveExportFile).mock.calls[0]![0];
    expect(request.format).toBe('jsonl');
    expect(request.content).toContain('"_score":1.0');
    expect(request.content).toContain('9007199254740993');
    expect(request.content.endsWith('\n')).toBe(true);
    expect(request.content.trimEnd().split('\n')).toHaveLength(1);
  });

  it('binds the export to the snapshot shown when the dialog opened', async () => {
    const service = fakeExport(async () => ({ status: 'saved' }));
    const { user, show } = setup(service);
    const dialog = await openDialog(user);
    expect(within(dialog).getByText('1 行')).toBeVisible();

    const grown = execution();
    show({ ...grown, pages: [...grown.pages, ...grown.pages] });
    expect(within(dialog).getByText('1 行')).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    await waitFor(() => expect(service.saveExportFile).toHaveBeenCalledTimes(1));
    const content = vi.mocked(service.saveExportFile).mock.calls[0]![0].content;
    expect(content.split('\r\n').filter((line) => line !== '')).toHaveLength(2);
  });

  it('guards a second submission and keeps the dialog open while the write is pending', async () => {
    const pending = deferred<{ status: 'saved' }>();
    const service = fakeExport(async () => ({ status: 'saved' }));
    vi.mocked(service.saveExportFile).mockReturnValueOnce(pending.promise);
    const { user } = setup(service);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    await waitFor(() => expect(service.saveExportFile).toHaveBeenCalledTimes(1));

    expect(within(dialog).getByRole('button', { name: 'JSONL' })).toBeDisabled();
    expect(within(dialog).getByLabelText('文件名')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    // The modal close affordance cannot drop a write that is already running.
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(screen.getByRole('dialog', { name: '导出已加载结果' })).toBeVisible();
    expect(service.saveExportFile).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve({ status: 'saved' }); });
    expect(await within(dialog).findByText('文件已保存。')).toBeVisible();
  });

  it('ignores a late completion after the execution changed and the dialog reopened', async () => {
    const pending = deferred<{ status: 'saved' }>();
    const service = fakeExport(async () => ({ status: 'saved' }));
    vi.mocked(service.saveExportFile).mockReturnValueOnce(pending.promise);
    const { user, show } = setup(service);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    await waitFor(() => expect(service.saveExportFile).toHaveBeenCalledTimes(1));

    // The displayed execution changes (running): the dialog is force-closed by the results surface.
    show(running());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出已加载结果' })).not.toBeInTheDocument());
    show(execution());
    const reopened = await openDialog(user);
    await act(async () => { pending.resolve({ status: 'saved' }); });
    expect(within(reopened).queryByText('文件已保存。')).not.toBeInTheDocument();

    await user.click(within(reopened).getByRole('button', { name: '导出' }));
    await waitFor(() => expect(service.saveExportFile).toHaveBeenCalledTimes(2));
    expect(await within(reopened).findByText('文件已保存。')).toBeVisible();
  });

  it('refuses a JSONL export that cannot reproduce every shown row', async () => {
    const service = fakeExport(async () => ({ status: 'saved' }));
    const { user } = setup(service, false, 'not json');
    const dialog = await openDialog(user);
    expect(within(dialog).getByText('1 行')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'JSONL' }));
    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    expect(await within(dialog).findByText('已加载的响应无法精确导出，未写入任何文件。')).toBeVisible();
    expect(service.saveExportFile).not.toHaveBeenCalled();
  });

  it('reports cancellation without claiming a disk save', async () => {
    const service = fakeExport(async () => ({ status: 'cancelled' }));
    const { user } = setup(service);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    expect(await within(dialog).findByText('已取消导出。')).toBeVisible();
    expect(within(dialog).queryByText('文件已保存。')).not.toBeInTheDocument();
  });

  it('reports an export failure without claiming a disk save', async () => {
    const service = fakeExport(async () => { throw { code: 'storageUnavailable', requestId: null, retryable: false }; });
    const { user } = setup(service);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    expect(await within(dialog).findByText('导出失败。')).toBeVisible();
    expect(within(dialog).queryByText('文件已保存。')).not.toBeInTheDocument();
  });

  it('marks a browser download request and partial results explicitly', async () => {
    const service = fakeExport(async () => ({ status: 'downloadRequested' }));
    const { user } = setup(service, true);
    const dialog = await openDialog(user);
    expect(within(dialog).getByText('当前为部分结果，导出文件只包含已显示的行。')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: '导出' }));
    expect(await within(dialog).findByText('已请求浏览器下载；未验证文件是否写入磁盘。')).toBeVisible();
    expect(within(dialog).queryByText('文件已保存。')).not.toBeInTheDocument();
  });
});

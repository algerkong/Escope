import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotExportDialog } from '../../src/features/query/SnapshotExportDialog';
import type { SnapshotExportOutcome, SnapshotExportProgress, SnapshotExportSource } from '../../src/domain/query-export';
import type { SnapshotExportService } from '../../src/services/query-export';
import { i18n } from '../../src/locales';
import fixture from '../fixtures/query-export-v1.json';

const source: SnapshotExportSource = {
  queryId: 'tab-fixture', connectionId: fixture.request.connectionId, connectionName: 'Original connection',
  endpoint: fixture.request.expectedEndpoint, index: fixture.request.index, rawDsl: fixture.request.rawDsl,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { resolve, reject, promise };
}

function setup() {
  const result = deferred<SnapshotExportOutcome>();
  const service: SnapshotExportService = {
    available: true, run: vi.fn(() => result.promise), cancel: vi.fn(async () => true),
  };
  const onClose = vi.fn();
  const content = (nextSource = source, targetAvailable = true) => <I18nextProvider i18n={i18n}>
    <SnapshotExportDialog source={nextSource} service={service} targetAvailable={targetAvailable} onClose={onClose} />
  </I18nextProvider>;
  const view = render(content());
  const user = userEvent.setup();
  const getRequest = () => vi.mocked(service.run).mock.calls[0]![0];
  const progress = (patch: Partial<SnapshotExportProgress> = {}) => {
    const request = getRequest();
    act(() => vi.mocked(service.run).mock.calls[0]![1]({
      requestId: request.requestId, connectionId: request.connectionId, phase: 'writing', rows: 2, bytes: 256, ...patch,
    }));
  };
  const finish = async (patch: Partial<SnapshotExportOutcome> = {}) => {
    const request = getRequest();
    await act(async () => {
      result.resolve({
        ...fixture.outcome as SnapshotExportOutcome, requestId: request.requestId, connectionId: request.connectionId,
        fileName: request.fileName, ...patch,
      });
    });
  };
  return { user, service, result, onClose, getRequest, progress, finish,
    rerender: (nextSource = source, available = true) => view.rerender(content(nextSource, available)),
    unmount: view.unmount,
  };
}

const start = () => screen.getByRole('button', { name: '选择文件并导出' });

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

describe('full export confirmation and lifecycle', () => {
  it('does not query on opening, reviewing, editing options or changing language', async () => {
    const job = setup();
    expect(job.service.run).not.toHaveBeenCalled();
    expect(screen.getByText(source.index)).toBeVisible();
    expect(screen.getByText(source.endpoint)).toBeVisible();
    await job.user.click(screen.getByText('最终 DSL'));
    expect(screen.getByText(/9007199254740993/, { selector: 'pre' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('每批行数'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('行数上限'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('文件上限 (MiB)'), { target: { value: '8' } });
    await job.user.click(screen.getByRole('button', { name: 'JSONL' }));
    expect(job.service.run).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage('en-US'); });
    expect(screen.getByRole('dialog', { name: 'Full snapshot export' })).toBeVisible();
    await job.user.click(screen.getByRole('button', { name: 'Choose file and export' }));
    const request = job.getRequest();
    expect(request).toMatchObject({
      expectedEndpoint: source.endpoint, connectionId: source.connectionId, index: source.index,
      maxRows: 60, maxBytes: 8 * 1024 * 1024, format: 'jsonl',
    });
    expect(request.rawDsl).toContain('"size": 20');
    expect(request.rawDsl).toContain('9007199254740993');
    await job.finish();
    job.progress({ rows: 3 });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('All matching documents were saved.')).toBeVisible();
  });

  it('freezes source and guards double submission and close while the job is running', async () => {
    const job = setup();
    job.rerender({ ...source, endpoint: 'https://replacement.test', index: 'other', rawDsl: '{}' });
    fireEvent.click(start());
    fireEvent.click(start());
    expect(job.service.run).toHaveBeenCalledTimes(1);
    expect(job.getRequest()).toMatchObject({ index: source.index, expectedEndpoint: source.endpoint });
    expect(start()).toBeDisabled();
    expect(screen.getByLabelText('文件名')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'JSONL' })).toBeDisabled();
    await job.user.click(screen.getByRole('button', { name: '关闭' }));
    expect(job.onClose).not.toHaveBeenCalled();
    await job.finish();
    expect(screen.getByText('全部匹配文档已保存。')).toBeVisible();
  });

  it('keeps foreign progress away from this dialog and reports counts without guessing a percentage', async () => {
    const job = setup();
    await job.user.click(start());
    job.progress({ requestId: 'foreign', rows: 999 });
    expect(screen.queryByText(/999 行/)).not.toBeInTheDocument();
    job.progress();
    expect(screen.getByText('2 行 · 256 字节')).toBeVisible();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');
    await job.finish();
  });

  it('waits for a terminal cancellation and exposes the actual partial file', async () => {
    const job = setup();
    await job.user.click(start());
    job.progress();
    await job.user.click(screen.getByRole('button', { name: '取消导出' }));
    expect(job.service.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '正在取消' })).toBeDisabled();
    expect(screen.queryByText('导出已取消，未确认完整文件。')).not.toBeInTheDocument();
    await job.finish({ status: 'cancelled', reason: 'cancelled', fileState: 'partial', fileName: 'chosen.csv.partial-fixture' });
    expect(screen.getByText('导出已取消，未确认完整文件。')).toBeVisible();
    expect(screen.getByText('chosen.csv.partial-fixture')).toBeVisible();
    expect(screen.queryByText('全部匹配文档已保存。')).not.toBeInTheDocument();
  });

  it('allows a failed cancel to be retried without starting another export', async () => {
    const job = setup();
    vi.mocked(job.service.cancel).mockRejectedValueOnce({ code: 'networkError' });
    await job.user.click(start());
    await job.user.click(screen.getByRole('button', { name: '取消导出' }));
    expect(await screen.findByText('取消请求未确认，导出可能仍在运行。')).toBeVisible();
    await job.user.click(screen.getByRole('button', { name: '取消导出' }));
    expect(job.service.cancel).toHaveBeenCalledTimes(2);
    expect(job.service.run).toHaveBeenCalledTimes(1);
    await job.finish({ status: 'cancelled', reason: 'cancelled', fileState: 'none', fileName: null, rows: 0, bytes: 0, pitCleanup: 'notOpened' });
  });

  it('cancels once if the original tab or target vanishes and never rebinds after it returns', async () => {
    const job = setup();
    await job.user.click(start());
    job.rerender(source, false);
    await waitFor(() => expect(job.service.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getByText('原标签或连接目标已不可用，不能启动或继续此导出。')).toBeVisible();
    job.rerender(source, true);
    await job.finish({ status: 'cancelled', reason: 'cancelled', fileState: 'partial', fileName: 'chosen.csv.partial-fixture' });
    expect(start()).toBeDisabled();
    expect(job.service.run).toHaveBeenCalledTimes(1);
  });

  it('cancels on unmount and cannot leak a late completion into a new opening', async () => {
    const first = setup();
    await first.user.click(start());
    first.unmount();
    expect(first.service.cancel).toHaveBeenCalledTimes(1);
    const second = setup();
    await first.finish();
    expect(screen.queryByText('全部匹配文档已保存。')).not.toBeInTheDocument();
    expect(second.service.run).not.toHaveBeenCalled();
    expect(start()).toBeEnabled();
  });

  it.each([
    ['limited', 'rowLimit', '达到导出上限，文件不完整。', '已达到行数上限。'],
    ['limited', 'byteLimit', '达到导出上限，文件不完整。', '已达到文件大小上限。'],
    ['limited', 'deadline', '达到导出上限，文件不完整。', '已达到 30 分钟时限。'],
    ['partial', 'partialResponse', '集群返回部分结果，文件不完整。', '响应超时、提前终止或存在失败分片。'],
    ['failed', 'exportFailed', '导出失败，未确认完整文件。', '文件创建、写入或最终保存失败。'],
  ] as const)('does not present %s / %s as a complete file', async (status, reason, heading, detail) => {
    const job = setup();
    await job.user.click(start());
    await job.finish({ status, reason, fileState: 'partial', fileName: 'chosen.csv.partial-fixture' });
    expect(screen.getByText(heading)).toBeVisible();
    expect(screen.getByText(detail)).toBeVisible();
    expect(screen.queryByText('全部匹配文档已保存。')).not.toBeInTheDocument();
  });

  it('shows an unconfirmed file state after an IPC failure, never a fabricated cancellation', async () => {
    const job = setup();
    await job.user.click(start());
    await act(async () => { job.result.reject({ code: 'invalidResponse' }); });
    expect(screen.getByText('文件状态未确认，请检查保存位置及 .partial 文件。')).toBeVisible();
    expect(screen.queryByText('未创建文件。')).not.toBeInTheDocument();
    expect(screen.queryByText('全部匹配文档已保存。')).not.toBeInTheDocument();
  });

  it('keeps cleanup uncertainty visible even when the complete file was saved', async () => {
    const job = setup();
    await job.user.click(start());
    await job.finish({ pitCleanup: 'pending' });
    expect(screen.getByText('全部匹配文档已保存。')).toBeVisible();
    expect(screen.getByText('PIT 关闭未确认，将等待集群过期；不会复用该 PIT。')).toBeVisible();
  });

  it('refuses invalid options and unsupported queries without any service call', async () => {
    const job = setup();
    fireEvent.change(screen.getByLabelText('文件名'), { target: { value: '../file.csv' } });
    expect(start()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('文件名'), { target: { value: 'file.csv' } });
    fireEvent.change(screen.getByLabelText('每批行数'), { target: { value: '0' } });
    expect(start()).toBeDisabled();
    expect(job.service.run).not.toHaveBeenCalled();
    job.unmount();
    const service = { available: true, run: vi.fn(), cancel: vi.fn() };
    render(<I18nextProvider i18n={i18n}><SnapshotExportDialog
      source={{ ...source, rawDsl: '{"aggs":{}}' }} service={service} targetAvailable onClose={() => {}} /></I18nextProvider>);
    expect(within(screen.getByRole('dialog')).getByText('该查询包含不支持全量扫描的设置，未修改原查询。')).toBeVisible();
    expect(start()).toBeDisabled();
    expect(service.run).not.toHaveBeenCalled();
  });

  it('does not show a foreign terminal response as saved', async () => {
    const job = setup();
    await job.user.click(start());
    await job.finish({ requestId: 'foreign' });
    expect(screen.queryByText('全部匹配文档已保存。')).not.toBeInTheDocument();
    expect(screen.getByText('文件状态未确认，请检查保存位置及 .partial 文件。')).toBeVisible();
  });
});

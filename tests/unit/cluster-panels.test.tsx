import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../../src/app/SettingsView';
import type { ConnectionProfile } from '../../src/domain/connection';
import { defaultPreferences } from '../../src/domain/preferences';
import { ClusterOverview } from '../../src/features/cluster/ClusterOverview';
import { ClusterResource } from '../../src/features/cluster/ClusterResource';
import { IndicesPanel } from '../../src/features/cluster/IndicesPanel';
import { NodesPanel } from '../../src/features/cluster/NodesPanel';
import { ShardsPanel } from '../../src/features/cluster/ShardsPanel';
import { i18n } from '../../src/locales';
import { enCluster, zhCluster } from '../../src/locales/cluster';
import type { ClusterBackend, ClusterCancelRequest, ClusterReadRequest, ClusterReadResponse } from '../../src/services/cluster';

// The cluster bundle is registered by `locales/index.ts`; the test registers it locally so no
// public setup or shared locale file has to change for this feature.
i18n.addResourceBundle('zh-CN', 'cluster', zhCluster);
i18n.addResourceBundle('en-US', 'cluster', enCluster);

const CONNECTION = '8d1c0f5e-2a3b-4c5d-8e9f-0a1b2c3d4e5f';
const ENDPOINT = 'http://fixture.test:9200';
const profile: ConnectionProfile = {
  id: CONNECTION, displayName: '本地集群', endpoint: ENDPOINT, environment: 'development', sortOrder: 0, auth: 'none',
};

const HEALTH = '{"cluster_name":"fixture","status":"yellow","timed_out":false,"number_of_nodes":3,' +
  '"number_of_data_nodes":3,"active_primary_shards":10,"active_shards":10,"relocating_shards":0,' +
  '"initializing_shards":1,"unassigned_shards":10,"delayed_unassigned_shards":0,"number_of_pending_tasks":0,' +
  '"number_of_in_flight_fetch":0,"active_shards_percent_as_number":50.0,"task_max_waiting_in_queue_millis":0}';
const HEALTH_RED = HEALTH.replace('"status":"yellow"', '"status":"red"');
const HEALTH_SPARSE = '{"status":"green","number_of_nodes":3}';
const NODES = '{"_nodes":{"total":2,"successful":2,"failed":0},"cluster_name":"fixture","nodes":{' +
  '"n2":{"name":"node-b","roles":[],"jvm":{"mem":{"heap_used_percent":10,' +
  '"heap_used_in_bytes":1,"heap_max_in_bytes":2}},"thread_pool":{"search":{"rejected":0}}},' +
  '"n1":{"name":"node-a","transport_address":"127.0.0.1:9300",' +
  '"host":"127.0.0.1","roles":["data","master"],"jvm":{"mem":{"heap_used_percent":42,' +
  '"heap_used_in_bytes":268435456,"heap_max_in_bytes":536870912}},"os":{"cpu":{"percent":-1,' +
  '"load_average":{"1m":0.5}}},"fs":{"total":{"total_in_bytes":1000,"available_in_bytes":400}},' +
  '"thread_pool":{"search":{"rejected":3},"write":{"rejected":0}}}}}';
const NODES_PARTIAL = NODES.replace('"_nodes":{"total":2,"successful":2,"failed":0}', '"_nodes":{"total":3,"successful":2,"failed":1}');
const NODES_REPLACED = '{"_nodes":{"total":1,"successful":1,"failed":0},"nodes":{"n1":{"name":"node-a",' +
  '"host":"10.0.0.9","roles":["data"],"jvm":{"mem":{"heap_used_percent":7,' +
  '"heap_used_in_bytes":9,"heap_max_in_bytes":10}},"thread_pool":{"search":{"rejected":1}}}}}';
const SHARDS = '[{"index":"orders","shard":"0","prirep":"p","state":"STARTED","docs":42,"store":"1kb",' +
  '"ip":"127.0.0.1","node":"n1"},{"index":"orders","shard":"0","prirep":"r","state":"UNASSIGNED",' +
  '"docs":null,"store":null,"ip":null,"node":null,"unassigned.reason":"NODE_LEFT"},' +
  '{"index":"logs","shard":"1","prirep":"p","state":"INITIALIZING","docs":"0","store":"0b","ip":"10.0.0.2","node":"n2"}]';
const CATALOG = '{"indices":[{"name":"orders","aliases":["orders-alias"],"attributes":["open"]},' +
  '{"name":".security","aliases":[],"attributes":["open","hidden"]}],' +
  '"aliases":[{"name":"orders-alias","indices":["orders"]}],' +
  '"data_streams":[{"name":"logs","backing_indices":[".ds-logs-000001"],"timestamp_field":"@timestamp"}]}';
const MAPPING = '{"orders":{"mappings":{"properties":{"id":{"type":"keyword"},"amount":{"type":"long"}}}}}';
const SETTINGS = '{"orders":{"settings":{"index":{"number_of_shards":"3"}}}}';

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

interface Fake {
  backend: ClusterBackend;
  calls: ClusterReadRequest[];
  cancelled: ClusterCancelRequest[];
  endpoint: string;
}

function fakeBackend(bodies: Partial<Record<ClusterReadRequest['resource'], string>>, failing: ClusterReadRequest['resource'][] = []): Fake {
  const calls: ClusterReadRequest[] = [];
  const cancelled: ClusterCancelRequest[] = [];
  const fake = {
    calls,
    cancelled,
    endpoint: ENDPOINT,
  } as Fake;
  fake.backend = {
    read: (request) => {
      calls.push(request);
      if (failing.includes(request.resource)) {
        return Promise.reject({ code: 'serverForbidden', requestId: request.requestId, retryable: false });
      }
      const body = bodies[request.resource];
      if (body === undefined) return Promise.reject({ code: 'networkError', requestId: request.requestId, retryable: false });
      return Promise.resolve({ requestId: request.requestId, connectionId: request.connectionId, endpoint: fake.endpoint, rawResponse: body });
    },
    cancel: (request) => {
      cancelled.push(request);
      return Promise.resolve(true);
    },
  };
  return fake;
}

/** Reads stay pending until the test resolves them, so cancellation and staleness are testable. */
function deferredBackend(cancelConfirmed = true) {
  const calls: ClusterReadRequest[] = [];
  const cancelled: ClusterCancelRequest[] = [];
  const pending = new Map<string, (raw: string) => void>();
  const state = { endpoint: ENDPOINT };
  const backend: ClusterBackend = {
    read: (request) => new Promise<ClusterReadResponse>((resolve) => {
      calls.push(request);
      pending.set(request.requestId, (raw) => resolve({
        requestId: request.requestId, connectionId: request.connectionId, endpoint: state.endpoint, rawResponse: raw,
      }));
    }),
    cancel: (request) => {
      cancelled.push(request);
      return Promise.resolve(cancelConfirmed);
    },
  };
  return { backend, calls, cancelled, pending, state };
}

/** One metric row of the health overview. */
function metric(label: string): string {
  const term = screen.getByText(label);
  return term.parentElement?.querySelector('dd')?.textContent ?? '';
}

/** The catalog row whose name cell is exactly `name`; alias info can repeat the same text. */
function catalogRow(table: HTMLElement, name: string): HTMLElement {
  const cell = within(table).getAllByRole('cell')
    .find((element) => element.classList.contains('cluster-strong') && element.textContent === name);
  if (!cell) throw new Error(`no catalog row for ${name}`);
  return cell.closest('tr')!;
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('cluster overview', () => {
  it('reads once on entry and explains what the allocation status means', async () => {
    const { backend, calls } = fakeBackend({ clusterHealth: HEALTH });
    renderWithI18n(<ClusterOverview connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    expect(await screen.findByText('黄色')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ connectionId: CONNECTION, resource: 'clusterHealth' });
    expect(calls[0]?.index).toBeUndefined();
    expect(screen.getByText(/副本分片未分配/)).toBeInTheDocument();
    expect(metric('未分配分片')).toBe('10');
    expect(metric('活动分片比例')).toBe('50.0%');
    expect(metric('节点')).toBe('3');
    // Green/yellow/red describe allocation, never performance.
    expect(screen.getByText(/健康状态只描述分片分配情况/)).toBeInTheDocument();
  });

  it('shows unknown instead of zero for a metric the server did not report', async () => {
    const { backend } = fakeBackend({ clusterHealth: HEALTH_SPARSE });
    renderWithI18n(<ClusterOverview connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    expect(await screen.findByText('绿色')).toBeInTheDocument();
    expect(metric('未分配分片')).toBe('未知');
    expect(metric('活动分片')).toBe('未知');
    expect(screen.getByText(/主分片与副本分片均已分配/)).toBeInTheDocument();
  });

  it('reports an unreadable body instead of showing an empty overview', async () => {
    const user = userEvent.setup();
    const { backend, calls } = fakeBackend({ clusterHealth: 'not json' });
    renderWithI18n(<ClusterOverview connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    expect(await screen.findByText('无法将响应解析为预期的元数据。')).toBeInTheDocument();
    expect(screen.queryByText('绿色')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(calls).toHaveLength(2);
  });

  it('cancels the in-flight read and drops its response', async () => {
    const user = userEvent.setup();
    const { backend, calls, cancelled, pending } = deferredBackend();
    renderWithI18n(<ClusterOverview connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    await screen.findByText('正在加载…');
    await user.click(screen.getByRole('button', { name: '取消请求' }));
    expect(await screen.findByText('已丢弃该响应。')).toBeInTheDocument();
    expect(cancelled).toEqual([{ requestId: calls[0]!.requestId, connectionId: CONNECTION }]);
    await act(async () => { pending.get(calls[0]!.requestId)!(HEALTH); });
    expect(screen.queryByText('黄色')).not.toBeInTheDocument();
    expect(screen.getByText('已丢弃该响应。')).toBeInTheDocument();
  });

  it('reports an unconfirmed cancellation instead of claiming the request stopped', async () => {
    const user = userEvent.setup();
    const { backend } = deferredBackend(false);
    renderWithI18n(<ClusterOverview connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    await screen.findByText('正在加载…');
    await user.click(screen.getByRole('button', { name: '取消请求' }));
    expect(await screen.findByText(/后端未确认取消/)).toBeInTheDocument();
  });

  it('invalidates and cancels the previous target when the endpoint changes', async () => {
    const { backend, calls, cancelled, pending, state } = deferredBackend();
    const view = renderWithI18n(<ClusterOverview connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    await screen.findByText('正在加载…');
    state.endpoint = 'http://other.test:9200';
    view.rerender(<I18nextProvider i18n={i18n}>
      <ClusterOverview connectionId={CONNECTION} endpoint="http://other.test:9200" backend={backend} />
    </I18nextProvider>);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.requestId).toBe(calls[0]?.requestId);
    await act(async () => { pending.get(calls[0]!.requestId)!(HEALTH); });
    expect(screen.queryByText('黄色')).not.toBeInTheDocument();
    await act(async () => { pending.get(calls[1]!.requestId)!(HEALTH_RED); });
    expect(await screen.findByText('红色')).toBeInTheDocument();
    expect(screen.getByText(/主分片未分配/)).toBeInTheDocument();
  });
});

describe('cluster resource entry', () => {
  it('offers the connection entry when no connection is selected', async () => {
    const user = userEvent.setup();
    const onAddConnection = vi.fn();
    const { backend, calls } = fakeBackend({ clusterHealth: HEALTH });
    renderWithI18n(<ClusterResource route="cluster" profile={null} desktop testLabel="尚未测试"
      backend={backend} onAddConnection={onAddConnection} />);
    await user.click(screen.getByRole('button', { name: '添加连接' }));
    expect(onAddConnection).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('states that live metadata needs the desktop app instead of showing fixture data', async () => {
    const { backend, calls } = fakeBackend({ clusterHealth: HEALTH });
    renderWithI18n(<ClusterResource route="cluster" profile={profile} desktop={false} testLabel="身份已确认"
      backend={backend} onAddConnection={() => {}} />);
    expect(await screen.findByText(/实时集群元数据需要桌面应用/)).toBeInTheDocument();
    expect(screen.getByText('本地集群')).toBeInTheDocument();
    expect(screen.getByText(ENDPOINT)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('renders live metadata inside the settings container instead of a placeholder', async () => {
    const { backend } = fakeBackend({ clusterHealth: HEALTH });
    renderWithI18n(<SettingsView route="cluster" navigate={() => {}} back={() => {}} preferences={defaultPreferences}
      updatePreferences={() => {}} connections={[profile]} activeId={CONNECTION} busy={false} canTest
      testResults={{}} testConnection={() => {}} selectConnection={async () => {}} saveConnection={async () => {}}
      deleteConnection={async () => {}} clusterBackend={backend} />);
    expect(await screen.findByText('黄色')).toBeInTheDocument();
    expect(screen.queryByText(/当前构建尚未接入资源发现/)).not.toBeInTheDocument();
    // The fixed settings sidebar stays in place.
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});

describe('nodes', () => {
  it('shows the reported metrics, an unavailable CPU as unknown, and cumulative rejections', async () => {
    const { backend } = fakeBackend({ nodesStats: NODES });
    renderWithI18n(<NodesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    const first = (await screen.findByText('node-a')).closest('tr')!;
    expect(within(first).getByText('42%')).toBeInTheDocument();
    expect(within(first).getByText('268435456 / 536870912 B')).toBeInTheDocument();
    expect(within(first).getByText('data')).toBeInTheDocument();
    expect(within(first).getByText('search 3')).toBeInTheDocument();
    // `os.cpu.percent: -1` is a missing measurement, so this row shows exactly one unknown value.
    expect(within(first).getAllByText('未知')).toHaveLength(1);
    const second = screen.getByText('node-b').closest('tr')!;
    expect(within(second).getByText('10%')).toBeInTheDocument();
    // Roles, CPU, load and both file-system counters are unreported for node-b; its one reported
    // pool has a cumulative `rejected` of 0, which is a value, not an unknown.
    expect(within(second).getByText('0')).toBeInTheDocument();
    expect(within(second).getAllByText('未知')).toHaveLength(5);
    expect(screen.getByText(/拒绝数是节点启动以来 thread_pool.\*\.rejected 的累计值/)).toBeInTheDocument();
  });

  it('states a partial _nodes answer instead of showing it as complete', async () => {
    const { backend } = fakeBackend({ nodesStats: NODES_PARTIAL });
    renderWithI18n(<NodesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    await screen.findByText('node-a');
    expect(screen.getByRole('status')).toHaveTextContent('_nodes 报告 3 个节点中 2 个成功、1 个失败');
    // The nodes that answered stay visible.
    expect(screen.getByText('node-a')).toBeInTheDocument();
    expect(screen.getByText('node-b')).toBeInTheDocument();
  });

  it('reports unknown completeness when the _nodes summary is unusable', async () => {
    const { backend } = fakeBackend({ nodesStats: NODES.replace('"_nodes":{"total":2,"successful":2,"failed":0},', '') });
    renderWithI18n(<NodesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    expect(await screen.findByText(/_nodes 汇总缺失或不可用/)).toBeInTheDocument();
    expect(screen.getByText('node-a')).toBeInTheDocument();
  });

  it('filters and pages a large node list locally', async () => {
    const user = userEvent.setup();
    const many = `{"_nodes":{"total":150,"successful":150,"failed":0},"nodes":{${Array.from({ length: 150 }, (_, position) =>
      `"n${position}":{"name":"node-${position}","roles":[],"thread_pool":{"search":{"rejected":0}}}`).join(',')}}}`;
    const { backend } = fakeBackend({ nodesStats: many });
    renderWithI18n(<NodesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    await screen.findByText('node-0');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(101);
    expect(screen.getByText('已显示 150 行中的 100 行。')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('按节点名或 ID 筛选'), 'node-149');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByPlaceholderText('按节点名或 ID 筛选'));
    await user.type(screen.getByPlaceholderText('按节点名或 ID 筛选'), 'nothing-here');
    expect(screen.getByText('没有节点符合当前筛选条件。')).toBeInTheDocument();
  });

  it('opens the verbatim JSON of the node the user asked for', async () => {
    const user = userEvent.setup();
    const { backend } = fakeBackend({ nodesStats: NODES });
    renderWithI18n(<NodesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    const first = (await screen.findByText('node-a')).closest('tr')!;
    await user.click(within(first).getByRole('button', { name: '查看原始 JSON' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('节点 node-a')).toBeInTheDocument();
    expect(within(dialog).getByText(/"name":"node-a"/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/"name":"node-b"/)).not.toBeInTheDocument();
  });

  it('binds the detail to the response it was opened from', async () => {
    const user = userEvent.setup();
    const bodies = [NODES, NODES_REPLACED];
    let call = 0;
    const backend: ClusterBackend = {
      read: (request) => Promise.resolve({
        requestId: request.requestId, connectionId: request.connectionId, endpoint: ENDPOINT,
        rawResponse: bodies[Math.min(call++, bodies.length - 1)]!,
      }),
      cancel: () => Promise.resolve(true),
    };
    renderWithI18n(<NodesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    await user.click(within((await screen.findByText('node-a')).closest('tr')!).getByRole('button', { name: '查看原始 JSON' }));
    expect(within(await screen.findByRole('dialog')).getByText(/"host":"127.0.0.1"/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Refreshing replaces the body; the detail is re-bound to the new body instead of slicing it
    // with the previous response's offsets.
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByText('node-a');
    await user.click(within((await screen.findByText('node-a')).closest('tr')!).getByRole('button', { name: '查看原始 JSON' }));
    const reopened = await screen.findByRole('dialog');
    expect(within(reopened).getByText(/"host":"10.0.0.9"/)).toBeInTheDocument();
    expect(within(reopened).queryByText(/"host":"127.0.0.1"/)).not.toBeInTheDocument();
  });

  it('drops the detail when the target changes', async () => {
    const user = userEvent.setup();
    const fake = fakeBackend({ nodesStats: NODES });
    const view = renderWithI18n(<ClusterResource route="nodes" profile={profile} desktop testLabel="身份已确认"
      backend={fake.backend} onAddConnection={() => {}} />);
    await user.click(within((await screen.findByText('node-a')).closest('tr')!).getByRole('button', { name: '查看原始 JSON' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fake.endpoint = 'http://other.test:9200';
    view.rerender(<I18nextProvider i18n={i18n}>
      <ClusterResource route="nodes" profile={{ ...profile, endpoint: 'http://other.test:9200' }} desktop
        testLabel="身份已确认" backend={fake.backend} onAddConnection={() => {}} />
    </I18nextProvider>);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The new target reads on its own and keeps no state from the previous one.
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1]?.connectionId).toBe(CONNECTION);
  });
});

describe('shards', () => {
  it('labels primary and replica, keeps the unassigned reason, and filters by index and state', async () => {
    const user = userEvent.setup();
    const { backend } = fakeBackend({ shards: SHARDS });
    renderWithI18n(<ShardsPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('主分片')).toHaveLength(2);
    expect(within(table).getByText('副本')).toBeInTheDocument();
    expect(within(table).getByText('NODE_LEFT')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    await user.type(screen.getByPlaceholderText('按索引筛选'), 'logs');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('按状态筛选'), 'UNASSIGNED');
    expect(screen.getByText('没有分片符合当前筛选条件。')).toBeInTheDocument();
    expect(screen.getByText(/来自 _cat\/shards/)).toBeInTheDocument();
  });

  it('pages large shard sets locally instead of rendering every row', async () => {
    const user = userEvent.setup();
    const many = `[${Array.from({ length: 150 }, (_, position) => `{"index":"idx-${position}","shard":"0","prirep":"p",` +
      '"state":"STARTED","docs":1,"store":"1b","ip":"127.0.0.1","node":"n1"}').join(',')}]`;
    const { backend } = fakeBackend({ shards: many });
    renderWithI18n(<ShardsPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    await screen.findByText('150 个分片');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(101);
    expect(screen.getByText('已显示 150 行中的 100 行。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('已显示 150 行中的 50 行。')).toBeInTheDocument();
  });
});

describe('indices', () => {
  it('lists indices, aliases and data streams with their flags', async () => {
    const { backend } = fakeBackend({ indices: CATALOG });
    renderWithI18n(<IndicesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('别名')).toBeInTheDocument();
    expect(within(table).getByText('数据流')).toBeInTheDocument();
    const hidden = catalogRow(table, '.security');
    expect(within(hidden).getByText('隐藏')).toBeInTheDocument();
    expect(within(hidden).getByText('系统')).toBeInTheDocument();
    const stream = catalogRow(table, 'logs');
    expect(within(stream).getByText(/1 个后备索引/)).toBeInTheDocument();
    expect(within(stream).getByText(/@timestamp/)).toBeInTheDocument();
  });

  it('loads mapping and settings independently and keeps one failure local', async () => {
    const user = userEvent.setup();
    const { backend, calls } = fakeBackend({ indices: CATALOG, indexSettings: SETTINGS }, ['mapping']);
    renderWithI18n(<IndicesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    const table = await screen.findByRole('table');
    await user.click(within(catalogRow(table, 'orders')).getByRole('button', { name: '详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/服务器拒绝了本次读取/)).toBeInTheDocument();
    expect(within(dialog).getByText(/"number_of_shards":"3"/)).toBeInTheDocument();
    expect(calls.map((call) => [call.resource, call.index])).toEqual([
      ['indices', undefined], ['mapping', 'orders'], ['indexSettings', 'orders'],
    ]);
  });

  it('renders the mapping fields and both verbatim bodies when the reads succeed', async () => {
    const user = userEvent.setup();
    const { backend } = fakeBackend({ indices: CATALOG, mapping: MAPPING, indexSettings: SETTINGS });
    renderWithI18n(<IndicesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    const table = await screen.findByRole('table');
    await user.click(within(catalogRow(table, 'orders')).getByRole('button', { name: '详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('amount')).toBeInTheDocument();
    expect(within(dialog).getByText('long')).toBeInTheDocument();
    expect(within(dialog).getByText(/"number_of_shards":"3"/)).toBeInTheDocument();
    expect(within(dialog).getByText('索引详情 · orders')).toBeInTheDocument();
  });

  it('reads a manually typed target and refuses an invalid one before sending it', async () => {
    const user = userEvent.setup();
    const { backend, calls } = fakeBackend({ indices: CATALOG, mapping: MAPPING, indexSettings: SETTINGS });
    renderWithI18n(<IndicesPanel connectionId={CONNECTION} endpoint={ENDPOINT} backend={backend} />);
    await screen.findByRole('table');
    const input = screen.getByLabelText('索引或模式');
    await user.type(input, '../etc');
    expect(screen.getByRole('button', { name: '读取详情' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/索引或模式只能包含/);
    expect(calls.map((call) => call.resource)).toEqual(['indices']);
    await user.clear(input);
    await user.type(input, 'orders-*');
    await user.click(screen.getByRole('button', { name: '读取详情' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(calls.map((call) => [call.resource, call.index])).toEqual([
      ['indices', undefined], ['mapping', 'orders-*'], ['indexSettings', 'orders-*'],
    ]);
  });
});

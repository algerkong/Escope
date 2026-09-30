import { describe, expect, it } from 'vitest';
import {
  healthMeaning, isValidIndexTarget, parseClusterHealth, parseIndexSettings, parseNodesStats, parseShards,
  shardStateCounts,
} from '../../src/domain/cluster';
import { sliceRaw } from '../../src/domain/query-result';

const health = `{"cluster_name":"fixture","status":"yellow","timed_out":false,"number_of_nodes":3,` +
  `"number_of_data_nodes":3,"active_primary_shards":10,"active_shards":10,"relocating_shards":0,` +
  `"initializing_shards":1,"unassigned_shards":10,"delayed_unassigned_shards":0,"number_of_pending_tasks":2,` +
  `"number_of_in_flight_fetch":0,"active_shards_percent_as_number":50.0,"task_max_waiting_in_queue_millis":7}`;

describe('cluster health', () => {
  it('keeps every counter as the exact token the cluster returned', () => {
    const parsed = parseClusterHealth(health);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.clusterName).toBe('fixture');
    expect(parsed.value.status).toBe('yellow');
    expect(parsed.value.numberOfNodes).toEqual({ text: '3', value: 3 });
    expect(parsed.value.unassignedShards).toEqual({ text: '10', value: 10 });
    expect(parsed.value.delayedUnassignedShards).toEqual({ text: '0', value: 0 });
    // The float literal survives: the body is never re-serialized through JSON.parse/stringify.
    expect(parsed.value.activeShardsPercent).toBe('50.0');
    expect(parsed.value.taskMaxWaitingTimeInQueue).toBe('7');
    expect(parsed.value.timedOut).toBe(false);
  });

  it('reports a missing or unusable metric as unknown instead of zero', () => {
    const parsed = parseClusterHealth('{"status":"green","number_of_nodes":3,"unassigned_shards":"many"}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.numberOfNodes?.text).toBe('3');
    // A string is not a counter, so it is unknown rather than displayed as a value.
    expect(parsed.value.unassignedShards).toBeNull();
    expect(parsed.value.relocatingShards).toBeNull();
    expect(parsed.value.activeShardsPercent).toBeNull();
  });

  it('refuses negative, fractional and non-numeric counters and percentages', () => {
    const parsed = parseClusterHealth('{"number_of_nodes":-1,"active_shards":1.5,"unassigned_shards":{},' +
      '"active_primary_shards":null,"active_shards_percent_as_number":120,"task_max_waiting_in_queue_millis":-5}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.numberOfNodes).toBeNull();
    expect(parsed.value.activeShards).toBeNull();
    expect(parsed.value.unassignedShards).toBeNull();
    expect(parsed.value.activePrimaryShards).toBeNull();
    expect(parsed.value.activeShardsPercent).toBeNull();
    expect(parsed.value.taskMaxWaitingTimeInQueue).toBeNull();
  });

  it('keeps a counter beyond the safe integer range exact and still comparable', () => {
    const parsed = parseClusterHealth('{"status":"green","unassigned_shards":9007199254740993}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.unassignedShards).toEqual({ text: '9007199254740993', value: null });
    // The comparison must not read a huge count as zero.
    expect(healthMeaning(parsed.value)).toBe('unassignedReported');
  });

  it('explains allocation without reading a green status as healthy performance', () => {
    const meaning = (body: string) => {
      const parsed = parseClusterHealth(body);
      return parsed.ok ? healthMeaning(parsed.value) : null;
    };
    expect(meaning('{"status":"green","unassigned_shards":0}')).toBe('healthy');
    expect(meaning('{"status":"green","unassigned_shards":2}')).toBe('unassignedReported');
    expect(meaning('{"status":"yellow"}')).toBe('replicasUnassigned');
    expect(meaning('{"status":"red"}')).toBe('primariesUnassigned');
    expect(meaning('{"status":"purple"}')).toBe('unknown');
    expect(meaning('{"cluster_name":"fixture"}')).toBe('unknown');
  });

  it('rejects a body that is not a health object', () => {
    expect(parseClusterHealth('[]').ok).toBe(false);
    expect(parseClusterHealth('not json').ok).toBe(false);
  });
});

const nodes = '{"_nodes":{"total":2,"successful":2,"failed":0},"cluster_name":"fixture","nodes":{' +
  '"n2":{"name":"node-b","roles":[],"jvm":{"mem":{"heap_used_percent":10,"heap_used_in_bytes":1,' +
  '"heap_max_in_bytes":2}},"thread_pool":{"search":{"rejected":0}}},' +
  '"n1":{"name":"node-a","transport_address":"127.0.0.1:9300","host":"127.0.0.1","roles":["data","master"],' +
  '"jvm":{"mem":{"heap_used_percent":42,"heap_used_in_bytes":268435456,"heap_max_in_bytes":536870912}},' +
  '"os":{"cpu":{"percent":-1,"load_average":{"1m":0.5}}},' +
  '"fs":{"total":{"total_in_bytes":1000,"available_in_bytes":400}},' +
  '"thread_pool":{"search":{"rejected":3},"write":{"rejected":0}}}}}';

describe('node statistics', () => {
  it('reads node metrics verbatim and treats a missing CPU measurement as unknown', () => {
    const parsed = parseNodesStats(nodes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.nodes.map((node) => node.name)).toEqual(['node-a', 'node-b']);
    expect(parsed.value.completeness).toBe('complete');
    const [first] = parsed.value.nodes;
    expect(first?.id).toBe('n1');
    expect(first?.heapPercent).toBe('42');
    expect(first?.heapUsed).toBe('268435456');
    expect(first?.heapMax).toBe('536870912');
    expect(first?.roles).toEqual(['data', 'master']);
    expect(first?.fsTotal).toBe('1000');
    expect(first?.fsAvailable).toBe('400');
    // `os.cpu.percent: -1` means the OS does not report CPU usage, not 0%.
    expect(first?.cpuPercent).toBeNull();
    expect(first?.loadAverage).toBe('0.5');
    // Cumulative `rejected` counters, not a rate; only non-zero pools are listed.
    expect(first?.threadPoolRejections).toBe('3');
    expect(first?.rejectingPools).toEqual([{ pool: 'search', rejected: '3' }]);
    expect(parsed.value.nodes[1]?.threadPoolRejections).toBe('0');
    expect(parsed.value.nodes[1]?.cpuPercent).toBeNull();
  });

  it('sums rejected counters exactly, beyond the safe integer range', () => {
    const parsed = parseNodesStats('{"_nodes":{"total":1,"successful":1,"failed":0},"nodes":{"n1":' +
      '{"name":"n1","thread_pool":{"search":{"rejected":9007199254740993},"write":{"rejected":1}}}}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.nodes[0]?.threadPoolRejections).toBe('9007199254740994');
    expect(parsed.value.nodes[0]?.rejectingPools).toEqual([
      { pool: 'search', rejected: '9007199254740993' }, { pool: 'write', rejected: '1' },
    ]);
  });

  it('never presents a subset sum as the node total', () => {
    const sum = (threadPool: string) => {
      const parsed = parseNodesStats(`{"_nodes":{"total":1,"successful":1,"failed":0},"nodes":{"n1":{"name":"n1","thread_pool":${threadPool}}}}`);
      return parsed.ok ? parsed.value.nodes[0] : null;
    };
    // One pool without a usable counter: the total is unknown, the reported counter stays visible.
    expect(sum('{"search":{"rejected":3},"write":{"queue":1}}')).toMatchObject({
      threadPoolRejections: null, rejectingPools: [{ pool: 'search', rejected: '3' }],
    });
    for (const invalid of ['{"search":{"rejected":-1}}', '{"search":{"rejected":1.5}}', '{"search":{"rejected":"3"}}',
      '{"search":{"rejected":{}}}', '{}']) {
      expect(sum(invalid)?.threadPoolRejections).toBeNull();
    }
    expect(sum('{"search":{"rejected":3},"write":{"rejected":2}}')?.threadPoolRejections).toBe('5');
  });

  it('reports a partial or unknown _nodes summary instead of assuming completeness', () => {
    const completeness = (meta: string) => {
      const parsed = parseNodesStats(`{${meta}"nodes":{"n1":{"name":"n1","thread_pool":{"search":{"rejected":0}}}}}`);
      return parsed.ok ? parsed.value.completeness : null;
    };
    expect(completeness('"_nodes":{"total":2,"successful":2,"failed":0},')).toBe('complete');
    expect(completeness('"_nodes":{"total":2,"successful":1,"failed":1},')).toBe('partial');
    // Fewer nodes answered than requested, even without a reported failure.
    expect(completeness('"_nodes":{"total":2,"successful":1,"failed":0},')).toBe('partial');
    expect(completeness('')).toBe('unknown');
    expect(completeness('"_nodes":{"total":2,"successful":"2","failed":0},')).toBe('unknown');
    expect(completeness('"_nodes":{"failed":0},')).toBe('unknown');
  });

  it('refuses implausible percentages, byte counts and load values', () => {
    const node = (body: string) => {
      const parsed = parseNodesStats(`{"_nodes":{"total":1,"successful":1,"failed":0},"nodes":{"n1":${body}}}`);
      return parsed.ok ? parsed.value.nodes[0] : null;
    };
    expect(node('{"jvm":{"mem":{"heap_used_percent":250}}}')?.heapPercent).toBeNull();
    expect(node('{"jvm":{"mem":{"heap_used_percent":"42"}}}')?.heapPercent).toBeNull();
    expect(node('{"jvm":{"mem":{"heap_used_in_bytes":-1}}}')?.heapUsed).toBeNull();
    expect(node('{"jvm":{"mem":{"heap_used_in_bytes":1.5}}}')?.heapUsed).toBeNull();
    expect(node('{"jvm":{"mem":{"heap_used_in_bytes":{}}}}')?.heapUsed).toBeNull();
    expect(node('{"os":{"cpu":{"percent":"oops"}}}')?.cpuPercent).toBeNull();
    expect(node('{"os":{"cpu":{"percent":150}}}')?.cpuPercent).toBeNull();
    expect(node('{"os":{"cpu":{"percent":42.5}}}')?.cpuPercent).toBe('42.5');
    expect(node('{"os":{"cpu":{"load_average":{"1m":-0.5}}}}')?.loadAverage).toBeNull();
    expect(node('{"os":{"cpu":{"load_average":{"1m":"high"}}}}')?.loadAverage).toBeNull();
    expect(node('{"fs":{"total":{"total_in_bytes":{}}}}')?.fsTotal).toBeNull();
    expect(node('{"fs":{"total":{"total_in_bytes":1024}}}')?.fsTotal).toBe('1024');
  });

  it('keeps a source range per node so the raw view shows exactly the cluster bytes', () => {
    const parsed = parseNodesStats(nodes);
    if (!parsed.ok) throw new Error('expected a parsed response');
    const range = parsed.value.nodes[0]?.range;
    expect(range).not.toBeNull();
    const raw = sliceRaw(nodes, range!);
    expect(raw.startsWith('{"name":"node-a"')).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({ name: 'node-a', host: '127.0.0.1' });
  });

  it('rejects a body without a nodes object', () => {
    expect(parseNodesStats('{"cluster_name":"fixture"}').ok).toBe(false);
    expect(parseNodesStats('{}').ok).toBe(false);
  });
});

const shards = `[{"index":"orders","shard":"0","prirep":"p","state":"STARTED","docs":42,"store":"1kb",` +
  `"ip":"127.0.0.1","node":"n1"},{"index":"orders","shard":"0","prirep":"r","state":"UNASSIGNED",` +
  `"docs":null,"store":null,"ip":null,"node":null,"unassigned.reason":"NODE_LEFT"},` +
  `{"index":"logs","shard":"1","prirep":"p","state":"INITIALIZING","docs":"0","store":"0b","ip":"10.0.0.2",` +
  `"node":"n2","unassigned_reason":"CLUSTER_RECOVERED"}]`;

describe('cat shards rows', () => {
  it('keeps verbatim values, distinguishes primary from replica and keeps the unassigned reason', () => {
    const parsed = parseShards(shards);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(3);
    expect(parsed.value[0]).toMatchObject({ index: 'orders', shard: '0', primary: true, docs: '42', store: '1kb' });
    expect(parsed.value[1]).toMatchObject({ primary: false, state: 'UNASSIGNED', unassignedReason: 'NODE_LEFT' });
    // A null column stays unknown instead of becoming `0`, and a string token stays exact.
    expect(parsed.value[1]?.docs).toBeNull();
    expect(parsed.value[1]?.store).toBeNull();
    expect(parsed.value[1]?.node).toBeNull();
    expect(parsed.value[2]?.docs).toBe('0');
    expect(parsed.value[2]?.unassignedReason).toBe('CLUSTER_RECOVERED');
  });

  it('does not print an object where a scalar column belongs', () => {
    const parsed = parseShards('[{"index":"orders","shard":"0","priprip":1,"state":"STARTED","store":{"b":1}}]');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]?.store).toBeNull();
    expect(parsed.value[0]?.primary).toBeNull();
  });

  it('counts the reported states without inventing one', () => {
    const parsed = parseShards(shards);
    if (!parsed.ok) throw new Error('expected a parsed response');
    expect(shardStateCounts(parsed.value)).toEqual([
      { state: 'INITIALIZING', count: 1 }, { state: 'STARTED', count: 1 }, { state: 'UNASSIGNED', count: 1 },
    ]);
  });

  it('rejects a body that is not a shard array', () => {
    expect(parseShards('{"index":"orders"}').ok).toBe(false);
    expect(parseShards('nope').ok).toBe(false);
  });
});

const settings = `{"orders":{"settings":{"index":{"number_of_shards":"3","number_of_replicas":"1"}}},` +
  `"audit":{"index":{"number_of_shards":"1"}}}`;

describe('index settings', () => {
  it('keeps one verbatim source range per index', () => {
    const parsed = parseIndexSettings(settings);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((entry) => entry.index)).toEqual(['audit', 'orders']);
    expect(sliceRaw(settings, parsed.value[1]!.range)).toBe('{"index":{"number_of_shards":"3","number_of_replicas":"1"}}');
    // An entry without a `settings` wrapper falls back to the whole index object.
    expect(sliceRaw(settings, parsed.value[0]!.range)).toBe('{"index":{"number_of_shards":"1"}}');
  });

  it('rejects a body that is not a settings object', () => {
    expect(parseIndexSettings('[]').ok).toBe(false);
  });
});

describe('index target mirror', () => {
  it('accepts the expressions the backend accepts', () => {
    for (const target of ['orders', 'orders-*', 'a,b', '.system', '2026.09.30', 'logs_*']) {
      expect(isValidIndexTarget(target)).toBe(true);
    }
  });

  it('refuses path, query and reserved-name forms before a request is sent', () => {
    for (const target of ['', '  ', '..', '.', '_internal', '-exclude', 'a/b', 'a?b', 'a#b', 'a b', '%2e%2e']) {
      expect(isValidIndexTarget(target)).toBe(false);
    }
    expect(isValidIndexTarget('a'.repeat(256))).toBe(false);
    expect(isValidIndexTarget(Array.from({ length: 65 }, () => 'a').join(','))).toBe(false);
  });
});

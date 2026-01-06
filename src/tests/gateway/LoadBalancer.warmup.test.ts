import { IntelligentLoadBalancer } from '../../gateway/IntelligentLoadBalancer.js';
import { ServiceObservationStore } from '../../gateway/service-state.js';
import type { Logger, McpServiceConfig, ServiceInstance } from '../../types/index.js';

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeTemplate(name: string, overrides: Partial<McpServiceConfig> = {}): McpServiceConfig {
  return {
    name,
    version: '2024-11-26',
    transport: 'stdio',
    command: 'node',
    args: ['-v'],
    timeout: 5000,
    retries: 1,
    ...overrides
  };
}

function makeInstance(id: string, templateName: string): ServiceInstance {
  return {
    id,
    config: makeTemplate(templateName),
    state: 'idle',
    startedAt: new Date(),
    errorCount: 0,
    metadata: {}
  };
}

describe('IntelligentLoadBalancer warmup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns null for empty input and creates metrics on first selection', () => {
    vi.useFakeTimers();
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store, { warmupDurationMs: 10_000 });

    expect(lb.selectInstance([], 'performance')).toBeNull();

    const instance = makeInstance('only-1', 'svc-a');
    expect(lb.selectInstance([instance], 'performance')?.id).toBe('only-1');
    const metrics = store.getMetrics('only-1');
    expect(metrics?.requestCount).toBe(0);
    expect(metrics?.addedAt.getTime()).toBe(t0.getTime());
  });

  it('ramps new instance score linearly during warmup', () => {
    vi.useFakeTimers();
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store, { warmupDurationMs: 10_000 });

    store.updateMetrics('svc-1', {
      serviceId: 'svc-1',
      requestCount: 0,
      errorCount: 0,
      avgResponseTime: 0,
      addedAt: new Date(t0),
      lastRequestTime: new Date(t0)
    });

    expect((lb as any).calculatePerformanceScore('svc-1')).toBeCloseTo(0, 8);

    vi.setSystemTime(new Date(t0.getTime() + 2500));
    expect((lb as any).calculatePerformanceScore('svc-1')).toBeCloseTo(0.25, 8);

    vi.setSystemTime(new Date(t0.getTime() + 5000));
    expect((lb as any).calculatePerformanceScore('svc-1')).toBeCloseTo(0.5, 8);

    vi.setSystemTime(new Date(t0.getTime() + 10_000));
    expect((lb as any).calculatePerformanceScore('svc-1')).toBeCloseTo(1, 8);

    vi.setSystemTime(new Date(t0.getTime() + 15_000));
    expect((lb as any).calculatePerformanceScore('svc-1')).toBeCloseTo(1, 8);
  });

  it('combines warmup with response time and error rate scoring', () => {
    vi.useFakeTimers();
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store, { warmupDurationMs: 10_000 });

    const a = makeInstance('a', 'svc-a');
    const b = makeInstance('b', 'svc-a');

    // a: warmed up, but slower (baseScore=0.6)
    store.updateMetrics('a', {
      serviceId: 'a',
      requestCount: 10,
      errorCount: 0,
      avgResponseTime: 4000,
      addedAt: new Date(t0.getTime() - 60_000),
      lastRequestTime: new Date(t0)
    });

    // b: new, fast and healthy (baseScore=0.9), but should ramp up during warmup
    const bAddedAt = new Date(t0);
    store.updateMetrics('b', {
      serviceId: 'b',
      requestCount: 10,
      errorCount: 0,
      avgResponseTime: 1000,
      addedAt: bAddedAt,
      lastRequestTime: new Date(t0)
    });

    expect(lb.selectInstance([a, b], 'performance')?.id).toBe('a');

    vi.setSystemTime(new Date(t0.getTime() + 5000));
    expect((lb as any).calculatePerformanceScore('a')).toBeCloseTo(0.6, 8);
    expect((lb as any).calculatePerformanceScore('b')).toBeCloseTo(0.45, 8);
    expect(lb.selectInstance([a, b], 'performance')?.id).toBe('a');

    vi.setSystemTime(new Date(t0.getTime() + 7000));
    expect(lb.selectInstance([a, b], 'performance')?.id).toBe('b');

    // If b becomes error-prone, it should be penalized even after warmup completes.
    vi.setSystemTime(new Date(t0.getTime() + 12_000));
    store.updateMetrics('b', {
      serviceId: 'b',
      requestCount: 10,
      errorCount: 9,
      avgResponseTime: 1000,
      addedAt: bAddedAt,
      lastRequestTime: new Date()
    });

    expect((lb as any).calculatePerformanceScore('b')).toBeCloseTo(0.45, 8);
    expect(lb.selectInstance([a, b], 'performance')?.id).toBe('a');
  });

  it('selects load-balance by least requests and breaks ties round-robin', () => {
    vi.useFakeTimers();
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store, { warmupDurationMs: 10_000 });

    const a = makeInstance('a', 'svc-a');
    const b = makeInstance('b', 'svc-a');

    store.updateMetrics('a', {
      serviceId: 'a',
      requestCount: 5,
      errorCount: 0,
      avgResponseTime: 10,
      addedAt: new Date(t0.getTime() - 60_000),
      lastRequestTime: new Date(t0)
    });
    store.updateMetrics('b', {
      serviceId: 'b',
      requestCount: 1,
      errorCount: 0,
      avgResponseTime: 10,
      addedAt: new Date(t0.getTime() - 60_000),
      lastRequestTime: new Date(t0)
    });

    expect(lb.selectInstance([a, b], 'load-balance')?.id).toBe('b');

    store.updateMetrics('a', {
      serviceId: 'a',
      requestCount: 1,
      errorCount: 0,
      avgResponseTime: 10,
      addedAt: new Date(t0.getTime() - 60_000),
      lastRequestTime: new Date(t0)
    });

    expect(lb.selectInstance([a, b], 'load-balance')?.id).toBe('a');
    expect(lb.selectInstance([a, b], 'load-balance')?.id).toBe('b');
  });

  it('breaks performance ties via round-robin', () => {
    vi.useFakeTimers();
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store, { warmupDurationMs: 10_000 });

    const a = makeInstance('a', 'svc-a');
    const b = makeInstance('b', 'svc-a');

    const warmed = new Date(t0.getTime() - 60_000);
    store.updateMetrics('a', {
      serviceId: 'a',
      requestCount: 10,
      errorCount: 0,
      avgResponseTime: 1000,
      addedAt: warmed,
      lastRequestTime: new Date(t0)
    });
    store.updateMetrics('b', {
      serviceId: 'b',
      requestCount: 10,
      errorCount: 0,
      avgResponseTime: 1000,
      addedAt: warmed,
      lastRequestTime: new Date(t0)
    });

    expect(lb.selectInstance([a, b], 'performance')?.id).toBe('a');
    expect(lb.selectInstance([a, b], 'performance')?.id).toBe('b');
    expect(lb.selectInstance([a, b], 'performance')?.id).toBe('a');
  });

  it('routes content-aware via performance and falls back on unknown strategies', () => {
    vi.useFakeTimers();
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store, { warmupDurationMs: 10_000 });

    const a = makeInstance('a', 'svc-a');
    const b = makeInstance('b', 'svc-a');

    store.updateMetrics('a', {
      serviceId: 'a',
      requestCount: 10,
      errorCount: 0,
      avgResponseTime: 4500,
      addedAt: new Date(t0.getTime() - 60_000),
      lastRequestTime: new Date(t0)
    });
    store.updateMetrics('b', {
      serviceId: 'b',
      requestCount: 10,
      errorCount: 0,
      avgResponseTime: 500,
      addedAt: new Date(t0.getTime() - 60_000),
      lastRequestTime: new Date(t0)
    });

    expect(lb.selectInstance([a, b], 'content-aware')?.id).toBe('b');
    expect(lb.selectInstance([a, b], 'unknown' as any)?.id).toBe('a');
  });

  it('records requests, preserves addedAt, and supports removal', () => {
    vi.useFakeTimers();
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store, { warmupDurationMs: 10_000 });

    lb.recordRequest('svc-1', 100, false);
    const first = store.getMetrics('svc-1');
    expect(first?.requestCount).toBe(1);
    expect(first?.errorCount).toBe(1);
    expect(first?.avgResponseTime).toBe(100);
    expect(first?.addedAt.getTime()).toBe(t0.getTime());

    vi.setSystemTime(new Date(t0.getTime() + 1000));
    lb.recordRequest('svc-1', 300, true);
    const second = store.getMetrics('svc-1');
    expect(second?.requestCount).toBe(2);
    expect(second?.errorCount).toBe(1);
    expect(second?.avgResponseTime).toBe(200);
    expect(second?.addedAt.getTime()).toBe(t0.getTime());

    vi.setSystemTime(new Date(t0.getTime() + 2000));
    lb.recordRequest('svc-1', -1, true);
    const third = store.getMetrics('svc-1');
    expect(third?.requestCount).toBe(3);
    expect(third?.avgResponseTime).toBe(200);

    lb.removeInstance('svc-1');
    expect(store.getMetrics('svc-1')).toBeUndefined();
  });

  it('backfills addedAt when missing on existing metrics', () => {
    vi.useFakeTimers();
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store, { warmupDurationMs: 10_000 });

    const cold = makeInstance('cold', 'svc-a');
    store.updateMetrics(
      'cold',
      {
        serviceId: 'cold',
        requestCount: 0,
        errorCount: 0,
        avgResponseTime: 0,
        lastRequestTime: new Date(t0)
      } as any
    );
    lb.addInstance(cold);
    expect(store.getMetrics('cold')?.addedAt.getTime()).toBe(t0.getTime());

    const warm = makeInstance('warm', 'svc-a');
    store.updateMetrics(
      'warm',
      {
        serviceId: 'warm',
        requestCount: 1,
        errorCount: 0,
        avgResponseTime: 10,
        lastRequestTime: new Date(t0)
      } as any
    );
    lb.addInstance(warm);
    expect(store.getMetrics('warm')?.addedAt.getTime()).toBe(t0.getTime() - 10_000);

    expect((lb as any).calculatePerformanceScore('missing')).toBe(1);
  });

  it('summarizes load balancer stats from the store', () => {
    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store);

    store.setInstance(makeInstance('a', 'svc-a'));
    store.setInstance(makeInstance('b', 'svc-a'));
    store.setInstance(makeInstance('c', 'svc-a')); // no metrics: should be skipped

    const now = new Date();
    store.updateMetrics('a', {
      serviceId: 'a',
      requestCount: 10,
      errorCount: 2,
      avgResponseTime: 50,
      addedAt: now,
      lastRequestTime: now
    });
    store.updateMetrics('b', {
      serviceId: 'b',
      requestCount: 0,
      errorCount: 0,
      avgResponseTime: 0,
      addedAt: now,
      lastRequestTime: now
    });

    const stats = lb.getLoadBalancerStats().sort((x, y) => x.serviceId.localeCompare(y.serviceId));
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({ serviceId: 'a', requestCount: 10, errorCount: 2, avgResponseTime: 50 });
    expect(stats[0].errorRate).toBeCloseTo(0.2, 8);
    expect(stats[1].errorRate).toBe(0);
  });

  it('selects cost strategy using stable round-robin (no time modulo)', () => {
    const store = new ServiceObservationStore();
    const lb = new IntelligentLoadBalancer(makeLogger(), store);

    const a = makeInstance('a', 'svc-a');
    const b = makeInstance('b', 'svc-a');
    const c = makeInstance('c', 'svc-a');

    expect(lb.selectInstance([a, b, c], 'cost')?.id).toBe('a');
    expect(lb.selectInstance([a, b, c], 'cost')?.id).toBe('b');
    expect(lb.selectInstance([a, b, c], 'cost')?.id).toBe('c');
    expect(lb.selectInstance([a, b, c], 'cost')?.id).toBe('a');
  });
});

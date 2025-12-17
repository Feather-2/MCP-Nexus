import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelState } from '../../ai/types.js';
import { LoadBalancer } from '../../ai/load-balancer.js';

type WeightedState = ChannelState & { weight: number };
type InternalMetricsView = {
  channelId: string;
  avgLatencyMs: number;
  totalRequests: number;
  totalErrors: number;
  consecutiveFailures: number;
  lastRequestAt?: Date;
  lastFailureAt?: Date;
  cooldownUntil?: Date;
  healthy: boolean;
};

function makeState(channelId: string, enabled: boolean = true): ChannelState {
  return {
    channelId,
    enabled,
    keys: [],
    pollingIndex: 0,
    consecutiveFailures: 0,
    cooldownUntil: undefined,
    metrics: {
      totalRequests: 0,
      totalErrors: 0,
      avgLatencyMs: 0,
      lastRequestAt: undefined
    }
  };
}

function withDeterministicRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

describe('LoadBalancer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-robin 轮询正确', () => {
    const lb = new LoadBalancer({ strategy: 'round-robin' });
    const candidates = [makeState('a'), makeState('b'), makeState('c')];

    expect(lb.select(candidates)).toBe('a');
    expect(lb.select(candidates)).toBe('b');
    expect(lb.select(candidates)).toBe('c');
    expect(lb.select(candidates)).toBe('a');
    expect(lb.select(candidates)).toBe('b');
  });

  it('select returns undefined for empty candidates', () => {
    const lb = new LoadBalancer({ strategy: 'round-robin' });
    expect(lb.select([])).toBeUndefined();
  });

  it('least-latency 选择最低延迟', () => {
    const lb = new LoadBalancer({ strategy: 'least-latency' });
    const candidates = [makeState('a'), makeState('b'), makeState('c')];

    lb.report('a', 120, true);
    lb.report('b', 80, true);
    lb.report('c', 200, true);

    expect(lb.select(candidates)).toBe('b');
  });

  it('least-latency uses candidate.metrics avgLatencyMs when no reports', () => {
    const lb = new LoadBalancer({ strategy: 'least-latency' });
    const a = makeState('a');
    const b = makeState('b');
    const c = makeState('c');

    a.metrics.avgLatencyMs = 150;
    b.metrics.avgLatencyMs = 50;
    c.metrics.avgLatencyMs = 100;

    expect(lb.select([a, b, c])).toBe('b');
  });

  it('least-latency returns first when all latency unknown', () => {
    const lb = new LoadBalancer({ strategy: 'least-latency' });
    const a = makeState('a');
    const b = makeState('b');
    a.metrics.avgLatencyMs = 0;
    b.metrics.avgLatencyMs = 0;

    expect(lb.select([a, b])).toBe('a');
  });

  it('weighted 按权重分布', () => {
    const lb = new LoadBalancer({ strategy: 'weighted' });
    const a: WeightedState = { ...makeState('a'), weight: 1 };
    const b: WeightedState = { ...makeState('b'), weight: 3 };
    const zero: WeightedState = { ...makeState('zero'), weight: 0 };
    const candidates: ChannelState[] = [a, b, zero];

    const counts: Record<string, number> = { a: 0, b: 0, zero: 0 };
    withDeterministicRandom(42, () => {
      for (let i = 0; i < 20_000; i += 1) {
        const picked = lb.select(candidates);
        if (!picked) throw new Error('expected pick');
        counts[picked] += 1;
      }
    });

    expect(counts.zero).toBe(0);
    const ratioB = counts.b / (counts.a + counts.b);
    expect(ratioB).toBeGreaterThan(0.70);
    expect(ratioB).toBeLessThan(0.80);
  });

  it('weighted returns undefined when no positive weights', () => {
    const lb = new LoadBalancer({ strategy: 'weighted' });
    const a: WeightedState = { ...makeState('a'), weight: 0 };
    const candidates: ChannelState[] = [a];
    expect(lb.select(candidates)).toBeUndefined();
  });

  it('weighted falls back to last item when Math.random() returns 1', () => {
    const lb = new LoadBalancer({ strategy: 'weighted' });
    const a: WeightedState = { ...makeState('a'), weight: 1 };
    const b: WeightedState = { ...makeState('b'), weight: 1 };
    const candidates: ChannelState[] = [a, b];

    const original = Math.random;
    Math.random = () => 1;
    try {
      expect(lb.select(candidates)).toBe('b');
    } finally {
      Math.random = original;
    }
  });

  it('weighted defaults weight to 1 when missing', () => {
    const lb = new LoadBalancer({ strategy: 'weighted' });
    const withDefault = makeState('default-weight');
    const weighted: WeightedState = { ...makeState('weighted'), weight: 2 };
    const candidates: ChannelState[] = [withDefault, weighted];

    const original = Math.random;
    Math.random = () => 0;
    try {
      expect(lb.select(candidates)).toBe('default-weight');
    } finally {
      Math.random = original;
    }
  });

  it('failover 主备切换', () => {
    const lb = new LoadBalancer({ strategy: 'failover', cooldownMs: 1000 });
    const candidates = [makeState('primary'), makeState('backup')];

    expect(lb.select(candidates)).toBe('primary');
    lb.report('primary', 50, false);
    expect(lb.select(candidates)).toBe('backup');

    lb.markHealthy('primary');
    expect(lb.select(candidates)).toBe('primary');
  });

  it('report 更新 metrics', () => {
    const lb = new LoadBalancer({ healthThreshold: 1 });
    lb.report('c1', 100, true);

    const m1 = lb.getMetrics('c1');
    expect(m1).toBeDefined();
    expect(m1?.avgLatencyMs).toBe(100);
    expect(m1?.errorRate).toBe(0);
    expect(m1?.consecutiveFailures).toBe(0);
    expect(m1?.lastRequestAt?.getTime()).toBe(0);
    expect(m1?.healthy).toBe(true);

    vi.advanceTimersByTime(500);
    lb.report('c1', 100, false);

    const m2 = lb.getMetrics('c1');
    expect(m2?.errorRate).toBe(0.5);
    expect(m2?.consecutiveFailures).toBe(1);
    expect(m2?.lastRequestAt?.getTime()).toBe(500);
    expect(m2?.lastFailureAt?.getTime()).toBe(500);
    expect(m2?.healthy).toBe(true);
  });

  it('report clamps invalid latencyMs to 0', () => {
    const lb = new LoadBalancer({ healthThreshold: 1, latencyWindowSize: Number.NaN });
    lb.report('c1', Number.NaN, true);
    expect(lb.getMetrics('c1')?.avgLatencyMs).toBe(0);

    lb.report('c1', -1, true);
    expect(lb.getMetrics('c1')?.avgLatencyMs).toBe(0);
  });

  it('EMA 延迟计算正确', () => {
    const lb = new LoadBalancer({ latencyWindowSize: 3, healthThreshold: 1 });
    lb.report('c1', 100, true);
    lb.report('c1', 200, true);
    expect(lb.getMetrics('c1')?.avgLatencyMs).toBe(150);

    lb.report('c1', 100, true);
    expect(lb.getMetrics('c1')?.avgLatencyMs).toBe(125);
  });

  it('错误率计算正确', () => {
    const lb = new LoadBalancer({ healthThreshold: 2 });
    lb.report('c1', 1, true);
    lb.report('c1', 1, false);
    lb.report('c1', 1, false);

    expect(lb.getMetrics('c1')?.errorRate).toBeCloseTo(2 / 3, 6);
  });

  it('getMetrics returns undefined for unknown channel', () => {
    const lb = new LoadBalancer();
    expect(lb.getMetrics('missing')).toBeUndefined();
  });

  it('consecutiveFailures 触发不健康', () => {
    const lb = new LoadBalancer({ healthThreshold: 1, cooldownMs: 1000 });
    const candidates = [makeState('bad'), makeState('good')];

    lb.report('bad', 10, false);
    lb.report('bad', 10, false);
    lb.report('bad', 10, false);

    const badMetrics = lb.getMetrics('bad');
    expect(badMetrics?.healthy).toBe(false);
    expect(badMetrics?.consecutiveFailures).toBe(3);
    expect(badMetrics?.cooldownUntil?.getTime()).toBe(1000);

    expect(lb.select(candidates)).toBe('good');
  });

  it('cooldown 期间不选择', () => {
    const lb = new LoadBalancer({ strategy: 'round-robin', cooldownMs: 1000 });
    const candidates = [makeState('bad'), makeState('good')];

    lb.markUnhealthy('bad', 1000);
    expect(lb.select(candidates)).toBe('good');
  });

  it('candidate cooldownUntil excludes it from selection', () => {
    const lb = new LoadBalancer({ strategy: 'failover' });
    const a = makeState('a');
    a.cooldownUntil = new Date(10_000);
    const b = makeState('b');

    expect(lb.select([a, b])).toBe('b');
  });

  it('cooldown expires and resets health counters', () => {
    const lb = new LoadBalancer({ strategy: 'failover', cooldownMs: 1000 });
    const candidates = [makeState('c1'), makeState('c2')];

    lb.markUnhealthy('c1', 1000);
    expect(lb.getMetrics('c1')?.healthy).toBe(false);
    expect(lb.select(candidates)).toBe('c2');

    vi.advanceTimersByTime(1001);
    expect(lb.select(candidates)).toBe('c1');
    expect(lb.getMetrics('c1')?.healthy).toBe(true);
    expect(lb.getMetrics('c1')?.errorRate).toBe(0);
    expect(lb.getMetrics('c1')?.consecutiveFailures).toBe(0);
  });

  it('markUnhealthy does not shrink cooldown', () => {
    const lb = new LoadBalancer({ cooldownMs: 1000 });
    lb.markUnhealthy('c1', 1000);
    expect(lb.getMetrics('c1')?.cooldownUntil?.getTime()).toBe(1000);

    lb.markUnhealthy('c1', 500);
    expect(lb.getMetrics('c1')?.cooldownUntil?.getTime()).toBe(1000);
  });

  it('refresh marks unhealthy when errorRate exceeds threshold', () => {
    const lb = new LoadBalancer({ healthThreshold: 0.5 });
    lb.report('c1', 10, true);

    const view = lb as unknown as { metrics: Map<string, InternalMetricsView> };
    const m = view.metrics.get('c1');
    if (!m) throw new Error('missing metrics');
    m.totalRequests = 10;
    m.totalErrors = 6;
    m.consecutiveFailures = 0;
    m.cooldownUntil = undefined;

    expect(lb.getMetrics('c1')?.healthy).toBe(false);
  });

  it('errorRate is 0 for non-finite ratios', () => {
    const lb = new LoadBalancer();
    lb.report('c1', 10, true);

    const view = lb as unknown as { metrics: Map<string, InternalMetricsView> };
    const m = view.metrics.get('c1');
    if (!m) throw new Error('missing metrics');
    m.totalRequests = 1;
    m.totalErrors = Number.POSITIVE_INFINITY;

    expect(lb.getMetrics('c1')?.errorRate).toBe(0);
  });

  it('markUnhealthy/markHealthy 工作正常', () => {
    const lb = new LoadBalancer({ strategy: 'failover', cooldownMs: 1000 });
    const candidates = [makeState('c1'), makeState('c2')];

    lb.markUnhealthy('c1', 1000);
    expect(lb.select(candidates)).toBe('c2');

    lb.markHealthy('c1');
    expect(lb.select(candidates)).toBe('c1');

    lb.reset();
    expect(lb.getAllMetrics()).toEqual([]);
  });

  it('getAllMetrics returns sorted metrics', () => {
    const lb = new LoadBalancer();
    lb.report('b', 1, true);
    lb.report('a', 1, true);

    const all = lb.getAllMetrics().map((m) => m.channelId);
    expect(all).toEqual(['a', 'b']);
  });

  it('无健康 channel 时返回 undefined', () => {
    const lb = new LoadBalancer({ strategy: 'least-latency' });
    const candidates = [makeState('a', false), makeState('b', false)];

    expect(lb.select(candidates)).toBeUndefined();
  });
});

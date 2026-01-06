import { ServiceHealthChecker } from '../../gateway/ServiceHealthChecker.js';
import { ServiceObservationStore } from '../../gateway/service-state.js';
import type { HealthCheckResult } from '../../types/index.js';

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ServiceHealthChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates a periodic timer and calls unref when available', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((_fn: any, _ms?: any) => ({ unref }) as any);

    const logger = makeLogger();
    const store = new ServiceObservationStore();

    new ServiceHealthChecker(logger as any, store as any);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(5000);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('startMonitoring/stopMonitoring are no-ops when serviceId is missing', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    await checker.startMonitoring();
    await checker.stopMonitoring();

    expect(logger.debug).not.toHaveBeenCalled();
    const stats = await checker.getHealthStats();
    expect(stats.monitoring).toBe(0);
  });

  it('tracks monitored services and removes cached health on stopMonitoring', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const events: string[] = [];
    store.subscribe((event) => events.push(event.type));

    await checker.startMonitoring('svc-1');
    expect((await checker.getHealthStats()).monitoring).toBe(1);
    expect(logger.debug).toHaveBeenCalledWith('Started health monitoring for: svc-1');

    checker.reportHeartbeat('svc-1', { healthy: true, latency: 10 });
    expect(store.getHealth('svc-1')?.healthy).toBe(true);

    await checker.stopMonitoring('svc-1');
    expect((await checker.getHealthStats()).monitoring).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith('Stopped health monitoring for: svc-1');
    expect(store.getHealth('svc-1')).toBeUndefined();
    expect(events).toContain('health:remove');
  });

  it('getHealthStatus returns cached health for monitored services only', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    store.updateHealth('svc-a', { healthy: true, timestamp: new Date('2020-01-01T00:00:00.000Z') });
    store.updateHealth('svc-b', { healthy: false, error: 'bad', timestamp: new Date('2020-01-01T00:00:00.000Z') });

    await checker.startMonitoring('svc-a');
    const status = await checker.getHealthStatus();

    expect(status).toMatchObject({ 'svc-a': { healthy: true } });
    expect(status).not.toHaveProperty('svc-b');
  });

  it('checkHealth returns fresh cached results (skips probe)', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const cached: HealthCheckResult = { healthy: true, latency: 1, timestamp: new Date(Date.now() - 1000) };
    store.updateHealth('svc-1', cached);

    const probe = vi.fn(async () => ({ healthy: false, timestamp: new Date() }));
    checker.setProbe(probe);

    const res = await checker.checkHealth('svc-1');
    expect(res).toBe(cached);
    expect(probe).not.toHaveBeenCalled();
  });

  it('checkHealth parses non-Date timestamps for cache age checks', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const cached = { healthy: true, timestamp: '2025-01-01T00:00:00.000Z' } as any as HealthCheckResult;
    store.updateHealth('svc-1', cached as any);

    const probe = vi.fn(async () => ({ healthy: false, timestamp: new Date() }));
    checker.setProbe(probe);

    const res = await checker.checkHealth('svc-1');
    expect(res).toBe(cached);
    expect(probe).not.toHaveBeenCalled();
  });

  it('checkHealth performs a probe when cache is expired or invalid', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    store.updateHealth('svc-expired', { healthy: true, timestamp: new Date(Date.now() - 6000) });
    store.updateHealth('svc-invalid', { healthy: true, timestamp: new Date('not-a-date') });

    const probe = vi.fn(async (serviceId: string) => ({ healthy: serviceId === 'svc-expired', timestamp: new Date() }));
    checker.setProbe(probe);

    const res1 = await checker.checkHealth('svc-expired');
    const res2 = await checker.checkHealth('svc-invalid');

    expect(probe).toHaveBeenCalledTimes(2);
    expect(res1.healthy).toBe(true);
    expect(res2.healthy).toBe(false);
  });

  it('deduplicates concurrent checkHealth calls per serviceId', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const deferred = createDeferred<HealthCheckResult>();
    const probe = vi
      .fn()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValueOnce({ healthy: true, timestamp: new Date(), latency: 5 });
    checker.setProbe(probe as any);

    const p1 = checker.checkHealth('svc-1', { force: true });
    const p2 = checker.checkHealth('svc-1', { force: true });

    expect(probe).toHaveBeenCalledTimes(1);

    deferred.resolve({ healthy: true, timestamp: new Date(), latency: 10 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r2).toBe(r1);
    expect(r1).toMatchObject({ healthy: true, latency: 10 });

    await checker.checkHealth('svc-1', { force: true });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('returns an unhealthy result when no probe is configured', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const res = await checker.checkHealth('svc-1', { force: true });
    expect(res.healthy).toBe(false);
    expect(res.error).toBe('probe not configured');
    expect(typeof res.latency).toBe('number');
  });

  it('handles probe failures (network/timeout errors) as unhealthy', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const probe = vi.fn(async () => {
      throw new Error('network down');
    });
    checker.setProbe(probe as any);

    const res = await checker.checkHealth('svc-1', { force: true });
    expect(res).toMatchObject({ healthy: false, error: 'network down' });
    expect(typeof res.latency).toBe('number');
    expect(res.timestamp).toBeInstanceOf(Date);
  });

  it('normalizes probe results (timestamp + inferred latency)', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const probe = vi.fn(
      async () =>
        new Promise<HealthCheckResult>((resolve) => {
          setTimeout(() => {
            resolve({ healthy: true, timestamp: '2020-01-01T00:00:00.000Z' as any } as any);
          }, 50);
        })
    );
    checker.setProbe(probe as any);

    const p = checker.checkHealth('svc-1', { force: true });
    await vi.advanceTimersByTimeAsync(50);
    const res = await p;

    expect(res.healthy).toBe(true);
    expect(res.latency).toBe(50);
    expect(res.timestamp).toBeInstanceOf(Date);
    expect(res.timestamp.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('getLastHealthCheck returns cached result (or null)', () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    expect(checker.getLastHealthCheck('missing')).toBeNull();

    const cached: HealthCheckResult = { healthy: true, timestamp: new Date('2020-01-01T00:00:00.000Z') };
    store.updateHealth('svc-1', cached);

    expect(checker.getLastHealthCheck('svc-1')).toBe(cached);
  });

  it('reportHeartbeat updates store health and per-service metrics', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    await checker.startMonitoring('svc-1');

    const events: string[] = [];
    store.subscribe((event) => events.push(event.type));

    checker.reportHeartbeat('svc-1', { healthy: true, latency: 10 });
    checker.reportHeartbeat('svc-1', { healthy: false, latency: 20, error: 'oops' });

    expect(events).toEqual(['health:update', 'health:update']);
    expect(store.getHealth('svc-1')).toMatchObject({ healthy: false, latency: 20, error: 'oops' });

    const per = checker.getPerServiceStats().find((s) => s.id === 'svc-1')!;
    expect(per.samples).toBe(2);
    expect(per.p95).toBe(10);
    expect(per.p99).toBe(10);
    expect(per.errorRate).toBeCloseTo(0.5);
    expect(per.lastError).toBe('oops');
  });

  it('getHealthStats aggregates counts, latency, percentiles, and error rate', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    await checker.startMonitoring('svc-a');
    await checker.startMonitoring('svc-b');

    checker.reportHeartbeat('svc-a', { healthy: true, latency: 10 });
    checker.reportHeartbeat('svc-a', { healthy: true, latency: 20 });
    checker.reportHeartbeat('svc-a', { healthy: true, latency: 30 });
    checker.reportHeartbeat('svc-b', { healthy: false, latency: 40, error: 'bad' });

    const stats = await checker.getHealthStats();
    expect(stats.monitoring).toBe(2);
    expect(stats.healthy).toBe(1);
    expect(stats.unhealthy).toBe(1);
    expect(stats.avgLatency).toBe(35);
    expect(stats.p95).toBe(30);
    expect(stats.p99).toBe(30);
    expect(stats.errorRate).toBeCloseTo(0.25);
  });

  it('getHealthStats handles empty monitoring list', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const stats = await checker.getHealthStats();
    expect(stats).toEqual({
      monitoring: 0,
      healthy: 0,
      unhealthy: 0,
      avgLatency: 0,
      p95: 0,
      p99: 0,
      errorRate: 0
    });
  });

  it('getPerServiceStats includes last 30 latency samples and caps history at 200', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    await checker.startMonitoring('svc-1');

    for (let i = 1; i <= 35; i++) {
      checker.reportHeartbeat('svc-1', { healthy: true, latency: i });
    }

    let stats = checker.getPerServiceStats().find((s) => s.id === 'svc-1')!;
    expect(stats.samples).toBe(35);
    expect(stats.latencies).toHaveLength(30);
    expect(stats.latencies?.[0]).toBe(6);
    expect(stats.latencies?.[29]).toBe(35);

    for (let i = 36; i <= 201; i++) {
      checker.reportHeartbeat('svc-1', { healthy: true, latency: i });
    }

    stats = checker.getPerServiceStats().find((s) => s.id === 'svc-1')!;
    expect(stats.samples).toBe(200);
    expect(stats.latencies).toHaveLength(30);
    expect(stats.latencies?.[0]).toBe(172);
    expect(stats.latencies?.[29]).toBe(201);
  });

  it('periodic checks use cache when fresh and re-probe when expired', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    await checker.startMonitoring('svc-1');
    const checkSpy = vi.spyOn(checker, 'checkHealth');

    store.updateHealth('svc-1', { healthy: true, timestamp: new Date() });
    const probe = vi.fn(async () => ({ healthy: false, timestamp: new Date() }));
    checker.setProbe(probe as any);

    await vi.advanceTimersByTimeAsync(5000);
    expect(checkSpy).toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();

    store.updateHealth('svc-1', { healthy: true, timestamp: new Date(Date.now() - 6000) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('runs periodic checks with concurrency limit and tolerates service removal during checks', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    const ids = Array.from({ length: 10 }).map((_, i) => `svc-${i}`);
    for (const id of ids) await checker.startMonitoring(id);

    const gate = createDeferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;

    const probe = vi.fn(async (serviceId: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await gate.promise;
        return { healthy: true, timestamp: new Date() };
      } finally {
        inFlight--;
      }
    });
    checker.setProbe(probe as any);

    const periodic = (checker as any).performPeriodicChecks();
    for (let i = 0; i < 20 && probe.mock.calls.length < 8; i++) {
      await Promise.resolve();
    }

    expect(probe).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBe(8);
    expect(inFlight).toBe(8);

    await checker.stopMonitoring('svc-0');
    gate.resolve();
    await periodic;

    expect(probe).toHaveBeenCalledTimes(10);

    const status = await checker.getHealthStatus();
    expect(status).not.toHaveProperty('svc-0');
  });

  it('logs warnings when periodic check work throws and avoids re-entrancy', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    await checker.startMonitoring('svc-1');

    const first = createDeferred<HealthCheckResult>();
    const checkSpy = vi
      .spyOn(checker, 'checkHealth')
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error('boom'));

    const p1 = (checker as any).performPeriodicChecks();
    await Promise.resolve();

    await (checker as any).performPeriodicChecks();
    expect(checkSpy).toHaveBeenCalledTimes(1);

    first.resolve({ healthy: true, timestamp: new Date() });
    await p1;

    await (checker as any).performPeriodicChecks();
    expect(logger.warn).toHaveBeenCalledWith('Periodic health check failed for svc-1:', expect.any(Error));
  });

  it('returns an unhealthy result when internal health check logic throws unexpectedly', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    (checker as any).performHealthCheck = vi.fn(async () => {
      throw new Error('boom');
    });

    const res = await checker.checkHealth('svc-1', { force: true });
    expect(res).toMatchObject({ healthy: false, error: 'boom' });
    expect(store.getHealth('svc-1')?.healthy).toBe(false);
  });

  it('recordMetrics tolerates missing latency values', async () => {
    const logger = makeLogger();
    const store = new ServiceObservationStore();
    const checker = new ServiceHealthChecker(logger as any, store as any);

    await checker.startMonitoring('svc-1');

    checker.reportHeartbeat('svc-1', { healthy: true });
    checker.reportHeartbeat('svc-1', { healthy: false, error: 'x' });

    const per = checker.getPerServiceStats().find((s) => s.id === 'svc-1')!;
    expect(per.samples).toBe(0);
    expect(per.errorRate).toBeCloseTo(0.5);
    expect(per.lastError).toBe('x');
  });
});

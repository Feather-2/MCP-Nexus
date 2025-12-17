import { HealthCheckMiddleware, HEALTH_PROBE_CTX_KEY, HEALTH_PROBE_RESULT_STATE_KEY, HEALTH_VIEW_STATE_KEY } from '../../gateway/health-check.middleware.js';
import { ServiceStateManager } from '../../gateway/service-state.js';
import type { Context, State } from '../../middleware/types.js';
import type { McpServiceConfig, ServiceInstance } from '../../types/index.js';

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

function makeCtx(metadata: Record<string, unknown> = {}): Context {
  return { requestId: 'req-1', startTime: Date.now(), metadata };
}

function makeState(): State {
  return { stage: 'beforeModel', values: new Map(), aborted: false };
}

describe('HealthCheckMiddleware', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('builds a health view from cache when probe is absent', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a-1', 'svc-a'));
    mgr.updateHealth('a-1', { healthy: true, timestamp: new Date() });

    const mw = new HealthCheckMiddleware(mgr, { ttl: 1000 });
    const ctx = makeCtx({ templateId: 'svc-a' });
    const state = makeState();

    await mw.beforeModel(ctx, state);
    const view = state.values.get(HEALTH_VIEW_STATE_KEY);
    expect(view).toBeInstanceOf(Map);
    expect((view as Map<string, unknown>).get('a-1')).toMatchObject({ healthy: true });
  });

  it('refreshes health view with TTL caching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a-1', 'svc-a'));
    mgr.setInstance(makeInstance('a-2', 'svc-a'));

    const probe = vi.fn(async (instanceId: string) => ({
      healthy: true,
      latency: instanceId === 'a-1' ? 10 : 20,
      timestamp: new Date()
    }));

    const mw = new HealthCheckMiddleware(mgr, { ttl: 1000, concurrency: 4 });
    const ctx = makeCtx({ [HEALTH_PROBE_CTX_KEY]: probe, templateId: 'svc-a' });
    const state = makeState();

    await mw.beforeModel(ctx, state);
    expect(probe).toHaveBeenCalledTimes(2);

    const view1 = state.values.get(HEALTH_VIEW_STATE_KEY);
    expect(view1).toBeInstanceOf(Map);
    expect((view1 as Map<string, unknown>).size).toBe(2);

    await mw.beforeModel(ctx, makeState());
    expect(probe).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1001);
    await mw.beforeModel(ctx, makeState());
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('resolves templateId from state when ctx.metadata is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a-1', 'svc-a'));

    const probe = vi.fn(async (_instanceId: string) => ({ healthy: true, timestamp: new Date() }));
    const mw = new HealthCheckMiddleware(mgr, { ttl: 0, concurrency: 1 });
    const ctx = makeCtx({ [HEALTH_PROBE_CTX_KEY]: probe });
    const state = makeState();
    state.values.set('templateId', 'svc-a');

    await mw.beforeModel(ctx, state);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('can use instances from state.values', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const mgr = new ServiceStateManager();
    const probe = vi.fn(async (instanceId: string) => ({ healthy: true, timestamp: new Date(), latency: instanceId.length }));
    const mw = new HealthCheckMiddleware(mgr, { ttl: 0, concurrency: 2 });

    const ctx = makeCtx({ [HEALTH_PROBE_CTX_KEY]: probe });
    const state = makeState();
    state.values.set('instances', [{ id: 'x-1' }, { id: 'x-2' }]);

    await mw.beforeModel(ctx, state);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(mgr.getHealth('x-1')?.healthy).toBe(true);
  });

  it('falls back to state manager when state.values instances are invalid', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a-1', 'svc-a'));

    const probe = vi.fn(async (_instanceId: string) => ({ healthy: true, timestamp: new Date() }));
    const mw = new HealthCheckMiddleware(mgr, { ttl: 0, concurrency: 1 });

    const ctx = makeCtx({ [HEALTH_PROBE_CTX_KEY]: probe, templateId: 'svc-a' });
    const state = makeState();
    state.values.set('instances', [{ nope: true }]);

    await mw.beforeModel(ctx, state);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(mgr.getHealth('a-1')?.healthy).toBe(true);
  });

  it('treats non-positive concurrency as unbounded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const mgr = new ServiceStateManager();
    for (let i = 0; i < 3; i++) {
      mgr.setInstance(makeInstance(`a-${i}`, 'svc-a'));
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const probe = vi.fn(async (_instanceId: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { healthy: true, timestamp: new Date() };
    });

    const mw = new HealthCheckMiddleware(mgr, { ttl: 0, concurrency: 0 });
    const ctx = makeCtx({ [HEALTH_PROBE_CTX_KEY]: probe, templateId: 'svc-a' });

    const promise = mw.beforeModel(ctx, makeState());
    await vi.runAllTimersAsync();
    await promise;

    expect(maxInFlight).toBe(3);
  });

  it('limits concurrency when probing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const mgr = new ServiceStateManager();
    for (let i = 0; i < 5; i++) {
      mgr.setInstance(makeInstance(`a-${i}`, 'svc-a'));
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const probe = vi.fn(async (_instanceId: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { healthy: true, timestamp: new Date() };
    });

    const mw = new HealthCheckMiddleware(mgr, { ttl: 0, concurrency: 2 });
    const ctx = makeCtx({ [HEALTH_PROBE_CTX_KEY]: probe, templateId: 'svc-a' });

    const promise = mw.beforeModel(ctx, makeState());
    await vi.runAllTimersAsync();
    await promise;

    expect(probe).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(2);
  });

  it('records probe results in afterTool', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a-1', 'svc-a'));

    const mw = new HealthCheckMiddleware(mgr);
    const state = makeState();
    const status = { healthy: false, latency: 99, error: 'boom', timestamp: new Date() };
    state.values.set(HEALTH_PROBE_RESULT_STATE_KEY, { instanceId: 'a-1', status });

    await mw.afterTool(makeCtx(), state);
    expect(mgr.getHealth('a-1')).toEqual(status);
  });

  it('ignores invalid probe results in afterTool', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a-1', 'svc-a'));
    mgr.updateHealth('a-1', { healthy: true, timestamp: new Date() });

    const mw = new HealthCheckMiddleware(mgr);
    const state = makeState();
    state.values.set(HEALTH_PROBE_RESULT_STATE_KEY, { instanceId: 123, status: 'nope' });

    await mw.afterTool(makeCtx(), state);
    expect(mgr.getHealth('a-1')?.healthy).toBe(true);
  });
});

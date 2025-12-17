import {
  LoadBalancerMiddleware,
  SELECTED_INSTANCE_ID_STATE_KEY,
  SELECTED_INSTANCE_STATE_KEY,
  TOOL_ERROR_STATE_KEY,
  TOOL_LATENCY_MS_STATE_KEY,
  TOOL_SUCCESS_STATE_KEY
} from '../../gateway/load-balancer.middleware.js';
import { HealthCheckMiddleware, HEALTH_PROBE_CTX_KEY } from '../../gateway/health-check.middleware.js';
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

function makeInstance(id: string, templateName: string, weight?: number): ServiceInstance {
  return {
    id,
    config: makeTemplate(templateName),
    state: 'idle',
    startedAt: new Date(),
    errorCount: 0,
    metadata: weight ? { weight } : {}
  };
}

function makeCtx(metadata: Record<string, unknown> = {}): Context {
  return { requestId: 'req-1', startTime: Date.now(), metadata };
}

function makeState(): State {
  return { stage: 'beforeModel', values: new Map(), aborted: false };
}

describe('LoadBalancerMiddleware', () => {
  it('no-ops when no candidates exist', async () => {
    const mgr = new ServiceStateManager();
    const mw = new LoadBalancerMiddleware(mgr);
    const state = makeState();

    await mw.beforeModel(makeCtx({ templateId: 'svc-a' }), state);
    expect(state.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBeUndefined();
  });

  it('selects instances round-robin (health aware)', async () => {
    const mgr = new ServiceStateManager();
    const a = makeInstance('a', 'svc-a');
    const b = makeInstance('b', 'svc-a');
    mgr.setInstance(a);
    mgr.setInstance(b);
    mgr.updateHealth('a', { healthy: true, timestamp: new Date() });
    mgr.updateHealth('b', { healthy: true, timestamp: new Date() });

    const mw = new LoadBalancerMiddleware(mgr, { strategy: 'round-robin' });
    const ctx = makeCtx({ templateId: 'svc-a' });

    const s1 = makeState();
    await mw.beforeModel(ctx, s1);
    expect(s1.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('a');

    const s2 = makeState();
    await mw.beforeModel(ctx, s2);
    expect(s2.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('b');

    const s3 = makeState();
    await mw.beforeModel(ctx, s3);
    expect(s3.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('a');
  });

  it('falls back to candidates when all unhealthy', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a', 'svc-a'));
    mgr.setInstance(makeInstance('b', 'svc-a'));
    mgr.updateHealth('a', { healthy: false, timestamp: new Date() });
    mgr.updateHealth('b', { healthy: false, timestamp: new Date() });

    const mw = new LoadBalancerMiddleware(mgr, { strategy: 'round-robin' });
    const ctx = makeCtx({ templateId: 'svc-a' });
    const state = makeState();

    await mw.beforeModel(ctx, state);
    expect(state.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('a');
  });

  it('selects least-conn based on stored metrics', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a', 'svc-a'));
    mgr.setInstance(makeInstance('b', 'svc-a'));
    mgr.updateHealth('a', { healthy: true, timestamp: new Date() });
    mgr.updateHealth('b', { healthy: true, timestamp: new Date() });
    mgr.updateMetrics('a', { serviceId: 'a', requestCount: 5, errorCount: 0, avgResponseTime: 10, lastRequestTime: new Date() });
    mgr.updateMetrics('b', { serviceId: 'b', requestCount: 1, errorCount: 0, avgResponseTime: 10, lastRequestTime: new Date() });

    const mw = new LoadBalancerMiddleware(mgr, { strategy: 'least-conn' });
    const ctx = makeCtx({ templateId: 'svc-a' });
    const state = makeState();

    await mw.beforeModel(ctx, state);
    expect(state.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('b');
  });

  it('supports weighted selection', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a', 'svc-a', 1));
    mgr.setInstance(makeInstance('b', 'svc-a', 3));
    mgr.updateHealth('a', { healthy: true, timestamp: new Date() });
    mgr.updateHealth('b', { healthy: true, timestamp: new Date() });

    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const mw = new LoadBalancerMiddleware(mgr, { strategy: 'weighted' });
    const ctx = makeCtx({ templateId: 'svc-a' });
    const state = makeState();

    await mw.beforeModel(ctx, state);
    expect(state.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('b');

    spy.mockRestore();
  });

  it('records latency/error metrics in afterTool', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a', 'svc-a'));
    mgr.updateHealth('a', { healthy: true, timestamp: new Date() });

    const mw = new LoadBalancerMiddleware(mgr);
    const state = makeState();
    state.values.set(SELECTED_INSTANCE_ID_STATE_KEY, 'a');
    state.values.set(TOOL_LATENCY_MS_STATE_KEY, 50);
    state.values.set(TOOL_SUCCESS_STATE_KEY, false);

    await mw.afterTool(makeCtx(), state);
    const metrics = mgr.getMetrics('a');
    expect(metrics?.requestCount).toBe(1);
    expect(metrics?.errorCount).toBe(1);
    expect(metrics?.avgResponseTime).toBe(50);
  });

  it('afterTool no-ops when no selected instance is present', async () => {
    const mgr = new ServiceStateManager();
    const mw = new LoadBalancerMiddleware(mgr);
    const state = makeState();

    await mw.afterTool(makeCtx(), state);
    expect(mgr.getMetrics('a')).toBeUndefined();
  });

  it('afterTool defaults to success=true when no error is present', async () => {
    const mgr = new ServiceStateManager();
    const mw = new LoadBalancerMiddleware(mgr);
    const state = makeState();
    state.values.set(SELECTED_INSTANCE_ID_STATE_KEY, 'a');

    await mw.afterTool(makeCtx(), state);
    expect(mgr.getMetrics('a')?.errorCount).toBe(0);
  });

  it('afterTool treats toolError Error and state.error as failures', async () => {
    const mgr = new ServiceStateManager();
    const mw = new LoadBalancerMiddleware(mgr);

    const s1 = makeState();
    s1.values.set(SELECTED_INSTANCE_ID_STATE_KEY, 'a');
    s1.values.set(TOOL_ERROR_STATE_KEY, new Error('boom'));
    await mw.afterTool(makeCtx(), s1);
    expect(mgr.getMetrics('a')?.errorCount).toBe(1);

    const s2 = makeState();
    s2.values.set(SELECTED_INSTANCE_ID_STATE_KEY, 'b');
    s2.error = new Error('stage-failed');
    await mw.afterTool(makeCtx(), s2);
    expect(mgr.getMetrics('b')?.errorCount).toBe(1);
  });

  it('keeps avgResponseTime when latency is missing/invalid', async () => {
    const mgr = new ServiceStateManager();
    const mw = new LoadBalancerMiddleware(mgr);

    mgr.updateMetrics('a', { serviceId: 'a', requestCount: 1, errorCount: 0, avgResponseTime: 99, lastRequestTime: new Date() });

    const state = makeState();
    state.values.set(SELECTED_INSTANCE_ID_STATE_KEY, 'a');
    state.values.set('toolStartTimeMs', 10);
    state.values.set('toolEndTimeMs', 5);

    await mw.afterTool(makeCtx(), state);
    expect(mgr.getMetrics('a')?.avgResponseTime).toBe(99);
  });

  it('computes latency from start/end and resolves instanceId from selected instance object', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a', 'svc-a'));

    const mw = new LoadBalancerMiddleware(mgr);
    const state = makeState();
    state.values.set(SELECTED_INSTANCE_STATE_KEY, makeInstance('a', 'svc-a'));
    state.values.set('toolStartTimeMs', 10);
    state.values.set('toolEndTimeMs', 45);
    state.values.set(TOOL_ERROR_STATE_KEY, 'failed');

    await mw.afterTool(makeCtx(), state);
    const metrics = mgr.getMetrics('a');
    expect(metrics?.requestCount).toBe(1);
    expect(metrics?.errorCount).toBe(1);
    expect(metrics?.avgResponseTime).toBe(35);
  });

  it('reads candidates from state.values when provided', async () => {
    const mgr = new ServiceStateManager();
    const a = makeInstance('a', 'svc-a');
    const b = makeInstance('b', 'svc-a');
    mgr.updateHealth('a', { healthy: true, timestamp: new Date() });
    mgr.updateHealth('b', { healthy: true, timestamp: new Date() });

    const mw = new LoadBalancerMiddleware(mgr, { strategy: 'round-robin' });
    const state = makeState();
    state.values.set('instances', [a, b]);

    await mw.beforeModel(makeCtx(), state);
    expect(state.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('a');
  });

  it('uses health view from state to filter candidates', async () => {
    const mgr = new ServiceStateManager();
    const a = makeInstance('a', 'svc-a');
    const b = makeInstance('b', 'svc-a');
    mgr.setInstance(a);
    mgr.setInstance(b);

    const mw = new LoadBalancerMiddleware(mgr, { strategy: 'round-robin' });
    const state = makeState();
    state.values.set('instances', [a, b]);
    state.values.set('healthView', new Map([['a', { healthy: false }], ['b', { healthy: true }]]));

    await mw.beforeModel(makeCtx(), state);
    expect(state.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('b');
  });

  it('breaks least-conn ties by id', async () => {
    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a', 'svc-a'));
    mgr.setInstance(makeInstance('b', 'svc-a'));
    mgr.updateHealth('a', { healthy: true, timestamp: new Date() });
    mgr.updateHealth('b', { healthy: true, timestamp: new Date() });
    mgr.updateMetrics('a', { serviceId: 'a', requestCount: 1, errorCount: 0, avgResponseTime: 10, lastRequestTime: new Date() });
    mgr.updateMetrics('b', { serviceId: 'b', requestCount: 1, errorCount: 0, avgResponseTime: 10, lastRequestTime: new Date() });

    const mw = new LoadBalancerMiddleware(mgr, { strategy: 'least-conn' });
    const state = makeState();
    await mw.beforeModel(makeCtx({ templateId: 'svc-a' }), state);

    expect(state.values.get(SELECTED_INSTANCE_ID_STATE_KEY)).toBe('a');
  });

  it('can consume health view from HealthCheckMiddleware', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const mgr = new ServiceStateManager();
    mgr.setInstance(makeInstance('a', 'svc-a'));
    mgr.setInstance(makeInstance('b', 'svc-a'));

    const probe = vi.fn(async (instanceId: string) => ({
      healthy: instanceId === 'b',
      timestamp: new Date()
    }));

    const healthMw = new HealthCheckMiddleware(mgr, { ttl: 0, concurrency: 2 });
    const lbMw = new LoadBalancerMiddleware(mgr, { strategy: 'least-conn' });

    const ctx = makeCtx({ [HEALTH_PROBE_CTX_KEY]: probe, templateId: 'svc-a' });
    const state = makeState();

    await healthMw.beforeModel(ctx, state);
    await lbMw.beforeModel(ctx, state);

    expect(state.values.get(SELECTED_INSTANCE_STATE_KEY)).toMatchObject({ id: 'b' });
    vi.useRealTimers();
  });
});

import { ServiceStateManager } from '../../gateway/service-state.js';
import type { HealthCheckResult, LoadBalancerMetrics, McpServiceConfig, ServiceInstance } from '../../types/index.js';

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

describe('ServiceStateManager', () => {
  it('stores and reads templates', () => {
    const mgr = new ServiceStateManager();
    const template = makeTemplate('svc-a');

    mgr.setTemplate(template);

    expect(mgr.getTemplate('svc-a')).toEqual(template);
    expect(mgr.listTemplates()).toEqual([template]);
  });

  it('uses provided initial maps', () => {
    const templates = new Map<string, McpServiceConfig>([['svc-a', makeTemplate('svc-a')]]);
    const instances = new Map<string, ServiceInstance>([['a-1', makeInstance('a-1', 'svc-a')]]);
    const healthCache = new Map<string, HealthCheckResult>([['a-1', { healthy: true, timestamp: new Date() }]]);
    const metrics = new Map<string, LoadBalancerMetrics>([
      [
        'a-1',
        {
          serviceId: 'a-1',
          requestCount: 1,
          errorCount: 0,
          avgResponseTime: 10,
          addedAt: new Date(),
          lastRequestTime: new Date()
        }
      ]
    ]);

    const mgr = new ServiceStateManager({ templates, instances, healthCache, metrics });

    expect(mgr.getTemplate('svc-a')?.name).toBe('svc-a');
    expect(mgr.getInstance('a-1')?.config.name).toBe('svc-a');
    expect(mgr.getHealth('a-1')?.healthy).toBe(true);
    expect(mgr.getMetrics('a-1')?.requestCount).toBe(1);
  });

  it('stores and reads instances (optionally filtered by template)', () => {
    const mgr = new ServiceStateManager();
    const a1 = makeInstance('a-1', 'svc-a');
    const a2 = makeInstance('a-2', 'svc-a');
    const b1 = makeInstance('b-1', 'svc-b');

    mgr.setInstance(a1);
    mgr.setInstance(a2);
    mgr.setInstance(b1);

    expect(mgr.getInstance('a-2')).toEqual(a2);
    expect(mgr.listInstances()).toHaveLength(3);
    expect(mgr.listInstances('svc-a').map((i) => i.id).sort()).toEqual(['a-1', 'a-2']);
  });

  it('updates and reads health and metrics', () => {
    const mgr = new ServiceStateManager();
    const instance = makeInstance('a-1', 'svc-a');
    mgr.setInstance(instance);

    const health: HealthCheckResult = { healthy: true, latency: 12, timestamp: new Date() };
    mgr.updateHealth(instance.id, health);
    expect(mgr.getHealth(instance.id)).toEqual(health);

    const metrics: LoadBalancerMetrics = {
      serviceId: instance.id,
      requestCount: 3,
      errorCount: 1,
      avgResponseTime: 42,
      addedAt: new Date(),
      lastRequestTime: new Date()
    };
    mgr.updateMetrics(instance.id, metrics);
    expect(mgr.getMetrics(instance.id)).toEqual(metrics);
  });

  it('removes instances and clears derived state', () => {
    const mgr = new ServiceStateManager();
    const instance = makeInstance('a-1', 'svc-a');
    mgr.setInstance(instance);
    mgr.updateHealth(instance.id, { healthy: false, timestamp: new Date() });
    mgr.updateMetrics(instance.id, {
      serviceId: instance.id,
      requestCount: 1,
      errorCount: 1,
      avgResponseTime: 10,
      addedAt: new Date(),
      lastRequestTime: new Date()
    });

    mgr.removeInstance(instance.id);

    expect(mgr.getInstance(instance.id)).toBeUndefined();
    expect(mgr.getHealth(instance.id)).toBeUndefined();
    expect(mgr.getMetrics(instance.id)).toBeUndefined();
  });

  it('removes templates', () => {
    const mgr = new ServiceStateManager();
    const template = makeTemplate('svc-a');
    mgr.setTemplate(template);

    mgr.removeTemplate('svc-a');

    expect(mgr.getTemplate('svc-a')).toBeUndefined();
    expect(mgr.listTemplates()).toEqual([]);
  });
});

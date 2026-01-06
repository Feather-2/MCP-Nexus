import { ServiceObservationStore } from '../../gateway/service-state.js';
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

function makeInstance(id: string, templateName: string, overrides: Partial<ServiceInstance> = {}): ServiceInstance {
  return {
    id,
    config: makeTemplate(templateName),
    state: 'idle',
    startedAt: new Date(),
    errorCount: 0,
    metadata: {},
    ...overrides
  };
}

describe('ServiceObservationStore', () => {
  it('applies atomic updates and emits ordered events after commit', () => {
    const store = new ServiceObservationStore();
    const template = makeTemplate('svc-a');
    const instance = makeInstance('a-1', 'svc-a');
    const health: HealthCheckResult = { healthy: true, latency: 12, timestamp: new Date('2020-01-01T00:00:00.000Z') };
    const metrics: LoadBalancerMetrics = {
      serviceId: 'a-1',
      requestCount: 1,
      errorCount: 0,
      avgResponseTime: 10,
      addedAt: new Date('2020-01-01T00:00:00.000Z'),
      lastRequestTime: new Date('2020-01-01T00:00:00.000Z')
    };

    const seen: string[] = [];
    let sawCommittedStateOnFirstEvent = false;

    store.subscribe((event) => {
      seen.push(event.type);
      if (seen.length === 1) {
        sawCommittedStateOnFirstEvent =
          store.getTemplate('svc-a')?.name === 'svc-a' &&
          store.getInstance('a-1')?.id === 'a-1' &&
          store.getHealth('a-1')?.healthy === true &&
          store.getMetrics('a-1')?.requestCount === 1;
      }
    });

    store.atomicUpdate((tx) => {
      tx.setTemplate(template);
      tx.setInstance(instance);
      tx.setHealth('a-1', health);
      tx.setMetrics('a-1', metrics);
    });

    expect(seen).toEqual(['template:set', 'instance:set', 'health:update', 'metrics:update']);
    expect(sawCommittedStateOnFirstEvent).toBe(true);
    expect(store.getRevision()).toBe(1);
  });

  it('rolls back state and emits no events when atomicUpdate throws', () => {
    const store = new ServiceObservationStore();
    const template = makeTemplate('svc-a');

    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));

    expect(() =>
      store.atomicUpdate((tx) => {
        tx.setTemplate(template);
        throw new Error('boom');
      })
    ).toThrow('boom');

    expect(store.getTemplate('svc-a')).toBeUndefined();
    expect(events).toEqual([]);
    expect(store.getRevision()).toBe(0);
  });

  it('rejects async atomicUpdate callbacks (no partial state)', () => {
    const store = new ServiceObservationStore();
    const template = makeTemplate('svc-a');

    expect(() =>
      store.atomicUpdate(async (tx) => {
        tx.setTemplate(template);
      })
    ).toThrow('callback must be synchronous');

    expect(store.getTemplate('svc-a')).toBeUndefined();
    expect(store.getRevision()).toBe(0);
  });

  it('supports nested atomic updates (single revision bump)', () => {
    const store = new ServiceObservationStore();
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));

    store.atomicUpdate((tx) => {
      tx.setTemplate(makeTemplate('svc-a'));
      store.setTemplate(makeTemplate('svc-b')); // nested atomicUpdate
      tx.setTemplate(makeTemplate('svc-c'));
    });

    expect(events).toEqual(['template:set', 'template:set', 'template:set']);
    expect(store.getRevision()).toBe(1);
  });

  it('unsubscribe prevents further events', () => {
    const store = new ServiceObservationStore();
    const events: string[] = [];
    const unsubscribe = store.subscribe((e) => events.push(e.type));

    store.setTemplate(makeTemplate('svc-a'));
    unsubscribe();
    store.setTemplate(makeTemplate('svc-b'));

    expect(events).toEqual(['template:set']);
  });

  it('isolates subscriber failures', () => {
    const store = new ServiceObservationStore();

    const ok = vi.fn();
    store.subscribe(() => {
      throw new Error('bad subscriber');
    });
    store.subscribe(ok);

    expect(() => store.setTemplate(makeTemplate('svc-a'))).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('patchInstance merges metadata and emits an instance:set event', () => {
    const store = new ServiceObservationStore();
    store.setInstance(makeInstance('a-1', 'svc-a', { metadata: { a: 1 } }));

    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));

    const updated = store.patchInstance('a-1', { metadata: { b: 2 } });
    expect(updated?.metadata).toEqual({ a: 1, b: 2 });
    expect(store.getInstance('a-1')?.metadata).toEqual({ a: 1, b: 2 });
    expect(events).toContain('instance:set');
  });

  it('no-ops when removing missing keys (no events)', () => {
    const store = new ServiceObservationStore();
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));

    store.removeTemplate('missing-template');
    store.removeHealth('missing-instance');
    store.removeMetrics('missing-instance');

    expect(events).toEqual([]);
    expect(store.getRevision()).toBe(0);
  });

  it('patchInstance returns undefined when instance is missing', () => {
    const store = new ServiceObservationStore();
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));

    const updated = store.patchInstance('missing', { metadata: { x: 1 } });
    expect(updated).toBeUndefined();
    expect(events).toEqual([]);
    expect(store.getRevision()).toBe(0);
  });

  it('removeInstance clears derived state and emits removal events in order', () => {
    const store = new ServiceObservationStore();
    const instance = makeInstance('a-1', 'svc-a');
    store.setInstance(instance);
    store.updateHealth('a-1', { healthy: true, timestamp: new Date() });
    store.updateMetrics('a-1', {
      serviceId: 'a-1',
      requestCount: 1,
      errorCount: 0,
      avgResponseTime: 10,
      addedAt: new Date(),
      lastRequestTime: new Date()
    });

    const seen: string[] = [];
    store.subscribe((e) => seen.push(e.type));

    store.removeInstance('a-1');

    expect(store.getInstance('a-1')).toBeUndefined();
    expect(store.getHealth('a-1')).toBeUndefined();
    expect(store.getMetrics('a-1')).toBeUndefined();

    expect(seen).toEqual(['instance:remove', 'health:remove', 'metrics:remove']);
  });
});

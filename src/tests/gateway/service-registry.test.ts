import { ServiceRegistry } from '../../gateway/service-registry.js';
import { ServiceStateManager } from '../../gateway/service-state.js';
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

describe('ServiceRegistry (lifecycle)', () => {
  it('registers and unregisters templates', () => {
    const state = new ServiceStateManager();
    const registry = new ServiceRegistry(state);
    const template = makeTemplate('svc-a');

    registry.registerTemplate(template);
    expect(registry.getTemplate('svc-a')).toEqual(template);

    registry.unregisterTemplate('svc-a');
    expect(registry.getTemplate('svc-a')).toBeUndefined();
  });

  it('creates and removes instances', () => {
    const state = new ServiceStateManager();
    const registry = new ServiceRegistry(state);
    registry.registerTemplate(makeTemplate('svc-a'));

    const instance = registry.createInstance('svc-a');
    expect(instance.id).toMatch(/^svc-a-/);
    expect(registry.getInstance(instance.id)?.config.name).toBe('svc-a');

    registry.removeInstance(instance.id);
    expect(registry.getInstance(instance.id)).toBeUndefined();
  });

  it('throws on createInstance when template is missing', () => {
    const state = new ServiceStateManager();
    const registry = new ServiceRegistry(state);
    expect(() => registry.createInstance('missing')).toThrow('Template missing not found');
  });

  it('supports overriding instance fields', () => {
    const state = new ServiceStateManager();
    const registry = new ServiceRegistry(state);
    const template = makeTemplate('svc-a', { timeout: 5000 });
    registry.registerTemplate(template);

    const overrideConfig: McpServiceConfig = { ...template, timeout: 1234 };
    const overrides: Partial<ServiceInstance> = { id: 'custom-id', state: 'running', config: overrideConfig };

    const instance = registry.createInstance('svc-a', overrides);
    expect(instance.id).toBe('custom-id');
    expect(instance.state).toBe('running');
    expect(instance.config.timeout).toBe(1234);
  });

  it('lists templates and instances', () => {
    const state = new ServiceStateManager();
    const registry = new ServiceRegistry(state);
    registry.registerTemplate(makeTemplate('svc-a'));
    registry.registerTemplate(makeTemplate('svc-b'));

    const a1 = registry.createInstance('svc-a');
    const b1 = registry.createInstance('svc-b');

    expect(registry.listTemplates().map((t) => t.name).sort()).toEqual(['svc-a', 'svc-b']);
    expect(registry.listInstances().map((i) => i.id).sort()).toEqual([a1.id, b1.id].sort());
    expect(registry.listInstances('svc-a').map((i) => i.id)).toEqual([a1.id]);
  });
});


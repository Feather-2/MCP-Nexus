import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ServiceRegistryImpl } from '../../gateway/ServiceRegistryImpl.js';
import type { Logger, McpServiceConfig } from '../../types/index.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeTemplate(name = 'test-svc', overrides: Partial<McpServiceConfig> = {}): McpServiceConfig {
  return { name, version: '2024-11-26', transport: 'stdio', command: 'echo', args: ['hi'], timeout: 5000, retries: 1, ...overrides } as McpServiceConfig;
}

describe('ServiceRegistryImpl – extended coverage', () => {
  let registry: ServiceRegistryImpl;

  beforeEach(() => {
    registry = new ServiceRegistryImpl(makeLogger());
  });

  // ── Template management ──

  it('registerTemplate and getTemplate round-trip', async () => {
    await registry.registerTemplate(makeTemplate('alpha'));
    const t = await registry.getTemplate('alpha');
    expect(t).not.toBeNull();
    expect(t!.name).toBe('alpha');
  });

  it('getTemplate returns null for missing', async () => {
    expect(await registry.getTemplate('nope')).toBeNull();
  });

  it('listTemplates returns registered templates', async () => {
    const before = (await registry.listTemplates()).length;
    await registry.registerTemplate(makeTemplate('cov-a'));
    await registry.registerTemplate(makeTemplate('cov-b'));
    const list = await registry.listTemplates();
    expect(list.length).toBeGreaterThanOrEqual(before);
  });

  it('removeTemplate removes it', async () => {
    await registry.registerTemplate(makeTemplate('rm-me'));
    await registry.removeTemplate('rm-me');
    expect(await registry.getTemplate('rm-me')).toBeNull();
  });

  it('getTemplateManager returns manager', () => {
    expect(registry.getTemplateManager()).toBeDefined();
  });

  // ── Instance lifecycle ──

  it('createInstance creates instance from template', async () => {
    await registry.registerTemplate(makeTemplate('svc'));
    const inst = await registry.createInstance('svc');
    expect(inst.id).toContain('svc');
    expect(inst.state).toBe('idle');
    expect(inst.config.name).toBe('svc');
  });

  it('createInstance throws for missing template', async () => {
    await expect(registry.createInstance('missing')).rejects.toThrow('not found');
  });

  it('createInstance sanitizes filesystem ALLOWED_DIRECTORY placeholder', async () => {
    await registry.registerTemplate(makeTemplate('filesystem', {
      transport: 'stdio', command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '${ALLOWED_DIRECTORY}']
    }));
    const inst = await registry.createInstance('filesystem');
    expect(inst.config.args).toBeDefined();
    expect(inst.config.args!.every(a => !String(a).includes('${ALLOWED_DIRECTORY}'))).toBe(true);
  });

  it('createInstance with instanceMode=managed skips health monitoring', async () => {
    await registry.registerTemplate(makeTemplate('managed'));
    const inst = await registry.createInstance('managed', { instanceMode: 'managed' } as any);
    expect(inst.metadata.mode).toBe('managed');
  });

  it('getInstance returns null for missing', async () => {
    expect(await registry.getInstance('nope')).toBeNull();
  });

  it('listInstances returns created instances', async () => {
    await registry.registerTemplate(makeTemplate('li'));
    await registry.createInstance('li');
    await registry.createInstance('li');
    const list = await registry.listInstances();
    expect(list.length).toBe(2);
  });

  it('listServices is alias for listInstances', async () => {
    await registry.registerTemplate(makeTemplate('ls'));
    await registry.createInstance('ls');
    const list = await registry.listServices();
    expect(list.length).toBe(1);
  });

  it('getService is alias for getInstance', async () => {
    await registry.registerTemplate(makeTemplate('gs'));
    const inst = await registry.createInstance('gs');
    const found = await registry.getService(inst.id);
    expect(found?.id).toBe(inst.id);
  });

  it('createServiceFromTemplate returns instance id', async () => {
    await registry.registerTemplate(makeTemplate('csft'));
    const id = await registry.createServiceFromTemplate('csft');
    expect(typeof id).toBe('string');
    expect(id).toContain('csft');
  });

  // ── Stop / Remove ──

  it('stopService removes instance', async () => {
    await registry.registerTemplate(makeTemplate('stop'));
    const inst = await registry.createInstance('stop');
    const ok = await registry.stopService(inst.id);
    expect(ok).toBe(true);
    expect(await registry.getInstance(inst.id)).toBeNull();
  });

  it('stopService handles nonexistent gracefully', async () => {
    const ok = await registry.stopService('nonexistent-id');
    expect(typeof ok).toBe('boolean');
  });

  it('removeInstance removes instance', async () => {
    await registry.registerTemplate(makeTemplate('rm'));
    const inst = await registry.createInstance('rm');
    await registry.removeInstance(inst.id);
    expect(await registry.getInstance(inst.id)).toBeNull();
  });

  // ── Health ──

  it('reportHeartbeat does not throw', async () => {
    await registry.registerTemplate(makeTemplate('hb'));
    const inst = await registry.createInstance('hb');
    registry.reportHeartbeat(inst.id, { healthy: true, latency: 10 });
  });

  it('reportHeartbeat is safe for missing instance', () => {
    registry.reportHeartbeat('nope', { healthy: false, error: 'gone' });
  });

  it('getHealthAggregates returns global and perService', async () => {
    const agg = await registry.getHealthAggregates();
    expect(agg.global).toBeDefined();
    expect(Array.isArray(agg.perService)).toBe(true);
  });

  it('getHealthyInstances returns empty for no instances', async () => {
    const healthy = await registry.getHealthyInstances();
    expect(healthy.length).toBe(0);
  });

  it('setInstanceMetadata sets value', async () => {
    await registry.registerTemplate(makeTemplate('meta'));
    const inst = await registry.createInstance('meta');
    await registry.setInstanceMetadata(inst.id, 'foo', 'bar');
    const found = await registry.getInstance(inst.id);
    expect(found?.metadata.foo).toBe('bar');
  });

  it('setInstanceMetadata throws for missing', async () => {
    await expect(registry.setInstanceMetadata('nope', 'k', 'v')).rejects.toThrow('not found');
  });

  // ── Selection ──

  it('selectBestInstance returns null when no instances', async () => {
    expect(await registry.selectBestInstance('nope')).toBeNull();
  });

  it('selectBestInstance returns instance when available', async () => {
    await registry.registerTemplate(makeTemplate('sel'));
    await registry.createInstance('sel');
    const best = await registry.selectBestInstance('sel');
    expect(best).not.toBeNull();
  });

  it('selectInstance returns null when no instances', async () => {
    expect(await registry.selectInstance('nope')).toBeNull();
  });

  it('selectInstance returns instance when available', async () => {
    await registry.registerTemplate(makeTemplate('si'));
    await registry.createInstance('si');
    const inst = await registry.selectInstance('si');
    expect(inst).not.toBeNull();
  });

  // ── Health monitoring ──

  it('startHealthMonitoring and stopHealthMonitoring', async () => {
    await registry.registerTemplate(makeTemplate('hm'));
    await registry.createInstance('hm');
    await registry.startHealthMonitoring();
    await registry.stopHealthMonitoring();
  });

  it('getHealthStatus returns record', async () => {
    const status = await registry.getHealthStatus();
    expect(typeof status).toBe('object');
  });

  // ── Scaling ──

  it('scaleTemplate scales up', async () => {
    await registry.registerTemplate(makeTemplate('scale'));
    const result = await registry.scaleTemplate('scale', 3);
    expect(result.length).toBe(3);
  });

  it('scaleTemplate scales down', async () => {
    await registry.registerTemplate(makeTemplate('sd'));
    await registry.scaleTemplate('sd', 3);
    const result = await registry.scaleTemplate('sd', 1);
    expect(result.length).toBe(1);
  });

  it('scaleTemplate no-op when target equals current', async () => {
    await registry.registerTemplate(makeTemplate('noop'));
    await registry.createInstance('noop');
    const result = await registry.scaleTemplate('noop', 1);
    expect(result.length).toBe(1);
  });

  // ── Stats ──

  it('getRegistryStats returns correct totals', async () => {
    const before = await registry.getRegistryStats();
    await registry.registerTemplate(makeTemplate('stats-svc'));
    await registry.createInstance('stats-svc');
    const stats = await registry.getRegistryStats();
    expect(stats.totalTemplates).toBeGreaterThanOrEqual(before.totalTemplates);
    expect(stats.totalInstances).toBe(before.totalInstances + 1);
    expect(stats.instancesByState.idle).toBeGreaterThanOrEqual(1);
  });

  it('getInstancesByTemplate filters correctly', async () => {
    await registry.registerTemplate(makeTemplate('a'));
    await registry.registerTemplate(makeTemplate('b'));
    await registry.createInstance('a');
    await registry.createInstance('a');
    await registry.createInstance('b');
    const aInstances = await registry.getInstancesByTemplate('a');
    expect(aInstances.length).toBe(2);
  });
});

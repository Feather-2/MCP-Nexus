import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ServiceInstanceManager } from '../../gateway/ServiceInstanceManager.js';
import type { Logger, McpServiceConfig } from '../../types/index.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeConfig(name = 'test-svc'): McpServiceConfig {
  return { name, version: '2024-11-26', transport: 'stdio', command: 'echo', args: ['hi'], timeout: 5000, retries: 1 };
}

describe('ServiceInstanceManager', () => {
  let mgr: ServiceInstanceManager;

  beforeEach(() => {
    mgr = new ServiceInstanceManager(makeLogger());
  });

  it('create returns instance with correct properties', async () => {
    const inst = await mgr.create(makeConfig());
    expect(inst.id).toContain('test-svc');
    expect(inst.state).toBe('idle');
    expect(inst.errorCount).toBe(0);
    expect(inst.metadata.transport).toBe('stdio');
  });

  it('get returns instance by id', async () => {
    const inst = await mgr.create(makeConfig());
    const found = await mgr.get(inst.id);
    expect(found?.id).toBe(inst.id);
  });

  it('get returns null for missing id', async () => {
    expect(await mgr.get('nonexistent')).toBeNull();
  });

  it('list returns all instances', async () => {
    await mgr.create(makeConfig('a'));
    await mgr.create(makeConfig('b'));
    const all = await mgr.list();
    expect(all.length).toBe(2);
  });

  it('update modifies instance', async () => {
    const inst = await mgr.create(makeConfig());
    const updated = await mgr.update(inst.id, { state: 'running' });
    expect(updated.state).toBe('running');
  });

  it('update throws for missing instance', async () => {
    await expect(mgr.update('nope', {})).rejects.toThrow('not found');
  });

  it('remove deletes instance', async () => {
    const inst = await mgr.create(makeConfig());
    await mgr.remove(inst.id);
    expect(await mgr.get(inst.id)).toBeNull();
  });

  it('remove throws for missing instance', async () => {
    await expect(mgr.remove('nope')).rejects.toThrow('not found');
  });

  it('updateState changes state and records timestamp', async () => {
    const inst = await mgr.create(makeConfig());
    await mgr.updateState(inst.id, 'running');
    const found = await mgr.get(inst.id);
    expect(found?.state).toBe('running');
    expect(found?.metadata.lastStateChange).toBeDefined();
  });

  it('updateState throws for missing instance', async () => {
    await expect(mgr.updateState('nope', 'running')).rejects.toThrow('not found');
  });

  it('incrementErrorCount increments and sets lastError', async () => {
    const inst = await mgr.create(makeConfig());
    await mgr.incrementErrorCount(inst.id);
    const found = await mgr.get(inst.id);
    expect(found?.errorCount).toBe(1);
    expect(found?.metadata.lastError).toBeDefined();
  });

  it('incrementErrorCount is no-op for missing instance', async () => {
    await mgr.incrementErrorCount('nope');
  });

  it('resetErrorCount resets to zero', async () => {
    const inst = await mgr.create(makeConfig());
    await mgr.incrementErrorCount(inst.id);
    await mgr.resetErrorCount(inst.id);
    const found = await mgr.get(inst.id);
    expect(found?.errorCount).toBe(0);
    expect(found?.metadata.lastError).toBeUndefined();
  });

  it('resetErrorCount is no-op for missing instance', async () => {
    await mgr.resetErrorCount('nope');
  });

  it('getInstancesByTemplate filters by config name', async () => {
    await mgr.create(makeConfig('alpha'));
    await mgr.create(makeConfig('beta'));
    await mgr.create(makeConfig('alpha'));
    const alphas = await mgr.getInstancesByTemplate('alpha');
    expect(alphas.length).toBe(2);
  });

  it('getInstancesByState filters by state', async () => {
    const inst = await mgr.create(makeConfig());
    await mgr.updateState(inst.id, 'running');
    await mgr.create(makeConfig());
    const running = await mgr.getInstancesByState('running');
    expect(running.length).toBe(1);
  });

  it('setMetadata sets key-value on instance', async () => {
    const inst = await mgr.create(makeConfig());
    await mgr.setMetadata(inst.id, 'foo', 'bar');
    const val = await mgr.getMetadata(inst.id, 'foo');
    expect(val).toBe('bar');
  });

  it('setMetadata throws for missing instance', async () => {
    await expect(mgr.setMetadata('nope', 'k', 'v')).rejects.toThrow('not found');
  });

  it('getMetadata returns undefined for missing instance', async () => {
    expect(await mgr.getMetadata('nope', 'k')).toBeUndefined();
  });

  it('getInstanceStats returns correct aggregation', async () => {
    const a = await mgr.create(makeConfig('svc-a'));
    await mgr.updateState(a.id, 'running');
    await mgr.incrementErrorCount(a.id);
    await mgr.create(makeConfig('svc-b'));
    const stats = await mgr.getInstanceStats();
    expect(stats.total).toBe(2);
    expect(stats.byState.running).toBe(1);
    expect(stats.byState.idle).toBe(1);
    expect(stats.byTemplate['svc-a']).toBe(1);
    expect(stats.byTemplate['svc-b']).toBe(1);
    expect(stats.avgErrorCount).toBe(0.5);
  });

  it('getInstanceStats returns zeros for empty manager', async () => {
    const stats = await mgr.getInstanceStats();
    expect(stats.total).toBe(0);
    expect(stats.avgErrorCount).toBe(0);
  });
});

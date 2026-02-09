import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createGateway, PbMcpGateway } from '../index.js';

describe('PbMcpGateway – extended coverage', () => {
  let gw: PbMcpGateway;

  beforeEach(() => {
    gw = createGateway({ logLevel: 'error' });
  });

  afterEach(async () => {
    if (gw?.isRunning()) await gw.stop();
  });

  // ── Pre-start guards ──

  it('ensureStarted throws before start()', () => {
    expect(() => gw.getMetrics()).toThrow('Gateway is not started');
  });

  it('listServices throws before start()', async () => {
    await expect(gw.listServices()).rejects.toThrow('not started');
  });

  it('getService throws before start()', async () => {
    await expect(gw.getService('x')).rejects.toThrow('not started');
  });

  it('getServiceStatus throws before start()', async () => {
    await expect(gw.getServiceStatus('x')).rejects.toThrow('not started');
  });

  it('createService throws before start()', async () => {
    await expect(gw.createService('x')).rejects.toThrow('not started');
  });

  it('stopService throws before start()', async () => {
    await expect(gw.stopService('x')).rejects.toThrow('not started');
  });

  it('generateToken throws before start()', async () => {
    await expect(gw.generateToken('u', ['r'])).rejects.toThrow('not started');
  });

  it('createApiKey throws before start()', async () => {
    await expect(gw.createApiKey('k', ['r'])).rejects.toThrow('not started');
  });

  it('revokeToken throws before start()', async () => {
    await expect(gw.revokeToken('t')).rejects.toThrow('not started');
  });

  it('revokeApiKey throws before start()', async () => {
    await expect(gw.revokeApiKey('k')).rejects.toThrow('not started');
  });

  it('getHealthStatus throws before start()', async () => {
    await expect(gw.getHealthStatus()).rejects.toThrow('not started');
  });

  // ── start() double-call ──

  it('start() throws if already started', async () => {
    await gw.start();
    await expect(gw.start()).rejects.toThrow('already started');
  });

  // ── Utility methods ──

  it('getVersion returns string', () => {
    expect(gw.getVersion()).toBe('1.0.0');
  });

  it('isStarted mirrors isRunning', () => {
    expect(gw.isStarted()).toBe(false);
    expect(gw.isRunning()).toBe(false);
  });

  // ── Component accessors ──

  it('exposes component accessors', () => {
    expect(gw.getServiceRegistry()).toBeDefined();
    expect(gw.getAuthLayer()).toBeDefined();
    expect(gw.getRouter()).toBeDefined();
    expect(gw.getHttpServer()).toBeDefined();
    expect(gw.getConfigManager()).toBeDefined();
    expect(gw.serviceRegistry).toBeDefined();
  });

  // ── Config methods ──

  it('getConfig returns config object', () => {
    const cfg = gw.getConfig();
    expect(cfg).toBeDefined();
    expect(cfg.host).toBe('127.0.0.1');
  });

  it('listTemplates returns array', async () => {
    const templates = await gw.listTemplates();
    expect(Array.isArray(templates)).toBe(true);
  });

  it('exportConfig returns JSON string', async () => {
    const json = await gw.exportConfig();
    expect(typeof json).toBe('string');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  // ── Post-start methods ──

  it('getMetrics returns structured data after start', async () => {
    await gw.start();
    const metrics = gw.getMetrics();
    expect(metrics.registry).toBeDefined();
    expect(metrics.router).toBeDefined();
    expect(metrics.auth).toBeDefined();
  });

  it('getHealthStatus returns structured data after start', async () => {
    await gw.start();
    const health = await gw.getHealthStatus();
    expect(health.gateway.status).toBe('healthy');
    expect(health.gateway.uptime).toBeGreaterThan(0);
    expect(Array.isArray(health.services)).toBe(true);
    expect(typeof health.metrics.totalServices).toBe('number');
  });

  it('getOrchestratorStatus returns status', async () => {
    await gw.start();
    const status = gw.getOrchestratorStatus();
    expect(status).toBeDefined();
    expect(typeof status.enabled).toBe('boolean');
  });

  it('getOrchestratorStatus falls back to manager when no cached status', () => {
    const status = gw.getOrchestratorStatus();
    expect(status).toBeDefined();
  });

  // ── Event forwarding ──

  it('emits started event on start', async () => {
    const spy = vi.fn();
    gw.on('started', spy);
    await gw.start();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ config: expect.any(Object) }));
  });

  it('emits stopped event on stop', async () => {
    await gw.start();
    const spy = vi.fn();
    gw.on('stopped', spy);
    await gw.stop();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // ── Graceful shutdown ──

  it('enableGracefulShutdown is idempotent', () => {
    gw.enableGracefulShutdown();
    gw.enableGracefulShutdown();
    gw.disableGracefulShutdown();
  });

  it('disableGracefulShutdown clears handlers', () => {
    gw.enableGracefulShutdown();
    gw.disableGracefulShutdown();
    gw.disableGracefulShutdown();
  });

  // ── stop() when not started ──

  it('stop() is no-op when not started', async () => {
    await gw.stop();
  });

  // ── Template management ──

  it('registerTemplate and removeTemplate work', async () => {
    const template = {
      name: 'cov-test-tmpl',
      version: '2024-11-26',
      transport: 'stdio' as const,
      command: 'echo',
      args: ['hi'],
      timeout: 5000,
      retries: 1
    };
    await gw.registerTemplate(template as any);
    const removed = await gw.removeTemplate('cov-test-tmpl');
    expect(removed).toBe(true);
  });

  it('removeTemplate returns false for non-existent', async () => {
    const removed = await gw.removeTemplate('nonexistent-xxx');
    expect(removed).toBe(false);
  });

  // ── updateConfig ──

  it('updateConfig updates loadBalancingStrategy', async () => {
    await gw.start();
    const spy = vi.fn();
    gw.on('configUpdated', spy);
    const cfg = await gw.updateConfig({ loadBalancingStrategy: 'round-robin' });
    expect(cfg.loadBalancingStrategy).toBe('round-robin');
  });

  // ── importConfig ──

  it('importConfig emits configImported event', async () => {
    const spy = vi.fn();
    gw.on('configImported', spy);
    const json = await gw.exportConfig();
    await gw.importConfig(json);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

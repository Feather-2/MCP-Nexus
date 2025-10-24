import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createGateway, PbMcpGateway } from '../index.js';

describe('PaperBurnerGateway', () => {
  let gateway: PbMcpGateway;

  beforeEach(() => {
    gateway = createGateway({ logLevel: 'error' }); // Reduce noise in tests
  });

  afterEach(async () => {
    // Ensure gateway is stopped after each test
    if (gateway?.isRunning()) {
      await gateway.stop();
    }
  });

  it('should create a gateway instance', () => {
    expect(gateway).toBeDefined();
    expect(gateway.isRunning()).toBe(false);
  });

  it('should start and stop the gateway', async () => {
    expect(gateway.isRunning()).toBe(false);
    
    await gateway.start();
    expect(gateway.isRunning()).toBe(true);
    
    await gateway.stop();
    expect(gateway.isRunning()).toBe(false);
  });

  it('should list available templates after start', async () => {
    await gateway.start();
    
    const templates = await gateway.serviceRegistry.listTemplates();
    expect(templates).toBeDefined();
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);
    
    // Check for default templates
    const templateNames = templates.map(t => t.name);
    expect(templateNames).toContain('filesystem');
    expect(templateNames).toContain('brave-search');
    expect(templateNames).toContain('github');
    
    await gateway.stop();
  });

  it('should create and manage service instances', async () => {
    await gateway.start();
    
    // Initially no services
    let services = await gateway.listServices();
    expect(services).toHaveLength(0);
    
    // Register a custom template for testing
    await gateway.serviceRegistry.registerTemplate({
      name: 'test-service',
      version: '2024-11-26',
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
      timeout: 5000,
      retries: 1
    });
    
    // Create instance from template
    const instance = await gateway.serviceRegistry.createInstance('test-service');
    expect(instance).toBeDefined();
    expect(instance.config.name).toBe('test-service');
    expect(instance.state).toBe('idle');
    
    // List services should now show one
    services = await gateway.listServices();
    expect(services).toHaveLength(1);
    
    // Remove instance
    await gateway.serviceRegistry.removeInstance(instance.id);
    services = await gateway.listServices();
    expect(services).toHaveLength(0);
    
    await gateway.stop();
  });

  it('should handle template validation', async () => {
    await gateway.start();
    
    // Valid template should work
    const validTemplate = {
      name: 'valid-test',
      version: '2024-11-26' as const,
      transport: 'stdio' as const,
      command: 'node',
      args: ['-v'],
      timeout: 10000,
      retries: 2
    };
    
    await expect(
      gateway.serviceRegistry.registerTemplate(validTemplate)
    ).resolves.not.toThrow();
    
    // Invalid template should fail
    const invalidTemplate = {
      name: '', // Empty name should fail
      version: '2024-11-26' as const,
      transport: 'stdio' as const
    };
    
    await expect(
      gateway.serviceRegistry.registerTemplate(invalidTemplate as any)
    ).rejects.toThrow();
    
    await gateway.stop();
  });
});
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceRegistryImpl } from '../../gateway/ServiceRegistryImpl.js';
import { ServiceTemplateManager } from '../../gateway/ServiceTemplateManager.js';
import { ServiceInstanceManager } from '../../gateway/ServiceInstanceManager.js';
import { ServiceHealthChecker } from '../../gateway/ServiceHealthChecker.js';
import { IntelligentLoadBalancer } from '../../gateway/IntelligentLoadBalancer.js';
import { McpServiceConfig, ServiceInstance, Logger } from '../../types/index.js';

// Mock the dependencies
vi.mock('../../gateway/ServiceTemplateManager.js');
vi.mock('../../gateway/ServiceInstanceManager.js');
vi.mock('../../gateway/ServiceHealthChecker.js');
vi.mock('../../gateway/IntelligentLoadBalancer.js');

describe('ServiceRegistryImpl', () => {
  let registry: ServiceRegistryImpl;
  let mockLogger: Logger;
  let mockTemplateManager: ServiceTemplateManager;
  let mockInstanceManager: ServiceInstanceManager;
  let mockHealthChecker: ServiceHealthChecker;
  let mockLoadBalancer: IntelligentLoadBalancer;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    // Create mocked instances
    mockTemplateManager = {
      register: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      initializeDefaults: vi.fn()
    } as any;

    mockInstanceManager = {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      updateState: vi.fn(),
      getMetrics: vi.fn()
    } as any;

    mockHealthChecker = {
      startMonitoring: vi.fn().mockResolvedValue(undefined),
      stopMonitoring: vi.fn().mockResolvedValue(undefined),
      checkHealth: vi.fn(),
      getHealthStatus: vi.fn().mockResolvedValue({})
    } as any;

    mockLoadBalancer = {
      selectInstance: vi.fn(),
      addInstance: vi.fn(),
      removeInstance: vi.fn(),
      updateMetrics: vi.fn(),
      getStrategy: vi.fn(),
      setStrategy: vi.fn()
    } as any;

    // Mock the constructors to return our mock instances
    vi.mocked(ServiceTemplateManager).mockImplementation(() => mockTemplateManager);
    vi.mocked(ServiceInstanceManager).mockImplementation(() => mockInstanceManager);
    vi.mocked(ServiceHealthChecker).mockImplementation(() => mockHealthChecker);
    vi.mocked(IntelligentLoadBalancer).mockImplementation(() => mockLoadBalancer);

    registry = new ServiceRegistryImpl(mockLogger);
  });

  describe('template management', () => {
    it('should register a template', async () => {
      const template: McpServiceConfig = {
        name: 'test-service',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'node',
        args: ['-v'],
        timeout: 5000,
        retries: 2
      };

      vi.mocked(mockTemplateManager.register).mockResolvedValueOnce(undefined);

      await registry.registerTemplate(template);

      expect(mockTemplateManager.register).toHaveBeenCalledWith(template);
      expect(mockLogger.info).toHaveBeenCalledWith('Template registered: test-service');
    });

    it('should get a template', async () => {
      const template: McpServiceConfig = {
        name: 'test-service',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'node',
        args: ['-v'],
        timeout: 5000,
        retries: 2
      };

      vi.mocked(mockTemplateManager.get).mockResolvedValueOnce(template);

      const result = await registry.getTemplate('test-service');

      expect(mockTemplateManager.get).toHaveBeenCalledWith('test-service');
      expect(result).toEqual(template);
    });

    it('should return null for non-existent template', async () => {
      vi.mocked(mockTemplateManager.get).mockResolvedValueOnce(null);

      const result = await registry.getTemplate('non-existent');

      expect(result).toBeNull();
    });

    it('should list templates', async () => {
      const templates: McpServiceConfig[] = [
        {
          name: 'service1',
          version: '2024-11-26',
          transport: 'stdio',
          command: 'node',
          args: ['-v'],
          timeout: 5000,
          retries: 2
        },
        {
          name: 'service2',
          version: '2024-11-26',
          transport: 'http',
          command: 'python',
          args: ['--version'],
          timeout: 8000,
          retries: 1
        }
      ];

      vi.mocked(mockTemplateManager.list).mockResolvedValueOnce(templates);

      const result = await registry.listTemplates();

      expect(mockTemplateManager.list).toHaveBeenCalled();
      expect(result).toEqual(templates);
    });
  });

  describe('instance management', () => {
    const mockTemplate: McpServiceConfig = {
      name: 'test-service',
      version: '2024-11-26',
      transport: 'stdio',
      command: 'node',
      args: ['-v'],
      timeout: 5000,
      retries: 2
    };

    const mockInstance: ServiceInstance = {
      id: 'instance-123',
      config: mockTemplate,
      state: 'idle',
      createdAt: new Date(),
      lastHealthCheck: new Date(),
      metrics: {
        requestCount: 0,
        errorCount: 0,
        avgResponseTime: 0,
        uptime: 0
      }
    };

    it('should create instance from template', async () => {
      vi.mocked(mockTemplateManager.get).mockResolvedValueOnce(mockTemplate);
      vi.mocked(mockInstanceManager.create).mockResolvedValueOnce(mockInstance);

      const result = await registry.createInstance('test-service');

      expect(mockTemplateManager.get).toHaveBeenCalledWith('test-service');
      expect(mockInstanceManager.create).toHaveBeenCalledWith(mockTemplate);
      expect(result).toEqual(mockInstance);
      expect(mockLogger.info).toHaveBeenCalledWith('Instance created from template test-service: instance-123');
    });

    it('should create instance with overrides', async () => {
      const overrides = { timeout: 10000 };
      const expectedConfig = { ...mockTemplate, ...overrides };

      vi.mocked(mockTemplateManager.get).mockResolvedValueOnce(mockTemplate);
      vi.mocked(mockInstanceManager.create).mockResolvedValueOnce({ ...mockInstance, config: expectedConfig });

      const result = await registry.createInstance('test-service', overrides);

      expect(mockInstanceManager.create).toHaveBeenCalledWith(expectedConfig);
      expect(result.config.timeout).toBe(10000);
    });

    it('should throw error for non-existent template', async () => {
      vi.mocked(mockTemplateManager.get).mockResolvedValueOnce(null);

      await expect(registry.createInstance('non-existent')).rejects.toThrow('Template non-existent not found');
    });

    it('should get instance', async () => {
      vi.mocked(mockInstanceManager.get).mockResolvedValueOnce(mockInstance);

      const result = await registry.getInstance('instance-123');

      expect(mockInstanceManager.get).toHaveBeenCalledWith('instance-123');
      expect(result).toEqual(mockInstance);
    });

    it('should list instances', async () => {
      const instances = [mockInstance];
      vi.mocked(mockInstanceManager.list).mockResolvedValueOnce(instances);

      const result = await registry.listInstances();

      expect(mockInstanceManager.list).toHaveBeenCalled();
      expect(result).toEqual(instances);
    });

    it('should remove instance', async () => {
      vi.mocked(mockInstanceManager.remove).mockResolvedValueOnce(undefined);

      await registry.removeInstance('instance-123');

      expect(mockInstanceManager.remove).toHaveBeenCalledWith('instance-123');
      expect(mockLogger.info).toHaveBeenCalledWith('Instance removed: instance-123');
    });
  });

  describe('health monitoring', () => {
    it('should start health monitoring', async () => {
      vi.mocked(mockHealthChecker.startMonitoring).mockResolvedValueOnce(undefined);

      await registry.startHealthMonitoring();

      expect(mockHealthChecker.startMonitoring).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Health monitoring started');
    });

    it('should stop health monitoring', async () => {
      vi.mocked(mockHealthChecker.stopMonitoring).mockResolvedValueOnce(undefined);

      await registry.stopHealthMonitoring();

      expect(mockHealthChecker.stopMonitoring).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Health monitoring stopped');
    });

    it('should get health status', async () => {
      const healthStatus = {
        'instance-123': {
          status: 'healthy' as const,
          responseTime: 150,
          lastCheck: new Date(),
          consecutiveFailures: 0
        }
      };

      vi.mocked(mockHealthChecker.getHealthStatus).mockResolvedValueOnce(healthStatus);

      const result = await registry.getHealthStatus();

      expect(mockHealthChecker.getHealthStatus).toHaveBeenCalled();
      expect(result).toEqual(healthStatus);
    });
  });

  describe('load balancing', () => {
    it('should select best instance', async () => {
      const instances = [
        { id: 'instance-1', config: { name: 'service1' } },
        { id: 'instance-2', config: { name: 'service1' } }
      ] as ServiceInstance[];

      const selectedInstance = instances[0];

      vi.mocked(mockInstanceManager.list).mockResolvedValueOnce(instances);
      vi.mocked(mockLoadBalancer.selectInstance).mockResolvedValueOnce(selectedInstance);

      const result = await registry.selectBestInstance('service1');

      expect(mockInstanceManager.list).toHaveBeenCalled();
      expect(mockLoadBalancer.selectInstance).toHaveBeenCalledWith(instances, 'performance');
      expect(result).toEqual(selectedInstance);
    });

    it('should return null when no instances available', async () => {
      vi.mocked(mockInstanceManager.list).mockResolvedValueOnce([]);

      const result = await registry.selectBestInstance('service1');

      expect(result).toBeNull();
    });

    it('should filter instances by service name', async () => {
      const instances = [
        { id: 'instance-1', config: { name: 'service1' } },
        { id: 'instance-2', config: { name: 'service2' } }
      ] as ServiceInstance[];

      const filteredInstances = [instances[0]];
      const selectedInstance = instances[0];

      vi.mocked(mockInstanceManager.list).mockResolvedValueOnce(instances);
      vi.mocked(mockLoadBalancer.selectInstance).mockResolvedValueOnce(selectedInstance);

      await registry.selectBestInstance('service1');

      expect(mockLoadBalancer.selectInstance).toHaveBeenCalledWith(filteredInstances, 'performance');
    });

    it('should use custom strategy', async () => {
      const instances = [{ id: 'instance-1', config: { name: 'service1' } }] as ServiceInstance[];

      vi.mocked(mockInstanceManager.list).mockResolvedValueOnce(instances);
      vi.mocked(mockLoadBalancer.selectInstance).mockResolvedValueOnce(instances[0]);

      await registry.selectBestInstance('service1', 'round-robin');

      expect(mockLoadBalancer.selectInstance).toHaveBeenCalledWith(instances, 'round-robin');
    });
  });
});
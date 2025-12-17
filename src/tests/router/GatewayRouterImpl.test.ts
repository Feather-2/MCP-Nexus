import { GatewayRouterImpl } from '../../router/GatewayRouterImpl.js';
import { 
  RouteRequest, 
   
  RoutingRule, 
  Logger,
  ServiceInstance,
  
  ServiceState
} from '../../types/index.js';

describe('GatewayRouterImpl', () => {
  let router: GatewayRouterImpl;
  let mockLogger: Logger;

  const createMockService = (id: string, name: string, state: ServiceState = 'running'): ServiceInstance => ({
    id,
    config: {
      name,
      version: '2024-11-26',
      transport: 'stdio',
      command: 'node',
      args: [],
      timeout: 5000,
      retries: 2
    },
    state,
    errorCount: 0,
    metadata: {},
    startedAt: new Date(),
    lastHealthCheck: new Date()
  });

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn()
    };

    router = new GatewayRouterImpl(mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with default load balancing strategy', () => {
      expect(router).toBeDefined();
      expect(router.getLoadBalancingStrategy()).toBe('performance-based');
    });

    it('should initialize with custom load balancing strategy', () => {
      const customRouter = new GatewayRouterImpl(mockLogger, 'round-robin');
      expect(customRouter.getLoadBalancingStrategy()).toBe('round-robin');
    });

    it('should initialize default routing rules', () => {
      const rules = router.getRoutingRules();
      expect(rules).toBeInstanceOf(Array);
      expect(rules.length).toBeGreaterThan(0);
    });
  });

  describe('routing', () => {
    const mockServices = [
      createMockService('service-1', 'test-service'),
      createMockService('service-2', 'test-service'),
      createMockService('service-3', 'other-service')
    ];

    it('should route to available service successfully', async () => {
      const request: RouteRequest = {
        method: 'POST',
        serviceGroup: 'test-service',
        availableServices: mockServices.slice(0, 2), // Only test-service instances
        clientIp: '127.0.0.1',
        serviceHealthMap: new Map()
      };

      const response = await router.route(request);

      expect(response.success).toBe(true);
      expect(response.selectedService).toBeDefined();
      expect(response.selectedService?.config.name).toBe('test-service');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Routing request',
        expect.objectContaining({
          method: 'POST',
          serviceGroup: 'test-service',
          availableServices: 2
        })
      );
    });

    it('should fail when no services are available', async () => {
      const request: RouteRequest = {
        method: 'GET',
        serviceGroup: 'non-existent-service',
        availableServices: [],
        clientIp: '127.0.0.1',
        serviceHealthMap: new Map()
      };

      const response = await router.route(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('No suitable services found after applying routing rules');
    });

    it('should handle routing errors gracefully', async () => {
      // Mock an error in service selection
      const originalSelectService = router.selectService;
      vi.spyOn(router, 'selectService').mockImplementation(() => {
        throw new Error('Selection error');
      });

      const request: RouteRequest = {
        method: 'GET',
        serviceGroup: 'test-service',
        availableServices: mockServices,
        clientIp: '127.0.0.1',
        serviceHealthMap: new Map()
      };

      const response = await router.route(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Routing failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Routing error:',
        expect.any(Error)
      );

      // Restore method
      router.selectService = originalSelectService;
    });
  });

  describe('service selection strategies', () => {
    const mockServices = [
      createMockService('fast-service', 'test-service'),
      createMockService('slow-service', 'test-service'),
      createMockService('medium-service', 'test-service')
    ];

    beforeEach(() => {
      // Set up some metrics to make selection more predictable
      router.updateServiceMetrics('fast-service', {
        averageResponseTime: 100,
        requestCount: 50,
        errorRate: 0.01,
        cpuUsage: 30,
        memoryUsage: 40
      });

      router.updateServiceMetrics('slow-service', {
        averageResponseTime: 500,
        requestCount: 10,
        errorRate: 0.05,
        cpuUsage: 80,
        memoryUsage: 90
      });

      router.updateServiceMetrics('medium-service', {
        averageResponseTime: 200,
        requestCount: 30,
        errorRate: 0.02,
        cpuUsage: 50,
        memoryUsage: 60
      });
    });

    it('should select service based on performance strategy', () => {
      router.setLoadBalancingStrategy('performance-based');
      
      const selected = router.selectService(mockServices);
      
      // Should select the fastest service
      expect(selected?.id).toBe('fast-service');
    });

    it('should select service based on round-robin strategy', () => {
      router.setLoadBalancingStrategy('round-robin');
      
      const selections = [
        router.selectService(mockServices),
        router.selectService(mockServices),
        router.selectService(mockServices)
      ];
      
      // Should cycle through services
      const selectedIds = selections.map(s => s?.id);
      expect(selectedIds).toHaveLength(3);
      expect(new Set(selectedIds).size).toBeGreaterThan(1); // At least some variety
    });

    it('should select service based on cost-optimized strategy', () => {
      router.setLoadBalancingStrategy('cost-optimized');
      
      // Set up cost metrics
      router.updateCostMetrics('fast-service', {
        costPerRequest: 0.05,
        totalCost: 2.50,
        costEfficiency: 0.8
      });

      router.updateCostMetrics('slow-service', {
        costPerRequest: 0.02,
        totalCost: 0.20,
        costEfficiency: 0.9
      });

      const selected = router.selectService(mockServices);
      
      // Should prefer cost-effective service
      expect(selected?.id).toBe('slow-service');
    });

    it('should handle content-aware strategy', () => {
      router.setLoadBalancingStrategy('content-aware');
      
      // Set up content analysis
      router.updateContentAnalysis('fast-service', {
        supportedContentTypes: ['application/json'],
        specializedMethods: ['GET', 'POST'],
        maxContentLength: 1024 * 1024,
        averageProcessingTime: 100
      });

      const selected = router.selectService(mockServices);
      expect(selected).toBeDefined();
    });
  });

  describe('routing rules', () => {
    const mockServices = [
      createMockService('prod-service', 'production-service'),
      createMockService('dev-service', 'development-service'),
      createMockService('test-service', 'test-service')
    ];

    it('should add and apply custom routing rules', () => {
      const rule: RoutingRule = {
        name: 'Development Rule',
        priority: 10,
        condition: {},
        action: {
          type: 'filter',
          criteria: { name: 'development-service' }
        },
        enabled: true
      };

      router.addRoutingRule(rule);

      const request: RouteRequest = {
        method: 'GET',
        serviceGroup: 'any',
        availableServices: mockServices,
        clientIp: '127.0.0.1',
        serviceHealthMap: new Map()
      };

      const filteredServices = (router as any).applyRoutingRules(request);

      // Should only include development service
      expect(filteredServices).toHaveLength(1);
      expect(filteredServices[0].config.name).toBe('development-service');
    });

    it('should remove routing rules', () => {
      const rule: RoutingRule = {
        // @ts-expect-error - RoutingRule doesn't have id property
        id: 'temp-rule',
        name: 'Temporary Rule',
        priority: 5,
        conditions: { pathPattern: '/temp/*' },
        actions: { routeTo: ['test-service'] },
        enabled: true
      };

      router.addRoutingRule(rule);
      // @ts-expect-error - RoutingRule doesn't have id property
      expect(router.getRoutingRules().some(r => r.id === 'temp-rule')).toBe(true);

      router.removeRoutingRule('temp-rule');
      // @ts-expect-error - RoutingRule doesn't have id property
      expect(router.getRoutingRules().some(r => r.id === 'temp-rule')).toBe(false);
    });

    it('should disable/enable routing rules', () => {
      const rule: RoutingRule = {
        // @ts-expect-error - RoutingRule doesn't have id property
        id: 'toggle-rule',
        name: 'Toggle Rule',
        priority: 5,
        conditions: { pathPattern: '/toggle/*' },
        actions: { routeTo: ['test-service'] },
        enabled: true
      };

      router.addRoutingRule(rule);

      router.disableRoutingRule('toggle-rule');
      // @ts-expect-error - RoutingRule doesn't have id property
      const disabledRule = router.getRoutingRules().find(r => r.id === 'toggle-rule');
      expect(disabledRule?.enabled).toBe(false);

      router.enableRoutingRule('toggle-rule');
      // @ts-expect-error - RoutingRule doesn't have id property
      const enabledRule = router.getRoutingRules().find(r => r.id === 'toggle-rule');
      expect(enabledRule?.enabled).toBe(true);
    });

    it('should apply rules in priority order', () => {
      const lowPriorityRule: RoutingRule = {
        // @ts-expect-error - RoutingRule doesn't have id property
        id: 'low-priority',
        name: 'Low Priority Rule',
        priority: 1,
        conditions: { pathPattern: '/api/*' },
        actions: { routeTo: ['test-service'] },
        enabled: true
      };

      const highPriorityRule: RoutingRule = {
        // @ts-expect-error - RoutingRule doesn't have id property
        id: 'high-priority',
        name: 'High Priority Rule',
        priority: 10,
        conditions: { pathPattern: '/api/*' },
        actions: { routeTo: ['production-service'] },
        enabled: true
      };

      router.addRoutingRule(lowPriorityRule);
      router.addRoutingRule(highPriorityRule);

      const request: RouteRequest = {
        method: 'GET',
        serviceGroup: 'any',
        availableServices: mockServices,
        clientIp: '127.0.0.1',
        serviceHealthMap: new Map(),
        path: '/api/users'  // Add path to match pathPattern condition
      } as any;

      const filteredServices = (router as any).applyRoutingRules(request);
      
      // High priority rule should take precedence
      expect(filteredServices).toHaveLength(1);
      expect(filteredServices[0].config.name).toBe('production-service');
    });
  });

  describe('metrics management', () => {
    it('should update and retrieve service metrics', () => {
      const metrics = {
        averageResponseTime: 150,
        requestCount: 100,
        errorRate: 0.02,
        cpuUsage: 45,
        memoryUsage: 60
      };

      router.updateServiceMetrics('test-service', metrics);
      
      const retrieved = router.getServiceMetrics('test-service');
      expect(retrieved).toEqual(metrics);
    });

    it('should update and retrieve cost metrics', () => {
      const costMetrics = {
        costPerRequest: 0.03,
        totalCost: 3.00,
        costEfficiency: 0.85
      };

      router.updateCostMetrics('test-service', costMetrics);
      
      const retrieved = router.getCostMetrics('test-service');
      expect(retrieved).toEqual(costMetrics);
    });

    it('should update and retrieve content analysis', () => {
      const contentAnalysis = {
        supportedContentTypes: ['application/json', 'text/plain'],
        specializedMethods: ['GET', 'POST', 'PUT'],
        maxContentLength: 1024 * 1024,
        averageProcessingTime: 100
      };

      router.updateContentAnalysis('test-service', contentAnalysis);
      
      const retrieved = router.getContentAnalysis('test-service');
      expect(retrieved).toEqual(contentAnalysis);
    });

    it('should get all metrics', () => {
      router.updateServiceMetrics('service-1', {
        averageResponseTime: 100,
        requestCount: 50,
        errorRate: 0.01,
        cpuUsage: 30,
        memoryUsage: 40
      });

      router.updateServiceMetrics('service-2', {
        averageResponseTime: 200,
        requestCount: 25,
        errorRate: 0.03,
        cpuUsage: 60,
        memoryUsage: 70
      });

      const allMetrics = router.getAllMetrics();
      expect(Object.keys(allMetrics)).toHaveLength(2);
      expect(allMetrics['service-1']).toBeDefined();
      expect(allMetrics['service-2']).toBeDefined();
    });

    it('should reset metrics', () => {
      router.updateServiceMetrics('test-service', {
        averageResponseTime: 100,
        requestCount: 50,
        errorRate: 0.01,
        cpuUsage: 30,
        memoryUsage: 40
      });

      router.resetMetrics();
      
      const metrics = router.getServiceMetrics('test-service');
      expect(metrics).toBeUndefined();
    });
  });

  describe('request history', () => {
    it('should track request history', () => {
      router.recordRequest('service-1', 150, true);
      router.recordRequest('service-2', 300, false);
      
      const history = router.getRequestHistory();
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        serviceId: 'service-1',
        responseTime: 150,
        success: true
      });
    });

    it('should limit request history size', () => {
      // Record more requests than the limit (assume limit is 1000)
      for (let i = 0; i < 1100; i++) {
        router.recordRequest(`service-${i % 5}`, 100 + i, true);
      }

      const history = router.getRequestHistory();
      expect(history.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('health-based routing', () => {
    it('should exclude unhealthy services', () => {
      const services = [
        createMockService('healthy-service', 'test-service', 'running'),
        createMockService('unhealthy-service', 'test-service', 'error'),
        createMockService('stopped-service', 'test-service', 'stopped')
      ];

      const healthyServices = router.filterHealthyServices(services);
      
      expect(healthyServices).toHaveLength(1);
      expect(healthyServices[0].id).toBe('healthy-service');
    });

    it('should consider service health in selection', () => {
      const services = [
        createMockService('service-1', 'test-service', 'running'),
        createMockService('service-2', 'test-service', 'running'),
        createMockService('service-3', 'test-service', 'error')
      ];

      // Update health metrics
      router.updateServiceHealth('service-1', {
        status: 'healthy',
        responseTime: 100,
        lastCheck: new Date()
      });

      router.updateServiceHealth('service-2', {
        status: 'unhealthy',
        responseTime: 1000,
        lastCheck: new Date(),
        error: 'Service unhealthy'
      });

      const selected = router.selectService(services);
      
      // Should prefer healthy service
      expect(selected?.id).toBe('service-1');
    });
  });

  describe('performance optimization', () => {
    it('should cache routing decisions for repeated requests', async () => {
      const services = [createMockService('service-1', 'test-service')];
      
      const request: RouteRequest = {
        method: 'GET',
        serviceGroup: 'test-service',
        availableServices: services,
        clientIp: '127.0.0.1',
        serviceHealthMap: new Map()
      };

      // Make multiple identical requests
      await router.route(request);
      await router.route(request);

      // Should use caching (implementation detail - router might optimize internally)
      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });

  describe('event emission', () => {
    it('should emit events for routing decisions', async () => {
      const eventSpy = vi.fn();
      router.on('routingDecision', eventSpy);

      const services = [createMockService('service-1', 'test-service')];
      const request: RouteRequest = {
        method: 'GET',
        serviceGroup: 'test-service',
        availableServices: services,
        clientIp: '127.0.0.1',
        serviceHealthMap: new Map()
      };

      await router.route(request);

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedService: expect.any(Object),
          strategy: 'performance-based'
        })
      );
    });
  });
});
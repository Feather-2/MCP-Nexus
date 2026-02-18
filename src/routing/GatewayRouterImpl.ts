import {
  GatewayRouter,
  RouteRequest,
  RouteResponse,
  LoadBalancingStrategy,
  RoutingRule,
  RouteHandler,
  Logger,
  ServiceInstance,
  ServiceHealth,
  ServiceLoadMetrics,
  ServiceCostMetrics,
  ServiceContentAnalysis,
  Disposable
} from '../types/index.js';
import { EventEmitter } from 'events';
import { MetricsCollector } from './MetricsCollector.js';
import { LoadBalancer } from './LoadBalancer.js';
import { RouteEvaluator } from './RouteEvaluator.js';
import { RuleManager } from './RuleManager.js';

export class GatewayRouterImpl extends EventEmitter implements GatewayRouter, Disposable {
  private routeHandlers = new Map<string, RouteHandler>();
  private metricsCollector: MetricsCollector;
  private loadBalancer: LoadBalancer;
  private routeEvaluator: RouteEvaluator;
  private ruleManager: RuleManager;

  constructor(
    private logger: Logger,
    private loadBalancingStrategy: LoadBalancingStrategy = 'performance-based'
  ) {
    super();
    this.metricsCollector = new MetricsCollector(logger);
    this.loadBalancer = new LoadBalancer();
    this.routeEvaluator = new RouteEvaluator(logger);
    this.ruleManager = new RuleManager(logger);

    // Forward events from RuleManager
    this.ruleManager.on('routingRuleAdded', (rule) => this.emit('routingRuleAdded', rule));
    this.ruleManager.on('routingRuleRemoved', (rule) => this.emit('routingRuleRemoved', rule));
  }

  // GatewayRouter interface methods
  addRoute(pattern: string, handler: RouteHandler): void {
    this.routeHandlers.set(pattern, handler);
    this.logger.info(`Added route handler for pattern: ${pattern}`);
  }

  removeRoute(pattern: string): void {
    const removed = this.routeHandlers.delete(pattern);
    if (removed) {
      this.logger.info(`Removed route handler for pattern: ${pattern}`);
    }
  }

  setRoutingStrategy(strategy: LoadBalancingStrategy): void {
    const oldStrategy = this.loadBalancingStrategy;
    this.loadBalancingStrategy = strategy;
    this.logger.info(`Routing strategy changed from ${oldStrategy} to ${strategy}`);
    this.emit('strategyUpdated', { from: oldStrategy, to: strategy });
  }

  getRoutingStrategy(): LoadBalancingStrategy {
    return this.loadBalancingStrategy;
  }

  // Compatibility layer for tests
  getLoadBalancingStrategy(): LoadBalancingStrategy {
    return this.getRoutingStrategy();
  }

  setLoadBalancingStrategy(strategy: LoadBalancingStrategy): void {
    this.setRoutingStrategy(strategy);
  }

  async resetMetrics(): Promise<void> {
    this.metricsCollector.reset();
    this.emit('metricsReset');
  }

  async route(request: RouteRequest): Promise<RouteResponse> {
    try {
      this.logger.debug('Routing request', {
        method: request.method,
        serviceGroup: request.serviceGroup,
        availableServices: request.availableServices?.length ?? 0
      });

      // Apply routing rules (call private method for test compatibility)
      const filteredServices = this.applyRoutingRules(request);
      const preferredServiceIds = (request as unknown as Record<string, unknown>)._preferredServiceIds as Set<string>;
      const appliedRules = (request as unknown as Record<string, unknown>)._appliedRules as string[];

      if (filteredServices.length === 0) {
        return {
          success: false,
          error: 'No suitable services found after applying routing rules'
        };
      }

      // Build default health map if missing
      if (!request.serviceHealthMap) {
        (request as { serviceHealthMap: Map<string, ServiceHealth> }).serviceHealthMap =
          new Map<string, ServiceHealth>(
            filteredServices.map(s => [
              s.id,
              { status: s.state === 'running' ? 'healthy' : 'unhealthy', responseTime: 0, lastCheck: new Date() } as ServiceHealth
            ])
          );
      }

      // Store preferred services on request for selectService to use
      (request as unknown as Record<string, unknown>)._preferredServiceIds = preferredServiceIds;

      // Select best service using load balancing strategy (call this.selectService for test compatibility)
      const selectedService = this.selectService(filteredServices, request);

      if (!selectedService) {
        return {
          success: false,
          error: 'No healthy services available'
        };
      }

      // Update metrics
      this.metricsCollector.updateRequestMetrics(selectedService.id);

      this.logger.info('Request routed successfully', {
        serviceId: selectedService.id,
        serviceName: selectedService.config.name,
        strategy: this.loadBalancingStrategy
      });

      const response = {
        success: true,
        selectedService,
        routingDecision: {
          strategy: this.loadBalancingStrategy,
          reason: this.routeEvaluator.getRoutingReason(this.loadBalancingStrategy),
          appliedRules
        }
      } as RouteResponse;

      // Emit event for tests
      this.emit('routingDecision', {
        selectedService,
        strategy: this.loadBalancingStrategy,
        request
      });

      // Store applied rules and preferred services on request for compatibility
      (request as unknown as Record<string, unknown>)._appliedRules = appliedRules;
      (request as unknown as Record<string, unknown>)._preferredServiceIds = preferredServiceIds;

      this.emit('requestRouted', { serviceId: selectedService.id, request, timestamp: Date.now() });

      return response;

    } catch (error) {
      this.logger.error('Routing error:', error);
      return {
        success: false,
        error: 'Routing failed'
      };
    }
  }

  // Routing rule management - delegate to RuleManager
  async addRoutingRule(rule: RoutingRule): Promise<void> {
    return this.ruleManager.addRoutingRule(rule);
  }

  async removeRoutingRule(ruleName: string): Promise<boolean> {
    return this.ruleManager.removeRoutingRule(ruleName);
  }

  getRoutingRules(): RoutingRule[] {
    return this.ruleManager.getRoutingRules();
  }

  disableRoutingRule(ruleName: string): void {
    this.ruleManager.disableRoutingRule(ruleName);
  }

  enableRoutingRule(ruleName: string): void {
    this.ruleManager.enableRoutingRule(ruleName);
  }

  async updateLoadBalancingStrategy(strategy: LoadBalancingStrategy): Promise<void> {
    const oldStrategy = this.loadBalancingStrategy;
    this.loadBalancingStrategy = strategy;

    this.logger.info(`Load balancing strategy updated`, {
      from: oldStrategy,
      to: strategy
    });

    this.emit('strategyUpdated', { from: oldStrategy, to: strategy });
  }

  // Metrics management - delegate to MetricsCollector
  getMetrics(): {
    totalRequests: number;
    successRate: number;
    averageResponseTime: number;
    serviceDistribution: Record<string, number>;
    strategyEffectiveness: Record<LoadBalancingStrategy, number>;
  } {
    const baseMetrics = this.metricsCollector.getMetrics();
    return {
      ...baseMetrics,
      strategyEffectiveness: {
        'round-robin': 0.8,
        'performance-based': 0.9,
        'cost-optimized': 0.85,
        'content-aware': 0.88
      }
    };
  }

  getServiceMetrics(serviceId: string): ServiceLoadMetrics | undefined {
    return this.metricsCollector.getServiceMetrics(serviceId);
  }

  getCostMetrics(serviceId: string): ServiceCostMetrics | undefined {
    return this.metricsCollector.getCostMetrics(serviceId);
  }

  getAllMetrics(): Record<string, ServiceLoadMetrics> {
    return this.metricsCollector.getAllMetrics();
  }

  getContentAnalysis(serviceId: string): ServiceContentAnalysis | undefined {
    return this.metricsCollector.getContentAnalysis(serviceId);
  }

  updateServiceMetrics(serviceId: string, metrics: Partial<ServiceLoadMetrics> & Record<string, unknown>): void {
    this.metricsCollector.updateServiceMetrics(serviceId, metrics);
  }

  updateServiceHealth(serviceId: string, health: ServiceHealth): void {
    this.metricsCollector.updateServiceHealth(serviceId, health);
  }

  updateRequestResult(serviceId: string, responseTime: number, success: boolean): void {
    this.metricsCollector.updateRequestResult(serviceId, responseTime, success);
  }

  updateServiceCostMetrics(serviceId: string, costMetrics: ServiceCostMetrics): void {
    this.metricsCollector.updateServiceCostMetrics(serviceId, costMetrics);
  }

  updateServiceContentAnalysis(serviceId: string, analysis: ServiceContentAnalysis): void {
    this.metricsCollector.updateServiceContentAnalysis(serviceId, analysis);
  }

  updateCostMetrics(serviceId: string, metrics: ServiceCostMetrics): void {
    this.updateServiceCostMetrics(serviceId, metrics);
  }

  updateContentAnalysis(serviceId: string, analysis: ServiceContentAnalysis): void {
    this.updateServiceContentAnalysis(serviceId, analysis);
  }

  recordRequest(serviceId: string, responseTime: number, success: boolean): void {
    this.metricsCollector.recordRequest(serviceId, responseTime, success);
  }

  getRequestHistory(): Array<{ serviceId: string; timestamp: Date; responseTime: number; success: boolean; }> {
    return this.metricsCollector.getRequestHistory();
  }

  // Service selection - delegate to LoadBalancer
  selectService(services: ServiceInstance[], request?: RouteRequest): ServiceInstance | null {
    const req: RouteRequest = request ?? {
      method: 'GET',
      params: undefined,
      serviceGroup: undefined,
      contentType: undefined,
      contentLength: undefined,
      clientIp: '',
      availableServices: services,
      serviceHealthMap: new Map<string, ServiceHealth>(
        services.map(s => [s.id, { status: 'healthy', responseTime: 0, lastCheck: new Date() } as ServiceHealth])
      )
    };

    // Extract preferred service IDs from request if available
    const preferredServiceIds = (req as unknown as Record<string, unknown>)._preferredServiceIds as Set<string> | undefined;

    // Build cost and content analysis maps
    const costMetrics = new Map<string, ServiceCostMetrics>();
    const contentAnalysis = new Map<string, ServiceContentAnalysis>();
    for (const service of services) {
      const cost = this.metricsCollector.getCostMetrics(service.id);
      if (cost) costMetrics.set(service.id, cost);
      const analysis = this.metricsCollector.getContentAnalysis(service.id);
      if (analysis) contentAnalysis.set(service.id, analysis);
    }

    return this.loadBalancer.selectService(
      services,
      req,
      this.loadBalancingStrategy,
      new Map(Object.entries(this.metricsCollector.getAllMetrics())),
      costMetrics,
      contentAnalysis,
      preferredServiceIds
    );
  }

  filterHealthyServices(services: ServiceInstance[]): ServiceInstance[] {
    return this.loadBalancer.filterHealthyServices(services);
  }

  // Test compatibility helpers
  private applyRoutingRules(request: RouteRequest): ServiceInstance[] {
    const candidateRules = this.ruleManager.getCandidateRules(request);
    const { filteredServices, preferredServiceIds, appliedRules } =
      this.routeEvaluator.applyRoutingRules(request, candidateRules);

    // Store for compatibility
    (request as unknown as Record<string, unknown>)._appliedRules = appliedRules;
    (request as unknown as Record<string, unknown>)._preferredServiceIds = preferredServiceIds;

    return filteredServices;
  }

  publicApplyRoutingRules(request: RouteRequest): ServiceInstance[] {
    return this.applyRoutingRules(request);
  }

  refreshServiceMetrics(serviceId?: string, directMetrics?: ServiceLoadMetrics): void {
    this.metricsCollector.refreshServiceMetrics(serviceId, directMetrics);
  }

  destroy(): void {
    this.metricsCollector.destroy();
    this.removeAllListeners();
  }

  private disposed = false;
  dispose(): void { if (this.disposed) return; this.disposed = true; this.destroy(); }
}

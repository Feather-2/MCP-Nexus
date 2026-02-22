import {
  ServiceInstance,
  ServiceHealth,
  LoadBalancingStrategy,
  RouteRequest,
  ServiceLoadMetrics,
  ServiceCostMetrics,
  ServiceContentAnalysis
} from '../types/index.js';

export class LoadBalancer {
  private rrCounters = new Map<string, number>();

  selectService(
    services: ServiceInstance[],
    request: RouteRequest,
    strategy: LoadBalancingStrategy,
    serviceMetrics: Map<string, ServiceLoadMetrics>,
    costMetrics: Map<string, ServiceCostMetrics>,
    contentAnalysis: Map<string, ServiceContentAnalysis>,
    preferredServiceIds?: ReadonlySet<string>
  ): ServiceInstance | null {
    const healthyServices = services.filter(service =>
      request.serviceHealthMap.get(service.id)?.status !== 'unhealthy'
    );

    if (healthyServices.length === 0) return null;
    if (healthyServices.length === 1) return healthyServices[0];

    switch (strategy) {
      case 'round-robin': {
        const groupKey = request.serviceGroup || '__default__';
        return this.selectRoundRobin(healthyServices, groupKey);
      }
      case 'performance-based':
        return this.selectPerformanceBased(
          healthyServices,
          request.serviceHealthMap,
          serviceMetrics,
          preferredServiceIds
        );
      case 'cost-optimized':
        return this.selectCostOptimized(healthyServices, costMetrics);
      case 'content-aware':
        return this.selectContentAware(healthyServices, request, contentAnalysis);
      default:
        return healthyServices[0];
    }
  }

  filterHealthyServices(services: ServiceInstance[]): ServiceInstance[] {
    return services.filter(s => s.state === 'running');
  }

  private selectRoundRobin(services: ServiceInstance[], groupKey: string): ServiceInstance {
    const counter = this.rrCounters.get(groupKey) ?? 0;
    const index = counter % services.length;
    this.rrCounters.set(groupKey, (counter + 1) >>> 0);
    return services[index];
  }

  private selectPerformanceBased(
    services: ServiceInstance[],
    healthMap: Map<string, ServiceHealth>,
    serviceMetrics: Map<string, ServiceLoadMetrics>,
    preferredServiceIds?: ReadonlySet<string>
  ): ServiceInstance {
    const scoredServices = services.map(service => {
      const health = healthMap.get(service.id);
      const metrics = serviceMetrics.get(service.id);

      let score = 100;

      if (health?.responseTime) {
        score -= Math.min(health.responseTime / 10, 50);
      }

      if (health?.metrics?.cpu) {
        score -= health.metrics.cpu;
      }

      if (health?.metrics?.memory) {
        score -= health.metrics.memory / 2;
      }

      if (metrics?.successRate) {
        score += metrics.successRate * 20;
      }

      if (preferredServiceIds?.has(service.id)) {
        score += 25;
      }

      return { service, score };
    });

    scoredServices.sort((a, b) => b.score - a.score);
    return scoredServices[0].service;
  }

  private selectCostOptimized(
    services: ServiceInstance[],
    costMetrics: Map<string, ServiceCostMetrics>
  ): ServiceInstance {
    const scoredServices = services.map(service => {
      const cost = costMetrics.get(service.id);
      const costPerRequest = cost?.costPerRequest || 1.0;
      return { service, cost: costPerRequest };
    });

    scoredServices.sort((a, b) => a.cost - b.cost);
    return scoredServices[0].service;
  }

  private selectContentAware(
    services: ServiceInstance[],
    request: RouteRequest,
    contentAnalysis: Map<string, ServiceContentAnalysis>
  ): ServiceInstance {
    const scoredServices = services.map(service => {
      const analysis = contentAnalysis.get(service.id);
      let score = 50;

      if (request.contentType && analysis?.supportedContentTypes?.includes(request.contentType)) {
        score += 30;
      }

      if (request.method && analysis?.specializedMethods?.includes(request.method)) {
        score += 20;
      }

      if (request.contentLength && analysis?.maxContentLength) {
        if (request.contentLength <= analysis.maxContentLength) {
          score += 10;
        } else {
          score -= 50;
        }
      }

      return { service, score };
    });

    scoredServices.sort((a, b) => b.score - a.score);
    return scoredServices[0].service;
  }
}

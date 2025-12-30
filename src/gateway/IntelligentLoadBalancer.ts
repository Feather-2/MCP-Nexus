import { ServiceInstance, RoutingStrategy, Logger } from '../types/index.js';

type InstanceMetrics = {
  requestCount: number;
  errorCount: number;
  totalResponseTime: number;
  lastRequestTime: Date;
};

export class IntelligentLoadBalancer {
  /**
   * In-memory metrics snapshot per instance.
   * Note: Node is single-threaded, but we still treat entries as immutable to avoid accidental
   * shared-object mutation if references escape (and to ease future async/remote metric backends).
   */
  private instanceMetrics = new Map<string, InstanceMetrics>();

  constructor(private logger: Logger) {}

  addInstance(instance: ServiceInstance): void {
    if (!this.instanceMetrics.has(instance.id)) {
      this.instanceMetrics.set(instance.id, {
        requestCount: 0,
        errorCount: 0,
        totalResponseTime: 0,
        lastRequestTime: new Date()
      });
    }
  }

  removeInstance(serviceId: string): void {
    this.instanceMetrics.delete(serviceId);
  }

  selectInstance(instances: ServiceInstance[], strategy: RoutingStrategy = 'performance'): ServiceInstance | null {
    if (instances.length === 0) {
      return null;
    }

    if (instances.length === 1) {
      return instances[0];
    }

    switch (strategy) {
      case 'performance':
        return this.selectByPerformance(instances);
      case 'load-balance':
        return this.selectByLoadBalance(instances);
      case 'cost':
        return this.selectByCost(instances);
      case 'content-aware':
        return this.selectByContentAware(instances);
      default:
        return instances[0];
    }
  }

  recordRequest(serviceId: string, responseTime: number, success: boolean): void {
    const prev = this.instanceMetrics.get(serviceId) || {
      requestCount: 0,
      errorCount: 0,
      totalResponseTime: 0,
      lastRequestTime: new Date(0)
    };

    const next: InstanceMetrics = {
      requestCount: prev.requestCount + 1,
      errorCount: prev.errorCount + (success ? 0 : 1),
      totalResponseTime: prev.totalResponseTime + (Number.isFinite(responseTime) ? responseTime : 0),
      lastRequestTime: new Date()
    };

    this.instanceMetrics.set(serviceId, next);
  }

  private selectByPerformance(instances: ServiceInstance[]): ServiceInstance {
    // Select instance with best response time and lowest error rate
    let bestInstance = instances[0];
    let bestScore = this.calculatePerformanceScore(bestInstance.id);

    for (let i = 1; i < instances.length; i++) {
      const score = this.calculatePerformanceScore(instances[i].id);
      if (score > bestScore) {
        bestScore = score;
        bestInstance = instances[i];
      }
    }

    return bestInstance;
  }

  private selectByLoadBalance(instances: ServiceInstance[]): ServiceInstance {
    // Round-robin or least connections
    let bestInstance = instances[0];
    let leastRequests = this.getRequestCount(bestInstance.id);

    for (let i = 1; i < instances.length; i++) {
      const requestCount = this.getRequestCount(instances[i].id);
      if (requestCount < leastRequests) {
        leastRequests = requestCount;
        bestInstance = instances[i];
      }
    }

    return bestInstance;
  }

  private selectByCost(instances: ServiceInstance[]): ServiceInstance {
    // For now, just use round-robin
    // In a real implementation, this would consider API costs, compute costs, etc.
    const now = Date.now();
    const index = Math.floor(now / 1000) % instances.length;
    return instances[index];
  }

  private selectByContentAware(instances: ServiceInstance[]): ServiceInstance {
    // For now, just select by performance
    // In a real implementation, this would analyze request content and route accordingly
    return this.selectByPerformance(instances);
  }

  private calculatePerformanceScore(serviceId: string): number {
    const metrics = this.instanceMetrics.get(serviceId);
    if (!metrics || metrics.requestCount === 0) {
      return 1; // New instances get benefit of doubt
    }

    const avgResponseTime = metrics.totalResponseTime / metrics.requestCount;
    const errorRate = metrics.errorCount / metrics.requestCount;
    
    // Higher score is better
    // Penalize high response time and error rate
    const responseTimeScore = Math.max(0, 1 - (avgResponseTime / 5000)); // 5s max
    const errorRateScore = Math.max(0, 1 - errorRate);
    
    return (responseTimeScore + errorRateScore) / 2;
  }

  private getRequestCount(serviceId: string): number {
    const metrics = this.instanceMetrics.get(serviceId);
    return metrics?.requestCount || 0;
  }

  getLoadBalancerStats(): Array<{
    serviceId: string;
    requestCount: number;
    errorCount: number;
    avgResponseTime: number;
    errorRate: number;
  }> {
    const stats: Array<{
      serviceId: string;
      requestCount: number;
      errorCount: number;
      avgResponseTime: number;
      errorRate: number;
    }> = [];

    for (const [serviceId, metrics] of this.instanceMetrics) {
      stats.push({
        serviceId,
        requestCount: metrics.requestCount,
        errorCount: metrics.errorCount,
        avgResponseTime: metrics.requestCount > 0 
          ? metrics.totalResponseTime / metrics.requestCount 
          : 0,
        errorRate: metrics.requestCount > 0 
          ? metrics.errorCount / metrics.requestCount 
          : 0
      });
    }

    return stats;
  }
}

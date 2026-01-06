import { ServiceInstance, RoutingStrategy, Logger } from '../types/index.js';
import type { ServiceMetrics, ServiceObservationStore } from './service-state.js';

type MetricsStore = Pick<ServiceObservationStore, 'getMetrics' | 'updateMetrics' | 'removeMetrics' | 'listInstances'>;

function updateMetrics(existing: ServiceMetrics | undefined, serviceId: string, responseTime: number, success: boolean): ServiceMetrics {
  const prevCount = existing?.requestCount ?? 0;
  const nextCount = prevCount + 1;

  const prevErr = existing?.errorCount ?? 0;
  const nextErr = prevErr + (success ? 0 : 1);

  const prevAvg = existing?.avgResponseTime ?? 0;
  const nextAvg =
    Number.isFinite(responseTime) && responseTime >= 0 ? (prevAvg * prevCount + responseTime) / nextCount : prevAvg;

  const now = new Date();
  return {
    serviceId,
    requestCount: nextCount,
    errorCount: nextErr,
    avgResponseTime: nextAvg,
    addedAt: existing?.addedAt ?? now,
    lastRequestTime: now
  };
}

export class IntelligentLoadBalancer {
  private readonly warmupDurationMs: number;
  private rrCursorByKey = new Map<string, number>();

  constructor(
    private logger: Logger,
    private store: MetricsStore,
    options?: { warmupDurationMs?: number }
  ) {
    const configured = options?.warmupDurationMs;
    this.warmupDurationMs =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : 10_000;
  }

  private nextCursor(key: string): number {
    const cursor = this.rrCursorByKey.get(key) ?? 0;
    this.rrCursorByKey.set(key, cursor + 1);
    return cursor;
  }

  private pickRoundRobin(key: string, candidates: readonly ServiceInstance[]): ServiceInstance {
    if (candidates.length === 1) return candidates[0];
    const stable = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
    const cursor = this.nextCursor(key);
    return stable[cursor % stable.length];
  }

  private computeWarmupFactor(metrics: ServiceMetrics | undefined): number {
    if (!metrics?.addedAt) return 1;
    if (!Number.isFinite(this.warmupDurationMs) || this.warmupDurationMs <= 0) return 1;

    const elapsedMs = Date.now() - metrics.addedAt.getTime();
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;

    const factor = elapsedMs / this.warmupDurationMs;
    if (factor >= 1) return 1;
    if (factor <= 0) return 0;
    return factor;
  }

  addInstance(instance: ServiceInstance): void {
    const existing = this.store.getMetrics(instance.id);
    if (!existing) {
      const now = new Date();
      this.store.updateMetrics(instance.id, {
        serviceId: instance.id,
        requestCount: 0,
        errorCount: 0,
        avgResponseTime: 0,
        addedAt: now,
        lastRequestTime: now
      });
      return;
    }

    if (!existing.addedAt) {
      const now = new Date();
      const addedAt = existing.requestCount > 0 ? new Date(now.getTime() - this.warmupDurationMs) : now;
      this.store.updateMetrics(instance.id, { ...existing, addedAt });
    }
  }

  removeInstance(serviceId: string): void {
    this.store.removeMetrics(serviceId);
  }

  selectInstance(instances: ServiceInstance[], strategy: RoutingStrategy = 'performance'): ServiceInstance | null {
    if (instances.length === 0) {
      return null;
    }

    for (const instance of instances) {
      this.addInstance(instance);
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
    const prev = this.store.getMetrics(serviceId);
    const next = updateMetrics(prev, serviceId, responseTime, success);
    this.store.updateMetrics(serviceId, next);
  }

  private selectByPerformance(instances: ServiceInstance[]): ServiceInstance {
    // Select instance with best response time and lowest error rate
    const EPS = 1e-9;
    let bestScore = -Infinity;
    let best: ServiceInstance[] = [];

    for (const instance of instances) {
      const score = this.calculatePerformanceScore(instance.id);
      if (score > bestScore + EPS) {
        bestScore = score;
        best = [instance];
      } else if (Math.abs(score - bestScore) <= EPS) {
        best.push(instance);
      }
    }

    return this.pickRoundRobin('performance', best);
  }

  private selectByLoadBalance(instances: ServiceInstance[]): ServiceInstance {
    // Round-robin or least connections
    let leastRequests = Infinity;
    let best: ServiceInstance[] = [];

    for (const instance of instances) {
      const requestCount = this.getRequestCount(instance.id);
      if (requestCount < leastRequests) {
        leastRequests = requestCount;
        best = [instance];
      } else if (requestCount === leastRequests) {
        best.push(instance);
      }
    }

    return this.pickRoundRobin('load-balance', best);
  }

  private selectByCost(instances: ServiceInstance[]): ServiceInstance {
    // For now, just use round-robin
    // In a real implementation, this would consider API costs, compute costs, etc.
    return this.pickRoundRobin('cost', instances);
  }

  private selectByContentAware(instances: ServiceInstance[]): ServiceInstance {
    // For now, just select by performance
    // In a real implementation, this would analyze request content and route accordingly
    return this.selectByPerformance(instances);
  }

  private calculatePerformanceScore(serviceId: string): number {
    const metrics = this.store.getMetrics(serviceId);
    if (!metrics || metrics.requestCount === 0) {
      const warmupFactor = this.computeWarmupFactor(metrics);
      return warmupFactor; // New instances ramp up linearly during warmup
    }

    const avgResponseTime = metrics.avgResponseTime;
    const errorRate = metrics.requestCount > 0 ? metrics.errorCount / metrics.requestCount : 0;
    
    // Higher score is better
    // Penalize high response time and error rate
    const responseTimeScore = Math.max(0, 1 - (avgResponseTime / 5000)); // 5s max
    const errorRateScore = Math.max(0, 1 - errorRate);
    
    const baseScore = (responseTimeScore + errorRateScore) / 2;
    const warmupFactor = this.computeWarmupFactor(metrics);
    return baseScore * warmupFactor;
  }

  private getRequestCount(serviceId: string): number {
    const metrics = this.store.getMetrics(serviceId);
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
    const instances = this.store.listInstances();
    for (const instance of instances) {
      const metrics = this.store.getMetrics(instance.id);
      if (!metrics) continue;
      stats.push({
        serviceId: instance.id,
        requestCount: metrics.requestCount,
        errorCount: metrics.errorCount,
        avgResponseTime: metrics.avgResponseTime,
        errorRate: metrics.requestCount > 0 ? metrics.errorCount / metrics.requestCount : 0
      });
    }

    return stats;
  }
}

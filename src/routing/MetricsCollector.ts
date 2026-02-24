import {
  Logger,
  ServiceLoadMetrics,
  ServiceCostMetrics,
  ServiceContentAnalysis,
  ServiceHealth
} from '../types/index.js';
import { CircularBuffer } from '../utils/CircularBuffer.js';
import { unrefTimer } from '../utils/async.js';

export interface RequestRecord {
  serviceId: string;
  timestamp: Date;
  responseTime: number;
  success: boolean;
}

export class MetricsCollector {
  private static readonly MAX_SERVICES = 500;
  private serviceMetrics = new Map<string, ServiceLoadMetrics>();
  private costMetrics = new Map<string, ServiceCostMetrics>();
  private contentAnalysis = new Map<string, ServiceContentAnalysis>();
  private requestHistory = new CircularBuffer<RequestRecord>(1000);
  private metricsInterval?: NodeJS.Timeout;

  constructor(private logger: Logger) {
    this.startMetricsCollection();
  }

  reset(): void {
    this.serviceMetrics.clear();
    this.costMetrics.clear();
    this.contentAnalysis.clear();
    this.requestHistory.clear();
    this.logger.info('Metrics have been reset');
  }

  removeService(serviceId: string): void {
    this.serviceMetrics.delete(serviceId);
    this.costMetrics.delete(serviceId);
    this.contentAnalysis.delete(serviceId);
  }

  getServiceMetrics(serviceId: string): ServiceLoadMetrics | undefined {
    return this.serviceMetrics.get(serviceId);
  }

  getCostMetrics(serviceId: string): ServiceCostMetrics | undefined {
    return this.costMetrics.get(serviceId);
  }

  getAllMetrics(): Record<string, ServiceLoadMetrics> {
    const result: Record<string, ServiceLoadMetrics> = {};
    for (const [id, metrics] of this.serviceMetrics) result[id] = metrics;
    return result;
  }

  getContentAnalysis(serviceId: string): ServiceContentAnalysis | undefined {
    return this.contentAnalysis.get(serviceId);
  }

  updateServiceMetrics(serviceId: string, metrics: Partial<ServiceLoadMetrics> & Record<string, unknown>): void {
    if (!this.serviceMetrics.has(serviceId) && this.serviceMetrics.size >= MetricsCollector.MAX_SERVICES) return;
    const existing = this.serviceMetrics.get(serviceId) || {
      requestCount: 0,
      successRate: 1,
      averageResponseTime: 0,
      lastUsed: new Date()
    };
    this.serviceMetrics.set(serviceId, { ...existing, ...metrics } as ServiceLoadMetrics);
  }

  updateServiceHealth(serviceId: string, health: ServiceHealth): void {
    const metrics = this.serviceMetrics.get(serviceId) || {
      requestCount: 0,
      successRate: 1,
      averageResponseTime: 0,
      lastUsed: new Date()
    };
    metrics.averageResponseTime = health.responseTime ?? metrics.averageResponseTime;
    this.serviceMetrics.set(serviceId, metrics);
  }

  updateServiceCostMetrics(serviceId: string, costMetrics: ServiceCostMetrics): void {
    if (!this.costMetrics.has(serviceId) && this.costMetrics.size >= MetricsCollector.MAX_SERVICES) return;
    this.costMetrics.set(serviceId, costMetrics);
  }

  updateServiceContentAnalysis(serviceId: string, analysis: ServiceContentAnalysis): void {
    if (!this.contentAnalysis.has(serviceId) && this.contentAnalysis.size >= MetricsCollector.MAX_SERVICES) return;
    this.contentAnalysis.set(serviceId, analysis);
  }

  recordRequest(serviceId: string, responseTime: number, success: boolean): void {
    this.requestHistory.push({ serviceId, timestamp: new Date(), responseTime, success });
  }

  getRequestHistory(): RequestRecord[] {
    return this.requestHistory.toArray();
  }

  updateRequestMetrics(serviceId: string): void {
    this.requestHistory.push({
      serviceId,
      timestamp: new Date(),
      responseTime: 0,
      success: true
    });

    const metrics = this.serviceMetrics.get(serviceId) || {
      requestCount: 0,
      successRate: 1.0,
      averageResponseTime: 0,
      lastUsed: new Date()
    };

    metrics.requestCount += 1;
    metrics.lastUsed = new Date();
    this.serviceMetrics.set(serviceId, metrics);
  }

  updateRequestResult(serviceId: string, responseTime: number, success: boolean): void {
    const recentRequest = this.requestHistory.findLast(
      r => r.serviceId === serviceId && r.responseTime === 0
    );

    if (recentRequest) {
      recentRequest.responseTime = responseTime;
      recentRequest.success = success;
    }
  }

  getMetrics(): {
    totalRequests: number;
    successRate: number;
    averageResponseTime: number;
    serviceDistribution: Record<string, number>;
  } {
    const totalRequests = this.requestHistory.length;
    const successfulRequests = this.requestHistory.filter(r => r.success).length;
    const successRate = totalRequests > 0 ? successfulRequests / totalRequests : 0;

    const totalResponseTime = this.requestHistory.reduce((sum, r) => sum + r.responseTime, 0);
    const averageResponseTime = totalRequests > 0 ? totalResponseTime / totalRequests : 0;

    const serviceDistribution: Record<string, number> = {};
    for (const request of this.requestHistory) {
      serviceDistribution[request.serviceId] = (serviceDistribution[request.serviceId] || 0) + 1;
    }

    return {
      totalRequests,
      successRate,
      averageResponseTime,
      serviceDistribution
    };
  }

  refreshServiceMetrics(serviceId?: string, directMetrics?: ServiceLoadMetrics): void {
    if (serviceId && directMetrics) {
      this.serviceMetrics.set(serviceId, directMetrics);
      return;
    }

    const now = Date.now();
    const recentRequests = this.requestHistory.filter(
      r => now - r.timestamp.getTime() < 300000
    );

    const serviceStats = new Map<string, { total: number; successful: number; totalResponseTime: number }>();

    for (const request of recentRequests) {
      const stats = serviceStats.get(request.serviceId) || { total: 0, successful: 0, totalResponseTime: 0 };
      stats.total += 1;
      if (request.success) stats.successful += 1;
      stats.totalResponseTime += request.responseTime;
      serviceStats.set(request.serviceId, stats);
    }

    for (const [serviceId, stats] of serviceStats) {
      const metrics = this.serviceMetrics.get(serviceId) || {
        requestCount: 0,
        successRate: 1.0,
        averageResponseTime: 0,
        lastUsed: new Date()
      };

      metrics.successRate = stats.total > 0 ? stats.successful / stats.total : 1.0;
      metrics.averageResponseTime = stats.total > 0 ? stats.totalResponseTime / stats.total : 0;

      this.serviceMetrics.set(serviceId, metrics);
    }
  }

  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(() => {
      this.refreshServiceMetrics();
    }, 30000);
    unrefTimer(this.metricsInterval);
  }

  destroy(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }
}

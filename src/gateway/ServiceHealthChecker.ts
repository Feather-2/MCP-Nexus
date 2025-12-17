import { HealthCheckResult, Logger } from '../types/index.js';

export class ServiceHealthChecker {
  private monitoringServices = new Set<string>();
  private healthCache = new Map<string, HealthCheckResult>();
  private checkInterval = 5000; // 5 seconds
  private probe?: (serviceId: string) => Promise<HealthCheckResult>;
  private latencies: Map<string, number[]> = new Map();
  private counters: Map<string, { success: number; failure: number; lastError?: string }> = new Map();

  constructor(private logger: Logger) {
    // Start periodic health checks
    setInterval(() => {
      this.performPeriodicChecks();
    }, this.checkInterval);
  }

  setProbe(fn: (serviceId: string) => Promise<HealthCheckResult>): void {
    this.probe = fn;
  }

  async startMonitoring(serviceId?: string): Promise<void> {
    if (serviceId) {
      this.monitoringServices.add(serviceId);
      this.logger.debug(`Started health monitoring for: ${serviceId}`);
    }
  }

  async stopMonitoring(serviceId?: string): Promise<void> {
    if (serviceId) {
      this.monitoringServices.delete(serviceId);
      this.healthCache.delete(serviceId);
      this.logger.debug(`Stopped health monitoring for: ${serviceId}`);
    }
  }

  async getHealthStatus(): Promise<Record<string, HealthCheckResult>> {
    const status: Record<string, HealthCheckResult> = {};
    
    for (const serviceId of this.monitoringServices) {
      const healthCheck = this.healthCache.get(serviceId);
      if (healthCheck) {
        status[serviceId] = healthCheck;
      }
    }
    
    return status;
  }

  async checkHealth(serviceId: string): Promise<HealthCheckResult> {
    try {
      const startTime = Date.now();
      
      // For now, implement a simple ping-style health check
      // In a real implementation, this would send an actual MCP message
      const healthy = await this.performHealthCheck(serviceId);
      const latency = Date.now() - startTime;

      const result: HealthCheckResult = {
        healthy,
        latency,
        timestamp: new Date()
      };

      // Cache the result and record metrics
      this.healthCache.set(serviceId, result);
      this.recordMetrics(serviceId, result);
      
      return result;
    } catch (error) {
      const result: HealthCheckResult = {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date()
      };

      this.healthCache.set(serviceId, result);
      this.recordMetrics(serviceId, result);
      return result;
    }
  }

  getLastHealthCheck(serviceId: string): HealthCheckResult | null {
    return this.healthCache.get(serviceId) || null;
  }

  private async performPeriodicChecks(): Promise<void> {
    for (const serviceId of this.monitoringServices) {
      try {
        await this.checkHealth(serviceId);
      } catch (error) {
        this.logger.warn(`Periodic health check failed for ${serviceId}:`, error);
      }
    }
  }

  private async performHealthCheck(serviceId: string): Promise<boolean> {
    // If external probe is provided, use it and update cache; return boolean
    if (this.probe) {
      try {
        const res = await this.probe(serviceId);
        this.healthCache.set(serviceId, res);
        return !!res.healthy;
      } catch (e: any) {
        this.healthCache.set(serviceId, { healthy: false, error: e?.message || 'probe failed', timestamp: new Date() });
        return false;
      }
    }
    // No fallback in production: require probe to be set
    // Provide a conservative default to avoid false-healthy
    return false;
  }

  async getHealthStats(): Promise<{
    monitoring: number;
    healthy: number;
    unhealthy: number;
    avgLatency: number;
    p95?: number;
    p99?: number;
    errorRate?: number;
  }> {
    const monitoring = this.monitoringServices.size;
    let healthy = 0;
    let unhealthy = 0;
    let totalLatency = 0;
    let latencyCount = 0;
    let totalSuccess = 0;
    let totalFailure = 0;

    for (const [_serviceId, result] of this.healthCache) {
      if (result.healthy) {
        healthy++;
      } else {
        unhealthy++;
      }

      if (result.latency !== undefined) {
        totalLatency += result.latency;
        latencyCount++;
      }
    }

    // Aggregate success/failure
    for (const c of this.counters.values()) { totalSuccess += c.success; totalFailure += c.failure; }

    // Merge latencies across services for percentile
    const allLat = ([] as number[]).concat(...Array.from(this.latencies.values()));
    const [p95, p99] = this.computePercentiles(allLat, [0.95, 0.99]);

    return {
      monitoring,
      healthy,
      unhealthy,
      avgLatency: latencyCount > 0 ? totalLatency / latencyCount : 0,
      p95,
      p99,
      errorRate: (totalSuccess + totalFailure) > 0 ? totalFailure / (totalSuccess + totalFailure) : 0
    };
  }

  getPerServiceStats(): Array<{ id: string; last: HealthCheckResult | null; p95?: number; p99?: number; errorRate?: number; samples: number; lastError?: string; latencies?: number[] }>{
    const out: Array<{ id: string; last: HealthCheckResult | null; p95?: number; p99?: number; errorRate?: number; samples: number; lastError?: string; latencies?: number[] }> = [];
    for (const id of this.monitoringServices) {
      const hist = this.latencies.get(id) || [];
      const [p95, p99] = this.computePercentiles(hist, [0.95, 0.99]);
      const ctr = this.counters.get(id) || { success: 0, failure: 0 };
      const total = ctr.success + ctr.failure;
      const errorRate = total > 0 ? ctr.failure / total : 0;
      const latencies = hist.slice(-30);
      out.push({ id, last: this.healthCache.get(id) || null, p95, p99, errorRate, samples: hist.length, lastError: ctr.lastError, latencies });
    }
    return out;
  }

  private recordMetrics(serviceId: string, res: HealthCheckResult): void {
    if (typeof res.latency === 'number') {
      const list = this.latencies.get(serviceId) || [];
      list.push(res.latency);
      if (list.length > 200) list.shift();
      this.latencies.set(serviceId, list);
    }
    const ctr = this.counters.get(serviceId) || { success: 0, failure: 0 };
    if (res.healthy) ctr.success++; else ctr.failure++;
    if (res.error) ctr.lastError = res.error;
    this.counters.set(serviceId, ctr);
  }

  private computePercentiles(arr: number[], ps: number[]): number[] {
    if (!arr || arr.length === 0) return ps.map(() => 0);
    const sorted = [...arr].sort((a, b) => a - b);
    return ps.map(p => {
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length) - 1));
      return sorted[idx] ?? 0;
    });
  }
}

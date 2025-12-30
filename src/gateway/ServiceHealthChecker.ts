import { HealthCheckResult, Logger } from '../types/index.js';

export class ServiceHealthChecker {
  private monitoringServices = new Set<string>();
  private healthCache = new Map<string, HealthCheckResult>();
  private checkInterval = 5000; // 5 seconds
  private probe?: (serviceId: string) => Promise<HealthCheckResult>;
  private latencies: Map<string, number[]> = new Map();
  private counters: Map<string, { success: number; failure: number; lastError?: string }> = new Map();
  private periodicRunning = false;
  private inFlightChecks = new Map<string, Promise<HealthCheckResult>>();
  private readonly concurrency = 8;

  constructor(private logger: Logger) {
    // Start periodic health checks
    const t = setInterval(() => {
      void this.performPeriodicChecks();
    }, this.checkInterval);
    // Don't keep the process alive solely for background health probes (important for tests/CLI).
    (t as any).unref?.();
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

  async checkHealth(serviceId: string, opts?: { force?: boolean; maxAgeMs?: number }): Promise<HealthCheckResult> {
    const now = Date.now();
    const maxAgeMs = opts?.maxAgeMs ?? this.checkInterval;
    const cached = this.healthCache.get(serviceId);
    if (!opts?.force && cached) {
      const ts = cached.timestamp instanceof Date ? cached.timestamp.getTime() : new Date(cached.timestamp as any).getTime();
      if (Number.isFinite(ts) && (now - ts) <= maxAgeMs) {
        return cached;
      }
    }

    const existing = this.inFlightChecks.get(serviceId);
    if (existing) return existing;

    const p = this.performActiveCheck(serviceId)
      .finally(() => {
        this.inFlightChecks.delete(serviceId);
      });
    this.inFlightChecks.set(serviceId, p);
    return p;
  }

  /**
   * Passive heartbeat reporting: updates cached health without performing an active probe.
   * Useful to reduce long-tail latency and avoid side-effects on external services.
   */
  reportHeartbeat(serviceId: string, update: { healthy: boolean; latency?: number; error?: string }): void {
    const res: HealthCheckResult = {
      healthy: Boolean(update.healthy),
      latency: typeof update.latency === 'number' ? update.latency : undefined,
      error: update.error,
      timestamp: new Date()
    };
    this.healthCache.set(serviceId, res);
    this.recordMetrics(serviceId, res);
  }

  private async performActiveCheck(serviceId: string): Promise<HealthCheckResult> {
    try {
      const startTime = Date.now();

      const result = await this.performHealthCheck(serviceId, startTime);
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
    if (this.periodicRunning) return;
    this.periodicRunning = true;
    try {
      const ids = Array.from(this.monitoringServices);
      const maxAgeMs = this.checkInterval;

      await this.runWithConcurrency(ids, this.concurrency, async (serviceId) => {
        try {
          await this.checkHealth(serviceId, { force: false, maxAgeMs });
        } catch (error) {
          this.logger.warn(`Periodic health check failed for ${serviceId}:`, error);
        }
      });
    } finally {
      this.periodicRunning = false;
    }
  }

  private async performHealthCheck(serviceId: string, startedAtMs: number): Promise<HealthCheckResult> {
    // If external probe is provided, use it and update cache; return boolean
    if (this.probe) {
      try {
        const res = await this.probe(serviceId);
        return {
          healthy: Boolean(res.healthy),
          latency: typeof res.latency === 'number' ? res.latency : (Date.now() - startedAtMs),
          error: res.error,
          timestamp: res.timestamp instanceof Date ? res.timestamp : new Date(res.timestamp as any)
        };
      } catch (e: any) {
        return { healthy: false, error: e?.message || 'probe failed', latency: Date.now() - startedAtMs, timestamp: new Date() };
      }
    }
    // No fallback in production: require probe to be set
    // Provide a conservative default to avoid false-healthy
    return { healthy: false, error: 'probe not configured', latency: Date.now() - startedAtMs, timestamp: new Date() };
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

  private async runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>
  ): Promise<void> {
    const max = Math.max(1, Math.floor(limit || 1));
    let idx = 0;

    const runners = Array.from({ length: Math.min(max, items.length) }).map(async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        await worker(items[i]!);
      }
    });

    await Promise.all(runners);
  }
}

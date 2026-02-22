import { HealthCheckResult, Logger } from '../types/index.js';
import { ServiceHealthChecker } from './ServiceHealthChecker.js';
import { ServiceObservationStore } from './service-state.js';

export class HealthRegistry {
  private healthChecker: ServiceHealthChecker;

  constructor(
    private logger: Logger,
    private store: ServiceObservationStore
  ) {
    this.healthChecker = new ServiceHealthChecker(logger, store);
  }

  setProbe(probe: (serviceId: string) => Promise<HealthCheckResult>): void {
    (this.healthChecker as unknown as { setProbe?: (fn: unknown) => void }).setProbe?.(probe);
  }

  async check(serviceId: string): Promise<HealthCheckResult> {
    return await this.healthChecker.checkHealth(serviceId);
  }

  reportHeartbeat(serviceId: string, update: { healthy: boolean; latency?: number; error?: string }): void {
    try {
      (this.healthChecker as unknown as { reportHeartbeat?: (id: string, u: unknown) => void }).reportHeartbeat?.(serviceId, update);
    } catch (e) {
      this.logger.warn('Heartbeat report failed', { serviceId, error: (e as Error)?.message || String(e) });
    }
  }

  async getAggregates(): Promise<{
    global: { monitoring: number; healthy: number; unhealthy: number; avgLatency: number; p95?: number; p99?: number; errorRate?: number };
    perService: Array<{ id: string; last: HealthCheckResult | null; p95?: number; p99?: number; errorRate?: number; samples: number; lastError?: string }>
  }> {
    const global = await this.healthChecker.getHealthStats();
    const perService = this.healthChecker.getPerServiceStats();
    return { global, perService };
  }

  async startMonitoring(serviceId?: string): Promise<void> {
    if (serviceId) {
      await this.healthChecker.startMonitoring(serviceId);
    } else {
      await this.healthChecker.startMonitoring();
      const instances = this.store.listInstances();
      await Promise.all(instances.map((i) => this.healthChecker.startMonitoring(i.id)));
      this.logger.info('Health monitoring started');
    }
  }

  async stopMonitoring(serviceId?: string): Promise<void> {
    if (serviceId) {
      await this.healthChecker.stopMonitoring(serviceId);
    } else {
      await this.healthChecker.stopMonitoring();
      const instances = this.store.listInstances();
      await Promise.all(instances.map((i) => this.healthChecker.stopMonitoring(i.id)));
      this.logger.info('Health monitoring stopped');
    }
  }

  async getStatus(): Promise<Record<string, HealthCheckResult>> {
    return await this.healthChecker.getHealthStatus();
  }

  dispose(): void {
    this.healthChecker.dispose();
  }
}

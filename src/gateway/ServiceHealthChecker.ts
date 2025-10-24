import { HealthCheckResult, Logger } from '../types/index.js';

export class ServiceHealthChecker {
  private monitoringServices = new Set<string>();
  private healthCache = new Map<string, HealthCheckResult>();
  private checkInterval = 5000; // 5 seconds

  constructor(private logger: Logger) {
    // Start periodic health checks
    setInterval(() => {
      this.performPeriodicChecks();
    }, this.checkInterval);
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

      // Cache the result
      this.healthCache.set(serviceId, result);
      
      return result;
    } catch (error) {
      const result: HealthCheckResult = {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date()
      };

      this.healthCache.set(serviceId, result);
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
    // Simplified health check - in reality, this would:
    // 1. Send a ping/list_tools message to the service
    // 2. Wait for a response within timeout
    // 3. Validate the response format
    
    // For now, just simulate a health check
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Simulate occasional failures
    return Math.random() > 0.1; // 90% success rate
  }

  async getHealthStats(): Promise<{
    monitoring: number;
    healthy: number;
    unhealthy: number;
    avgLatency: number;
  }> {
    const monitoring = this.monitoringServices.size;
    let healthy = 0;
    let unhealthy = 0;
    let totalLatency = 0;
    let latencyCount = 0;

    for (const [serviceId, result] of this.healthCache) {
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

    return {
      monitoring,
      healthy,
      unhealthy,
      avgLatency: latencyCount > 0 ? totalLatency / latencyCount : 0
    };
  }
}
import { EventEmitter } from 'events';
import {
  ServiceRegistry,
  McpServiceConfig,
  ServiceInstance,
  HealthCheckResult,
  RoutingStrategy,
  Logger
} from '../types/index.js';
import { ServiceTemplateManager } from './ServiceTemplateManager.js';
import { ServiceObservationStore } from './service-state.js';
import { TemplateRegistry } from './TemplateRegistry.js';
import { InstanceRegistry } from './InstanceRegistry.js';
import { HealthRegistry } from './HealthRegistry.js';

export class ServiceRegistryImpl extends EventEmitter implements ServiceRegistry {
  private templateRegistry: TemplateRegistry;
  private instanceRegistry: InstanceRegistry;
  private healthRegistry: HealthRegistry;
  private store: ServiceObservationStore;

  constructor(private logger: Logger) {
    super();
    this.store = new ServiceObservationStore();
    this.templateRegistry = new TemplateRegistry(logger, this.store);
    this.instanceRegistry = new InstanceRegistry(logger, this.store);
    this.healthRegistry = new HealthRegistry(logger, this.store);
  }

  // Template Management
  async registerTemplate(template: McpServiceConfig): Promise<void> {
    await this.templateRegistry.register(template);
  }

  async getTemplate(name: string): Promise<McpServiceConfig | null> {
    return await this.templateRegistry.get(name);
  }

  async listTemplates(): Promise<McpServiceConfig[]> {
    return await this.templateRegistry.list();
  }

  async removeTemplate(templateName: string): Promise<void> {
    await this.templateRegistry.remove(templateName);
  }

  getTemplateManager(): ServiceTemplateManager {
    return this.templateRegistry.getManager();
  }

  setHealthProbe(probe: (serviceId: string) => Promise<HealthCheckResult>): void {
    this.healthRegistry.setProbe(probe);
  }

  // Instance Management
  async createInstance(templateName: string, overrides?: Partial<McpServiceConfig> & { instanceMode?: 'keep-alive' | 'managed' }): Promise<ServiceInstance> {
    const template = await this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template ${templateName} not found`);
    }
    const instance = await this.instanceRegistry.create(templateName, template, overrides);

    // Start health checking for keep-alive; skip for managed
    const instanceMode = (overrides as Record<string, unknown> | undefined)?.instanceMode as ('keep-alive' | 'managed' | undefined);
    if (instanceMode !== 'managed') {
      await this.healthRegistry.startMonitoring(instance.id);
    }

    return instance;
  }

  async getInstance(serviceId: string): Promise<ServiceInstance | null> {
    return this.instanceRegistry.get(serviceId);
  }

  async listInstances(): Promise<ServiceInstance[]> {
    return this.instanceRegistry.list();
  }

  async listServices(): Promise<ServiceInstance[]> {
    return this.listInstances();
  }

  async getService(serviceId: string): Promise<ServiceInstance | null> {
    return this.getInstance(serviceId);
  }

  async createServiceFromTemplate(templateName: string, overrides?: Record<string, unknown>): Promise<string> {
    const instance = await this.createInstance(templateName, overrides);
    return instance.id;
  }

  async stopService(serviceId: string): Promise<boolean> {
    try {
      await this.removeInstance(serviceId);
      return true;
    } catch (error) {
      this.logger.error('Failed to stop service:', error);
      return false;
    }
  }

  async removeInstance(serviceId: string): Promise<void> {
    await this.healthRegistry.stopMonitoring(serviceId);
    await this.instanceRegistry.remove(serviceId);
  }

  // Health & Load Balancing
  async checkHealth(serviceId: string): Promise<HealthCheckResult> {
    return await this.healthRegistry.check(serviceId);
  }

  reportHeartbeat(serviceId: string, update: { healthy: boolean; latency?: number; error?: string }): void {
    this.healthRegistry.reportHeartbeat(serviceId, update);
  }

  async getHealthAggregates(): Promise<{
    global: { monitoring: number; healthy: number; unhealthy: number; avgLatency: number; p95?: number; p99?: number; errorRate?: number };
    perService: Array<{ id: string; last: HealthCheckResult | null; p95?: number; p99?: number; errorRate?: number; samples: number; lastError?: string }>
  }> {
    return await this.healthRegistry.getAggregates();
  }

  async getHealthyInstances(templateName?: string): Promise<ServiceInstance[]> {
    const instances = templateName ? this.store.listInstances(templateName) : this.store.listInstances();
    return instances.filter((instance) => this.store.getHealth(instance.id)?.healthy === true);
  }

  async setInstanceMetadata(serviceId: string, key: string, value: unknown): Promise<void> {
    await this.instanceRegistry.setMetadata(serviceId, key, value);
  }

  async selectBestInstance(templateName: string, strategy: RoutingStrategy = 'performance'): Promise<ServiceInstance | null> {
    return await this.instanceRegistry.selectBest(templateName, strategy);
  }

  async startHealthMonitoring(): Promise<void> {
    await this.healthRegistry.startMonitoring();
  }

  async stopHealthMonitoring(): Promise<void> {
    await this.healthRegistry.stopMonitoring();
  }

  async getHealthStatus(): Promise<Record<string, HealthCheckResult>> {
    return await this.healthRegistry.getStatus();
  }

  async selectInstance(templateName: string, strategy?: RoutingStrategy): Promise<ServiceInstance | null> {
    return await this.instanceRegistry.select(templateName, strategy);
  }

  async getInstancesByTemplate(templateName: string): Promise<ServiceInstance[]> {
    return this.instanceRegistry.list(templateName);
  }

  async scaleTemplate(templateName: string, targetCount: number): Promise<ServiceInstance[]> {
    const currentInstances = await this.getInstancesByTemplate(templateName);
    const currentCount = currentInstances.length;

    if (targetCount === currentCount) {
      return currentInstances;
    }

    if (targetCount > currentCount) {
      const instancesToCreate = targetCount - currentCount;
      const newInstances: ServiceInstance[] = [];

      for (let i = 0; i < instancesToCreate; i++) {
        const instance = await this.createInstance(templateName);
        newInstances.push(instance);
      }

      return [...currentInstances, ...newInstances];
    } else {
      return await this.instanceRegistry.scale(templateName, targetCount);
    }
  }

  async getRegistryStats(): Promise<{
    totalTemplates: number;
    totalInstances: number;
    healthyInstances: number;
    instancesByState: Record<string, number>;
  }> {
    const templates = await this.listTemplates();
    const instances = this.store.listInstances();

    let healthyCount = 0;
    const stateCount: Record<string, number> = {};

    for (const instance of instances) {
      stateCount[instance.state] = (stateCount[instance.state] || 0) + 1;
      const health = this.store.getHealth(instance.id);
      if (health?.healthy) {
        healthyCount++;
      }
    }

    return {
      totalTemplates: templates.length,
      totalInstances: instances.length,
      healthyInstances: healthyCount,
      instancesByState: stateCount
    };
  }
}

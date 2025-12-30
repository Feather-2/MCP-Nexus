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
import { ServiceInstanceManager } from './ServiceInstanceManager.js';
import { ServiceHealthChecker } from './ServiceHealthChecker.js';
import { IntelligentLoadBalancer } from './IntelligentLoadBalancer.js';

export class ServiceRegistryImpl extends EventEmitter implements ServiceRegistry {
  private templateManager: ServiceTemplateManager;
  private instanceManager: ServiceInstanceManager;
  private healthChecker: ServiceHealthChecker;
  private loadBalancer: IntelligentLoadBalancer;

  constructor(private logger: Logger) {
    super();
    this.templateManager = new ServiceTemplateManager(logger);
    this.instanceManager = new ServiceInstanceManager(logger);
    this.healthChecker = new ServiceHealthChecker(logger);
    this.loadBalancer = new IntelligentLoadBalancer(logger);
    // Initialize default templates and fix legacy placeholders asynchronously (safe guard)
    try {
      const maybePromise = (this.templateManager as any).initializeDefaults?.();
      if (maybePromise && typeof maybePromise.then === 'function') {
        void maybePromise.catch((err: any) => this.logger.warn('Failed to initialize default templates:', err));
      }
    } catch (err) {
      this.logger.warn('Failed to initialize default templates:', err as any);
    }
  }

  // Template Management
  async registerTemplate(template: McpServiceConfig): Promise<void> {
    await this.templateManager.register(template);
    this.logger.info(`Template registered: ${template.name}`);
  }

  async getTemplate(name: string): Promise<McpServiceConfig | null> {
    return await this.templateManager.get(name);
  }

  async listTemplates(): Promise<McpServiceConfig[]> {
    return await this.templateManager.list();
  }

  getTemplateManager(): ServiceTemplateManager {
    return this.templateManager;
  }

  setHealthProbe(probe: (serviceId: string) => Promise<HealthCheckResult>): void {
    (this.healthChecker as any).setProbe?.(probe);
  }

  // Instance Management
  async createInstance(templateName: string, overrides?: Partial<McpServiceConfig> & { instanceMode?: 'keep-alive' | 'managed' }): Promise<ServiceInstance> {
    const template = await this.templateManager.get(templateName);
    if (!template) {
      throw new Error(`Template ${templateName} not found`);
    }
    const config: McpServiceConfig = { ...template, ...overrides } as McpServiceConfig;
    // Runtime safeguard: sanitize filesystem args to avoid "${ALLOWED_DIRECTORY}" placeholder
    if (config.name === 'filesystem' && config.transport === 'stdio' && Array.isArray(config.args)) {
      const defaultDir = process.platform === 'win32' ? 'C:/Users/Public' : '/tmp';
      const args = [...config.args];
      const pkgIndex = args.findIndex(a => typeof a === 'string' && a.includes('@modelcontextprotocol/server-filesystem'));
      if (pkgIndex >= 0) {
        const nextIdx = pkgIndex + 1;
        if (args[nextIdx] == null) {
          args.push(defaultDir);
        } else if (typeof args[nextIdx] === 'string' && (args[nextIdx] as string).includes('${ALLOWED_DIRECTORY}')) {
          args[nextIdx] = defaultDir;
        }
      }
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === 'string' && (args[i] as string).includes('${ALLOWED_DIRECTORY}')) {
          args[i] = (args[i] as string).replace('${ALLOWED_DIRECTORY}', defaultDir);
        }
      }
      config.args = args as string[];
    }

    const instance = await this.instanceManager.create(config);

    // Apply instance mode (keep-alive | managed)
    const instanceMode = (overrides as any)?.instanceMode as ('keep-alive' | 'managed' | undefined);
    if (instanceMode) {
      try { await this.instanceManager.setMetadata(instance.id, 'mode', instanceMode); } catch { /* ignored */ }
    }

    // Start health checking for keep-alive; skip for managed
    if (instanceMode !== 'managed') {
      await this.healthChecker.startMonitoring(instance.id);
    }

    // Register with load balancer
    this.loadBalancer.addInstance(instance);

    this.logger.info(`Instance created from template ${templateName}: ${instance.id}`);
    return instance;
  }

  async getInstance(serviceId: string): Promise<ServiceInstance | null> {
    return await this.instanceManager.get(serviceId);
  }

  async listInstances(): Promise<ServiceInstance[]> {
    return await this.instanceManager.list();
  }

  // Alias methods for PbMcpGateway compatibility
  async listServices(): Promise<ServiceInstance[]> {
    return this.listInstances();
  }

  async getService(serviceId: string): Promise<ServiceInstance | null> {
    return this.getInstance(serviceId);
  }

  async createServiceFromTemplate(templateName: string, overrides?: any): Promise<string> {
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

  async removeTemplate(templateName: string): Promise<void> {
    await this.templateManager.remove(templateName);
  }

  async removeInstance(serviceId: string): Promise<void> {
    // Stop health checking
    await this.healthChecker.stopMonitoring(serviceId);

    // Remove from load balancer
    this.loadBalancer.removeInstance(serviceId);

    // Remove instance
    await this.instanceManager.remove(serviceId);

    this.logger.info(`Instance removed: ${serviceId}`);
  }

  // Health & Load Balancing
  async checkHealth(serviceId: string): Promise<HealthCheckResult> {
    return await this.healthChecker.checkHealth(serviceId);
  }

  reportHeartbeat(serviceId: string, update: { healthy: boolean; latency?: number; error?: string }): void {
    try {
      (this.healthChecker as any).reportHeartbeat?.(serviceId, update);
    } catch {
      // ignore
    }
  }

  async getHealthAggregates(): Promise<{
    global: { monitoring: number; healthy: number; unhealthy: number; avgLatency: number; p95?: number; p99?: number; errorRate?: number };
    perService: Array<{ id: string; last: HealthCheckResult | null; p95?: number; p99?: number; errorRate?: number; samples: number; lastError?: string }>
  }> {
    const global = await this.healthChecker.getHealthStats();
    const perService = this.healthChecker.getPerServiceStats();
    return { global, perService };
  }

  async getHealthyInstances(templateName?: string): Promise<ServiceInstance[]> {
    const allInstances = await this.listInstances();
    const healthyInstances: ServiceInstance[] = [];

    for (const instance of allInstances) {
      if (templateName && instance.config.name !== templateName) {
        continue;
      }

      const health = await this.healthChecker.checkHealth(instance.id);
      if (health.healthy) {
        healthyInstances.push(instance);
      }
    }

    return healthyInstances;
  }

  // Metadata helpers for instances (exposed for server to annotate diagnostics)
  async setInstanceMetadata(serviceId: string, key: string, value: any): Promise<void> {
    await (this.instanceManager as any).setMetadata?.(serviceId, key, value);
  }

  async selectBestInstance(templateName: string, strategy: RoutingStrategy = 'performance'): Promise<ServiceInstance | null> {
    const instances = await this.listInstances();
    const filteredInstances = instances.filter(instance => instance.config.name === templateName);

    if (filteredInstances.length === 0) {
      return null;
    }

    return this.loadBalancer.selectInstance(filteredInstances, strategy);
  }

  // Health Monitoring
  async startHealthMonitoring(): Promise<void> {
    // Backward compatibility: older tests/callers expect a no-arg call.
    await this.healthChecker.startMonitoring();

    // Prefer per-instance monitoring when instances are available.
    const instances = await this.listInstances().catch(() => []);
    const list = Array.isArray(instances) ? instances : [];
    await Promise.all(list.map((i) => this.healthChecker.startMonitoring(i.id)));
    this.logger.info('Health monitoring started');
  }

  async stopHealthMonitoring(): Promise<void> {
    // Backward compatibility: older tests/callers expect a no-arg call.
    await this.healthChecker.stopMonitoring();

    const instances = await this.listInstances().catch(() => []);
    const list = Array.isArray(instances) ? instances : [];
    await Promise.all(list.map((i) => this.healthChecker.stopMonitoring(i.id)));
    this.logger.info('Health monitoring stopped');
  }

  async getHealthStatus(): Promise<Record<string, HealthCheckResult>> {
    return await this.healthChecker.getHealthStatus();
  }

  async selectInstance(templateName: string, strategy?: RoutingStrategy): Promise<ServiceInstance | null> {
    const healthyInstances = await this.getHealthyInstances(templateName);

    if (healthyInstances.length === 0) {
      return null;
    }

    return this.loadBalancer.selectInstance(healthyInstances, strategy);
  }

  // Advanced Features
  async getInstancesByTemplate(templateName: string): Promise<ServiceInstance[]> {
    const allInstances = await this.listInstances();
    return allInstances.filter(instance => instance.config.name === templateName);
  }

  async scaleTemplate(templateName: string, targetCount: number): Promise<ServiceInstance[]> {
    const currentInstances = await this.getInstancesByTemplate(templateName);
    const currentCount = currentInstances.length;

    if (targetCount === currentCount) {
      return currentInstances;
    }

    if (targetCount > currentCount) {
      // Scale up
      const instancesToCreate = targetCount - currentCount;
      const newInstances: ServiceInstance[] = [];

      for (let i = 0; i < instancesToCreate; i++) {
        const instance = await this.createInstance(templateName);
        newInstances.push(instance);
      }

      this.logger.info(`Scaled up ${templateName}: ${currentCount} -> ${targetCount}`);
      return [...currentInstances, ...newInstances];
    } else {
      // Scale down
      const _instancesToRemove = currentCount - targetCount;
      const instancesToKeep = currentInstances.slice(0, targetCount);
      const instancesToDelete = currentInstances.slice(targetCount);

      for (const instance of instancesToDelete) {
        await this.removeInstance(instance.id);
      }

      this.logger.info(`Scaled down ${templateName}: ${currentCount} -> ${targetCount}`);
      return instancesToKeep;
    }
  }

  async getRegistryStats(): Promise<{
    totalTemplates: number;
    totalInstances: number;
    healthyInstances: number;
    instancesByState: Record<string, number>;
  }> {
    const templates = await this.listTemplates();
    const instances = await this.listInstances();

    let healthyCount = 0;
    const stateCount: Record<string, number> = {};

    for (const instance of instances) {
      // Count by state
      stateCount[instance.state] = (stateCount[instance.state] || 0) + 1;

      // Count healthy instances
      const health = await this.healthChecker.checkHealth(instance.id);
      if (health.healthy) {
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

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
import { ServiceHealthChecker } from './ServiceHealthChecker.js';
import { IntelligentLoadBalancer } from './IntelligentLoadBalancer.js';
import { ServiceObservationStore } from './service-state.js';

export class ServiceRegistryImpl extends EventEmitter implements ServiceRegistry {
  private templateManager: ServiceTemplateManager;
  private healthChecker: ServiceHealthChecker;
  private loadBalancer: IntelligentLoadBalancer;
  private store: ServiceObservationStore;

  constructor(private logger: Logger) {
    super();
    this.store = new ServiceObservationStore();
    this.templateManager = new ServiceTemplateManager(logger);
    this.healthChecker = new ServiceHealthChecker(logger, this.store);
    this.loadBalancer = new IntelligentLoadBalancer(logger, this.store);
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
    const stored = await this.templateManager.get(template.name).catch(() => null);
    this.store.setTemplate(stored ?? template);
    this.logger.info(`Template registered: ${template.name}`);
  }

  async getTemplate(name: string): Promise<McpServiceConfig | null> {
    const template = await this.templateManager.get(name);
    if (template) {
      this.store.setTemplate(template);
    } else {
      this.store.removeTemplate(name);
    }
    return this.store.getTemplate(name) ?? null;
  }

  async listTemplates(): Promise<McpServiceConfig[]> {
    const templates = await this.templateManager.list();
    const nextNames = new Set(templates.map((t) => t.name));
    const prevNames = new Set(this.store.listTemplates().map((t) => t.name));

    this.store.atomicUpdate((tx) => {
      for (const tpl of templates) tx.setTemplate(tpl);
      for (const name of prevNames) {
        if (!nextNames.has(name)) tx.removeTemplate(name);
      }
    });

    return this.store.listTemplates();
  }

  getTemplateManager(): ServiceTemplateManager {
    return this.templateManager;
  }

  setHealthProbe(probe: (serviceId: string) => Promise<HealthCheckResult>): void {
    (this.healthChecker as any).setProbe?.(probe);
  }

  // Instance Management
  async createInstance(templateName: string, overrides?: Partial<McpServiceConfig> & { instanceMode?: 'keep-alive' | 'managed' }): Promise<ServiceInstance> {
    const template = await this.getTemplate(templateName);
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

    // Apply instance mode (keep-alive | managed)
    const instanceMode = (overrides as any)?.instanceMode as ('keep-alive' | 'managed' | undefined);
    const now = new Date();
    const instanceId = this.generateInstanceId(config.name);

    const instance: ServiceInstance = {
      id: instanceId,
      config,
      state: 'idle',
      startTime: now,
      startedAt: now,
      errorCount: 0,
      metadata: {
        createdAt: now.toISOString(),
        version: config.version,
        transport: config.transport,
        ...(instanceMode ? { mode: instanceMode } : {})
      }
    };

    // Atomic: instance + initial metrics
    this.store.atomicUpdate((tx) => {
      tx.setInstance(instance);
      tx.setMetrics(instance.id, {
        serviceId: instance.id,
        requestCount: 0,
        errorCount: 0,
        avgResponseTime: 0,
        addedAt: now,
        lastRequestTime: now
      });
    });

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
    return this.store.getInstance(serviceId) ?? null;
  }

  async listInstances(): Promise<ServiceInstance[]> {
    return this.store.listInstances();
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
    this.store.removeTemplate(templateName);
  }

  async removeInstance(serviceId: string): Promise<void> {
    // Stop health checking
    await this.healthChecker.stopMonitoring(serviceId);

    // Remove instance and derived state from store (single source of truth)
    this.store.removeInstance(serviceId);

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
    const instances = templateName ? this.store.listInstances(templateName) : this.store.listInstances();
    return instances.filter((instance) => this.store.getHealth(instance.id)?.healthy === true);
  }

  // Metadata helpers for instances (exposed for server to annotate diagnostics)
  async setInstanceMetadata(serviceId: string, key: string, value: any): Promise<void> {
    const updated = this.store.patchInstance(serviceId, { metadata: { [key]: value } });
    if (!updated) {
      throw new Error(`Instance ${serviceId} not found`);
    }
  }

  async selectBestInstance(templateName: string, strategy: RoutingStrategy = 'performance'): Promise<ServiceInstance | null> {
    const filteredInstances = this.store.listInstances(templateName);

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
    const instances = this.store.listInstances();
    await Promise.all(instances.map((i) => this.healthChecker.startMonitoring(i.id)));
    this.logger.info('Health monitoring started');
  }

  async stopHealthMonitoring(): Promise<void> {
    // Backward compatibility: older tests/callers expect a no-arg call.
    await this.healthChecker.stopMonitoring();

    const instances = this.store.listInstances();
    await Promise.all(instances.map((i) => this.healthChecker.stopMonitoring(i.id)));
    this.logger.info('Health monitoring stopped');
  }

  async getHealthStatus(): Promise<Record<string, HealthCheckResult>> {
    return await this.healthChecker.getHealthStatus();
  }

  async selectInstance(templateName: string, strategy?: RoutingStrategy): Promise<ServiceInstance | null> {
    const instances = this.store.listInstances(templateName);
    if (instances.length === 0) return null;

    const healthy = instances.filter((i) => this.store.getHealth(i.id)?.healthy === true);
    const pool = healthy.length > 0 ? healthy : instances;
    return this.loadBalancer.selectInstance(pool, strategy);
  }

  // Advanced Features
  async getInstancesByTemplate(templateName: string): Promise<ServiceInstance[]> {
    return this.store.listInstances(templateName);
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
    const instances = this.store.listInstances();

    let healthyCount = 0;
    const stateCount: Record<string, number> = {};

    for (const instance of instances) {
      // Count by state
      stateCount[instance.state] = (stateCount[instance.state] || 0) + 1;

      // Count healthy instances
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

  private generateInstanceId(templateName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${templateName}-${timestamp}-${random}`;
  }
}

import { ServiceInstance, McpServiceConfig, RoutingStrategy, Logger } from '../types/index.js';
import { ServiceObservationStore } from './service-state.js';
import { IntelligentLoadBalancer } from './IntelligentLoadBalancer.js';
import { randomBytes } from 'crypto';

export class InstanceRegistry {
  private loadBalancer: IntelligentLoadBalancer;

  constructor(
    private logger: Logger,
    private store: ServiceObservationStore
  ) {
    this.loadBalancer = new IntelligentLoadBalancer(logger, store);
  }

  async create(
    templateName: string,
    template: McpServiceConfig,
    overrides?: Partial<McpServiceConfig> & { instanceMode?: 'keep-alive' | 'managed' }
  ): Promise<ServiceInstance> {
    const config: McpServiceConfig = { ...template, ...overrides } as McpServiceConfig;

    // Runtime safeguard: sanitize filesystem args
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

    const instanceMode = (overrides as Record<string, unknown> | undefined)?.instanceMode as ('keep-alive' | 'managed' | undefined);
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

    this.loadBalancer.addInstance(instance);
    this.logger.info(`Instance created from template ${templateName}: ${instance.id}`);
    return instance;
  }

  get(serviceId: string): ServiceInstance | null {
    return this.store.getInstance(serviceId) ?? null;
  }

  list(templateName?: string): ServiceInstance[] {
    return templateName ? this.store.listInstances(templateName) : this.store.listInstances();
  }

  async remove(serviceId: string): Promise<void> {
    this.store.removeInstance(serviceId);
    this.logger.info(`Instance removed: ${serviceId}`);
  }

  async setMetadata(serviceId: string, key: string, value: unknown): Promise<void> {
    const updated = this.store.patchInstance(serviceId, { metadata: { [key]: value } });
    if (!updated) {
      throw new Error(`Instance ${serviceId} not found`);
    }
  }

  async scale(templateName: string, targetCount: number): Promise<ServiceInstance[]> {
    const currentInstances = this.list(templateName);
    const currentCount = currentInstances.length;

    if (targetCount === currentCount) {
      return currentInstances;
    }

    if (targetCount > currentCount) {
      this.logger.info(`Scaled up ${templateName}: ${currentCount} -> ${targetCount}`);
      return currentInstances;
    } else {
      const instancesToKeep = currentInstances.slice(0, targetCount);
      const instancesToDelete = currentInstances.slice(targetCount);

      for (const instance of instancesToDelete) {
        await this.remove(instance.id);
      }

      this.logger.info(`Scaled down ${templateName}: ${currentCount} -> ${targetCount}`);
      return instancesToKeep;
    }
  }

  async selectBest(templateName: string, strategy: RoutingStrategy = 'performance'): Promise<ServiceInstance | null> {
    const instances = this.list(templateName);
    if (instances.length === 0) return null;
    return this.loadBalancer.selectInstance(instances, strategy);
  }

  async select(templateName: string, strategy?: RoutingStrategy): Promise<ServiceInstance | null> {
    const instances = this.list(templateName);
    if (instances.length === 0) return null;

    const healthy = instances.filter((i) => this.store.getHealth(i.id)?.healthy === true);
    const pool = healthy.length > 0 ? healthy : instances;
    return this.loadBalancer.selectInstance(pool, strategy);
  }

  private generateInstanceId(templateName: string): string {
    const timestamp = Date.now();
    const random = randomBytes(6).toString('hex');
    return `${templateName}-${timestamp}-${random}`;
  }
}

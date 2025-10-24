import { ServiceInstance, McpServiceConfig, Logger } from '../types/index.js';

export class ServiceInstanceManager {
  private instances = new Map<string, ServiceInstance>();

  constructor(private logger: Logger) {}

  async create(config: McpServiceConfig): Promise<ServiceInstance> {
    const instanceId = this.generateInstanceId(config.name);
    
    const instance: ServiceInstance = {
      id: instanceId,
      config,
      state: 'idle',
      startTime: new Date(),
      startedAt: new Date(),
      errorCount: 0,
      metadata: {
        createdAt: new Date().toISOString(),
        version: config.version,
        transport: config.transport
      }
    };

    this.instances.set(instanceId, instance);
    this.logger.debug(`Instance created: ${instanceId}`);
    
    return instance;
  }

  async get(serviceId: string): Promise<ServiceInstance | null> {
    return this.instances.get(serviceId) || null;
  }

  async list(): Promise<ServiceInstance[]> {
    return Array.from(this.instances.values());
  }

  async update(serviceId: string, updates: Partial<ServiceInstance>): Promise<ServiceInstance> {
    const instance = this.instances.get(serviceId);
    if (!instance) {
      throw new Error(`Instance ${serviceId} not found`);
    }

    const updated = { ...instance, ...updates };
    this.instances.set(serviceId, updated);
    
    this.logger.debug(`Instance updated: ${serviceId}`);
    return updated;
  }

  async remove(serviceId: string): Promise<void> {
    const instance = this.instances.get(serviceId);
    if (!instance) {
      throw new Error(`Instance ${serviceId} not found`);
    }

    this.instances.delete(serviceId);
    this.logger.debug(`Instance removed: ${serviceId}`);
  }

  async updateState(serviceId: string, state: ServiceInstance['state']): Promise<void> {
    const instance = this.instances.get(serviceId);
    if (!instance) {
      throw new Error(`Instance ${serviceId} not found`);
    }

    instance.state = state;
    instance.metadata.lastStateChange = new Date().toISOString();

    this.logger.debug(`Instance state updated: ${serviceId} -> ${state}`);
  }

  async incrementErrorCount(serviceId: string): Promise<void> {
    const instance = this.instances.get(serviceId);
    if (instance) {
      instance.errorCount++;
      instance.metadata.lastError = new Date().toISOString();
    }
  }

  async resetErrorCount(serviceId: string): Promise<void> {
    const instance = this.instances.get(serviceId);
    if (instance) {
      instance.errorCount = 0;
      delete instance.metadata.lastError;
    }
  }

  async getInstancesByTemplate(templateName: string): Promise<ServiceInstance[]> {
    return Array.from(this.instances.values()).filter(
      instance => instance.config.name === templateName
    );
  }

  async getInstancesByState(state: ServiceInstance['state']): Promise<ServiceInstance[]> {
    return Array.from(this.instances.values()).filter(
      instance => instance.state === state
    );
  }

  async setMetadata(serviceId: string, key: string, value: any): Promise<void> {
    const instance = this.instances.get(serviceId);
    if (!instance) {
      throw new Error(`Instance ${serviceId} not found`);
    }

    instance.metadata[key] = value;
    this.logger.debug(`Metadata set for ${serviceId}: ${key} = ${value}`);
  }

  async getMetadata(serviceId: string, key: string): Promise<any> {
    const instance = this.instances.get(serviceId);
    return instance?.metadata[key];
  }

  private generateInstanceId(templateName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${templateName}-${timestamp}-${random}`;
  }

  // Statistics and monitoring
  async getInstanceStats(): Promise<{
    total: number;
    byState: Record<string, number>;
    byTemplate: Record<string, number>;
    avgErrorCount: number;
  }> {
    const instances = Array.from(this.instances.values());
    const total = instances.length;
    
    const byState: Record<string, number> = {};
    const byTemplate: Record<string, number> = {};
    let totalErrors = 0;

    for (const instance of instances) {
      // Count by state
      byState[instance.state] = (byState[instance.state] || 0) + 1;
      
      // Count by template
      byTemplate[instance.config.name] = (byTemplate[instance.config.name] || 0) + 1;
      
      // Sum errors
      totalErrors += instance.errorCount;
    }

    return {
      total,
      byState,
      byTemplate,
      avgErrorCount: total > 0 ? totalErrors / total : 0
    };
  }
}
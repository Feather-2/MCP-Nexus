import { randomUUID } from 'crypto';
import type { ServiceInstance } from '../types/index.js';
import type { ServiceStateManager, ServiceTemplate } from './service-state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ServiceRegistry {
  constructor(private stateManager: ServiceStateManager) {}

  registerTemplate(template: ServiceTemplate): void {
    this.stateManager.setTemplate(template);
  }

  unregisterTemplate(templateId: string): void {
    this.stateManager.removeTemplate(templateId);
  }

  createInstance(templateId: string, config?: Partial<ServiceInstance>): ServiceInstance {
    const template = this.stateManager.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    const overrideConfig = isRecord(config) && 'config' in config && isRecord(config.config)
      ? (config.config as Partial<ServiceTemplate>)
      : undefined;
    const mergedTemplate: ServiceTemplate = overrideConfig ? { ...template, ...overrideConfig } : template;

    const now = new Date();
    const instanceId = config?.id ?? `${templateId}-${randomUUID()}`;
    const metadataValue = config?.metadata;

    const baseInstance: ServiceInstance = {
      id: instanceId,
      config: mergedTemplate,
      state: config?.state ?? 'idle',
      pid: config?.pid,
      startTime: config?.startTime ?? now,
      startedAt: config?.startedAt ?? now,
      lastHealthCheck: config?.lastHealthCheck,
      errorCount: config?.errorCount ?? 0,
      metadata: isRecord(metadataValue) ? metadataValue : {}
    };

    this.stateManager.setInstance(baseInstance);
    return baseInstance;
  }

  removeInstance(instanceId: string): void {
    this.stateManager.removeInstance(instanceId);
  }

  getTemplate(id: string): ServiceTemplate | undefined {
    return this.stateManager.getTemplate(id);
  }

  getInstance(id: string): ServiceInstance | undefined {
    return this.stateManager.getInstance(id);
  }

  listTemplates(): ServiceTemplate[] {
    return this.stateManager.listTemplates();
  }

  listInstances(templateId?: string): ServiceInstance[] {
    return this.stateManager.listInstances(templateId);
  }
}

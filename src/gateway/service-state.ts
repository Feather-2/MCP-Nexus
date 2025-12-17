import type { HealthCheckResult, LoadBalancerMetrics, McpServiceConfig, ServiceInstance } from '../types/index.js';

export type ServiceTemplate = McpServiceConfig;
export type HealthStatus = HealthCheckResult;
export type ServiceMetrics = LoadBalancerMetrics;

export interface ServiceState {
  templates: Map<string, ServiceTemplate>;
  instances: Map<string, ServiceInstance>;
  healthCache: Map<string, HealthStatus>;
  metrics: Map<string, ServiceMetrics>;
}

export class ServiceStateManager {
  private state: ServiceState;

  constructor(initial?: Partial<ServiceState>) {
    this.state = {
      templates: initial?.templates ?? new Map<string, ServiceTemplate>(),
      instances: initial?.instances ?? new Map<string, ServiceInstance>(),
      healthCache: initial?.healthCache ?? new Map<string, HealthStatus>(),
      metrics: initial?.metrics ?? new Map<string, ServiceMetrics>()
    };
  }

  getTemplate(id: string): ServiceTemplate | undefined {
    return this.state.templates.get(id);
  }

  getInstance(id: string): ServiceInstance | undefined {
    return this.state.instances.get(id);
  }

  getHealth(instanceId: string): HealthStatus | undefined {
    return this.state.healthCache.get(instanceId);
  }

  getMetrics(instanceId: string): ServiceMetrics | undefined {
    return this.state.metrics.get(instanceId);
  }

  setTemplate(template: ServiceTemplate): void {
    this.state.templates.set(template.name, template);
  }

  setInstance(instance: ServiceInstance): void {
    this.state.instances.set(instance.id, instance);
  }

  updateHealth(instanceId: string, status: HealthStatus): void {
    this.state.healthCache.set(instanceId, status);
  }

  updateMetrics(instanceId: string, metrics: ServiceMetrics): void {
    this.state.metrics.set(instanceId, metrics);
  }

  listTemplates(): ServiceTemplate[] {
    return Array.from(this.state.templates.values());
  }

  listInstances(templateId?: string): ServiceInstance[] {
    const instances = Array.from(this.state.instances.values());
    if (!templateId) return instances;
    return instances.filter((instance) => instance.config.name === templateId);
  }

  removeTemplate(templateId: string): void {
    this.state.templates.delete(templateId);
  }

  removeInstance(instanceId: string): void {
    this.state.instances.delete(instanceId);
    this.state.healthCache.delete(instanceId);
    this.state.metrics.delete(instanceId);
  }
}


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

export type ServiceObservationEvent =
  | { type: 'template:set'; templateId: string; template: ServiceTemplate }
  | { type: 'template:remove'; templateId: string }
  | { type: 'instance:set'; instanceId: string; instance: ServiceInstance }
  | { type: 'instance:remove'; instanceId: string }
  | { type: 'health:update'; instanceId: string; status: HealthStatus }
  | { type: 'health:remove'; instanceId: string }
  | { type: 'metrics:update'; instanceId: string; metrics: ServiceMetrics }
  | { type: 'metrics:remove'; instanceId: string };

export type ServiceObservationSubscriber = (event: ServiceObservationEvent) => void;

export interface ServiceObservationTransaction {
  getTemplate(id: string): ServiceTemplate | undefined;
  setTemplate(template: ServiceTemplate): void;
  removeTemplate(templateId: string): void;

  getInstance(id: string): ServiceInstance | undefined;
  setInstance(instance: ServiceInstance): void;
  patchInstance(instanceId: string, patch: Partial<ServiceInstance>): ServiceInstance | undefined;
  removeInstance(instanceId: string): void;

  getHealth(instanceId: string): HealthStatus | undefined;
  setHealth(instanceId: string, status: HealthStatus): void;
  removeHealth(instanceId: string): void;

  getMetrics(instanceId: string): ServiceMetrics | undefined;
  setMetrics(instanceId: string, metrics: ServiceMetrics): void;
  removeMetrics(instanceId: string): void;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as any)?.then === 'function';
}

function cloneState(state: ServiceState): ServiceState {
  return {
    templates: new Map(state.templates),
    instances: new Map(state.instances),
    healthCache: new Map(state.healthCache),
    metrics: new Map(state.metrics)
  };
}

/**
 * Single source of truth for service observations (templates/instances/health/metrics).
 *
 * - Supports atomic updates (batched mutations + ordered event emission after commit)
 * - Provides subscriptions for reactive components
 */
export class ServiceObservationStore {
  private state: ServiceState;
  private subscribers = new Set<ServiceObservationSubscriber>();

  private txDepth = 0;
  private pendingEvents: ServiceObservationEvent[] = [];
  private revision = 0;

  private readonly txApi: ServiceObservationTransaction;

  constructor(initial?: Partial<ServiceState>) {
    this.state = {
      templates: initial?.templates ?? new Map<string, ServiceTemplate>(),
      instances: initial?.instances ?? new Map<string, ServiceInstance>(),
      healthCache: initial?.healthCache ?? new Map<string, HealthStatus>(),
      metrics: initial?.metrics ?? new Map<string, ServiceMetrics>()
    };

    this.txApi = {
      getTemplate: (id) => this.state.templates.get(id),
      setTemplate: (template) => this.applySetTemplate(template),
      removeTemplate: (templateId) => this.applyRemoveTemplate(templateId),

      getInstance: (id) => this.state.instances.get(id),
      setInstance: (instance) => this.applySetInstance(instance),
      patchInstance: (instanceId, patch) => this.applyPatchInstance(instanceId, patch),
      removeInstance: (instanceId) => this.applyRemoveInstance(instanceId),

      getHealth: (instanceId) => this.state.healthCache.get(instanceId),
      setHealth: (instanceId, status) => this.applySetHealth(instanceId, status),
      removeHealth: (instanceId) => this.applyRemoveHealth(instanceId),

      getMetrics: (instanceId) => this.state.metrics.get(instanceId),
      setMetrics: (instanceId, metrics) => this.applySetMetrics(instanceId, metrics),
      removeMetrics: (instanceId) => this.applyRemoveMetrics(instanceId)
    };
  }

  getRevision(): number {
    return this.revision;
  }

  subscribe(subscriber: ServiceObservationSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Apply multiple updates atomically.
   *
   * The callback must be synchronous: returning a Promise will throw (and rollback).
   */
  atomicUpdate(fn: (tx: ServiceObservationTransaction) => void): void {
    const outermost = this.txDepth === 0;
    const rollback = outermost ? cloneState(this.state) : undefined;

    this.txDepth += 1;
    try {
      const result = fn(this.txApi);
      if (isPromiseLike(result)) {
        throw new Error('ServiceObservationStore.atomicUpdate() callback must be synchronous');
      }
    } catch (err) {
      if (outermost && rollback) {
        this.state = rollback;
        this.pendingEvents = [];
      }
      throw err;
    } finally {
      this.txDepth -= 1;
      if (outermost && this.txDepth === 0) {
        const events = this.pendingEvents;
        this.pendingEvents = [];
        if (events.length > 0) {
          this.revision += 1;
          this.emit(events);
        }
      }
    }
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
    this.atomicUpdate((tx) => {
      tx.setTemplate(template);
    });
  }

  setInstance(instance: ServiceInstance): void {
    this.atomicUpdate((tx) => {
      tx.setInstance(instance);
    });
  }

  patchInstance(instanceId: string, patch: Partial<ServiceInstance>): ServiceInstance | undefined {
    let result: ServiceInstance | undefined;
    this.atomicUpdate((tx) => {
      result = tx.patchInstance(instanceId, patch);
    });
    return result;
  }

  updateHealth(instanceId: string, status: HealthStatus): void {
    this.atomicUpdate((tx) => {
      tx.setHealth(instanceId, status);
    });
  }

  removeHealth(instanceId: string): void {
    this.atomicUpdate((tx) => {
      tx.removeHealth(instanceId);
    });
  }

  updateMetrics(instanceId: string, metrics: ServiceMetrics): void {
    this.atomicUpdate((tx) => {
      tx.setMetrics(instanceId, metrics);
    });
  }

  removeMetrics(instanceId: string): void {
    this.atomicUpdate((tx) => {
      tx.removeMetrics(instanceId);
    });
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
    this.atomicUpdate((tx) => {
      tx.removeTemplate(templateId);
    });
  }

  removeInstance(instanceId: string): void {
    this.atomicUpdate((tx) => {
      tx.removeInstance(instanceId);
    });
  }

  private record(event: ServiceObservationEvent): void {
    this.pendingEvents.push(event);
  }

  private emit(events: ServiceObservationEvent[]): void {
    if (this.subscribers.size === 0) return;

    for (const event of events) {
      const listeners = Array.from(this.subscribers);
      for (const listener of listeners) {
        if (!this.subscribers.has(listener)) continue;
        try {
          listener(event);
        } catch {
          // Isolate store from subscriber failures.
        }
      }
    }
  }

  private applySetTemplate(template: ServiceTemplate): void {
    this.state.templates.set(template.name, template);
    this.record({ type: 'template:set', templateId: template.name, template });
  }

  private applyRemoveTemplate(templateId: string): void {
    const existed = this.state.templates.delete(templateId);
    if (existed) {
      this.record({ type: 'template:remove', templateId });
    }
  }

  private applySetInstance(instance: ServiceInstance): void {
    this.state.instances.set(instance.id, instance);
    this.record({ type: 'instance:set', instanceId: instance.id, instance });
  }

  private applyPatchInstance(instanceId: string, patch: Partial<ServiceInstance>): ServiceInstance | undefined {
    const existing = this.state.instances.get(instanceId);
    if (!existing) return undefined;

    const next: ServiceInstance = {
      ...existing,
      ...patch,
      metadata: patch.metadata ? { ...existing.metadata, ...patch.metadata } : existing.metadata
    };

    this.state.instances.set(instanceId, next);
    this.record({ type: 'instance:set', instanceId, instance: next });
    return next;
  }

  private applyRemoveInstance(instanceId: string): void {
    const existed = this.state.instances.delete(instanceId);
    if (existed) {
      this.record({ type: 'instance:remove', instanceId });
    }

    const hadHealth = this.state.healthCache.delete(instanceId);
    if (hadHealth) {
      this.record({ type: 'health:remove', instanceId });
    }

    const hadMetrics = this.state.metrics.delete(instanceId);
    if (hadMetrics) {
      this.record({ type: 'metrics:remove', instanceId });
    }
  }

  private applySetHealth(instanceId: string, status: HealthStatus): void {
    this.state.healthCache.set(instanceId, status);
    this.record({ type: 'health:update', instanceId, status });
  }

  private applyRemoveHealth(instanceId: string): void {
    const existed = this.state.healthCache.delete(instanceId);
    if (existed) {
      this.record({ type: 'health:remove', instanceId });
    }
  }

  private applySetMetrics(instanceId: string, metrics: ServiceMetrics): void {
    this.state.metrics.set(instanceId, metrics);
    this.record({ type: 'metrics:update', instanceId, metrics });
  }

  private applyRemoveMetrics(instanceId: string): void {
    const existed = this.state.metrics.delete(instanceId);
    if (existed) {
      this.record({ type: 'metrics:remove', instanceId });
    }
  }
}

/**
 * Backward compatible name. Prefer `ServiceObservationStore`.
 */
export class ServiceStateManager extends ServiceObservationStore {}

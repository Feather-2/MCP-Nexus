import type { Context, Middleware, State } from '../middleware/types.js';
import type { ServiceInstance } from '../types/index.js';
import type { ServiceMetrics, ServiceStateManager } from './service-state.js';
import { HEALTH_VIEW_STATE_KEY } from './health-check.middleware.js';

export const SELECTED_INSTANCE_STATE_KEY = 'selectedInstance';
export const SELECTED_INSTANCE_ID_STATE_KEY = 'selectedInstanceId';
export const TOOL_LATENCY_MS_STATE_KEY = 'toolLatencyMs';
export const TOOL_SUCCESS_STATE_KEY = 'toolSuccess';
export const TOOL_ERROR_STATE_KEY = 'toolError';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveTemplateId(ctx: Context, state: State): string | undefined {
  const fromCtx = ctx.metadata.templateId;
  if (typeof fromCtx === 'string') return fromCtx;
  const fromState = state.values.get('templateId');
  return typeof fromState === 'string' ? fromState : undefined;
}

function resolveCandidatesFromState(state: State): ServiceInstance[] | undefined {
  const value = state.values.get('instances');
  if (!Array.isArray(value)) return undefined;
  if (
    value.every(
      (v) =>
        isRecord(v) &&
        typeof v.id === 'string' &&
        isRecord(v.config) &&
        typeof v.config.name === 'string'
    )
  ) {
    return value as ServiceInstance[];
  }
  return undefined;
}

function resolveHealthView(state: State): Map<string, { healthy: boolean }> | undefined {
  const value = state.values.get(HEALTH_VIEW_STATE_KEY);
  if (!(value instanceof Map)) return undefined;
  const entries = Array.from(value.entries());
  if (entries.every(([k, v]) => typeof k === 'string' && isRecord(v) && typeof v.healthy === 'boolean')) {
    return value as Map<string, { healthy: boolean }>;
  }
  return undefined;
}

function readWeight(instance: ServiceInstance): number {
  const candidate = (instance.metadata as Record<string, unknown>)?.weight;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate;
  return 1;
}

function pickWeighted(instances: readonly ServiceInstance[]): ServiceInstance {
  const weights = instances.map(readWeight);
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!Number.isFinite(total) || total <= 0) return instances[0];

  const r = Math.random() * total;
  let acc = 0;
  for (let i = 0; i < instances.length; i++) {
    acc += weights[i];
    if (r < acc) return instances[i];
  }
  return instances[instances.length - 1];
}

function resolveSelectedInstanceId(state: State): string | undefined {
  const direct = state.values.get(SELECTED_INSTANCE_ID_STATE_KEY);
  if (typeof direct === 'string') return direct;
  const selected = state.values.get(SELECTED_INSTANCE_STATE_KEY);
  if (isRecord(selected) && typeof selected.id === 'string') return selected.id;
  return undefined;
}

function readLatencyMs(state: State): number | undefined {
  const direct = state.values.get(TOOL_LATENCY_MS_STATE_KEY);
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;

  const start = state.values.get('toolStartTimeMs');
  const end = state.values.get('toolEndTimeMs');
  if (typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return end - start;
  }

  return undefined;
}

function readSuccess(state: State): boolean {
  const explicit = state.values.get(TOOL_SUCCESS_STATE_KEY);
  if (typeof explicit === 'boolean') return explicit;
  const toolError = state.values.get(TOOL_ERROR_STATE_KEY);
  if (toolError instanceof Error) return false;
  if (typeof toolError === 'string' && toolError.trim()) return false;
  if (state.error) return false;
  return true;
}

function updateMetrics(existing: ServiceMetrics | undefined, instanceId: string, latencyMs: number | undefined, success: boolean): ServiceMetrics {
  const prevCount = existing?.requestCount ?? 0;
  const nextCount = prevCount + 1;

  const prevErr = existing?.errorCount ?? 0;
  const nextErr = prevErr + (success ? 0 : 1);

  const prevAvg = existing?.avgResponseTime ?? 0;
  const nextAvg = latencyMs === undefined ? prevAvg : (prevAvg * prevCount + latencyMs) / nextCount;

  return {
    serviceId: instanceId,
    requestCount: nextCount,
    errorCount: nextErr,
    avgResponseTime: nextAvg,
    lastRequestTime: new Date()
  };
}

export class LoadBalancerMiddleware implements Middleware {
  name = 'load-balancer';
  private rrCursorByKey = new Map<string, number>();

  constructor(
    private stateManager: ServiceStateManager,
    private options?: { strategy?: 'round-robin' | 'least-conn' | 'weighted' }
  ) {}

  async beforeModel(ctx: Context, state: State): Promise<void> {
    const templateId = resolveTemplateId(ctx, state);
    const candidates = resolveCandidatesFromState(state) ?? this.stateManager.listInstances(templateId);

    if (candidates.length === 0) return;

    const healthView = resolveHealthView(state);
    const healthy = candidates.filter((i) => {
      const status = healthView?.get(i.id) ?? this.stateManager.getHealth(i.id);
      return status?.healthy === true;
    });
    const pool = healthy.length > 0 ? healthy : candidates;

    const strategy = this.options?.strategy ?? 'round-robin';
    let selected: ServiceInstance;

    if (strategy === 'least-conn') {
      selected = pool.reduce((best, candidate) => {
        const bestCount = this.stateManager.getMetrics(best.id)?.requestCount ?? 0;
        const candCount = this.stateManager.getMetrics(candidate.id)?.requestCount ?? 0;
        if (candCount !== bestCount) return candCount < bestCount ? candidate : best;
        return candidate.id < best.id ? candidate : best;
      }, pool[0]);
    } else if (strategy === 'weighted') {
      selected = pickWeighted(pool);
    } else {
      const key = templateId ?? '*';
      const cursor = this.rrCursorByKey.get(key) ?? 0;
      selected = pool[cursor % pool.length];
      this.rrCursorByKey.set(key, cursor + 1);
    }

    state.values.set(SELECTED_INSTANCE_STATE_KEY, selected);
    state.values.set(SELECTED_INSTANCE_ID_STATE_KEY, selected.id);
  }

  async afterTool(_ctx: Context, state: State): Promise<void> {
    const instanceId = resolveSelectedInstanceId(state);
    if (!instanceId) return;

    const latencyMs = readLatencyMs(state);
    const success = readSuccess(state);

    const existing = this.stateManager.getMetrics(instanceId);
    const next = updateMetrics(existing, instanceId, latencyMs, success);
    this.stateManager.updateMetrics(instanceId, next);
  }
}


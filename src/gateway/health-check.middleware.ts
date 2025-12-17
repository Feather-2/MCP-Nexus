import type { Context, Middleware, State } from '../middleware/types.js';
import type { HealthStatus, ServiceStateManager } from './service-state.js';

export const HEALTH_PROBE_CTX_KEY = 'healthProbe';
export const HEALTH_VIEW_STATE_KEY = 'healthView';
export const HEALTH_PROBE_RESULT_STATE_KEY = 'healthProbeResult';

export interface HealthProbeResult {
  instanceId: string;
  status: HealthStatus;
}

type HealthProbe = (instanceId: string) => Promise<HealthStatus>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHealthProbe(value: unknown): value is HealthProbe {
  return typeof value === 'function';
}

function isHealthStatus(value: unknown): value is HealthStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.healthy === 'boolean' &&
    value.timestamp instanceof Date &&
    (value.latency === undefined || typeof value.latency === 'number') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isHealthProbeResult(value: unknown): value is HealthProbeResult {
  if (!isRecord(value)) return false;
  return typeof value.instanceId === 'string' && isHealthStatus(value.status);
}

function resolveTemplateId(ctx: Context, state: State): string | undefined {
  const fromCtx = ctx.metadata.templateId;
  if (typeof fromCtx === 'string') return fromCtx;
  const fromState = state.values.get('templateId');
  return typeof fromState === 'string' ? fromState : undefined;
}

function resolveInstancesFromState(state: State): Array<{ id: string }> | undefined {
  const value = state.values.get('instances');
  if (!Array.isArray(value)) return undefined;
  if (value.every((v) => isRecord(v) && typeof v.id === 'string')) {
    return value as Array<{ id: string }>;
  }
  return undefined;
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const limit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : items.length;
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await fn(current);
    }
  });

  await Promise.all(workers);
}

export class HealthCheckMiddleware implements Middleware {
  name = 'health-check';

  constructor(
    private stateManager: ServiceStateManager,
    private options?: { ttl?: number; concurrency?: number }
  ) {}

  async beforeModel(ctx: Context, state: State): Promise<void> {
    const probeCandidate = ctx.metadata[HEALTH_PROBE_CTX_KEY];
    const probe: HealthProbe | undefined = isHealthProbe(probeCandidate) ? probeCandidate : undefined;

    const templateId = resolveTemplateId(ctx, state);
    const candidatesFromState = resolveInstancesFromState(state);
    const candidates = candidatesFromState
      ? candidatesFromState
      : this.stateManager.listInstances(templateId);

    const ttlMs = this.options?.ttl ?? 5000;
    const nowMs = Date.now();

    const idsToRefresh: string[] = [];
    for (const instance of candidates) {
      const cached = this.stateManager.getHealth(instance.id);
      const ts = cached?.timestamp instanceof Date ? cached.timestamp.getTime() : 0;
      const ageMs = nowMs - ts;
      const shouldRefresh = !cached || !Number.isFinite(ttlMs) || ttlMs <= 0 || ageMs > ttlMs;
      if (shouldRefresh) idsToRefresh.push(instance.id);
    }

    if (probe && idsToRefresh.length > 0) {
      await forEachWithConcurrency(idsToRefresh, this.options?.concurrency ?? 4, async (instanceId) => {
        const status = await probe(instanceId);
        this.stateManager.updateHealth(instanceId, status);
      });
    }

    const healthView = new Map<string, HealthStatus>();
    for (const instance of candidates) {
      const status = this.stateManager.getHealth(instance.id);
      if (status) healthView.set(instance.id, status);
    }
    state.values.set(HEALTH_VIEW_STATE_KEY, healthView);
  }

  async afterTool(_ctx: Context, state: State): Promise<void> {
    const value = state.values.get(HEALTH_PROBE_RESULT_STATE_KEY);
    if (!isHealthProbeResult(value)) return;
    this.stateManager.updateHealth(value.instanceId, value.status);
  }
}

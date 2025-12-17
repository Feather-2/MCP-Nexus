import type { ChannelState } from './types.js';

export type LoadBalanceStrategy =
  | 'round-robin'
  | 'least-latency'
  | 'weighted'
  | 'failover';

export interface ChannelMetrics {
  channelId: string;
  avgLatencyMs: number;
  errorRate: number;
  consecutiveFailures: number;
  lastRequestAt?: Date;
  lastFailureAt?: Date;
  cooldownUntil?: Date;
  healthy: boolean;
}

type InternalMetrics = {
  channelId: string;
  avgLatencyMs: number;
  totalRequests: number;
  totalErrors: number;
  consecutiveFailures: number;
  lastRequestAt?: Date;
  lastFailureAt?: Date;
  cooldownUntil?: Date;
  healthy: boolean;
};

type LoadBalancerConfig = {
  strategy: LoadBalanceStrategy;
  healthThreshold: number;
  cooldownMs: number;
  latencyWindowSize: number;
};

type WeightedChannelState = ChannelState & { weight?: number };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampMinInt(value: number, min: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.floor(value));
}

function toAlpha(windowSize: number): number {
  const w = clampMinInt(windowSize, 1);
  return 2 / (w + 1);
}

function cloneDate(d?: Date): Date | undefined {
  return d ? new Date(d.getTime()) : undefined;
}

export class LoadBalancer {
  private readonly config: LoadBalancerConfig;
  private readonly metrics = new Map<string, InternalMetrics>();
  private roundRobinIndex = 0;

  constructor(config?: {
    strategy?: LoadBalanceStrategy;
    healthThreshold?: number;
    cooldownMs?: number;
    latencyWindowSize?: number;
  }) {
    this.config = {
      strategy: config?.strategy ?? 'round-robin',
      healthThreshold: isFiniteNumber(config?.healthThreshold) ? config.healthThreshold : 0.5,
      cooldownMs: isFiniteNumber(config?.cooldownMs) ? config.cooldownMs : 30_000,
      latencyWindowSize: clampMinInt(config?.latencyWindowSize ?? 10, 1)
    };
  }

  select(candidates: ChannelState[]): string | undefined {
    if (candidates.length === 0) return undefined;

    const now = new Date();
    const eligible = candidates.filter((c) => this.isCandidateEligible(c, now));
    if (eligible.length === 0) return undefined;

    switch (this.config.strategy) {
      case 'round-robin': {
        const idx = this.roundRobinIndex % eligible.length;
        const picked = eligible[idx];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % eligible.length;
        return picked.channelId;
      }
      case 'least-latency': {
        let best = eligible[0];
        let bestLatency = this.getLatencyForSelection(best);
        for (let i = 1; i < eligible.length; i += 1) {
          const cand = eligible[i];
          const l = this.getLatencyForSelection(cand);
          if (l < bestLatency) {
            best = cand;
            bestLatency = l;
          }
        }
        return best.channelId;
      }
      case 'weighted': {
        const weighted = eligible
          .map((c) => {
            const w = this.getWeight(c);
            return { channelId: c.channelId, weight: w };
          })
          .filter((x) => x.weight > 0);

        if (weighted.length === 0) return undefined;

        const total = weighted.reduce((sum, it) => sum + it.weight, 0);

        const r = Math.random() * total;
        let acc = 0;
        for (const it of weighted) {
          acc += it.weight;
          if (r < acc) return it.channelId;
        }
        return weighted[weighted.length - 1].channelId;
      }
      case 'failover': {
        return eligible[0].channelId;
      }
      /* c8 ignore next 4 */
      default: {
        const _exhaustive: never = this.config.strategy;
        return _exhaustive;
      }
    }
  }

  report(channelId: string, latencyMs: number, success: boolean): void {
    const now = new Date();
    const m = this.getOrCreate(channelId);
    this.refreshMetrics(m, now);

    const latency = isFiniteNumber(latencyMs) && latencyMs >= 0 ? latencyMs : 0;
    const alpha = toAlpha(this.config.latencyWindowSize);
    if (m.totalRequests === 0) {
      m.avgLatencyMs = latency;
    } else {
      m.avgLatencyMs = alpha * latency + (1 - alpha) * m.avgLatencyMs;
    }

    m.totalRequests += 1;
    m.lastRequestAt = now;

    if (success) {
      m.consecutiveFailures = 0;
      if (!m.cooldownUntil) m.healthy = true;
      return;
    }

    m.totalErrors += 1;
    m.consecutiveFailures += 1;
    m.lastFailureAt = now;

    const errorRate = this.computeErrorRate(m);
    if (errorRate > this.config.healthThreshold || m.consecutiveFailures >= 3) {
      this.markUnhealthy(channelId);
    }
  }

  getMetrics(channelId: string): ChannelMetrics | undefined {
    const m = this.metrics.get(channelId);
    if (!m) return undefined;
    this.refreshMetrics(m, new Date());
    return this.toPublicMetrics(m);
  }

  getAllMetrics(): ChannelMetrics[] {
    const now = new Date();
    const out: ChannelMetrics[] = [];
    for (const m of this.metrics.values()) {
      this.refreshMetrics(m, now);
      out.push(this.toPublicMetrics(m));
    }
    out.sort((a, b) => a.channelId.localeCompare(b.channelId));
    return out;
  }

  markUnhealthy(channelId: string, cooldownMs?: number): void {
    const now = new Date();
    const m = this.getOrCreate(channelId);

    const ms = isFiniteNumber(cooldownMs) ? cooldownMs : this.config.cooldownMs;
    const until = new Date(now.getTime() + Math.max(0, ms));
    if (!m.cooldownUntil || until.getTime() > m.cooldownUntil.getTime()) {
      m.cooldownUntil = until;
    }

    m.healthy = false;
    m.lastFailureAt = m.lastFailureAt ?? now;
  }

  markHealthy(channelId: string): void {
    const m = this.getOrCreate(channelId);
    m.cooldownUntil = undefined;
    m.healthy = true;
    m.consecutiveFailures = 0;
    m.totalRequests = 0;
    m.totalErrors = 0;
  }

  reset(): void {
    this.metrics.clear();
    this.roundRobinIndex = 0;
  }

  private getOrCreate(channelId: string): InternalMetrics {
    const existing = this.metrics.get(channelId);
    if (existing) return existing;

    const created: InternalMetrics = {
      channelId,
      avgLatencyMs: 0,
      totalRequests: 0,
      totalErrors: 0,
      consecutiveFailures: 0,
      lastRequestAt: undefined,
      lastFailureAt: undefined,
      cooldownUntil: undefined,
      healthy: true
    };
    this.metrics.set(channelId, created);
    return created;
  }

  private refreshMetrics(m: InternalMetrics, now: Date): void {
    if (m.cooldownUntil && now.getTime() >= m.cooldownUntil.getTime()) {
      m.cooldownUntil = undefined;
      m.healthy = true;
      m.consecutiveFailures = 0;
      m.totalRequests = 0;
      m.totalErrors = 0;
    }

    if (m.cooldownUntil && now.getTime() < m.cooldownUntil.getTime()) {
      m.healthy = false;
      return;
    }

    const errorRate = this.computeErrorRate(m);
    if (errorRate > this.config.healthThreshold || m.consecutiveFailures >= 3) {
      m.healthy = false;
    } else {
      m.healthy = true;
    }
  }

  private computeErrorRate(m: InternalMetrics): number {
    if (m.totalRequests <= 0) return 0;
    const rate = m.totalErrors / m.totalRequests;
    if (!Number.isFinite(rate)) return 0;
    return Math.min(1, Math.max(0, rate));
  }

  private isCandidateEligible(candidate: ChannelState, now: Date): boolean {
    if (!candidate.enabled) return false;
    if (candidate.cooldownUntil && now.getTime() < candidate.cooldownUntil.getTime()) return false;

    const m = this.getOrCreate(candidate.channelId);
    this.refreshMetrics(m, now);
    return m.healthy;
  }

  private getLatencyForSelection(candidate: ChannelState): number {
    const m = this.metrics.get(candidate.channelId);
    if (m && m.avgLatencyMs > 0) return m.avgLatencyMs;
    if (candidate.metrics.avgLatencyMs > 0) return candidate.metrics.avgLatencyMs;
    return Number.POSITIVE_INFINITY;
  }

  private getWeight(candidate: ChannelState): number {
    const w = (candidate as WeightedChannelState).weight;
    if (!isFiniteNumber(w)) return 1;
    return w;
  }

  private toPublicMetrics(m: InternalMetrics): ChannelMetrics {
    const errorRate = this.computeErrorRate(m);
    return {
      channelId: m.channelId,
      avgLatencyMs: m.avgLatencyMs,
      errorRate,
      consecutiveFailures: m.consecutiveFailures,
      lastRequestAt: cloneDate(m.lastRequestAt),
      lastFailureAt: cloneDate(m.lastFailureAt),
      cooldownUntil: cloneDate(m.cooldownUntil),
      healthy: m.healthy
    };
  }
}

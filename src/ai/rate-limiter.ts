import type { RateLimitConfig } from './types.js';

type StoredQueue = Readonly<{
  config: RateLimitConfig;
  timestamps: number[];
}>;

function makeStoreKey(subject: string, config: RateLimitConfig): string {
  return `${subject}::${config.windowMs}::${config.limit}`;
}

function normalizeCost(cost?: number): number {
  if (cost === undefined) return 1;
  if (!Number.isFinite(cost)) {
    throw new Error('SlidingWindowRateLimiter: cost must be a finite number');
  }
  if (cost <= 0) return 0;
  if (!Number.isSafeInteger(cost)) {
    throw new Error('SlidingWindowRateLimiter: cost must be a safe integer');
  }
  return cost;
}

export class SlidingWindowRateLimiter {
  private readonly store = new Map<string, StoredQueue>();
  private readonly cleanupIntervalMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: { cleanupIntervalMs?: number }) {
    const cleanupIntervalMs = config?.cleanupIntervalMs ?? 60_000;
    this.cleanupIntervalMs = cleanupIntervalMs;

    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
      (this.cleanupTimer as any).unref?.();
    }
  }

  private prune(entry: StoredQueue, now: number): void {
    const { windowMs } = entry.config;
    if (windowMs <= 0) {
      entry.timestamps.length = 0;
      return;
    }

    const cutoff = now - windowMs;
    const timestamps = entry.timestamps;

    let firstValidIndex = 0;
    while (firstValidIndex < timestamps.length && timestamps[firstValidIndex] <= cutoff) {
      firstValidIndex += 1;
    }
    if (firstValidIndex > 0) {
      timestamps.splice(0, firstValidIndex);
    }
  }

  private getOrCreateQueue(subject: string, config: RateLimitConfig): StoredQueue {
    const key = makeStoreKey(subject, config);
    const existing = this.store.get(key);
    if (existing) return existing;

    const created: StoredQueue = { config: { ...config }, timestamps: [] };
    this.store.set(key, created);
    return created;
  }

  consume(subject: string, config: RateLimitConfig, cost?: number): boolean {
    const costUnits = normalizeCost(cost);
    if (costUnits === 0) return true;

    const { limit, windowMs } = config;
    if (!Number.isFinite(limit) || !Number.isFinite(windowMs)) {
      throw new Error('SlidingWindowRateLimiter: config.limit and config.windowMs must be finite numbers');
    }
    if (limit <= 0) return false;
    if (windowMs <= 0) return true;
    if (costUnits > limit) return false;

    const now = Date.now();
    const entry = this.getOrCreateQueue(subject, config);
    this.prune(entry, now);

    if (entry.timestamps.length + costUnits > limit) {
      if (entry.timestamps.length === 0) {
        this.store.delete(makeStoreKey(subject, config));
      }
      return false;
    }

    for (let i = 0; i < costUnits; i += 1) {
      entry.timestamps.push(now);
    }
    return true;
  }

  remaining(subject: string, config: RateLimitConfig): number {
    const { limit, windowMs } = config;
    if (!Number.isFinite(limit) || !Number.isFinite(windowMs)) {
      throw new Error('SlidingWindowRateLimiter: config.limit and config.windowMs must be finite numbers');
    }
    if (limit <= 0) return 0;
    if (windowMs <= 0) return limit;

    const key = makeStoreKey(subject, config);
    const entry = this.store.get(key);
    if (!entry) return limit;

    const now = Date.now();
    this.prune(entry, now);
    if (entry.timestamps.length === 0) {
      this.store.delete(key);
      return limit;
    }

    return Math.max(0, limit - entry.timestamps.length);
  }

  resetIn(subject: string, config: RateLimitConfig): number {
    const { limit, windowMs } = config;
    if (!Number.isFinite(limit) || !Number.isFinite(windowMs)) {
      throw new Error('SlidingWindowRateLimiter: config.limit and config.windowMs must be finite numbers');
    }
    if (limit <= 0) return 0;
    if (windowMs <= 0) return 0;

    const key = makeStoreKey(subject, config);
    const entry = this.store.get(key);
    if (!entry) return 0;

    const now = Date.now();
    this.prune(entry, now);
    if (entry.timestamps.length === 0) {
      this.store.delete(key);
      return 0;
    }

    const oldest = entry.timestamps[0];
    return Math.max(0, oldest + windowMs - now);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      this.prune(entry, now);
      if (entry.timestamps.length === 0) {
        this.store.delete(key);
      }
    }
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}


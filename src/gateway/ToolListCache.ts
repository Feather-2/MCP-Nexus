import type { Logger, Disposable } from '../types/index.js';
import { unrefTimer } from '../utils/async.js';

export interface ToolListCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  cleanupIntervalMs?: number;
}

export interface CachedToolList {
  tools: unknown[];
  cachedAt: number;
}

export class ToolListCache implements Disposable {
  private cache: Map<string, CachedToolList>;
  private ttlMs: number;
  private maxEntries: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private logger: Logger;
  private hits = 0;
  private misses = 0;

  constructor(logger: Logger, opts: ToolListCacheOptions = {}) {
    this.cache = new Map();
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.maxEntries = opts.maxEntries ?? 200;
    this.logger = logger;

    const cleanupIntervalMs = opts.cleanupIntervalMs ?? 60_000;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    unrefTimer(this.cleanupTimer);
  }

  get(serviceKey: string): unknown[] | null {
    const entry = this.cache.get(serviceKey);
    if (!entry) {
      this.misses += 1;
      this.logger.debug(`ToolListCache miss for ${serviceKey}`);
      return null;
    }

    if (Date.now() - entry.cachedAt >= this.ttlMs) {
      this.cache.delete(serviceKey);
      this.misses += 1;
      this.logger.debug(`ToolListCache expired for ${serviceKey}`);
      return null;
    }

    this.hits += 1;
    this.logger.debug(`ToolListCache hit for ${serviceKey}`);
    return entry.tools;
  }

  set(serviceKey: string, tools: unknown[]): void {
    if (!this.cache.has(serviceKey) && this.cache.size >= this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestCachedAt = Number.POSITIVE_INFINITY;

      for (const [key, entry] of this.cache.entries()) {
        if (entry.cachedAt < oldestCachedAt) {
          oldestCachedAt = entry.cachedAt;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.cache.delete(oldestKey);
        this.logger.debug(`ToolListCache evicted oldest entry ${oldestKey}`);
      }
    }

    this.cache.set(serviceKey, {
      tools,
      cachedAt: Date.now()
    });
    this.logger.debug(`ToolListCache set for ${serviceKey}`, { size: this.cache.size, maxEntries: this.maxEntries });
  }

  invalidate(serviceKey: string): void {
    if (this.cache.delete(serviceKey)) {
      this.logger.debug(`ToolListCache invalidated for ${serviceKey}`);
    }
  }

  clear(): void {
    this.cache.clear();
    this.logger.debug('ToolListCache cleared');
  }

  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total
    };
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.cache.clear();
    this.logger.debug('ToolListCache shutdown complete');
  }

  private disposed = false;
  dispose(): void { if (this.disposed) return; this.disposed = true; this.shutdown(); }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.cachedAt >= this.ttlMs) {
        this.cache.delete(key);
        removed += 1;
      }
    }

    if (removed > 0) {
      this.logger.debug('ToolListCache cleanup removed expired entries', { removed, size: this.cache.size });
    }
  }
}

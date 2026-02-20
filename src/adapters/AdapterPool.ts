import type { TransportAdapter, Logger, Disposable } from '../types/index.js';
import { unrefTimer } from '../utils/async.js';

export interface AdapterPoolOptions {
  maxSize?: number;
  maxIdleMs?: number;
  cleanupIntervalMs?: number;
}

interface PoolEntry {
  adapter: TransportAdapter;
  lastUsed: number;
}

export class AdapterPool implements Disposable {
  private pool: Map<string, PoolEntry>;
  private maxSize: number;
  private maxIdleMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private logger: Logger;

  constructor(logger: Logger, opts: AdapterPoolOptions = {}) {
    this.pool = new Map();
    this.maxSize = opts.maxSize ?? 50;
    this.maxIdleMs = opts.maxIdleMs ?? 5 * 60 * 1000;
    this.logger = logger;

    const cleanupIntervalMs = opts.cleanupIntervalMs ?? 60_000;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    unrefTimer(this.cleanupTimer);
  }

  get(key: string): TransportAdapter | null {
    const entry = this.pool.get(key);
    if (!entry) {
      this.logger.debug(`AdapterPool miss for ${key}`);
      return null;
    }

    if (!entry.adapter.isConnected()) {
      this.logger.debug(`AdapterPool stale adapter evicted for ${key}`);
      void this.evict(key);
      return null;
    }

    entry.lastUsed = Date.now();
    this.logger.debug(`AdapterPool hit for ${key}`);
    return entry.adapter;
  }

  release(key: string, adapter: TransportAdapter): void {
    // Don't pool adapters that are no longer connected
    if (!adapter.isConnected()) {
      this.logger.debug(`Rejecting unhealthy adapter for ${key}`);
      adapter.disconnect().catch(() => { /* best-effort */ });
      return;
    }

    const existing = this.pool.get(key);
    const isNewKey = !existing;

    if (isNewKey && this.pool.size >= this.maxSize) {
      this.logger.debug(`AdapterPool full; discarding adapter for ${key}`);
      void adapter.disconnect().catch((error: unknown) => {
        this.logger.warn(`Failed to disconnect discarded adapter for ${key}`, error);
      });
      return;
    }

    if (existing && existing.adapter !== adapter) {
      void existing.adapter.disconnect().catch((error: unknown) => {
        this.logger.warn(`Failed to disconnect replaced adapter for ${key}`, error);
      });
    }

    this.pool.set(key, { adapter, lastUsed: Date.now() });
    this.logger.debug(`Adapter released to pool for ${key}`, { size: this.pool.size, maxSize: this.maxSize });
  }

  async evict(key: string): Promise<void> {
    const entry = this.pool.get(key);
    if (!entry) {
      return;
    }

    this.pool.delete(key);
    this.logger.debug(`Adapter evicted from pool for ${key}`, { size: this.pool.size });
    try {
      await entry.adapter.disconnect();
    } catch (error) {
      this.logger.warn(`Failed to disconnect adapter during eviction for ${key}`, error);
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    const entries = Array.from(this.pool.entries());
    this.pool.clear();
    await Promise.all(entries.map(async ([key, entry]) => {
      try {
        await entry.adapter.disconnect();
      } catch (error) {
        this.logger.warn(`Failed to disconnect adapter during shutdown for ${key}`, error);
      }
    }));
    this.logger.debug('AdapterPool shutdown complete');
  }

  private disposed = false;
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await this.shutdown(); }

  getStats(): { size: number; maxSize: number } {
    return {
      size: this.pool.size,
      maxSize: this.maxSize
    };
  }

  private cleanup(): void {
    const now = Date.now();
    const idleKeys: string[] = [];
    for (const [key, entry] of this.pool.entries()) {
      if (now - entry.lastUsed > this.maxIdleMs) {
        idleKeys.push(key);
      }
    }

    if (idleKeys.length === 0) {
      return;
    }

    this.logger.debug('AdapterPool cleanup evicting idle adapters', { count: idleKeys.length });
    for (const key of idleKeys) {
      void this.evict(key);
    }
  }
}

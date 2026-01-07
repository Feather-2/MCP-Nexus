/**
 * In-memory implementation of ObservationStoreBackend.
 */

import type { ObservationStoreBackend, StoreEvent, StoreEventHandler } from './ObservationStoreBackend.js';

interface CacheEntry<T> {
  value: T;
  expiresAt?: number;
}

export class InMemoryBackend implements ObservationStoreBackend {
  private readonly data = new Map<string, CacheEntry<unknown>>();
  private readonly handlers = new Set<StoreEventHandler>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor() {
    // Periodic cleanup of expired entries
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    (this.cleanupTimer as any).unref?.();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.data.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      await this.notifyHandlers({ type: 'expire', key });
      return undefined;
    }

    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const entry: CacheEntry<T> = { value };

    if (ttlMs && ttlMs > 0) {
      entry.expiresAt = Date.now() + ttlMs;
    }

    this.data.set(key, entry);
    await this.notifyHandlers({ type: 'set', key, value });
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.data.has(key);
    this.data.delete(key);

    if (existed) {
      await this.notifyHandlers({ type: 'delete', key });
    }

    return existed;
  }

  async has(key: string): Promise<boolean> {
    const entry = this.data.get(key);
    if (!entry) return false;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return false;
    }

    return true;
  }

  async keys(pattern?: string): Promise<string[]> {
    const allKeys: string[] = [];
    const now = Date.now();

    for (const [key, entry] of this.data) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.data.delete(key);
        continue;
      }

      if (!pattern || this.matchPattern(key, pattern)) {
        allKeys.push(key);
      }
    }

    return allKeys;
  }

  async subscribe(handler: StoreEventHandler): Promise<void> {
    this.handlers.add(handler);
  }

  async unsubscribe(handler: StoreEventHandler): Promise<void> {
    this.handlers.delete(handler);
  }

  async publish(event: StoreEvent): Promise<void> {
    await this.notifyHandlers(event);
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.handlers.clear();
    this.data.clear();
  }

  private async notifyHandlers(event: StoreEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  private matchPattern(key: string, pattern: string): boolean {
    // Simple glob-style pattern matching (* = any characters)
    const regex = new RegExp(
      '^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
    );
    return regex.test(key);
  }

  private cleanup(): void {
    const now = Date.now();

    for (const [key, entry] of this.data) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.data.delete(key);
        this.notifyHandlers({ type: 'expire', key }).catch(() => {});
      }
    }
  }
}

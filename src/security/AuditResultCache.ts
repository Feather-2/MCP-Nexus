/**
 * LRU Cache for audit results with TTL support.
 */

import type { AuditResult } from './AuditPipeline.js';

interface CacheEntry {
  result: AuditResult;
  expiresAt: number;
}

export interface AuditResultCacheOptions {
  maxSize?: number;
  defaultTtlMs?: number;
}

export class AuditResultCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;

  constructor(options: AuditResultCacheOptions = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.defaultTtlMs = options.defaultTtlMs ?? 3600_000; // 1 hour
  }

  /**
   * Generate cache key from skill identifier and content hash.
   */
  static makeKey(skillId: string, contentHash: string): string {
    return `${skillId}:${contentHash}`;
  }

  get(key: string): AuditResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end for LRU
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.result;
  }

  set(key: string, result: AuditResult, ttlMs?: number): void {
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = Date.now() + effectiveTtl;

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    // Delete first to maintain insertion order
    this.cache.delete(key);
    this.cache.set(key, { result, expiresAt });
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  /**
   * Remove expired entries.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned++;
      }
    }

    return pruned;
  }
}

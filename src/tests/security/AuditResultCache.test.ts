import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuditResultCache } from '../../security/AuditResultCache.js';
import type { AuditResult } from '../../security/AuditPipeline.js';

const makeResult = (decision: AuditResult['decision'] = 'approve'): AuditResult => ({
  decision,
  score: 90,
  findings: [],
  reviewRequired: false
});

describe('AuditResultCache', () => {
  let cache: AuditResultCache;

  beforeEach(() => {
    cache = new AuditResultCache({ maxSize: 3, defaultTtlMs: 500 });
  });

  it('makeKey generates consistent keys', () => {
    expect(AuditResultCache.makeKey('skill', 'abc')).toBe('skill:abc');
  });

  it('set and get work', () => {
    const r = makeResult();
    cache.set('k1', r);
    expect(cache.get('k1')).toEqual(r);
  });

  it('get returns undefined for missing key', () => {
    expect(cache.get('nope')).toBeUndefined();
  });

  it('get returns undefined for expired entry', async () => {
    cache.set('k1', makeResult(), 10);
    await new Promise(r => setTimeout(r, 20));
    expect(cache.get('k1')).toBeUndefined();
  });

  it('get moves entry to end (LRU)', () => {
    cache.set('a', makeResult());
    cache.set('b', makeResult());
    cache.get('a'); // access 'a' -> moves to end
    cache.set('c', makeResult());
    cache.set('d', makeResult()); // evicts 'b' (oldest)
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('has returns true for valid entry', () => {
    cache.set('k1', makeResult());
    expect(cache.has('k1')).toBe(true);
  });

  it('has returns false for missing entry', () => {
    expect(cache.has('nope')).toBe(false);
  });

  it('has returns false for expired entry', async () => {
    cache.set('k1', makeResult(), 10);
    await new Promise(r => setTimeout(r, 20));
    expect(cache.has('k1')).toBe(false);
  });

  it('delete removes entry', () => {
    cache.set('k1', makeResult());
    expect(cache.delete('k1')).toBe(true);
    expect(cache.get('k1')).toBeUndefined();
  });

  it('delete returns false for missing entry', () => {
    expect(cache.delete('nope')).toBe(false);
  });

  it('clear removes all entries', () => {
    cache.set('a', makeResult());
    cache.set('b', makeResult());
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('size returns current count', () => {
    expect(cache.size()).toBe(0);
    cache.set('a', makeResult());
    expect(cache.size()).toBe(1);
  });

  it('evicts oldest when at capacity', () => {
    cache.set('a', makeResult());
    cache.set('b', makeResult());
    cache.set('c', makeResult());
    expect(cache.size()).toBe(3);
    cache.set('d', makeResult()); // evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBeDefined();
    expect(cache.size()).toBe(3);
  });

  it('set updates existing entry without eviction', () => {
    cache.set('a', makeResult());
    cache.set('b', makeResult());
    cache.set('c', makeResult());
    cache.set('a', makeResult('review')); // update, not evict
    expect(cache.size()).toBe(3);
    expect(cache.get('a')?.decision).toBe('review');
  });

  it('prune removes expired entries', async () => {
    cache.set('a', makeResult(), 10);
    cache.set('b', makeResult(), 10);
    cache.set('c', makeResult(), 10000);
    await new Promise(r => setTimeout(r, 20));
    const pruned = cache.prune();
    expect(pruned).toBe(2);
    expect(cache.size()).toBe(1);
    expect(cache.get('c')).toBeDefined();
  });

  it('prune returns 0 when nothing expired', () => {
    cache.set('a', makeResult());
    expect(cache.prune()).toBe(0);
  });
});

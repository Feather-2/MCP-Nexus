import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RateLimitConfig } from '../../ai/types.js';
import { SlidingWindowRateLimiter } from '../../ai/rate-limiter.js';

type RateLimiterStoreView = {
  store: Map<string, { config: RateLimitConfig; timestamps: number[] }>;
};

function makeKey(subject: string, config: RateLimitConfig): string {
  return `${subject}::${config.windowMs}::${config.limit}`;
}

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a single consume', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 1, windowMs: 1000 };

    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.remaining('userA', config)).toBe(0);
  });

  it('returns false after reaching limit', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 2, windowMs: 1000 };

    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.consume('userA', config)).toBe(false);
  });

  it('recovers after window expires', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 2, windowMs: 1000 };

    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.consume('userA', config)).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(limiter.consume('userA', config)).toBe(true);
  });

  it('remaining returns correct quota', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 5, windowMs: 1000 };

    expect(limiter.remaining('userA', config)).toBe(5);
    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.remaining('userA', config)).toBe(3);
  });

  it('resetIn returns correct time', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 5, windowMs: 1000 };

    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.resetIn('userA', config)).toBe(1000);

    vi.advanceTimersByTime(400);
    expect(limiter.resetIn('userA', config)).toBe(600);
  });

  it('multiple subjects are independent', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 1, windowMs: 1000 };

    expect(limiter.consume('userA', config)).toBe(true);
    expect(limiter.consume('userA', config)).toBe(false);

    expect(limiter.consume('userB', config)).toBe(true);
    expect(limiter.consume('userB', config)).toBe(false);
  });

  it('cost > 1 consumes correctly', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 5, windowMs: 1000 };

    expect(limiter.consume('userA', config, 3)).toBe(true);
    expect(limiter.remaining('userA', config)).toBe(2);

    expect(limiter.consume('userA', config, 3)).toBe(false);
    expect(limiter.consume('userA', config, 2)).toBe(true);
    expect(limiter.remaining('userA', config)).toBe(0);
  });

  it('cleanup removes expired entries', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 1, windowMs: 1000 };

    expect(limiter.consume('userA', config)).toBe(true);
    expect((limiter as unknown as RateLimiterStoreView).store.size).toBe(1);

    vi.advanceTimersByTime(1001);
    limiter.cleanup();
    expect((limiter as unknown as RateLimiterStoreView).store.size).toBe(0);
  });

  it('close stops the cleanup timer', async () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 100 });
    const cleanupSpy = vi.spyOn(limiter, 'cleanup');

    await vi.advanceTimersByTimeAsync(300);
    expect(cleanupSpy).toHaveBeenCalledTimes(3);

    limiter.close();
    await vi.advanceTimersByTimeAsync(300);
    expect(cleanupSpy).toHaveBeenCalledTimes(3);
  });

  it('cost=0 is a no-op', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 1, windowMs: 1000 };

    expect(limiter.consume('userA', config, 0)).toBe(true);
    expect((limiter as unknown as RateLimiterStoreView).store.size).toBe(0);
  });

  it('remaining and resetIn drop expired entries on access', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 1, windowMs: 1000 };

    expect(limiter.consume('userA', config)).toBe(true);
    vi.advanceTimersByTime(1001);

    expect(limiter.remaining('userA', config)).toBe(1);
    expect((limiter as unknown as RateLimiterStoreView).store.size).toBe(0);

    expect(limiter.consume('userA', config)).toBe(true);
    vi.advanceTimersByTime(1001);

    expect(limiter.resetIn('userA', config)).toBe(0);
    expect((limiter as unknown as RateLimiterStoreView).store.size).toBe(0);
  });

  it('cleanup handles windowMs<=0 entries defensively', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 1, windowMs: 0 };

    (limiter as unknown as RateLimiterStoreView).store.set(makeKey('userA', config), {
      config,
      timestamps: [0]
    });

    limiter.cleanup();
    expect((limiter as unknown as RateLimiterStoreView).store.size).toBe(0);
  });

  it('throws on invalid cost', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });
    const config: RateLimitConfig = { limit: 10, windowMs: 1000 };

    expect(() => limiter.consume('userA', config, Number.POSITIVE_INFINITY)).toThrow();
    expect(() => limiter.consume('userA', config, 1.5)).toThrow();
  });

  it('throws on invalid configs', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });

    const badLimit: RateLimitConfig = { limit: Number.NaN, windowMs: 1000 };
    expect(() => limiter.consume('userA', badLimit)).toThrow();
    expect(() => limiter.remaining('userA', badLimit)).toThrow();
    expect(() => limiter.resetIn('userA', badLimit)).toThrow();

    const badWindow: RateLimitConfig = { limit: 1, windowMs: Number.NaN };
    expect(() => limiter.consume('userA', badWindow)).toThrow();
    expect(() => limiter.remaining('userA', badWindow)).toThrow();
    expect(() => limiter.resetIn('userA', badWindow)).toThrow();
  });

  it('handles edge configs (limit=0, windowMs=0)', () => {
    const limiter = new SlidingWindowRateLimiter({ cleanupIntervalMs: 0 });

    const blocked: RateLimitConfig = { limit: 0, windowMs: 1000 };
    expect(limiter.consume('userA', blocked)).toBe(false);
    expect(limiter.remaining('userA', blocked)).toBe(0);
    expect(limiter.resetIn('userA', blocked)).toBe(0);

    const immediateExpire: RateLimitConfig = { limit: 2, windowMs: 0 };
    expect(limiter.consume('userA', immediateExpire)).toBe(true);
    expect(limiter.consume('userA', immediateExpire)).toBe(true);
    expect(limiter.consume('userA', immediateExpire)).toBe(true);
    expect(limiter.remaining('userA', immediateExpire)).toBe(2);
    expect(limiter.resetIn('userA', immediateExpire)).toBe(0);

    limiter.close();
    limiter.close();
  });
});

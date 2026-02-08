import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../gateway/TokenBucket.js';

describe('TokenBucket', () => {
  it('starts full and allows tryAcquire', () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 10 });
    expect(tb.availableTokens()).toBeCloseTo(5, 0);
    expect(tb.tryAcquire()).toBe(true);
    expect(tb.availableTokens()).toBeCloseTo(4, 0);
  });

  it('rejects when empty', () => {
    const tb = new TokenBucket({ capacity: 2, refillRate: 0.01 });
    expect(tb.tryAcquire()).toBe(true);
    expect(tb.tryAcquire()).toBe(true);
    expect(tb.tryAcquire()).toBe(false);
  });

  it('refills over time', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 100 });
    for (let i = 0; i < 5; i++) tb.tryAcquire();
    expect(tb.tryAcquire()).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    expect(tb.tryAcquire()).toBe(true);
  });

  it('acquire resolves immediately when tokens available', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 10 });
    const result = await tb.acquire(100);
    expect(result).toBe(true);
  });

  it('acquire waits for refill', async () => {
    const tb = new TokenBucket({ capacity: 1, refillRate: 100 });
    tb.tryAcquire();
    const result = await tb.acquire(200);
    expect(result).toBe(true);
  });

  it('acquire times out when no tokens', async () => {
    const tb = new TokenBucket({ capacity: 1, refillRate: 0.001 });
    tb.tryAcquire();
    const result = await tb.acquire(50);
    expect(result).toBe(false);
  });

  it('reset restores to full capacity', () => {
    const tb = new TokenBucket({ capacity: 10, refillRate: 1 });
    for (let i = 0; i < 10; i++) tb.tryAcquire();
    expect(tb.tryAcquire()).toBe(false);
    tb.reset();
    expect(tb.availableTokens()).toBeCloseTo(10, 0);
    expect(tb.tryAcquire()).toBe(true);
  });
});

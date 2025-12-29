import { ChannelManager } from '../../ai/channel.js';
import { AiError, type AiClientConfig, type ChannelLease } from '../../ai/types.js';

function makeConfig(channels: AiClientConfig['channels']): AiClientConfig {
  return { channels };
}

function withDeterministicRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    // LCG (Numerical Recipes)
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function withFixedRandom<T>(value: number, fn: () => T): T {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

describe('ChannelManager', () => {
  it('parses keys (newline/json/single)', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'nl',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: ' k1 \n\nk2\r\n k3 ', format: 'newline' }
        },
        {
          id: 'json',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: '["a", " ", "b"]', format: 'json' }
        },
        {
          id: 'single',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: '  only-one  ', format: 'single' }
        }
      ])
    );

    const nlState = mgr.getState('nl');
    const jsonState = mgr.getState('json');
    const singleState = mgr.getState('single');

    expect(nlState?.keys.map((k) => k.index)).toEqual([0, 1, 2]);
    expect(jsonState?.keys.map((k) => k.index)).toEqual([0, 1]);
    expect(singleState?.keys.map((k) => k.index)).toEqual([0]);

    expect(mgr.acquire('nl').apiKey).toBe('k1');
    expect(mgr.acquire('json').apiKey).toBe('a');
    expect(mgr.acquire('single').apiKey).toBe('only-one');
  });

  it('parses keys from env and handles invalid json/empty', () => {
    const prev = process.env.TEST_AI_KEYS;
    process.env.TEST_AI_KEYS = 'e1\ne2';
    try {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'env',
            provider: 'openai',
            model: 'gpt',
            keySource: { type: 'env', value: 'TEST_AI_KEYS', format: 'newline' }
          },
          {
            id: 'bad-json',
            provider: 'openai',
            model: 'gpt',
            keySource: { type: 'literal', value: '{not json', format: 'json' }
          },
          {
            id: 'non-array-json',
            provider: 'openai',
            model: 'gpt',
            keySource: { type: 'literal', value: '{"k":"v"}', format: 'json' }
          },
          {
            id: 'empty-json',
            provider: 'openai',
            model: 'gpt',
            keySource: { type: 'literal', value: '   ', format: 'json' }
          },
          {
            id: 'mixed-json',
            provider: 'openai',
            model: 'gpt',
            keySource: { type: 'literal', value: '[1, "x"]', format: 'json' }
          }
        ])
      );

      expect(mgr.acquire('env').apiKey).toBe('e1');
      expect(mgr.acquire('env').apiKey).toBe('e2');

      expect(mgr.getState('bad-json')?.keys).toEqual([]);
      expect(mgr.getState('non-array-json')?.keys).toEqual([]);
      expect(mgr.getState('empty-json')?.keys).toEqual([]);
      expect(mgr.acquire('mixed-json').apiKey).toBe('x');
    } finally {
      if (prev === undefined) delete process.env.TEST_AI_KEYS;
      else process.env.TEST_AI_KEYS = prev;
    }
  });

  it('handles missing env and empty single key', () => {
    const prev = process.env.MISSING_KEYS;
    delete process.env.MISSING_KEYS;
    try {
      const mgr = new ChannelManager(
        makeConfig([
          {
            id: 'env-missing',
            provider: 'openai',
            model: 'gpt',
            keySource: { type: 'env', value: 'MISSING_KEYS', format: 'single' }
          },
          {
            id: 'single-empty',
            provider: 'openai',
            model: 'gpt',
            keySource: { type: 'literal', value: '   ', format: 'single' }
          }
        ])
      );

      expect(mgr.getState('env-missing')?.keys).toEqual([]);
      expect(mgr.getState('single-empty')?.keys).toEqual([]);
      expect(() => mgr.acquire('env-missing')).toThrow(AiError);
    } finally {
      if (prev !== undefined) process.env.MISSING_KEYS = prev;
    }
  });

  it('rotates keys (polling order correct)', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keyRotation: 'polling',
          keySource: { type: 'literal', value: 'k1\nk2\nk3', format: 'newline' }
        }
      ])
    );

    expect(mgr.acquire('c1').apiKey).toBe('k1');
    expect(mgr.acquire('c1').apiKey).toBe('k2');
    expect(mgr.acquire('c1').apiKey).toBe('k3');
    expect(mgr.acquire('c1').apiKey).toBe('k1');
  });

  it('rotates keys (random distribution)', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keyRotation: 'random',
          keySource: { type: 'literal', value: 'a\nb\nc', format: 'newline' }
        }
      ])
    );

    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    withDeterministicRandom(42, () => {
      for (let i = 0; i < 9000; i += 1) {
        counts[mgr.acquire('c1').apiKey] += 1;
      }
    });

    const expected = 3000;
    const tolerance = 0.15; // deterministic, but still allow slack
    expect(Math.abs(counts.a - expected) / expected).toBeLessThan(tolerance);
    expect(Math.abs(counts.b - expected) / expected).toBeLessThan(tolerance);
    expect(Math.abs(counts.c - expected) / expected).toBeLessThan(tolerance);
  });

  it('disables/enables a key', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keyRotation: 'polling',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' }
        }
      ])
    );

    mgr.disableKey('c1', 0, 'bad key');
    expect(mgr.acquire('c1').apiKey).toBe('k2');
    expect(mgr.acquire('c1').apiKey).toBe('k2');

    mgr.enableKey('c1', 0);
    expect(mgr.acquire('c1').apiKey).toBe('k1');
  });

  it('getState includes key disable metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' }
        }
      ])
    );

    mgr.disableKey('c1', 1, 'temp', 1000);
    const state1 = mgr.getState('c1');
    expect(state1?.keys[1]?.enabled).toBe(false);
    expect(state1?.keys[1]?.disabledReason).toBe('temp');
    expect(state1?.keys[1]?.disabledAt?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(state1?.keys[1]?.disabledUntil?.toISOString()).toBe('2025-01-01T00:00:01.000Z');

    mgr.enableKey('c1', 1);
    const state2 = mgr.getState('c1');
    expect(state2?.keys[1]?.enabled).toBe(true);
    expect(state2?.keys[1]?.disabledAt).toBeUndefined();
    expect(state2?.keys[1]?.disabledUntil).toBeUndefined();
    expect(state2?.keys[1]?.disabledReason).toBeUndefined();

    vi.useRealTimers();
  });

  it('auto restores a key after duration expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keyRotation: 'polling',
          keySource: { type: 'literal', value: 'k1\nk2', format: 'newline' }
        }
      ])
    );

    mgr.disableKey('c1', 0, 'temp', 1000);
    expect(mgr.acquire('c1').apiKey).toBe('k2');

    vi.setSystemTime(new Date('2025-01-01T00:00:00.999Z'));
    expect(mgr.acquire('c1').apiKey).toBe('k2');

    vi.setSystemTime(new Date('2025-01-01T00:00:01.000Z'));
    expect(mgr.acquire('c1').apiKey).toBe('k1');

    vi.useRealTimers();
  });

  it('filters channels by tags', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'a',
          provider: 'openai',
          model: 'gpt',
          tags: ['prod', 'us'],
          weight: 1,
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        },
        {
          id: 'b',
          provider: 'openai',
          model: 'gpt',
          tags: ['staging'],
          weight: 1,
          keySource: { type: 'literal', value: 'k2', format: 'single' }
        },
        {
          id: 'c',
          provider: 'openai',
          model: 'gpt',
          weight: 100,
          keySource: { type: 'literal', value: 'k3', format: 'single' }
        }
      ])
    );

    const lease = mgr.acquire(undefined, ['prod']);
    expect(lease.channelId).toBe('a');
    expect(() => mgr.acquire(undefined, ['does-not-exist'])).toThrow(AiError);
  });

  it('skips channels with non-positive weight', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'w0',
          provider: 'openai',
          model: 'gpt',
          weight: 0,
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        },
        {
          id: 'w1',
          provider: 'openai',
          model: 'gpt',
          weight: 1,
          keySource: { type: 'literal', value: 'k2', format: 'single' }
        }
      ])
    );

    withFixedRandom(0, () => {
      expect(mgr.acquire().channelId).toBe('w1');
    });
  });

  it('selects channels by weight', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'low',
          provider: 'openai',
          model: 'gpt',
          weight: 1,
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        },
        {
          id: 'high',
          provider: 'openai',
          model: 'gpt',
          weight: 3,
          keySource: { type: 'literal', value: 'k2', format: 'single' }
        }
      ])
    );

    const counts: Record<string, number> = { low: 0, high: 0 };
    withDeterministicRandom(7, () => {
      for (let i = 0; i < 8000; i += 1) {
        const lease = mgr.acquire();
        counts[lease.channelId] += 1;
      }
    });

    const ratio = counts.high / counts.low;
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(3.5);
  });

  it('disables/enables a channel', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          weight: 1,
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        },
        {
          id: 'c2',
          provider: 'openai',
          model: 'gpt',
          weight: 1,
          keySource: { type: 'literal', value: 'k2', format: 'single' }
        }
      ])
    );

    mgr.disableChannel('c1', 'maintenance');
    const lease = mgr.acquire();
    expect(lease.channelId).toBe('c2');

    mgr.enableChannel('c1');
    withDeterministicRandom(1, () => {
      const lease2 = mgr.acquire();
      expect(['c1', 'c2']).toContain(lease2.channelId);
    });
  });

  it('auto restores a channel after duration expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        }
      ])
    );

    mgr.disableChannel('c1', 'temp', 1000);
    expect(mgr.getState('c1')?.enabled).toBe(false);

    vi.setSystemTime(new Date('2025-01-01T00:00:01.001Z'));
    expect(mgr.getState('c1')?.enabled).toBe(true);

    vi.useRealTimers();
  });

  it('skips channels in cooldownUntil window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          weight: 1,
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        },
        {
          id: 'c2',
          provider: 'openai',
          model: 'gpt',
          weight: 1,
          keySource: { type: 'literal', value: 'k2', format: 'single' }
        }
      ])
    );

    const lease = mgr.acquire('c1');
    mgr.report(lease, {
      success: false,
      latencyMs: 10,
      error: new AiError('rate limited', 'rate_limit', 429, true, 1000)
    });
    mgr.report(lease, {
      success: false,
      latencyMs: 10,
      error: new AiError('rate limited again', 'rate_limit', 429, true, 500)
    });

    expect(mgr.getState('c1')?.cooldownUntil?.toISOString()).toBe('2025-01-01T00:00:01.000Z');

    withFixedRandom(0, () => {
      expect(mgr.acquire().channelId).toBe('c2');
    });

    vi.setSystemTime(new Date('2025-01-01T00:00:01.001Z'));
    withFixedRandom(0, () => {
      expect(mgr.acquire().channelId).toBe('c1');
    });

    vi.useRealTimers();
  });

  it('throws on invalid ids for report/key/channel controls', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        }
      ])
    );

    const badLease: ChannelLease = {
      channelId: 'missing',
      keyIndex: 0,
      apiKey: 'k',
      provider: 'openai',
      model: 'gpt',
      attempt: 1,
      acquiredAt: new Date()
    };
    expect(() => mgr.report(badLease, { success: true, latencyMs: 1 })).toThrow(AiError);

    const wrongKeyLease: ChannelLease = {
      ...badLease,
      channelId: 'c1',
      keyIndex: 99
    };
    expect(() => mgr.report(wrongKeyLease, { success: true, latencyMs: 1 })).toThrow(AiError);

    expect(() => mgr.disableKey('missing', 0, 'x')).toThrow(AiError);
    expect(() => mgr.disableKey('c1', 2, 'x')).toThrow(AiError);
    expect(() => mgr.enableKey('missing', 0)).toThrow(AiError);
    expect(() => mgr.enableKey('c1', 2)).toThrow(AiError);
    expect(() => mgr.disableChannel('missing', 'x')).toThrow(AiError);
    expect(() => mgr.enableChannel('missing')).toThrow(AiError);
  });

  it('throws when acquire has no available channel', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          enabled: false,
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        }
      ])
    );

    expect(() => mgr.acquire()).toThrow(AiError);
  });

  it('throws for unknown channel and unavailable channelId', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        }
      ])
    );

    expect(() => mgr.acquire('missing')).toThrow(AiError);
    mgr.disableChannel('c1', 'down');
    expect(() => mgr.acquire('c1')).toThrow(AiError);
  });

  it('getAllStates returns sorted copies', () => {
    const mgr = new ChannelManager(
      makeConfig([
        { id: 'b', provider: 'openai', model: 'gpt', keySource: { type: 'literal', value: 'k', format: 'single' } },
        { id: 'a', provider: 'openai', model: 'gpt', keySource: { type: 'literal', value: 'k', format: 'single' } }
      ])
    );

    const states = mgr.getAllStates();
    expect(states.map((s) => s.channelId)).toEqual(['a', 'b']);

    states[0]!.enabled = false;
    expect(mgr.getState('a')?.enabled).toBe(true);
    expect(mgr.getState('nope')).toBeUndefined();
  });

  it('report success updates metrics', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        }
      ])
    );

    const lease = mgr.acquire('c1');
    mgr.report(lease, { success: true, latencyMs: 120, tokens: 42 });
    mgr.report(lease, { success: true, latencyMs: 240, tokens: 8 });

    const state = mgr.getState('c1');
    expect(state?.metrics.totalRequests).toBe(2);
    expect(state?.metrics.totalErrors).toBe(0);
    expect(state?.metrics.avgLatencyMs).toBe(180);
    expect(state?.metrics.lastRequestAt?.toISOString()).toBe('2025-01-01T00:00:00.000Z');

    expect(state?.keys[0]?.totalRequests).toBe(2);
    expect(state?.keys[0]?.totalTokens).toBe(50);
    expect(state?.keys[0]?.errorCount).toBe(0);
    expect(state?.keys[0]?.lastUsedAt?.toISOString()).toBe('2025-01-01T00:00:00.000Z');

    vi.useRealTimers();
  });

  it('report failure increases errorCount', () => {
    const mgr = new ChannelManager(
      makeConfig([
        {
          id: 'c1',
          provider: 'openai',
          model: 'gpt',
          keySource: { type: 'literal', value: 'k1', format: 'single' }
        }
      ])
    );

    const lease = mgr.acquire('c1');
    mgr.report(lease, { success: false, latencyMs: 50, error: new AiError('oops', 'unknown') });

    const state = mgr.getState('c1');
    expect(state?.metrics.totalRequests).toBe(1);
    expect(state?.metrics.totalErrors).toBe(1);
    expect(state?.keys[0]?.totalRequests).toBe(1);
    expect(state?.keys[0]?.errorCount).toBe(1);
  });
});

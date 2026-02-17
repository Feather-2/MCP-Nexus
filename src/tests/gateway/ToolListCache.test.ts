import { ToolListCache } from '../../gateway/ToolListCache.js';
import type { Logger } from '../../types/index.js';

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

describe('ToolListCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('get() returns null for unknown key', () => {
    const cache = new ToolListCache(makeLogger());

    expect(cache.get('missing-service')).toBeNull();
    expect(cache.getStats()).toMatchObject({ hits: 0, misses: 1, size: 0 });

    cache.shutdown();
  });

  it('set() then get() returns cached tools', () => {
    const cache = new ToolListCache(makeLogger());
    const tools = [{ name: 'echo' }, { name: 'search' }];

    cache.set('svc-a', tools);

    expect(cache.get('svc-a')).toEqual(tools);
    expect(cache.getStats()).toMatchObject({ hits: 1, misses: 0, size: 1 });

    cache.shutdown();
  });

  it('get() returns null after TTL expiration', () => {
    const cache = new ToolListCache(makeLogger(), { ttlMs: 1_000, cleanupIntervalMs: 5_000 });

    cache.set('svc-a', [{ name: 'echo' }]);
    vi.advanceTimersByTime(1_001);

    expect(cache.get('svc-a')).toBeNull();
    expect(cache.getStats()).toMatchObject({ hits: 0, misses: 1, size: 0 });

    cache.shutdown();
  });

  it('invalidate() removes one entry', () => {
    const cache = new ToolListCache(makeLogger());

    cache.set('svc-a', [{ name: 'a' }]);
    cache.invalidate('svc-a');

    expect(cache.get('svc-a')).toBeNull();
    expect(cache.getStats().size).toBe(0);

    cache.shutdown();
  });

  it('clear() removes all entries', () => {
    const cache = new ToolListCache(makeLogger());

    cache.set('svc-a', [{ name: 'a' }]);
    cache.set('svc-b', [{ name: 'b' }]);
    cache.clear();

    expect(cache.getStats().size).toBe(0);
    expect(cache.get('svc-a')).toBeNull();
    expect(cache.get('svc-b')).toBeNull();

    cache.shutdown();
  });

  it('getStats() tracks hits, misses, and hitRate', () => {
    const cache = new ToolListCache(makeLogger());

    cache.set('svc-a', [{ name: 'a' }]);
    expect(cache.get('svc-a')).toEqual([{ name: 'a' }]); // hit
    expect(cache.get('svc-b')).toBeNull(); // miss

    const stats = cache.getStats();
    expect(stats.size).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);

    cache.shutdown();
  });

  it('set() evicts oldest entry when maxEntries is reached', () => {
    const cache = new ToolListCache(makeLogger(), { maxEntries: 2 });

    cache.set('svc-a', [{ name: 'a' }]);
    vi.advanceTimersByTime(10);
    cache.set('svc-b', [{ name: 'b' }]);
    vi.advanceTimersByTime(10);
    cache.set('svc-c', [{ name: 'c' }]); // should evict svc-a

    expect(cache.get('svc-a')).toBeNull();
    expect(cache.get('svc-b')).toEqual([{ name: 'b' }]);
    expect(cache.get('svc-c')).toEqual([{ name: 'c' }]);
    expect(cache.getStats().size).toBe(2);

    cache.shutdown();
  });

  it('shutdown() clears timer and entries', () => {
    const cache = new ToolListCache(makeLogger(), { ttlMs: 100, cleanupIntervalMs: 50 });

    cache.set('svc-a', [{ name: 'a' }]);
    cache.shutdown();

    vi.advanceTimersByTime(500);
    expect(cache.getStats().size).toBe(0);
    expect(cache.get('svc-a')).toBeNull();
  });
});

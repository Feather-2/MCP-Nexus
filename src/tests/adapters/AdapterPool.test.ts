import { AdapterPool } from '../../adapters/AdapterPool.js';
import type { Logger, TransportAdapter } from '../../types/index.js';

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeAdapter(connected: boolean = true): TransportAdapter {
  return {
    type: 'http',
    version: '2024-11-26',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    receive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', result: {} }),
    isConnected: vi.fn().mockReturnValue(connected)
  };
}

describe('AdapterPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('get() returns null for unknown key', () => {
    const pool = new AdapterPool(makeLogger());

    expect(pool.get('missing-service')).toBeNull();

    void pool.shutdown();
  });

  it('release() then get() returns the adapter', () => {
    const pool = new AdapterPool(makeLogger());
    const adapter = makeAdapter();

    pool.release('svc-a', adapter);

    expect(pool.get('svc-a')).toBe(adapter);
    expect(pool.getStats().size).toBe(1);

    void pool.shutdown();
  });

  it('evict() disconnects and removes adapter', async () => {
    const pool = new AdapterPool(makeLogger());
    const adapter = makeAdapter();

    pool.release('svc-a', adapter);
    await pool.evict('svc-a');

    expect(adapter.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.get('svc-a')).toBeNull();

    await pool.shutdown();
  });

  it('release() disconnects new adapter when pool is full', async () => {
    const pool = new AdapterPool(makeLogger(), { maxSize: 1 });
    const first = makeAdapter();
    const second = makeAdapter();

    pool.release('svc-a', first);
    pool.release('svc-b', second);

    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.get('svc-a')).toBe(first);
    expect(pool.get('svc-b')).toBeNull();
    expect(pool.getStats().size).toBe(1);

    await pool.shutdown();
  });

  it('cleanup() evicts idle adapters', async () => {
    const pool = new AdapterPool(makeLogger(), {
      maxIdleMs: 1_000,
      cleanupIntervalMs: 500
    });
    const adapter = makeAdapter();

    pool.release('svc-idle', adapter);
    vi.advanceTimersByTime(1_600);
    await Promise.resolve();

    expect(adapter.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.get('svc-idle')).toBeNull();

    await pool.shutdown();
  });

  it('shutdown() disconnects all pooled adapters', async () => {
    const pool = new AdapterPool(makeLogger());
    const a = makeAdapter();
    const b = makeAdapter();

    pool.release('svc-a', a);
    pool.release('svc-b', b);

    await pool.shutdown();

    expect(a.disconnect).toHaveBeenCalledTimes(1);
    expect(b.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.getStats().size).toBe(0);
  });

  it('get() returns null and evicts disconnected adapter', async () => {
    const pool = new AdapterPool(makeLogger());
    const adapter = makeAdapter(true);

    pool.release('svc-a', adapter);
    (adapter.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

    expect(pool.get('svc-a')).toBeNull();
    await Promise.resolve();
    expect(adapter.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.getStats().size).toBe(0);

    await pool.shutdown();
  });
});

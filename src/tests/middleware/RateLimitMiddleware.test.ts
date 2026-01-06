import { RateLimitMiddleware } from '../../middleware/index.js';
import type { Context, State } from '../../middleware/index.js';
import type { GatewayConfig } from '../../types/index.js';

const { ioredisMock, setIoredisClient } = vi.hoisted(() => {
  const ctor: any = vi.fn();
  ctor.__client = undefined;
  ctor.mockImplementation(() => ctor.__client);
  const setter = (client: any) => {
    ctor.__client = client;
  };
  return { ioredisMock: ctor, setIoredisClient: setter };
});

vi.mock('ioredis', () => ({ default: ioredisMock }));

function makeState(): State {
  return { stage: 'beforeAgent', values: new Map<string, unknown>(), aborted: false };
}

function makeReply() {
  const headers: Record<string, string> = {};
  const reply: any = {
    headers,
    header: vi.fn((key: string, value: string) => {
      headers[key.toLowerCase()] = value;
      return reply;
    }),
    code: vi.fn((_status: number) => reply),
    send: vi.fn((_payload: any) => reply)
  };
  return reply;
}

function makeCtx(request: any, reply: any, overrides: Partial<Context> = {}): Context {
  return {
    requestId: 'req-1',
    startTime: overrides.startTime ?? Date.now(),
    metadata: {},
    http: { request, reply } as any,
    ...overrides
  };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const base: any = {
    port: 0,
    host: '127.0.0.1',
    authMode: 'external-secure',
    routingStrategy: 'performance',
    loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 50,
    requestTimeout: 30000,
    enableMetrics: false,
    enableHealthChecks: false,
    healthCheckInterval: 30000,
    maxRetries: 1,
    enableCors: true,
    corsOrigins: ['http://localhost:3000'],
    maxRequestSize: 10 * 1024 * 1024,
    metricsRetentionDays: 1,
    rateLimiting: { enabled: false, maxRequests: 1, windowMs: 60000, store: 'memory' },
    logLevel: 'error',
    ai: { provider: 'none' }
  };
  return { ...base, ...overrides } as GatewayConfig;
}

describe('RateLimitMiddleware', () => {
  afterEach(() => {
    setIoredisClient(undefined);
    vi.restoreAllMocks();
    // `restoreAllMocks` may reset mock implementations; re-apply the ctor behavior.
    (ioredisMock as any).mockImplementation(() => (ioredisMock as any).__client);
  });

  it('does nothing without ctx.http', async () => {
    const configProvider = { getConfig: () => makeConfig() };
    const mw = new RateLimitMiddleware(configProvider as any);
    const ctx = { requestId: 'r', startTime: 0, metadata: {} } as any;
    const state = makeState();

    await mw.beforeAgent?.(ctx, state);
    expect(state.aborted).toBe(false);
  });

  it('skips when rate limiting is disabled', async () => {
    const configProvider = { getConfig: () => makeConfig({ rateLimiting: { enabled: false } as any }) };
    const mw = new RateLimitMiddleware(configProvider as any);
    const reply = makeReply();
    const request: any = { url: '/api/logs', method: 'GET', ip: '1.2.3.4', headers: {} };
    const ctx = makeCtx(request, reply);
    const state = makeState();

    await mw.beforeAgent?.(ctx, state);
    expect(state.aborted).toBe(false);
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('enforces memory store limit per api key', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);

    const configProvider = {
      getConfig: () =>
        makeConfig({
          rateLimiting: { enabled: true, maxRequests: 1, windowMs: 60000, store: 'memory' } as any
        })
    };
    const mw = new RateLimitMiddleware(configProvider as any);

    const request: any = { url: '/api/logs', method: 'GET', ip: '1.2.3.4', headers: { 'x-api-key': 'A-key-123' } };

    const reply1 = makeReply();
    const state1 = makeState();
    await mw.beforeAgent?.(makeCtx(request, reply1), state1);
    expect(state1.aborted).toBe(false);

    const reply2 = makeReply();
    const state2 = makeState();
    await mw.beforeAgent?.(makeCtx(request, reply2), state2);
    expect(state2.aborted).toBe(true);
    expect(reply2.code).toHaveBeenCalledWith(429);
    expect(reply2.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'RATE_LIMITED' })
      })
    );
  });

  it('resets memory window after expiration', async () => {
    const windowMs = 10;
    const nowSpy = vi.spyOn(Date, 'now');

    const configProvider = {
      getConfig: () =>
        makeConfig({
          rateLimiting: { enabled: true, maxRequests: 1, windowMs, store: 'memory' } as any
        })
    };
    const mw = new RateLimitMiddleware(configProvider as any);

    const request: any = { url: '/api/logs', method: 'GET', ip: '1.2.3.4', headers: { 'x-api-key': 'A-key-123' } };

    nowSpy.mockReturnValueOnce(0);
    const res1 = makeReply();
    await mw.beforeAgent?.(makeCtx(request, res1, { startTime: 0 }), makeState());

    nowSpy.mockReturnValueOnce(windowMs + 1);
    const res2 = makeReply();
    const state2 = makeState();
    await mw.beforeAgent?.(makeCtx(request, res2, { startTime: 0 }), state2);
    expect(state2.aborted).toBe(false);
  });

  it('skips when requiresRateLimit returns false', async () => {
    const configProvider = { getConfig: () => makeConfig({ rateLimiting: { enabled: true } as any }) };
    const mw = new RateLimitMiddleware(configProvider as any, { requiresRateLimit: () => false });
    const reply = makeReply();
    const request: any = { url: '/api/logs', method: 'GET', ip: '1.2.3.4', headers: {} };

    await mw.beforeAgent?.(makeCtx(request, reply), makeState());
    expect(reply.header).not.toHaveBeenCalled();
  });

  it('supports redis store via ioredis dynamic import', async () => {
    const mockClient: any = {
      incr: vi.fn(),
      pexpire: vi.fn(),
      pttl: vi.fn(),
      quit: vi.fn().mockResolvedValue(undefined)
    };
    mockClient.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    mockClient.pexpire.mockResolvedValueOnce(1);
    mockClient.pttl.mockResolvedValue(900);

    setIoredisClient(mockClient);

    const configProvider = {
      getConfig: () =>
        makeConfig({
          rateLimiting: {
            enabled: true,
            maxRequests: 1,
            windowMs: 1000,
            store: 'redis',
            redis: { url: 'redis://127.0.0.1:6379/0' }
          } as any
        })
    };
    const mw = new RateLimitMiddleware(configProvider as any);

    const request: any = { url: '/api/logs', method: 'GET', ip: '1.2.3.4', headers: { authorization: 'Bearer t' } };

    const r1 = makeReply();
    const s1 = makeState();
    await mw.beforeAgent?.(makeCtx(request, r1), s1);
    expect(s1.aborted).toBe(false);

    const r2 = makeReply();
    const s2 = makeState();
    await mw.beforeAgent?.(makeCtx(request, r2), s2);
    expect(s2.aborted).toBe(true);
    expect(r2.code).toHaveBeenCalledWith(429);

    expect(mockClient.incr).toHaveBeenCalledTimes(2);
    expect(mockClient.pexpire).toHaveBeenCalledTimes(1);

    await mw.shutdown();
    expect(mockClient.quit).toHaveBeenCalledTimes(1);
  });
});

import { setupMiddlewareWiring } from '../../server/MiddlewareWiring.js';
import type { GatewayConfig, Logger } from '../../types/index.js';

const { mockCorsPlugin, mockHelmetPlugin } = vi.hoisted(() => ({
  mockCorsPlugin: vi.fn(),
  mockHelmetPlugin: vi.fn()
}));

vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));
vi.mock('@fastify/helmet', () => ({ default: mockHelmetPlugin }));

type OriginFn = (origin: unknown, cb: (err: Error | null, allowed: boolean) => void) => void;

type HarnessOptions = {
  config?: Partial<GatewayConfig>;
  executeImpl?: (stage: string, ctx: any, state: any) => Promise<void> | void;
};

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const base: GatewayConfig = {
    port: 19233,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    routingStrategy: 'performance',
    loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10,
    requestTimeout: 30000,
    enableMetrics: false,
    enableHealthChecks: false,
    healthCheckInterval: 30000,
    maxRetries: 1,
    enableCors: true,
    corsOrigins: ['http://localhost:3000'],
    maxRequestSize: 1024 * 1024,
    metricsRetentionDays: 1,
    rateLimiting: {
      enabled: false,
      maxRequests: 100,
      windowMs: 60000,
      store: 'memory'
    },
    logLevel: 'error'
  };

  return { ...base, ...overrides };
}

function makeRequestReply() {
  const listeners: Record<string, () => void> = {};
  const request: any = {
    method: 'GET',
    url: '/api/test',
    ip: '127.0.0.1',
    headers: {},
    raw: {
      on: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler;
      })
    }
  };

  const reply: any = {
    sent: false,
    statusCode: 200,
    raw: { headersSent: false }
  };

  return { request, reply, listeners };
}

function createHarness(options: HarnessOptions = {}) {
  const hooks: Record<string, (...args: any[]) => unknown> = {};
  const registrations: Array<{ plugin: unknown; opts: Record<string, unknown> }> = [];
  const server: any = {
    addHook: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
      hooks[name] = handler;
      return server;
    }),
    register: vi.fn((plugin: unknown, opts: Record<string, unknown>) => {
      registrations.push({ plugin, opts });
      return server;
    })
  };

  const middlewareChain = {
    execute: vi.fn(options.executeImpl || vi.fn().mockResolvedValue(undefined))
  };

  const mapResult = {
    status: 418,
    code: 'MW_FAIL',
    message: 'middleware failed',
    recoverable: false,
    meta: { source: 'test' }
  };

  const respondError = vi.fn();
  const mapMiddlewareError = vi.fn().mockReturnValue(mapResult);

  setupMiddlewareWiring(
    server,
    makeConfig(options.config),
    makeLogger(),
    middlewareChain as any,
    respondError,
    mapMiddlewareError
  );

  const corsOrigin = registrations.find((entry) => typeof entry.opts.origin === 'function')?.opts.origin as OriginFn;

  return {
    hooks,
    middlewareChain,
    respondError,
    mapMiddlewareError,
    mapResult,
    corsOrigin
  };
}

async function checkOrigin(originFn: OriginFn, origin: unknown) {
  return new Promise<{ err: Error | null; allowed: boolean }>((resolve) => {
    originFn(origin, (err, allowed) => resolve({ err, allowed }));
  });
}

describe('setupMiddlewareWiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('preHandler branches', () => {
    it('wires client aborted/close events into AbortSignal', async () => {
      const { request, reply, listeners } = makeRequestReply();
      const executeImpl = vi.fn(async (_stage: string, ctx: any) => {
        expect(ctx.signal.aborted).toBe(false);
        listeners.close();
        expect(ctx.signal.aborted).toBe(true);
        expect((ctx.signal.reason as Error).message).toBe('client closed');
        listeners.aborted();
      });

      const { hooks, middlewareChain } = createHarness({ executeImpl });
      await hooks.preHandler(request, reply);

      expect(request.raw.on).toHaveBeenCalledWith('aborted', expect.any(Function));
      expect(request.raw.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(middlewareChain.execute).toHaveBeenCalledWith('beforeAgent', expect.any(Object), expect.any(Object));
    });

    it('maps execute errors and responds via respondError', async () => {
      const boom = new Error('boom');
      const { hooks, mapMiddlewareError, respondError, mapResult } = createHarness({
        executeImpl: vi.fn().mockRejectedValue(boom)
      });
      const { request, reply } = makeRequestReply();

      await hooks.preHandler(request, reply);

      expect(mapMiddlewareError).toHaveBeenCalledWith(boom);
      expect(respondError).toHaveBeenCalledWith(reply, mapResult.status, mapResult.message, {
        code: mapResult.code,
        recoverable: mapResult.recoverable,
        meta: mapResult.meta
      });
    });

    it('handles mwState.aborted with fallback Request aborted error', async () => {
      const executeImpl = vi.fn(async (_stage: string, _ctx: any, state: any) => {
        state.aborted = true;
      });
      const { hooks, mapMiddlewareError, respondError } = createHarness({ executeImpl });
      const { request, reply } = makeRequestReply();

      await hooks.preHandler(request, reply);

      expect(mapMiddlewareError).toHaveBeenCalledWith(expect.any(Error));
      const mappedArg = mapMiddlewareError.mock.calls[0][0] as Error;
      expect(mappedArg.message).toBe('Request aborted');
      expect(respondError).toHaveBeenCalledTimes(1);
    });

    it('skips error response when reply is already sent', async () => {
      const { hooks, mapMiddlewareError, respondError } = createHarness({
        executeImpl: vi.fn().mockRejectedValue(new Error('boom'))
      });
      const { request, reply } = makeRequestReply();
      reply.raw.headersSent = true;

      await hooks.preHandler(request, reply);

      expect(mapMiddlewareError).not.toHaveBeenCalled();
      expect(respondError).not.toHaveBeenCalled();
    });
  });

  describe('CORS origin branches', () => {
    it('allows requests without origin', async () => {
      const { corsOrigin } = createHarness();
      const res = await checkOrigin(corsOrigin, undefined);

      expect(res.err).toBeNull();
      expect(res.allowed).toBe(true);
    });

    it('when CORS disabled only allows same-origin', async () => {
      const { corsOrigin } = createHarness({
        config: { enableCors: false, host: '127.0.0.1', port: 19233 }
      });

      const sameOrigin = await checkOrigin(corsOrigin, 'http://localhost:19233');
      const crossOrigin = await checkOrigin(corsOrigin, 'http://evil.example.com');

      expect(sameOrigin).toEqual({ err: null, allowed: true });
      expect(crossOrigin).toEqual({ err: null, allowed: false });
    });

    it('when CORS enabled validates self-origin variants', async () => {
      const { corsOrigin } = createHarness({
        config: { enableCors: true, host: 'localhost', port: 18888 }
      });

      const selfOrigin = await checkOrigin(corsOrigin, 'http://127.0.0.1:18888');
      expect(selfOrigin).toEqual({ err: null, allowed: true });
    });

    it('allows configured origins and trailing slash variants', async () => {
      const { corsOrigin } = createHarness({
        config: { corsOrigins: ['https://app.example.com/'] }
      });

      const exact = await checkOrigin(corsOrigin, 'https://app.example.com/');
      const slashVariant = await checkOrigin(corsOrigin, 'https://app.example.com');

      expect(exact).toEqual({ err: null, allowed: true });
      expect(slashVariant).toEqual({ err: null, allowed: true });
    });

    it('returns CORS errors for blocked or malformed origins', async () => {
      const { corsOrigin } = createHarness();

      const blocked = await checkOrigin(corsOrigin, 'https://evil.example.com');
      const malformed = await checkOrigin(corsOrigin, {
        replace() {
          throw new Error('origin parse failed');
        }
      });

      expect(blocked.allowed).toBe(false);
      expect(blocked.err?.message).toBe('CORS origin not allowed');
      expect(malformed.allowed).toBe(false);
      expect(malformed.err?.message).toBe('origin parse failed');
    });
  });
});

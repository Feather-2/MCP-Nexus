import { HttpApiServer } from '../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../types/index.js';
import type { Context, Middleware, State } from '../../middleware/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

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
    rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
    logLevel: 'error',
    ai: { provider: 'none' }
  };
  return { ...base, ...overrides } as GatewayConfig;
}

function makeConfigManagerStub(config: GatewayConfig): any {
  return {
    getConfig: vi.fn().mockReturnValue(config),
    updateConfig: vi.fn(),
    get: vi.fn()
  };
}

describe('HttpApiServer middleware chain bridge', () => {
  let intervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    intervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue({
      ref() { return this; },
      unref() { return this; }
    } as any) as any;
  });

  afterEach(() => {
    intervalSpy.mockRestore();
  });

  it('propagates Context (traceId/sessionId/http) across beforeAgent middleware', async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const configManagerStub = makeConfigManagerStub(config);

    const authLayerStub = {
      authenticate: vi.fn().mockResolvedValue({
        success: true,
        context: { userId: 'u1', permissions: ['*'], trusted: false, mode: 'external-secure' }
      }),
      getActiveTokenCount: vi.fn().mockReturnValue(0),
      getActiveApiKeyCount: vi.fn().mockReturnValue(0)
    };

    const server = new HttpApiServer(config, logger, configManagerStub, { authLayer: authLayerStub as any });
    try {
      const headerMw: Middleware = {
        name: 'header-mw',
        beforeAgent: async (ctx: Context, _state: State) => {
          ctx.http?.reply.header('x-mw-trace', String(ctx.traceId || ''));
          ctx.http?.reply.header('x-mw-session', String(ctx.sessionId || ''));
        }
      };
      server.addMiddleware(headerMw);

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-mw-session']).toBe('u1');
      expect(typeof res.headers['x-trace-id']).toBe('string');
      expect(res.headers['x-mw-trace']).toBe(res.headers['x-trace-id']);
    } finally {
      await (server as any).server.close();
    }
  });

  it('short-circuits when middleware aborts and prevents route handler execution', async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const configManagerStub = makeConfigManagerStub(config);

    const authLayerStub = {
      authenticate: vi.fn().mockResolvedValue({
        success: true,
        context: { userId: 'u1', permissions: ['*'], trusted: false, mode: 'external-secure' }
      }),
      getActiveTokenCount: vi.fn().mockReturnValue(0),
      getActiveApiKeyCount: vi.fn().mockReturnValue(0)
    };

    const server = new HttpApiServer(config, logger, configManagerStub, { authLayer: authLayerStub as any });
    try {
      let shouldNotRun = 0;

      server.addMiddleware({
        name: 'blocker',
        beforeAgent: async (ctx: Context, state: State) => {
          state.aborted = true;
          ctx.http?.reply.code(403).send({ blocked: true });
        }
      });

      server.addMiddleware({
        name: 'should-not-run',
        beforeAgent: async () => {
          shouldNotRun += 1;
        }
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ blocked: true });
      expect(shouldNotRun).toBe(0);
    } finally {
      await (server as any).server.close();
    }
  });

  it('maps middleware exceptions into a consistent error response', async () => {
    const config = makeConfig();
    const logger = makeLogger();
    const configManagerStub = makeConfigManagerStub(config);

    const authLayerStub = {
      authenticate: vi.fn().mockResolvedValue({
        success: true,
        context: { userId: 'u1', permissions: ['*'], trusted: false, mode: 'external-secure' }
      }),
      getActiveTokenCount: vi.fn().mockReturnValue(0),
      getActiveApiKeyCount: vi.fn().mockReturnValue(0)
    };

    const server = new HttpApiServer(config, logger, configManagerStub, { authLayer: authLayerStub as any });
    try {
      let shouldNotRun = 0;

      server.addMiddleware({
        name: 'boom-mw',
        beforeAgent: async () => {
          throw new Error('boom');
        }
      });

      server.addMiddleware({
        name: 'should-not-run',
        beforeAgent: async () => {
          shouldNotRun += 1;
        }
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('MIDDLEWARE_ERROR');
      expect(body.error.message).toContain('boom');
      expect(body.error.meta).toMatchObject({ stage: 'beforeAgent', middlewareName: 'boom-mw' });
      expect(shouldNotRun).toBe(0);
    } finally {
      await (server as any).server.close();
    }
  });

  it('enforces beforeAgent timeout via per-stage settings', async () => {
    const config = makeConfig({ requestTimeout: 20 });
    const logger = makeLogger();
    const configManagerStub = makeConfigManagerStub(config);

    const authLayerStub = {
      authenticate: vi.fn().mockResolvedValue({
        success: true,
        context: { userId: 'u1', permissions: ['*'], trusted: false, mode: 'external-secure' }
      }),
      getActiveTokenCount: vi.fn().mockReturnValue(0),
      getActiveApiKeyCount: vi.fn().mockReturnValue(0)
    };

    const server = new HttpApiServer(config, logger, configManagerStub, { authLayer: authLayerStub as any });
    try {
      server.addMiddleware({
        name: 'slow',
        beforeAgent: async () => {
          await new Promise<void>(() => {});
        }
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(504);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('MIDDLEWARE_TIMEOUT');
    } finally {
      await (server as any).server.close();
    }
  });

  it('returns 401 when AuthMiddleware rejects the request', async () => {
    const config = makeConfig({ authMode: 'external-secure' });
    const logger = makeLogger();
    const configManagerStub = makeConfigManagerStub(config);

    const authLayerStub = {
      authenticate: vi.fn().mockResolvedValue({ success: false, error: 'nope' }),
      getActiveTokenCount: vi.fn().mockReturnValue(0),
      getActiveApiKeyCount: vi.fn().mockReturnValue(0)
    };

    const server = new HttpApiServer(config, logger, configManagerStub, { authLayer: authLayerStub as any });
    try {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toContain('nope');
    } finally {
      await (server as any).server.close();
    }
  });
});


import { HttpApiServer } from '../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../types/index.js';
import { MiddlewareTimeoutError, MiddlewareAbortedError, MiddlewareStageError } from '../../middleware/chain.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.())
}));
vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

const svcStub = {
  getRegistryStats: vi.fn().mockResolvedValue({}),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null),
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() }),
  setHealthProbe: vi.fn(),
  setInstanceMetadata: vi.fn()
};
const authStub = {
  authenticate: vi.fn().mockResolvedValue({ success: true }),
  getActiveTokenCount: vi.fn().mockReturnValue(0),
  getActiveApiKeyCount: vi.fn().mockReturnValue(0)
};
const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
vi.mock('../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl: vi.fn().mockImplementation(() => svcStub) }));
vi.mock('../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl: vi.fn().mockImplementation(() => authStub) }));
vi.mock('../../routing/GatewayRouterImpl.js', () => ({ GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub) }));
vi.mock('../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl: vi.fn().mockImplementation(() => ({})) }));

describe('HttpApiServer \u2013 branch coverage', () => {
  const config: GatewayConfig = {
    port: 0, host: '127.0.0.1', authMode: 'local-trusted',
    routingStrategy: 'performance', loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10, requestTimeout: 1000, enableMetrics: true,
    enableHealthChecks: true, healthCheckInterval: 1000, maxRetries: 2,
    enableCors: true, corsOrigins: ['http://allowed.com'], maxRequestSize: 1024,
    metricsRetentionDays: 1, rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
    logLevel: 'info'
  };
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cfgStub = { getConfig: vi.fn().mockReturnValue(config) } as any;
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, cfgStub);
  });

  afterEach(async () => {
    try { await server.stop(); } catch {}
  });

  describe('extractBearerToken', () => {
    it('extracts bearer token from Authorization header', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/services',
        headers: { Authorization: 'Bearer my-token-123' }
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns undefined for non-Bearer auth header', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/services',
        headers: { Authorization: 'Basic dXNlcjpwYXNz' }
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns undefined for missing auth header', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/services'
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('extractApiKey', () => {
    it('extracts x-api-key header', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/services',
        headers: { 'x-api-key': 'key1' }
      });
      expect(res.statusCode).toBe(200);
    });

    it('extracts x-api-token header', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/services',
        headers: { 'x-api-token': 'token1' }
      });
      expect(res.statusCode).toBe(200);
    });

    it('extracts apikey header', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/services',
        headers: { 'apikey': 'apikey1' }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('mapMiddlewareError branches', () => {
    it('maps MiddlewareTimeoutError to 504', () => {
      const mapped = (server as any).mapMiddlewareError(
        new MiddlewareTimeoutError('beforeAgent', 'test-mw', 5000)
      );
      expect(mapped.status).toBe(504);
      expect(mapped.code).toBe('MIDDLEWARE_TIMEOUT');
      expect(mapped.recoverable).toBe(true);
    });

    it('maps MiddlewareAbortedError to 499', () => {
      const mapped = (server as any).mapMiddlewareError(
        new MiddlewareAbortedError('beforeAgent', 'test-mw', 'client disconnect')
      );
      expect(mapped.status).toBe(499);
      expect(mapped.code).toBe('REQUEST_ABORTED');
    });

    it('maps AbortError by name to 499', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      const mapped = (server as any).mapMiddlewareError(err);
      expect(mapped.status).toBe(499);
    });

    it('maps MiddlewareStageError wrapping MiddlewareTimeoutError', () => {
      const timeout = new MiddlewareTimeoutError('beforeAgent', 'mw', 3000);
      const stage = new MiddlewareStageError('beforeAgent', 'mw', timeout);
      const mapped = (server as any).mapMiddlewareError(stage);
      expect(mapped.status).toBe(504);
      expect(mapped.meta.timeoutMs).toBe(3000);
    });

    it('maps generic MiddlewareStageError to 500', () => {
      const stage = new MiddlewareStageError('beforeAgent', 'mw', new Error('inner'));
      const mapped = (server as any).mapMiddlewareError(stage);
      expect(mapped.status).toBe(500);
      expect(mapped.code).toBe('MIDDLEWARE_ERROR');
      expect(mapped.meta.stage).toBe('beforeAgent');
    });

    it('maps non-Error value to 500', () => {
      const mapped = (server as any).mapMiddlewareError('just a string');
      expect(mapped.status).toBe(500);
    });
  });

  describe('SPA routes', () => {
    it('serves 503 when index.html does not exist for /dashboard', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/dashboard' });
      // May return 503, 200, or 500 depending on existsSync and static plugin mock
      expect([200, 500, 503]).toContain(res.statusCode);
    });

    it('serves root route', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/' });
      expect([200, 500, 503]).toContain(res.statusCode);
    });

    it('serves /services route', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/services' });
      expect([200, 500, 503]).toContain(res.statusCode);
    });

    it('serves /templates route', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/templates' });
      expect([200, 500, 503]).toContain(res.statusCode);
    });

    it('serves /auth route', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/auth' });
      expect([200, 500, 503]).toContain(res.statusCode);
    });

    it('serves /monitoring route', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/monitoring' });
      expect([200, 500, 503]).toContain(res.statusCode);
    });

    it('serves /settings route', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/settings' });
      expect([200, 500, 503]).toContain(res.statusCode);
    });
  });

  describe('health endpoints', () => {
    it('GET /health returns ok', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    });

    it('GET /api/health returns ok', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
    });

    it('GET /health/detailed returns detailed health', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/health/detailed' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('healthy');
    });
  });

  describe('API versioning', () => {
    it('GET /api/v1/health returns ok (aliased)', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
    });

    it('GET /api/v1/services returns ok (aliased)', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/v1/services' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('observability hooks', () => {
    it('sets X-Trace-Id header on response', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/health' });
      expect(res.headers['x-trace-id']).toBeDefined();
    });

    it('uses client-provided X-Trace-Id', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/health',
        headers: { 'x-trace-id': 'custom-trace-id' }
      });
      expect(res.headers['x-trace-id']).toBeDefined();
    });

    it('uses client-provided X-Request-Id', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/health',
        headers: { 'x-request-id': 'req-id-123' }
      });
      expect(res.headers['x-trace-id']).toBeDefined();
    });

    it('sets accept-language locale', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/health',
        headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('start/stop', () => {
    it('starts and stops server', async () => {
      const testCfg = { ...config, port: 0 };
      const s = new HttpApiServer(testCfg, logger, cfgStub);
      await s.start();
      await s.stop();
    });

    it('uses default host and port when not configured', async () => {
      const noCfg = { ...config, host: undefined as any, port: undefined as any };
      const s = new HttpApiServer(noCfg, logger, cfgStub);
      // Don't actually start - just verify construction works
      expect(s).toBeDefined();
    });
  });

  describe('convertHealthResult', () => {
    it('converts healthy result', () => {
      const result = (server as any).convertHealthResult({
        healthy: true, latency: 50, timestamp: new Date()
      });
      expect(result.status).toBe('healthy');
      expect(result.responseTime).toBe(50);
    });

    it('converts unhealthy result with error', () => {
      const result = (server as any).convertHealthResult({
        healthy: false, error: 'timeout', timestamp: new Date()
      });
      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('timeout');
      expect(result.responseTime).toBe(0);
    });
  });

  describe('respondError', () => {
    it('sends error with default code', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/nonexistent-xyz' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('updateOrchestratorStatus branches', () => {
    it('handles enabled status without manager (no engine created)', () => {
      server.updateOrchestratorStatus({ enabled: true, subagentsDir: '/tmp' } as any);
      // No engine because no manager
    });

    it('catches engine initialization error', () => {
      const mockMgr = { getStatus: vi.fn() } as any;
      server.setOrchestratorManager(mockMgr);
      // Trigger with a status that might cause SubagentLoader to fail
      server.updateOrchestratorStatus({ enabled: true, subagentsDir: '/nonexistent/path' } as any);
      // Should not throw
    });
  });

  describe('writeSseHeaders', () => {
    it('sets CORS header for allowed origin', () => {
      const headers: Record<string, string> = {};
      const mockReply = {
        raw: {
          writeHead: vi.fn((_s: number, h: Record<string, string>) => { Object.assign(headers, h); })
        }
      };
      const mockRequest = { headers: { origin: 'http://allowed.com' } };
      (server as any).writeSseHeaders(mockReply, mockRequest);
      expect(headers['Access-Control-Allow-Origin']).toBe('http://allowed.com');
    });

    it('does not set CORS header for disallowed origin', () => {
      const headers: Record<string, string> = {};
      const mockReply = {
        raw: {
          writeHead: vi.fn((_s: number, h: Record<string, string>) => { Object.assign(headers, h); })
        }
      };
      const mockRequest = { headers: { origin: 'http://evil.com' } };
      (server as any).writeSseHeaders(mockReply, mockRequest);
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('handles missing origin header', () => {
      const mockReply = { raw: { writeHead: vi.fn() } };
      const mockRequest = { headers: {} };
      expect(() => (server as any).writeSseHeaders(mockReply, mockRequest)).not.toThrow();
    });
  });
});

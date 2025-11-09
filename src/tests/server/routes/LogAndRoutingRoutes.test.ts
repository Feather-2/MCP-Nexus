import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

const serviceRegistryStub = {
  getRegistryStats: vi.fn().mockResolvedValue({}),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null),
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() })
};

const authLayerStub = {
  authenticate: vi.fn().mockResolvedValue({ success: true }),
  getActiveTokenCount: vi.fn().mockReturnValue(0),
  getActiveApiKeyCount: vi.fn().mockReturnValue(0)
};

const routerStub = { getMetrics: vi.fn().mockReturnValue({}), route: vi.fn().mockResolvedValue({ success: false, error: 'no services' }) };
const adaptersStub = {};

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub) }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl: vi.fn().mockImplementation(() => authLayerStub) }));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({ GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub) }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl: vi.fn().mockImplementation(() => adaptersStub) }));

describe('LogRoutes & RoutingRoutes - validation', () => {
  const config: GatewayConfig = {
    port: 0,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    routingStrategy: 'performance',
    loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10,
    requestTimeout: 1000,
    enableMetrics: true,
    enableHealthChecks: true,
    healthCheckInterval: 1000,
    maxRetries: 2,
    enableCors: true,
    corsOrigins: ['http://localhost:3000'],
    maxRequestSize: 1024,
    metricsRetentionDays: 1,
    rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
    logLevel: 'info'
  };
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const configManagerStub = { getConfig: vi.fn().mockReturnValue(config), get: vi.fn() } as any;
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
  });

  it('GET /api/logs validates limit', async () => {
    const bad = await (server as any).server.inject({ method: 'GET', url: '/api/logs?limit=abc' });
    expect(bad.statusCode).toBe(400);
    const ok = await (server as any).server.inject({ method: 'GET', url: '/api/logs?limit=10' });
    expect(ok.statusCode).toBe(200);
  });

  it('POST /api/route validates method and returns 503 when router has no services', async () => {
    const bad = await (server as any).server.inject({ method: 'POST', url: '/api/route', payload: {} });
    expect(bad.statusCode).toBe(400);
    const res = await (server as any).server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
    expect(res.statusCode).toBe(503);
  });

  it('POST /api/proxy/:serviceId validates param and returns 404 for missing service', async () => {
    const bad = await (server as any).server.inject({ method: 'POST', url: '/api/proxy//', payload: {} });
    expect([400,404]).toContain(bad.statusCode);
    // Send valid MCP message structure to test service not found (not input validation)
    const missing = await (server as any).server.inject({
      method: 'POST',
      url: '/api/proxy/abc',
      payload: { method: 'tools/list', params: {} }
    });
    expect(missing.statusCode).toBe(404);
  });
});


import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const {
  mockStaticPlugin, mockCorsPlugin,
  svcStub, authStub, routerStub, cfgManagerStub,
  ServiceRegistryImpl, AuthenticationLayerImpl, GatewayRouterImpl, ProtocolAdaptersImpl
} = vi.hoisted(() => {
  const svcStub = {
    getRegistryStats: vi.fn().mockResolvedValue({}),
    listServices: vi.fn().mockResolvedValue([]),
    getService: vi.fn().mockResolvedValue(null),
    checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() })
  };
  const authStub = { authenticate: vi.fn().mockResolvedValue({ success: true }), getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) };
  const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
  const cfgManagerStub = {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    get: vi.fn(),
    exportConfig: vi.fn(),
    importConfig: vi.fn()
  };
  return {
    mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
    mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
    svcStub, authStub, routerStub, cfgManagerStub,
    ServiceRegistryImpl: vi.fn().mockImplementation(function () { return svcStub; }),
    AuthenticationLayerImpl: vi.fn().mockImplementation(function () { return authStub; }),
    GatewayRouterImpl: vi.fn().mockImplementation(function () { return routerStub; }),
    ProtocolAdaptersImpl: vi.fn().mockImplementation(function () { return {}; }),
  };
});

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));
vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl }));
vi.mock('../../../routing/GatewayRouterImpl.js', () => ({ GatewayRouterImpl }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl }));

describe('ConfigRoutes – branch coverage', () => {
  const config: GatewayConfig = {
    port: 0, host: '127.0.0.1', authMode: 'local-trusted',
    routingStrategy: 'performance', loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10, requestTimeout: 1000, enableMetrics: true,
    enableHealthChecks: true, healthCheckInterval: 1000, maxRetries: 2,
    enableCors: true, corsOrigins: ['*'], maxRequestSize: 1024,
    metricsRetentionDays: 1, rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
    logLevel: 'info'
  };
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    cfgManagerStub.getConfig.mockReturnValue(config);
    server = new HttpApiServer(config, logger, cfgManagerStub as any);
  });

  // ── GET /api/config ──
  it('GET /api/config returns config', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/config returns 500 on error', async () => {
    cfgManagerStub.getConfig.mockImplementationOnce(() => { throw new Error('boom'); });
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(500);
  });

  // ── PUT /api/config ──
  it('PUT /api/config updates config', async () => {
    cfgManagerStub.updateConfig.mockResolvedValueOnce({ ...config, logLevel: 'debug' });
    const res = await (server as any).server.inject({
      method: 'PUT', url: '/api/config',
      payload: { logLevel: 'debug' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('PUT /api/config returns 400 for invalid payload', async () => {
    const res = await (server as any).server.inject({
      method: 'PUT', url: '/api/config',
      payload: { port: 'not-a-number' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/config returns 500 on update error', async () => {
    cfgManagerStub.updateConfig.mockRejectedValueOnce(new Error('save fail'));
    const res = await (server as any).server.inject({
      method: 'PUT', url: '/api/config',
      payload: { logLevel: 'debug' }
    });
    expect(res.statusCode).toBe(500);
  });

  // ── GET /api/config/:key ──
  it('GET /api/config/:key returns value', async () => {
    cfgManagerStub.get.mockResolvedValueOnce(8080);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/config/port' });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe(8080);
  });

  it('GET /api/config/:key returns 404 for missing key', async () => {
    cfgManagerStub.get.mockResolvedValueOnce(null);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/config/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/config/:key returns 500 on error', async () => {
    cfgManagerStub.get.mockRejectedValueOnce(new Error('read fail'));
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/config/port' });
    expect(res.statusCode).toBe(500);
  });
});

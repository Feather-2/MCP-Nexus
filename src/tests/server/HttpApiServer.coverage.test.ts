import { HttpApiServer } from '../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../types/index.js';

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
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() })
};
const authStub = { authenticate: vi.fn().mockResolvedValue({ success: true }), getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) };
const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
vi.mock('../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl: vi.fn().mockImplementation(() => svcStub) }));
vi.mock('../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl: vi.fn().mockImplementation(() => authStub) }));
vi.mock('../../router/GatewayRouterImpl.js', () => ({ GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub) }));
vi.mock('../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl: vi.fn().mockImplementation(() => ({})) }));

describe('HttpApiServer – extended coverage', () => {
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
  const cfgStub = { getConfig: vi.fn().mockReturnValue(config) } as any;
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, cfgStub);
  });

  it('returns 404 for unknown route', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/nonexistent-route-xyz' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe('Not Found');
  });

  it('getServer returns fastify instance', () => {
    expect(server.getServer()).toBeDefined();
    expect(typeof server.getServer().inject).toBe('function');
  });

  it('getServiceRegistry returns registry', () => {
    expect(server.getServiceRegistry()).toBeDefined();
  });

  it('getAuthLayer returns auth layer', () => {
    expect(server.getAuthLayer()).toBeDefined();
  });

  it('getRouter returns router', () => {
    expect(server.getRouter()).toBeDefined();
  });

  it('addMiddleware adds to chain', () => {
    const mw = { name: 'test-mw', execute: vi.fn() };
    server.addMiddleware(mw as any);
    // No throw means success
  });

  it('setOrchestratorManager sets manager', () => {
    const mockMgr = { getStatus: vi.fn() } as any;
    server.setOrchestratorManager(mockMgr);
  });

  it('updateOrchestratorStatus with null disables engine', () => {
    server.updateOrchestratorStatus(null);
  });

  it('updateOrchestratorStatus with enabled creates engine', () => {
    const mockMgr = { getStatus: vi.fn(), getConfig: vi.fn().mockReturnValue({}) } as any;
    server.setOrchestratorManager(mockMgr);
    server.updateOrchestratorStatus({ enabled: true, subagentsDir: '/tmp/subagents', subagentsCount: 0 } as any);
  });

  it('updateOrchestratorStatus with disabled clears engine', () => {
    server.updateOrchestratorStatus({ enabled: false } as any);
  });

  // Auth header extraction via authenticated routes
  it('GET /api/services with Bearer token', async () => {
    const res = await (server as any).server.inject({
      method: 'GET', url: '/api/services',
      headers: { Authorization: 'Bearer test-token-123' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/services with X-Api-Key header', async () => {
    const res = await (server as any).server.inject({
      method: 'GET', url: '/api/services',
      headers: { 'x-api-key': 'test-api-key' }
    });
    expect(res.statusCode).toBe(200);
  });
});

import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const {
  mockStaticPlugin, mockCorsPlugin,
  svcStub, authStub, routerStub,
  ServiceRegistryImpl, AuthenticationLayerImpl, GatewayRouterImpl, ProtocolAdaptersImpl
} = vi.hoisted(() => {
  const svcStub = {
    getRegistryStats: vi.fn().mockResolvedValue({
      totalTemplates: 2,
      totalInstances: 2,
      healthyInstances: 1,
      instancesByState: { running: 1, stopped: 1, error: 0 }
    }),
    listServices: vi.fn().mockResolvedValue([
      { id: 's1', config: { name: 'svc-a' }, state: 'running', startedAt: new Date(), errorCount: 0 },
      { id: 's2', config: { name: 'svc-b' }, state: 'stopped', startedAt: new Date(), errorCount: 0 }
    ]),
    getService: vi.fn().mockResolvedValue(null),
    checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date(), status: 'healthy', responseTime: 5 }),
    getHealthAggregates: vi.fn().mockResolvedValue({ total: 2, healthy: 1, unhealthy: 1 })
  };
  const authStub = { authenticate: vi.fn().mockResolvedValue({ success: true }), getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) };
  const routerStub = { getMetrics: vi.fn().mockReturnValue({ totalRequests: 100, successRate: 0.95, averageResponseTime: 50 }) };
  return {
    mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
    mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
    svcStub, authStub, routerStub,
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

describe('MonitoringRoutes – extended coverage', () => {
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
  const cfgStub = { getConfig: vi.fn().mockReturnValue(config), config } as any;
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, cfgStub);
  });

  it('GET /api/health-status returns summary', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/health-status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gateway.status).toBe('healthy');
    expect(body.services.total).toBe(2);
    expect(body.services.running).toBe(1);
    expect(typeof body.metrics.totalRequests).toBe('number');
  });

  it('GET /metrics returns Prometheus metrics', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain; version=0.0.4');
    expect(res.body).toContain('gateway_uptime_ms');
    expect(res.body).toContain('gateway_requests_total');
    expect(res.body).toContain('gateway_success_rate');
    expect(res.body).toContain('gateway_response_time_ms');
    expect(res.body).toContain('gateway_services_total');
    expect(res.body).toContain('gateway_services_running');
    expect(res.body).toContain('gateway_services_stopped');
    expect(res.body).toContain('gateway_services_error');
  });

  it('GET /api/metrics/registry returns stats', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/metrics/registry' });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toBeDefined();
  });

  it('GET /api/metrics/health returns aggregates', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/metrics/health' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/metrics/health returns 500 on error', async () => {
    svcStub.getHealthAggregates.mockRejectedValueOnce(new Error('fail'));
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/metrics/health' });
    expect(res.statusCode).toBe(500);
  });

  it('GET /api/metrics/router returns router metrics', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/metrics/router' });
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics).toBeDefined();
  });

  it('GET /api/metrics/services returns per-service metrics', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/metrics/services' });
    expect(res.statusCode).toBe(200);
    expect(res.json().serviceMetrics.length).toBe(2);
  });

  it('GET /api/metrics/services handles health check error per service', async () => {
    svcStub.checkHealth.mockRejectedValueOnce(new Error('probe fail'));
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/metrics/services' });
    expect(res.statusCode).toBe(200);
    const metrics = res.json().serviceMetrics;
    expect(metrics.some((m: any) => m.health.status === 'unhealthy')).toBe(true);
  });

  it('GET /api/performance/stats returns defaults when components are not configured', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/performance/stats' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.adapterPool).toEqual({ size: 0, maxSize: 0 });
    expect(body.toolListCache).toEqual({ size: 0, hits: 0, misses: 0, hitRate: 0 });
    expect(body.router).toBeDefined();
    expect(typeof body.timestamp).toBe('number');
  });

  it('GET /api/performance/stats returns stats from configured components', async () => {
    const mockCache = {
      getStats: vi.fn().mockReturnValue({ size: 5, hits: 30, misses: 10, hitRate: 0.75 }),
      clear: vi.fn()
    };
    const mockPool = {
      getStats: vi.fn().mockReturnValue({ size: 3, maxSize: 50 })
    };
    server.setPerformanceComponents(mockCache as any, mockPool as any);

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/performance/stats' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.adapterPool).toEqual({ size: 3, maxSize: 50 });
    expect(body.toolListCache).toEqual({ size: 5, hits: 30, misses: 10, hitRate: 0.75 });
    expect(mockPool.getStats).toHaveBeenCalledTimes(1);
    expect(mockCache.getStats).toHaveBeenCalledTimes(1);
  });

  it('POST /api/performance/cache/clear returns 503 when cache is not configured', async () => {
    const res = await (server as any).server.inject({ method: 'POST', url: '/api/performance/cache/clear' });
    expect(res.statusCode).toBe(503);

    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_CONFIGURED');
  });

  it('POST /api/performance/cache/clear clears configured cache', async () => {
    const mockCache = {
      getStats: vi.fn().mockReturnValue({ size: 5, hits: 30, misses: 10, hitRate: 0.75 }),
      clear: vi.fn()
    };
    const mockPool = {
      getStats: vi.fn().mockReturnValue({ size: 3, maxSize: 50 })
    };
    server.setPerformanceComponents(mockCache as any, mockPool as any);

    const res = await (server as any).server.inject({ method: 'POST', url: '/api/performance/cache/clear' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, message: 'Tool list cache cleared' });
    expect(mockCache.clear).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

const serviceRegistryStub = {
  getRegistryStats: vi.fn().mockResolvedValue({ total: 0 }),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null),
  getHealthAggregates: vi.fn().mockResolvedValue({ global: { monitoring: 0, healthy: 0, unhealthy: 0, avgLatency: 0 }, perService: [] }),
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() })
};

const authLayerStub = {
  authenticate: vi.fn().mockResolvedValue({ success: true }),
  getActiveTokenCount: vi.fn().mockReturnValue(0),
  getActiveApiKeyCount: vi.fn().mockReturnValue(0)
};

const routerStub = { getMetrics: vi.fn().mockReturnValue({ totalRequests: 0, successRate: 1, averageResponseTime: 0 }) };
const adaptersStub = {};

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub) }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl: vi.fn().mockImplementation(() => authLayerStub) }));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({ GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub) }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl: vi.fn().mockImplementation(() => adaptersStub) }));

describe('MonitoringRoutes - health and metrics', () => {
  const baseConfig: GatewayConfig = {
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

  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it('GET /api/health/ratelimit returns memory when disabled', async () => {
    const configManagerStub = { getConfig: vi.fn().mockReturnValue(baseConfig) } as any;
    const server = new HttpApiServer(baseConfig, logger, configManagerStub);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/health/ratelimit' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, store: 'memory' });
  });

  it('GET /api/health/ratelimit checks redis when enabled', async () => {
    // mock ioredis default export
    vi.mock('ioredis', () => ({ default: vi.fn().mockImplementation(() => ({ ping: vi.fn().mockResolvedValue('PONG'), quit: vi.fn().mockResolvedValue(undefined) })) }));

    const cfg = { ...baseConfig, rateLimiting: { enabled: true, maxRequests: 100, windowMs: 60000, store: 'redis', redis: { url: 'redis://127.0.0.1:6379/0' } } } as any;
    const configManagerStub = { getConfig: vi.fn().mockReturnValue(cfg) } as any;
    const server = new HttpApiServer(cfg, logger, configManagerStub);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/health/ratelimit' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.store).toBe('redis');
    expect([true, false]).toContain(body.connected);
  });

  it('GET /api/health-status returns summary', async () => {
    const configManagerStub = { getConfig: vi.fn().mockReturnValue(baseConfig) } as any;
    const server = new HttpApiServer(baseConfig, logger, configManagerStub);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/health-status' });
    expect(res.statusCode).toBe(200);
  });
});


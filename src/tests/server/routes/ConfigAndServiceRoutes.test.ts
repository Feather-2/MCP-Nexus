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
  getRegistryStats: vi.fn().mockResolvedValue({}),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null),
  createServiceFromTemplate: vi.fn().mockResolvedValue('svc-1'),
  stopService: vi.fn().mockResolvedValue(true),
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() })
};

const authLayerStub = {
  authenticate: vi.fn().mockResolvedValue({ success: true }),
  getActiveTokenCount: vi.fn().mockReturnValue(0),
  getActiveApiKeyCount: vi.fn().mockReturnValue(0)
};

const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
const adaptersStub = {};

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({
  ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub)
}));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({
  AuthenticationLayerImpl: vi.fn().mockImplementation(() => authLayerStub)
}));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({
  GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub)
}));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({
  ProtocolAdaptersImpl: vi.fn().mockImplementation(() => adaptersStub)
}));

describe('ConfigRoutes and ServiceRoutes - validation', () => {
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
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const configManagerStub = {
    getConfig: vi.fn().mockReturnValue(config),
    get: vi.fn().mockResolvedValue(null),
    updateConfig: vi.fn().mockImplementation(async (patch: Partial<GatewayConfig>) => ({ ...config, ...patch }))
  } as any;

  let server: HttpApiServer;
  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
  });

  it('GET /api/config returns configuration', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().host).toBe('127.0.0.1');
  });

  it('PUT /api/config rejects invalid payload', async () => {
    const bad = await (server as any).server.inject({ method: 'PUT', url: '/api/config', payload: { port: 'not-number' } });
    expect(bad.statusCode).toBe(400);
    const ok = await (server as any).server.inject({ method: 'PUT', url: '/api/config', payload: { port: 9999 } });
    expect(ok.statusCode).toBe(200);
  });

  it('GET /api/config/:key validates key and returns 404 for missing', async () => {
    const bad = await (server as any).server.inject({ method: 'GET', url: '/api/config/' });
    expect([400,404]).toContain(bad.statusCode);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/config/not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/services validates body and creates service', async () => {
    const bad = await (server as any).server.inject({ method: 'POST', url: '/api/services', payload: {} });
    expect(bad.statusCode).toBe(400);
    const ok = await (server as any).server.inject({ method: 'POST', url: '/api/services', payload: { templateName: 'demo' } });
    expect(ok.statusCode).toBe(201);
  });

  it('PATCH /api/services/:id/env validates params and body', async () => {
    const bad = await (server as any).server.inject({ method: 'PATCH', url: '/api/services//env', payload: { env: { A: '1' } } });
    expect([400,404]).toContain(bad.statusCode);
  });
});

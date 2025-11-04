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
  registerTemplate: vi.fn().mockResolvedValue(undefined)
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

describe('GeneratorRoutes - validation and flow', () => {
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
    updateConfig: vi.fn(),
    get: vi.fn()
  } as any;

  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);

    // Provide mcpGenerator stub
    (server as any).mcpGenerator = {
      generate: vi.fn().mockResolvedValue({ success: true, template: { name: 'svc', config: { name: 'svc', version: '2024-11-26', transport: 'stdio' }, tools: [] } }),
      export: vi.fn().mockResolvedValue({ success: true, format: 'json', data: {} }),
      import: vi.fn().mockResolvedValue({ success: true, template: { name: 'svc', config: { name: 'svc', version: '2024-11-26', transport: 'stdio' } } }),
      getExportedFile: vi.fn().mockImplementation(async (name: string) => name === 'ok.json' ? JSON.stringify({}) : null)
    };
  });

  it('POST /api/generator/generate validates body', async () => {
    const bad = await (server as any).server.inject({ method: 'POST', url: '/api/generator/generate', payload: {} });
    expect(bad.statusCode).toBe(400);

    const ok = await (server as any).server.inject({ method: 'POST', url: '/api/generator/generate', payload: { source: { type: 'markdown', content: '# API' } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);
  });

  it('POST /api/generator/export validates body', async () => {
    const bad = await (server as any).server.inject({ method: 'POST', url: '/api/generator/export', payload: {} });
    expect(bad.statusCode).toBe(400);
    const ok = await (server as any).server.inject({ method: 'POST', url: '/api/generator/export', payload: { templateName: 'svc', format: 'json' } });
    expect(ok.statusCode).toBe(200);
  });

  it('POST /api/generator/import validates body', async () => {
    const bad = await (server as any).server.inject({ method: 'POST', url: '/api/generator/import', payload: {} });
    expect(bad.statusCode).toBe(400);
    const ok = await (server as any).server.inject({ method: 'POST', url: '/api/generator/import', payload: { source: { type: 'json', content: {} } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);
  });

  it('GET /api/generator/download returns 404 for missing and 200 for existing', async () => {
    const missing = await (server as any).server.inject({ method: 'GET', url: '/api/generator/download/missing.zip' });
    expect(missing.statusCode).toBe(404);

    const ok = await (server as any).server.inject({ method: 'GET', url: '/api/generator/download/ok.json' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('application/json');
  });

  it('POST /api/generator/marketplace/install installs fallback item', async () => {
    const res = await (server as any).server.inject({ method: 'POST', url: '/api/generator/marketplace/install', payload: { templateId: 'filesystem' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(serviceRegistryStub.registerTemplate).toHaveBeenCalled();
  });
});


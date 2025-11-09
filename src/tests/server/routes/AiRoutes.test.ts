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
  getService: vi.fn().mockResolvedValue(null)
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

describe('AiRoutes - config and chat validation', () => {
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

  const aiConfig = { provider: 'none', model: '', endpoint: '', timeoutMs: 1000, streaming: true };
  const configManagerStub = {
    getConfig: vi.fn().mockReturnValue(config),
    get: vi.fn().mockImplementation((key: string) => key === 'ai' ? aiConfig : undefined),
    update: vi.fn(),
    updateConfig: vi.fn().mockImplementation(async (patch: any) => ({ ...config, ...patch }))
  } as any;

  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
  });

  it('GET /api/ai/config returns config', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/ai/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ config: aiConfig });
  });

  it('PUT /api/ai/config validates body with zod', async () => {
    const bad = await (server as any).server.inject({ method: 'PUT', url: '/api/ai/config', payload: { timeoutMs: 'oops' } });
    expect(bad.statusCode).toBe(400);

    const ok = await (server as any).server.inject({ method: 'PUT', url: '/api/ai/config', payload: { provider: 'none', timeoutMs: 1500 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);
  });

  it('POST /api/ai/chat validates messages and returns heuristic fallback', async () => {
    const bad = await (server as any).server.inject({ method: 'POST', url: '/api/ai/chat', payload: { messages: [] } });
    expect(bad.statusCode).toBe(400);

    const ok = await (server as any).server.inject({ method: 'POST', url: '/api/ai/chat', payload: { messages: [{ role: 'user', content: 'help me' }] } });
    expect(ok.statusCode).toBe(200);
    const data = ok.json();
    expect(data.success).toBe(true);
    expect(data.message?.role).toBe('assistant');
  });
});


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
  listTemplates: vi.fn().mockResolvedValue([]),
  getTemplate: vi.fn().mockResolvedValue(null),
  registerTemplate: vi.fn().mockResolvedValue(undefined),
  removeTemplate: vi.fn().mockResolvedValue(undefined)
};

const authLayerStub = {
  authenticate: vi.fn().mockResolvedValue({ success: true }),
  getActiveTokenCount: vi.fn().mockReturnValue(0),
  getActiveApiKeyCount: vi.fn().mockReturnValue(0)
};

const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
const adaptersStub = {};

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub) }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl: vi.fn().mockImplementation(() => authLayerStub) }));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({ GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub) }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl: vi.fn().mockImplementation(() => adaptersStub) }));

describe('TemplateRoutes - validation & operations', () => {
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

  it('POST /api/templates validates body', async () => {
    const bad = await (server as any).server.inject({ method: 'POST', url: '/api/templates', payload: {} });
    expect(bad.statusCode).toBe(400);
    const okPayload = { name: 'svc', version: '2024-11-26', transport: 'stdio' };
    const ok = await (server as any).server.inject({ method: 'POST', url: '/api/templates', payload: okPayload });
    expect(ok.statusCode).toBe(201);
  });

  it('GET /api/templates/:name validates param and 404 when missing', async () => {
    const bad = await (server as any).server.inject({ method: 'GET', url: '/api/templates/' });
    expect([400,404]).toContain(bad.statusCode);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/templates/repair calls templateManager.initializeDefaults', async () => {
    (serviceRegistryStub as any).templateManager = { initializeDefaults: vi.fn().mockResolvedValue(undefined) };
    const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair' });
    expect(res.statusCode).toBe(200);
    expect((serviceRegistryStub as any).templateManager.initializeDefaults).toHaveBeenCalled();
  });

  it('POST /api/templates/repair-images repairs missing image based on command', async () => {
    serviceRegistryStub.listTemplates.mockResolvedValueOnce([
      { name: 'py-svc', version: '2024-11-26', transport: 'stdio', command: 'python', env: { SANDBOX: 'container' } },
      { name: 'node-svc', version: '2024-11-26', transport: 'stdio', command: 'npm', env: { SANDBOX: 'container' } }
    ]);
    const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair-images' });
    expect(res.statusCode).toBe(200);
    expect(serviceRegistryStub.registerTemplate).toHaveBeenCalled();
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.fixed).toBeGreaterThanOrEqual(1);
  });
});

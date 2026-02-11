import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const {
  mockStaticPlugin, mockCorsPlugin,
  serviceRegistryStub, authLayerStub, routerStub, mockAdapter, adaptersStub,
  ServiceRegistryImpl, AuthenticationLayerImpl, GatewayRouterImpl, ProtocolAdaptersImpl
} = vi.hoisted(() => {
  const serviceRegistryStub = {
    getRegistryStats: vi.fn().mockResolvedValue({}),
    listServices: vi.fn().mockResolvedValue([]),
    getService: vi.fn().mockResolvedValue(null),
    setInstanceMetadata: vi.fn().mockResolvedValue(undefined),
    getTemplateManager: vi.fn().mockReturnValue({}),
    getTemplate: vi.fn().mockResolvedValue(null)
  };
  const authLayerStub = {
    authenticate: vi.fn().mockResolvedValue({ success: true }),
    getActiveTokenCount: vi.fn().mockReturnValue(0),
    getActiveApiKeyCount: vi.fn().mockReturnValue(0)
  };
  const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
  const mockAdapter = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: { tools: [{ name: 'tool1', description: 'A tool', inputSchema: {} }] } }),
    sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: { content: 'hello' } }),
    isConnected: vi.fn().mockReturnValue(true)
  };
  const adaptersStub = { createAdapter: vi.fn().mockResolvedValue(mockAdapter) };
  return {
    mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
    mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
    serviceRegistryStub, authLayerStub, routerStub, mockAdapter, adaptersStub,
    ServiceRegistryImpl: vi.fn().mockImplementation(function () { return serviceRegistryStub; }),
    AuthenticationLayerImpl: vi.fn().mockImplementation(function () { return authLayerStub; }),
    GatewayRouterImpl: vi.fn().mockImplementation(function () { return routerStub; }),
    ProtocolAdaptersImpl: vi.fn().mockImplementation(function () { return adaptersStub; }),
  };
});

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));
vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl }));
vi.mock('../../../routing/GatewayRouterImpl.js', () => ({ GatewayRouterImpl }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl }));

describe('ToolRoutes', () => {
  const config: GatewayConfig = {
    port: 0, host: '127.0.0.1', authMode: 'local-trusted',
    routingStrategy: 'performance', loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10, requestTimeout: 1000,
    enableMetrics: true, enableHealthChecks: true, healthCheckInterval: 1000,
    maxRetries: 2, enableCors: true, corsOrigins: ['http://localhost:3000'],
    maxRequestSize: 1024, metricsRetentionDays: 1,
    rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
    logLevel: 'info'
  };
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const configManagerStub = {
    getConfig: vi.fn().mockReturnValue(config),
    listTemplates: vi.fn().mockResolvedValue([
      { name: 'sqlite', transport: 'stdio', version: '1.0' }
    ]),
    get: vi.fn()
  } as any;

  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
  });

  it('GET /api/tools lists aggregated tools', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.tools).toBeInstanceOf(Array);
    expect(body.tools.length).toBeGreaterThanOrEqual(1);
    expect(body.tools[0].name).toBe('sqlite');
  });

  it('GET /api/tools/:toolId returns 404 for missing tool', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/tools/:toolId returns tool details when found', async () => {
    serviceRegistryStub.getTemplate.mockResolvedValueOnce({
      name: 'sqlite', transport: 'stdio', version: '1.0', healthCheck: { enabled: true }
    });
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/sqlite' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.tool.name).toBe('sqlite');
  });

  it('POST /api/tools/execute rejects invalid body', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/tools/execute', payload: {}
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/tools/execute returns 500 for missing tool', async () => {
    serviceRegistryStub.getTemplate.mockResolvedValueOnce(null);
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/tools/execute',
      payload: { toolId: 'missing-tool', params: {} }
    });
    expect(res.statusCode).toBe(500);
  });

  it('POST /api/tools/execute succeeds with valid tool', async () => {
    serviceRegistryStub.getTemplate.mockResolvedValue({
      name: 'sqlite', transport: 'stdio', version: '1.0'
    });
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/tools/execute',
      payload: { toolId: 'sqlite', params: { query: 'SELECT 1' } }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.executionId).toBeDefined();
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('POST /api/tools/batch rejects invalid body', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/tools/batch', payload: {}
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/tools/batch executes sequentially', async () => {
    serviceRegistryStub.getTemplate.mockResolvedValue({
      name: 'sqlite', transport: 'stdio', version: '1.0'
    });
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/tools/batch',
      payload: {
        calls: [
          { toolId: 'sqlite', params: { q: '1' } },
          { toolId: 'sqlite', params: { q: '2' } }
        ],
        options: { parallel: false, stopOnError: false }
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(2);
    expect(body.summary.total).toBe(2);
  });

  it('POST /api/tools/batch executes in parallel', async () => {
    serviceRegistryStub.getTemplate.mockResolvedValue({
      name: 'sqlite', transport: 'stdio', version: '1.0'
    });
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/tools/batch',
      payload: {
        calls: [{ toolId: 'sqlite', params: {} }],
        options: { parallel: true }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
  });

  it('GET /api/tools/history returns empty initially', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/history' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.history).toBeInstanceOf(Array);
  });

  it('GET /api/tools/history returns records after execution', async () => {
    serviceRegistryStub.getTemplate.mockResolvedValue({ name: 'sqlite', transport: 'stdio', version: '1.0' });
    await (server as any).server.inject({
      method: 'POST', url: '/api/tools/execute',
      payload: { toolId: 'sqlite', params: {} }
    });
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json().history.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/tools/history filters by toolId', async () => {
    serviceRegistryStub.getTemplate.mockResolvedValue({ name: 'sqlite', transport: 'stdio', version: '1.0' });
    await (server as any).server.inject({
      method: 'POST', url: '/api/tools/execute',
      payload: { toolId: 'sqlite', params: {} }
    });
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/history?toolId=nonexistent' });
    expect(res.statusCode).toBe(200);
    expect(res.json().history).toHaveLength(0);
  });
});

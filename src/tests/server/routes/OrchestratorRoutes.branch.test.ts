import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.())
}));
vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

const svcStub = {
  getRegistryStats: vi.fn().mockResolvedValue({}),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null)
};
const authStub = { authenticate: vi.fn().mockResolvedValue({ success: true }), getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) };
const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl: vi.fn().mockImplementation(() => svcStub) }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl: vi.fn().mockImplementation(() => authStub) }));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({ GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub) }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl: vi.fn().mockImplementation(() => ({})) }));

describe('OrchestratorRoutes – branch coverage', () => {
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

  // ── GET /api/orchestrator/status ──
  it('returns disabled when no orchestrator status', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
  });

  // ── GET /api/orchestrator/config ──
  it('returns 503 when orchestrator manager not available', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/config' });
    expect(res.statusCode).toBe(503);
  });

  // ── PUT /api/orchestrator/config ──
  it('returns 503 when orchestrator manager not available for update', async () => {
    const res = await (server as any).server.inject({
      method: 'PUT', url: '/api/orchestrator/config',
      payload: { enabled: true }
    });
    expect(res.statusCode).toBe(503);
  });

  // ── GET /api/orchestrator/subagents ──
  it('returns 503 when orchestrator disabled for subagents list', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/subagents' });
    expect(res.statusCode).toBe(503);
  });

  // ── POST /api/orchestrator/execute ──
  it('returns 503 when orchestrator disabled for execute', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/orchestrator/execute',
      payload: { goal: 'do something' }
    });
    expect(res.statusCode).toBe(503);
  });

  // ── POST /api/orchestrator/subagents ──
  it('returns 400 for invalid subagent config', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/orchestrator/subagents',
      payload: {}
    });
    expect(res.statusCode).toBe(400);
  });

  // ── DELETE /api/orchestrator/subagents/:name ──
  it('returns 404/503 for delete without orchestrator', async () => {
    const res = await (server as any).server.inject({
      method: 'DELETE', url: '/api/orchestrator/subagents/test-agent'
    });
    // Should be 503 (no orchestrator status)
    expect([404, 503]).toContain(res.statusCode);
  });

  // ── With orchestrator manager set ──
  it('GET /api/orchestrator/config returns config when manager available', async () => {
    const mockMgr = {
      getConfig: vi.fn().mockReturnValue({ enabled: true }),
      updateConfig: vi.fn().mockResolvedValue({ enabled: false })
    } as any;
    server.setOrchestratorManager(mockMgr);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().config).toBeDefined();
  });

  it('GET /api/orchestrator/config returns 500 when getConfig throws', async () => {
    const mockMgr = {
      getConfig: vi.fn().mockImplementation(() => { throw new Error('boom'); }),
    } as any;
    server.setOrchestratorManager(mockMgr);
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/config' });
    expect(res.statusCode).toBe(500);
  });

  it('PUT /api/orchestrator/config updates when manager available', async () => {
    const mockMgr = {
      getConfig: vi.fn(),
      updateConfig: vi.fn().mockResolvedValue({ enabled: false })
    } as any;
    server.setOrchestratorManager(mockMgr);
    const res = await (server as any).server.inject({
      method: 'PUT', url: '/api/orchestrator/config',
      payload: { enabled: false }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('PUT /api/orchestrator/config returns 400 for invalid config', async () => {
    const mockMgr = {
      getConfig: vi.fn(),
      updateConfig: vi.fn().mockRejectedValue(new Error('invalid'))
    } as any;
    server.setOrchestratorManager(mockMgr);
    const res = await (server as any).server.inject({
      method: 'PUT', url: '/api/orchestrator/config',
      payload: { enabled: false }
    });
    expect(res.statusCode).toBe(400);
  });
});

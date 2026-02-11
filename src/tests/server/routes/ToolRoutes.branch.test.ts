import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const {
  mockStaticPlugin, mockCorsPlugin,
  adapterStub, svcStub, authStub, routerStub, cfgStub, adaptersStub,
  ServiceRegistryImpl, AuthenticationLayerImpl, GatewayRouterImpl, ProtocolAdaptersImpl
} = vi.hoisted(() => {
  const adapterStub = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'test', description: 'A test tool', inputSchema: {} }] } }),
    send: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { content: 'ok' } })
  };
  const svcStub = {
    getRegistryStats: vi.fn().mockResolvedValue({}),
    listServices: vi.fn().mockResolvedValue([]),
    getService: vi.fn().mockResolvedValue(null),
    getTemplate: vi.fn().mockResolvedValue({ name: 'test-tool', version: '1', transport: 'stdio', command: 'echo' })
  };
  const authStub = { authenticate: vi.fn().mockResolvedValue({ success: true }), getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) };
  const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
  const cfgStub = {
    listTemplates: vi.fn().mockResolvedValue([{ name: 'test-tool', version: '1', transport: 'stdio' }]),
    getTemplate: vi.fn().mockResolvedValue({ name: 'test-tool', version: '1', transport: 'stdio', command: 'echo' })
  };
  const adaptersStub = { createAdapter: vi.fn().mockResolvedValue(adapterStub) };
  return {
    mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
    mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
    adapterStub, svcStub, authStub, routerStub, cfgStub, adaptersStub,
    ServiceRegistryImpl: vi.fn().mockImplementation(function () { return svcStub; }),
    AuthenticationLayerImpl: vi.fn().mockImplementation(function () { return authStub; }),
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

describe('ToolRoutes \u2013 branch coverage', () => {
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
  const cfgMgrStub = { getConfig: vi.fn().mockReturnValue(config), ...cfgStub } as any;
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, cfgMgrStub);
  });

  afterEach(async () => {
    try { await server.stop(); } catch {}
  });

  describe('GET /api/tools', () => {
    it('returns tool list', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools' });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns 500 when listTemplates fails', async () => {
      cfgStub.listTemplates.mockRejectedValueOnce(new Error('list fail'));
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools' });
      expect(res.statusCode).toBe(500);
    });

    it('handles fetchToolInfo failure gracefully', async () => {
      adaptersStub.createAdapter.mockRejectedValueOnce(new Error('connect fail'));
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools' });
      expect(res.statusCode).toBe(200);
      expect(res.json().tools[0].meta.toolCount).toBe(0);
    });
  });

  describe('GET /api/tools/:toolId', () => {
    it('returns tool detail', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/test-tool' });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns 404 when tool not found', async () => {
      svcStub.getTemplate.mockResolvedValueOnce(null);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/nonexistent' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 500 on error', async () => {
      svcStub.getTemplate.mockRejectedValueOnce(new Error('boom'));
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/bad' });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/tools/execute', () => {
    it('executes tool successfully', async () => {
      adapterStub.sendAndReceive.mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: { content: 'done' } });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/execute',
        payload: { toolId: 'test-tool', params: { q: 'hello' } }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns 400 for invalid body', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/execute',
        payload: { toolId: '' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when tool not found', async () => {
      svcStub.getTemplate.mockResolvedValueOnce(null);
      svcStub.getTemplate.mockResolvedValueOnce(null);
      svcStub.getTemplate.mockResolvedValueOnce(null);
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/execute',
        payload: { toolId: 'missing', options: { retries: 0 } }
      });
      expect(res.statusCode).toBe(500);
    });

    it('handles tool error response', async () => {
      adapterStub.sendAndReceive.mockResolvedValue({ jsonrpc: '2.0', id: 1, error: { message: 'tool error' } });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/execute',
        payload: { toolId: 'test-tool', options: { retries: 2 } }
      });
      expect(res.statusCode).toBe(500);
    });

    it('uses adapter.send when sendAndReceive not available', async () => {
      const noSendReceive = { connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: 'ok' }) };
      adaptersStub.createAdapter.mockResolvedValueOnce(noSendReceive);
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/execute',
        payload: { toolId: 'test-tool', options: { retries: 0 } }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/tools/batch', () => {
    it('executes batch sequentially', async () => {
      adapterStub.sendAndReceive.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { content: 'ok' } });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/batch',
        payload: { calls: [{ toolId: 'test-tool' }, { toolId: 'test-tool' }] }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toHaveLength(2);
    });

    it('executes batch in parallel', async () => {
      adapterStub.sendAndReceive.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { content: 'ok' } });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/batch',
        payload: { calls: [{ toolId: 'test-tool' }, { toolId: 'test-tool' }], options: { parallel: true } }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toHaveLength(2);
    });

    it('stops on error in sequential mode', async () => {
      svcStub.getTemplate.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/batch',
        payload: { calls: [{ toolId: 'missing' }, { toolId: 'test-tool' }], options: { stopOnError: true } }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toHaveLength(1);
      expect(res.json().results[0].success).toBe(false);
    });

    it('continues on error when stopOnError=false', async () => {
      svcStub.getTemplate
        .mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ name: 'test-tool', version: '1', transport: 'stdio', command: 'echo' });
      adapterStub.sendAndReceive.mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: 'ok' });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/batch',
        payload: { calls: [{ toolId: 'missing' }, { toolId: 'test-tool' }], options: { stopOnError: false } }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toHaveLength(2);
    });

    it('handles parallel execution errors', async () => {
      svcStub.getTemplate.mockResolvedValue(null);
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/batch',
        payload: { calls: [{ toolId: 'a' }, { toolId: 'b' }], options: { parallel: true } }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results.every((r: any) => !r.success)).toBe(true);
    });

    it('returns 400 for invalid body', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/tools/batch',
        payload: { calls: [] }
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/tools/history', () => {
    it('returns empty history', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/tools/history' });
      expect(res.statusCode).toBe(200);
      expect(res.json().history).toEqual([]);
    });

    it('filters history by toolId', async () => {
      adapterStub.sendAndReceive.mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: 'ok' });
      await (server as any).server.inject({
        method: 'POST', url: '/api/tools/execute',
        payload: { toolId: 'test-tool', options: { retries: 0 } }
      });
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/tools/history?toolId=test-tool'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().history.length).toBeGreaterThanOrEqual(1);
    });

    it('respects limit parameter', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/tools/history?limit=5'
      });
      expect(res.statusCode).toBe(200);
    });

    it('filters by non-matching toolId returns empty', async () => {
      const res = await (server as any).server.inject({
        method: 'GET', url: '/api/tools/history?toolId=nonexistent'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().history).toEqual([]);
    });
  });
});

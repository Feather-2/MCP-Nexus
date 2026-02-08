import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

// Mock ExternalMcpConfigImporter for import routes
const mockDiscoverAll = vi.fn().mockResolvedValue([]);
vi.mock('../../../config/ExternalMcpConfigImporter.js', () => ({
  ExternalMcpConfigImporter: vi.fn().mockImplementation(() => ({ discoverAll: mockDiscoverAll }))
}));

const serviceRegistryStub = {
  getRegistryStats: vi.fn().mockResolvedValue({}),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null),
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() }),
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

describe('Medium coverage routes', () => {
  const config: GatewayConfig = {
    port: 0, host: '127.0.0.1', authMode: 'local-trusted',
    routingStrategy: 'performance', loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10, requestTimeout: 1000, enableMetrics: true,
    enableHealthChecks: true, healthCheckInterval: 1000, maxRetries: 2,
    enableCors: true, corsOrigins: ['http://localhost:3000'], maxRequestSize: 1024,
    metricsRetentionDays: 1, rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
    logLevel: 'info'
  };
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const configManagerStub = { getConfig: vi.fn().mockReturnValue(config), get: vi.fn() } as any;
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
  });

  // ── TemplateRoutes ──────────────────────────────────────

  describe('TemplateRoutes – additional coverage', () => {
    it('PATCH /api/templates/:name/env updates env', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'svc', version: '2024-11-26', transport: 'stdio', command: 'node', env: {}
      });
      const res = await (server as any).server.inject({
        method: 'PATCH', url: '/api/templates/svc/env',
        payload: { env: { FOO: 'bar' } }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('PATCH /api/templates/:name/env returns 404 for missing template', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce(null);
      const res = await (server as any).server.inject({
        method: 'PATCH', url: '/api/templates/nope/env',
        payload: { env: { FOO: 'bar' } }
      });
      expect(res.statusCode).toBe(404);
    });

    it('PATCH /api/templates/:name/env returns 400 for invalid body', async () => {
      const res = await (server as any).server.inject({
        method: 'PATCH', url: '/api/templates/svc/env',
        payload: []
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/templates/:name/diagnose returns missing env vars', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'brave-search', version: '2024-11-26', transport: 'stdio', command: 'npx',
        args: ['@modelcontextprotocol/server-brave-search'], env: {}
      });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/templates/brave-search/diagnose'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().missing).toContain('BRAVE_API_KEY');
    });

    it('POST /api/templates/:name/diagnose handles missing template', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce(null);
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/templates/nope/diagnose'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
    });

    it('DELETE /api/templates/:name succeeds', async () => {
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/templates/svc' });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('DELETE /api/templates/:name returns 404 on not found error', async () => {
      serviceRegistryStub.removeTemplate.mockRejectedValueOnce(new Error('Template not found'));
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/templates/missing' });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /api/templates/:name returns 500 on other errors', async () => {
      serviceRegistryStub.removeTemplate.mockRejectedValueOnce(new Error('db error'));
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/templates/svc' });
      expect(res.statusCode).toBe(500);
    });

    it('GET /api/templates/:name returns template with sandbox policy', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'svc', version: '2024-11-26', transport: 'stdio', command: 'node', env: {}
      });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates/svc' });
      expect(res.statusCode).toBe(200);
      expect(res.json().sandboxPolicy).toBeDefined();
    });

    it('GET /api/templates/:name returns 500 on registry error', async () => {
      serviceRegistryStub.getTemplate.mockRejectedValueOnce(new Error('db fail'));
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates/svc' });
      expect(res.statusCode).toBe(500);
    });

    it('POST /api/templates/repair returns 500 on error', async () => {
      (serviceRegistryStub as any).templateManager = { initializeDefaults: vi.fn().mockRejectedValue(new Error('repair fail')) };
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair' });
      expect(res.statusCode).toBe(500);
    });

    it('POST /api/templates/repair-images returns 500 on listTemplates error', async () => {
      serviceRegistryStub.listTemplates.mockRejectedValueOnce(new Error('list fail'));
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair-images' });
      expect(res.statusCode).toBe(500);
    });

    it('POST /api/templates/:name/diagnose for github template', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'github-mcp', version: '2024-11-26', transport: 'stdio', command: 'npx',
        args: ['@modelcontextprotocol/server-github'], env: {}
      });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/templates/github-mcp/diagnose'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().missing).toContain('GITHUB_TOKEN');
    });

    it('POST /api/templates/:name/diagnose for openai template', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'openai-svc', version: '2024-11-26', transport: 'stdio', command: 'openai', env: {}
      });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/templates/openai-svc/diagnose'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().missing).toContain('OPENAI_API_KEY');
    });

    it('POST /api/templates/:name/diagnose for anthropic template', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'anthropic-svc', version: '2024-11-26', transport: 'stdio', command: 'anthropic', env: {}
      });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/templates/anthropic-svc/diagnose'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().missing).toContain('ANTHROPIC_API_KEY');
    });

    it('POST /api/templates/:name/diagnose for generic template returns empty', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'custom', version: '2024-11-26', transport: 'stdio', command: 'custom-cmd', env: {}
      });
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/templates/custom/diagnose'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().missing).toEqual([]);
    });
  });

  // ── LogRoutes ──────────────────────────────────────────

  describe('LogRoutes – additional coverage', () => {
    it('GET /api/logs returns recent logs with default limit', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it('GET /api/logs?limit=5 returns limited logs', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/logs?limit=5' });
      expect(res.statusCode).toBe(200);
    });

    // GET /api/logs/stream is SSE (writes to reply.raw) – inject() hangs; covered in integration tests.
  });

  // ── ExternalImportRoutes ──────────────────────────────────

  describe('ExternalImportRoutes – coverage', () => {
    it('GET /api/config/import/preview returns discovered configs', async () => {
      mockDiscoverAll.mockResolvedValueOnce([{ source: 'VSCode', path: '/test', items: [] }]);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/config/import/preview' });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('GET /api/config/import/preview returns 500 on error', async () => {
      mockDiscoverAll.mockRejectedValueOnce(new Error('discover fail'));
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/config/import/preview' });
      expect(res.statusCode).toBe(500);
    });

    it('POST /api/config/import/apply applies templates', async () => {
      mockDiscoverAll.mockResolvedValueOnce([{
        source: 'VSCode', path: '/test',
        items: [{ name: 'imported', version: '2024-11-26', transport: 'stdio', command: 'node' }]
      }]);
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/config/import/apply' });
      expect(res.statusCode).toBe(200);
      expect(res.json().applied).toBe(1);
    });

    it('POST /api/config/import/apply handles register errors gracefully', async () => {
      serviceRegistryStub.registerTemplate.mockRejectedValueOnce(new Error('dup'));
      mockDiscoverAll.mockResolvedValueOnce([{
        source: 'Cursor', path: '/c',
        items: [{ name: 'fail-tmpl', version: '2024-11-26', transport: 'stdio', command: 'node' }]
      }]);
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/config/import/apply' });
      expect(res.statusCode).toBe(200);
      expect(res.json().applied).toBe(0);
    });

    it('POST /api/config/import/apply returns 500 on discoverAll error', async () => {
      mockDiscoverAll.mockRejectedValueOnce(new Error('apply fail'));
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/config/import/apply' });
      expect(res.statusCode).toBe(500);
    });
  });
});

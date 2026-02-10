import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.())
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
  removeTemplate: vi.fn().mockResolvedValue(undefined),
  templateManager: { initializeDefaults: vi.fn().mockResolvedValue(undefined) }
};
const authStub = { authenticate: vi.fn().mockResolvedValue({ success: true }), getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) };
const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub) }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl: vi.fn().mockImplementation(() => authStub) }));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({ GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub) }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl: vi.fn().mockImplementation(() => ({})) }));

describe('TemplateRoutes \u2013 branch coverage', () => {
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

  describe('detectSandboxMode branches', () => {
    it('returns container for SANDBOX=container env', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'svc', transport: 'stdio', env: { SANDBOX: 'container' } }
      ]);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates' });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0].sandboxPolicy.requested).toBe('container');
    });

    it('returns container for container object', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'svc', transport: 'stdio', container: { image: 'node:20' } }
      ]);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates' });
      expect(res.json()[0].sandboxPolicy.requested).toBe('container');
    });

    it('returns portable for SANDBOX=portable env', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'svc', transport: 'stdio', env: { SANDBOX: 'portable' } }
      ]);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates' });
      expect(res.json()[0].sandboxPolicy.requested).toBe('portable');
    });

    it('returns none for non-stdio transport', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'svc', transport: 'http', env: {} }
      ]);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates' });
      expect(res.json()[0].sandboxPolicy.requested).toBe('none');
    });

    it('returns none for stdio without sandbox env', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'svc', transport: 'stdio', env: {} }
      ]);
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates' });
      expect(res.json()[0].sandboxPolicy.requested).toBe('none');
    });
  });

  describe('GET /api/templates/:name', () => {
    it('returns template with sandbox policy when found', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'found', transport: 'stdio', version: '2024-11-26', env: {}
      });
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates/found' });
      expect(res.statusCode).toBe(200);
      expect(res.json().sandboxPolicy).toBeDefined();
    });

    it('returns 500 when getTemplate throws', async () => {
      serviceRegistryStub.getTemplate.mockRejectedValueOnce(new Error('db error'));
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/templates/broken' });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('PATCH /api/templates/:name/env', () => {
    it('returns 400 when env is not provided (array body)', async () => {
      const res = await (server as any).server.inject({
        method: 'PATCH', url: '/api/templates/svc/env',
        payload: []
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when template not found', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce(null);
      const res = await (server as any).server.inject({
        method: 'PATCH', url: '/api/templates/missing/env',
        payload: { env: { KEY: 'val' } }
      });
      expect(res.statusCode).toBe(404);
    });

    it('updates env when template exists', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'svc', transport: 'stdio', version: '2024-11-26', env: { OLD: 'val' }
      });
      const res = await (server as any).server.inject({
        method: 'PATCH', url: '/api/templates/svc/env',
        payload: { env: { NEW: 'val2' } }
      });
      expect(res.statusCode).toBe(200);
    });

    it('handles direct env object (no env wrapper)', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'svc', transport: 'stdio', version: '2024-11-26', env: {}
      });
      const res = await (server as any).server.inject({
        method: 'PATCH', url: '/api/templates/svc/env',
        payload: { KEY: 'val' }
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 500 when registerTemplate throws', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'svc', transport: 'stdio', version: '2024-11-26', env: {}
      });
      serviceRegistryStub.registerTemplate.mockRejectedValueOnce(new Error('write fail'));
      const res = await (server as any).server.inject({
        method: 'PATCH', url: '/api/templates/svc/env',
        payload: { env: { K: 'v' } }
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/templates/:name/diagnose', () => {
    it('returns missing=[] for unknown template', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce(null);
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/missing/diagnose' });
      expect(res.json().success).toBe(false);
    });

    it('detects missing env for brave', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({
        name: 'brave-search', transport: 'stdio', version: '2024-11-26', env: {}
      });
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/brave-search/diagnose' });
      expect(res.json().missing).toContain('BRAVE_API_KEY');
    });

    it('detects github token', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({ name: 'github', transport: 'stdio', version: '2024-11-26', env: {} });
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/github/diagnose' });
      expect(res.json().missing).toContain('GITHUB_TOKEN');
    });

    it('no missing for ollama', async () => {
      serviceRegistryStub.getTemplate.mockResolvedValueOnce({ name: 'ollama', transport: 'stdio', version: '2024-11-26', env: {} });
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/ollama/diagnose' });
      expect(res.json().missing).toHaveLength(0);
    });

    const providers = [
      ['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY'], ['gemini', 'GOOGLE_API_KEY'],
      ['cohere', 'COHERE_API_KEY'], ['groq', 'GROQ_API_KEY'], ['together', 'TOGETHER_API_KEY'],
      ['fireworks', 'FIREWORKS_API_KEY'], ['deepseek', 'DEEPSEEK_API_KEY'], ['mistral', 'MISTRAL_API_KEY'],
      ['perplexity', 'PERPLEXITY_API_KEY'], ['replicate', 'REPLICATE_API_TOKEN'], ['serpapi', 'SERPAPI_API_KEY'],
      ['huggingface', 'HF_TOKEN'], ['openrouter', 'OPENROUTER_API_KEY']
    ] as const;

    for (const [name, key] of providers) {
      it(`detects ${key} for ${name}`, async () => {
        serviceRegistryStub.getTemplate.mockResolvedValueOnce({ name, transport: 'stdio', version: '2024-11-26', env: {} });
        const res = await (server as any).server.inject({ method: 'POST', url: `/api/templates/${name}/diagnose` });
        expect(res.json().missing).toContain(key);
      });
    }

    it('returns error when diagnose throws', async () => {
      serviceRegistryStub.getTemplate.mockRejectedValueOnce(new Error('db fail'));
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/err/diagnose' });
      expect(res.json().success).toBe(false);
    });
  });

  describe('DELETE /api/templates/:name', () => {
    it('returns 200 on successful delete', async () => {
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/templates/svc' });
      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when not found error', async () => {
      serviceRegistryStub.removeTemplate.mockRejectedValueOnce(new Error('Template not found'));
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/templates/missing' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 500 for other errors', async () => {
      serviceRegistryStub.removeTemplate.mockRejectedValueOnce(new Error('disk failure'));
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/templates/broken' });
      expect(res.statusCode).toBe(500);
    });

    it('handles non-Error throw', async () => {
      serviceRegistryStub.removeTemplate.mockRejectedValueOnce('string error');
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/templates/broken' });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/templates/repair-images edge cases', () => {
    it('skips non-stdio templates', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([{ name: 'http-svc', transport: 'http', env: { SANDBOX: 'container' } }]);
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair-images' });
      expect(res.json().fixed).toBe(0);
    });

    it('skips templates with existing image', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'svc', transport: 'stdio', env: { SANDBOX: 'container' }, container: { image: 'existing:1' } }
      ]);
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair-images' });
      expect(res.json().fixed).toBe(0);
    });

    it('suggests go image', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'go-svc', transport: 'stdio', command: 'go run .', env: { SANDBOX: 'container' } }
      ]);
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair-images' });
      expect(res.json().fixed).toBe(1);
    });

    it('suggests alpine for unknown command', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'rust-svc', transport: 'stdio', command: 'cargo run', env: { SANDBOX: 'container' } }
      ]);
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair-images' });
      expect(res.json().fixed).toBe(1);
    });

    it('handles registerTemplate failure', async () => {
      serviceRegistryStub.listTemplates.mockResolvedValueOnce([
        { name: 'fail', transport: 'stdio', command: 'node', env: { SANDBOX: 'container' } }
      ]);
      serviceRegistryStub.registerTemplate.mockRejectedValueOnce(new Error('fail'));
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair-images' });
      expect(res.json().fixed).toBe(0);
    });

    it('returns 500 when listTemplates throws', async () => {
      serviceRegistryStub.listTemplates.mockRejectedValueOnce(new Error('db fail'));
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair-images' });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/templates/repair', () => {
    it('returns 500 when initializeDefaults throws', async () => {
      (serviceRegistryStub as any).templateManager.initializeDefaults.mockRejectedValueOnce(new Error('init fail'));
      const res = await (server as any).server.inject({ method: 'POST', url: '/api/templates/repair' });
      expect(res.statusCode).toBe(500);
    });
  });
});

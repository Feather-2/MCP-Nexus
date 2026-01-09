import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';
import { createHmac } from 'crypto';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn()
}));

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, readFile: readFileMock };
});

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
  const envSnapshot = { ...process.env };
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

  const configManagerStub = {
    getConfig: vi.fn().mockReturnValue(config),
    updateConfig: vi.fn(),
    get: vi.fn()
  } as any;

  let server: HttpApiServer;
  let actualReadFile: (typeof import('fs/promises'))['readFile'];

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    actualReadFile = actual.readFile;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
    readFileMock.mockReset();
    readFileMock.mockImplementation(actualReadFile as any);

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

  it('returns 503 when mcpGenerator is not initialized', async () => {
    (server as any).mcpGenerator = undefined;

    const gen = await (server as any).server.inject({
      method: 'POST',
      url: '/api/generator/generate',
      payload: { source: { type: 'markdown', content: '# API' } }
    });
    expect(gen.statusCode).toBe(503);
    expect(gen.json().error.code).toBe('NOT_READY');

    const exp = await (server as any).server.inject({
      method: 'POST',
      url: '/api/generator/export',
      payload: { templateName: 'svc', format: 'json' }
    });
    expect(exp.statusCode).toBe(503);
    expect(exp.json().error.code).toBe('NOT_READY');

    const imp = await (server as any).server.inject({
      method: 'POST',
      url: '/api/generator/import',
      payload: { source: { type: 'json', content: {} } }
    });
    expect(imp.statusCode).toBe(503);
    expect(imp.json().error.code).toBe('NOT_READY');

    const dl = await (server as any).server.inject({ method: 'GET', url: '/api/generator/download/ok.json' });
    expect(dl.statusCode).toBe(503);
    expect(dl.json().error.code).toBe('NOT_READY');
  });

  it('handles generator exceptions for generate/export/import', async () => {
    const boom = new Error('boom');

    (server as any).mcpGenerator.generate.mockRejectedValueOnce(boom);
    const gen = await (server as any).server.inject({
      method: 'POST',
      url: '/api/generator/generate',
      payload: { source: { type: 'markdown', content: '# API' } }
    });
    expect(gen.statusCode).toBe(500);
    expect(gen.json().error.code).toBe('GEN_ERROR');
    expect(gen.json().error.message).toBe('boom');

    (server as any).mcpGenerator.export.mockImplementationOnce(() => {
      throw boom;
    });
    const exp = await (server as any).server.inject({
      method: 'POST',
      url: '/api/generator/export',
      payload: { templateName: 'svc', format: 'json' }
    });
    expect(exp.statusCode).toBe(500);
    expect(exp.json().error.code).toBe('EXPORT_ERROR');
    expect(exp.json().error.message).toBe('boom');

    (server as any).mcpGenerator.import.mockRejectedValueOnce(boom);
    const imp = await (server as any).server.inject({
      method: 'POST',
      url: '/api/generator/import',
      payload: { source: { type: 'json', content: {} } }
    });
    expect(imp.statusCode).toBe(500);
    expect(imp.json().error.code).toBe('IMPORT_ERROR');
    expect(imp.json().error.message).toBe('boom');
  });

  it('GET /api/generator/marketplace returns templates list from file', async () => {
    const items = [
      { id: 'alpha', name: 'Alpha', description: 'First', tags: ['core'] },
      { id: 'beta', name: 'Beta', description: 'Second', tags: ['extras'] }
    ];

    process.env.PB_MARKETPLACE_PATH = '/tmp/marketplace.test.json';
    readFileMock.mockResolvedValueOnce(JSON.stringify(items));

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toEqual(items);
    expect(readFileMock).toHaveBeenCalledWith('/tmp/marketplace.test.json', 'utf-8');
  });

  it('GET /api/generator/marketplace/search filters results with q', async () => {
    const items = [
      { id: 'alpha', name: 'Alpha', description: 'First', tags: ['core'] },
      { id: 'beta', name: 'Beta', description: 'Second', tags: ['extras'] }
    ];

    readFileMock.mockResolvedValueOnce(JSON.stringify(items));
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace/search?q=core' });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().query).toBe('core');
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0].id).toBe('alpha');
  });

  it('GET /api/generator/marketplace/search returns all results when q is empty', async () => {
    const items = [
      { id: 'alpha', name: 'Alpha', description: 'First', tags: ['core'] },
      { id: 'beta', name: 'Beta', description: 'Second', tags: ['extras'] }
    ];

    readFileMock.mockResolvedValueOnce(JSON.stringify(items));
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace/search' });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().query).toBe('');
    expect(res.json().results).toHaveLength(2);
  });

  it('POST /api/generator/marketplace/publish returns 501', async () => {
    const res = await (server as any).server.inject({ method: 'POST', url: '/api/generator/marketplace/publish', payload: {} });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('NOT_IMPLEMENTED');
  });

  it('POST /api/generator/marketplace/install returns 404 when template does not exist', async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify([{ id: 'alpha', name: 'Alpha', template: { name: 'Alpha' } }]));

    const res = await (server as any).server.inject({
      method: 'POST',
      url: '/api/generator/marketplace/install',
      payload: { templateId: 'missing' }
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(serviceRegistryStub.registerTemplate).not.toHaveBeenCalled();
  });

  it('POST /api/generator/marketplace/install returns 422 when config is missing', async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify([{ id: 'nocfg', name: 'NoConfig' }]));

    const res = await (server as any).server.inject({
      method: 'POST',
      url: '/api/generator/marketplace/install',
      payload: { templateId: 'nocfg' }
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('UNPROCESSABLE');
    expect(serviceRegistryStub.registerTemplate).not.toHaveBeenCalled();
  });

  it('loadMarketplaceItems returns cached items within TTL', async () => {
    const items = [{ id: 'alpha', name: 'Alpha', description: 'First' }];
    readFileMock.mockResolvedValueOnce(JSON.stringify(items));

    const first = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(first.statusCode).toBe(200);
    expect(first.json().templates).toEqual(items);

    const second = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(second.statusCode).toBe(200);
    expect(second.json().templates).toEqual(items);

    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it('loadMarketplaceItems loads and merges items from URL (HMAC verified)', async () => {
    process.env.PB_MARKETPLACE_URL = 'https://example.com/marketplace.json';
    process.env.PB_MARKETPLACE_TOKEN = 'token-123';
    process.env.PB_MARKETPLACE_HMAC_SECRET = 'secret';

    const fromFile = [
      { id: 'dupe', name: 'Duped', description: 'from file' },
      { id: 'file-only', name: 'FileOnly', description: 'file' }
    ];
    readFileMock.mockResolvedValueOnce(JSON.stringify(fromFile));

    const fromUrlItems = [
      { id: 'dupe', name: 'Duped', description: 'from url' },
      { id: 'url-only', name: 'UrlOnly', description: 'url' }
    ];

    const hmac = createHmac('sha256', process.env.PB_MARKETPLACE_HMAC_SECRET)
      .update(JSON.stringify(fromUrlItems))
      .digest('hex');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ items: fromUrlItems, hmac })
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(res.statusCode).toBe(200);
    const templates = res.json().templates as any[];
    expect(templates.map((t) => t.id).sort()).toEqual(['dupe', 'file-only', 'url-only'].sort());
    expect(templates.find((t) => t.id === 'dupe')?.description).toBe('from url');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/marketplace.json');
    expect(opts.headers.Authorization).toBe('Bearer token-123');
  });

  it('loadMarketplaceItems loads remote array response using Basic auth header', async () => {
    process.env.PB_MARKETPLACE_URL = 'https://example.com/marketplace-array.json';
    process.env.PB_MARKETPLACE_BASIC_AUTH = 'user:pass';

    readFileMock.mockRejectedValueOnce(new Error('no file'));

    const fromUrlItems = [
      { id: 'url1', name: 'Url1', description: 'one' },
      { id: 'url2', name: 'Url2', description: 'two' }
    ];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue(fromUrlItems)
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates.map((t: any) => t.id).sort()).toEqual(['url1', 'url2']);

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toMatch(/^Basic /);
  });

  it('loadMarketplaceItems ignores remote items when HMAC verification fails', async () => {
    process.env.PB_MARKETPLACE_URL = 'https://example.com/marketplace.json';
    process.env.PB_MARKETPLACE_HMAC_SECRET = 'secret';

    const fromFile = [{ id: 'file-only', name: 'FileOnly', description: 'file' }];
    readFileMock.mockResolvedValueOnce(JSON.stringify(fromFile));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ items: [{ id: 'url-only', name: 'UrlOnly' }], hmac: 'bad-hmac' })
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toEqual(fromFile);
    expect(logger.warn).toHaveBeenCalledWith('Marketplace HMAC verification failed; ignoring remote items');
  });

  it('loadMarketplaceItems ignores remote items when HMAC verification throws', async () => {
    process.env.PB_MARKETPLACE_URL = 'https://example.com/marketplace.json';
    process.env.PB_MARKETPLACE_HMAC_SECRET = 'secret';

    const fromFile = [{ id: 'file-only', name: 'FileOnly', description: 'file' }];
    readFileMock.mockResolvedValueOnce(JSON.stringify(fromFile));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        items: [{ id: 'url-only', name: 'UrlOnly' }],
        get hmac() { throw new Error('bad hmac getter'); }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toEqual(fromFile);
    expect(logger.warn).toHaveBeenCalledWith('Marketplace HMAC verify error; ignoring remote items', expect.any(Error));
  });

  it('loadMarketplaceItems logs warning when fetch returns non-ok status', async () => {
    process.env.PB_MARKETPLACE_URL = 'https://example.com/marketplace.json';

    const fromFile = [{ id: 'file-only', name: 'FileOnly', description: 'file' }];
    readFileMock.mockResolvedValueOnce(JSON.stringify(fromFile));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found'
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toEqual(fromFile);
    expect(logger.warn).toHaveBeenCalledWith('Failed to fetch marketplace url', { status: 404, statusText: 'Not Found' });
  });

  it('loadMarketplaceItems logs warning when fetch throws network error', async () => {
    process.env.PB_MARKETPLACE_URL = 'https://example.com/marketplace.json';

    const fromFile = [{ id: 'file-only', name: 'FileOnly', description: 'file' }];
    readFileMock.mockResolvedValueOnce(JSON.stringify(fromFile));

    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toEqual(fromFile);
    expect(logger.warn).toHaveBeenCalledWith('Marketplace URL fetch error', expect.any(Error));
  });

  it('loadMarketplaceItems returns fallback built-in when no file or URL data', async () => {
    // Clear any marketplace env vars and ensure file read fails
    delete process.env.PB_MARKETPLACE_PATH;
    delete process.env.PB_MARKETPLACE_URL;
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/generator/marketplace' });
    expect(res.statusCode).toBe(200);
    const templates = res.json().templates;
    expect(templates).toHaveLength(1);
    expect(templates[0].id).toBe('filesystem');
    expect(templates[0].template).toBeDefined();
    expect(templates[0].template.name).toBe('filesystem');
  });

});

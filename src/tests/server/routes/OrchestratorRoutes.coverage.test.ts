import os from 'os';
import path from 'path';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const {
  mockStaticPlugin, mockCorsPlugin,
  serviceRegistryStub, authLayerStub, routerStub,
  ServiceRegistryImpl, AuthenticationLayerImpl, GatewayRouterImpl, ProtocolAdaptersImpl
} = vi.hoisted(() => {
  const serviceRegistryStub = {
    getRegistryStats: vi.fn().mockResolvedValue({}),
    listServices: vi.fn().mockResolvedValue([]),
    getService: vi.fn().mockResolvedValue(null),
    setInstanceMetadata: vi.fn().mockResolvedValue(undefined),
    getTemplateManager: vi.fn().mockReturnValue({})
  };
  const authLayerStub = {
    authenticate: vi.fn().mockResolvedValue({ success: true }),
    getActiveTokenCount: vi.fn().mockReturnValue(0),
    getActiveApiKeyCount: vi.fn().mockReturnValue(0)
  };
  const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
  return {
    mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
    mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
    serviceRegistryStub, authLayerStub, routerStub,
    ServiceRegistryImpl: vi.fn().mockImplementation(function () { return serviceRegistryStub; }),
    AuthenticationLayerImpl: vi.fn().mockImplementation(function () { return authLayerStub; }),
    GatewayRouterImpl: vi.fn().mockImplementation(function () { return routerStub; }),
    ProtocolAdaptersImpl: vi.fn().mockImplementation(function () { return {}; }),
  };
});

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));
vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl }));
vi.mock('../../../routing/GatewayRouterImpl.js', () => ({ GatewayRouterImpl }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl }));

describe('OrchestratorRoutes – config & subagents CRUD', () => {
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
  const configManagerStub = { getConfig: vi.fn().mockReturnValue(config), get: vi.fn() } as any;

  let server: HttpApiServer;
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-orch-cov-'));
    server = new HttpApiServer(config, logger, configManagerStub);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- /api/orchestrator/status ---
  it('GET /api/orchestrator/status returns disabled when no orchestrator', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });

  // --- /api/orchestrator/config ---
  it('GET /api/orchestrator/config returns 503 when unavailable', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/config' });
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/orchestrator/config returns config when available', async () => {
    const mockConfig = { enabled: true, mode: 'manager-only' };
    (server as any).orchestratorManager = { getConfig: vi.fn().mockReturnValue(mockConfig) };
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().config).toEqual(mockConfig);
  });

  it('PUT /api/orchestrator/config returns 503 when unavailable', async () => {
    const res = await (server as any).server.inject({
      method: 'PUT', url: '/api/orchestrator/config', payload: { enabled: false }
    });
    expect(res.statusCode).toBe(503);
  });

  it('PUT /api/orchestrator/config updates config', async () => {
    const updated = { enabled: false, mode: 'manager-only' };
    (server as any).orchestratorManager = {
      getConfig: vi.fn().mockReturnValue({}),
      updateConfig: vi.fn().mockResolvedValue(updated)
    };
    const res = await (server as any).server.inject({
      method: 'PUT', url: '/api/orchestrator/config', payload: { enabled: false }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  // --- /api/orchestrator/subagents ---
  it('GET /api/orchestrator/subagents returns 503 when disabled', async () => {
    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/subagents' });
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/orchestrator/subagents lists subagents', async () => {
    (server as any).orchestratorManager = {} as any;
    (server as any).orchestratorStatus = { enabled: true, mode: 'manager-only', subagentsDir: tmpDir };
    // Write a subagent JSON file
    const { writeFile: wf, mkdir: mkd } = await import('fs/promises');
    await wf(path.join(tmpDir, 'search.json'), JSON.stringify({ name: 'search', model: 'gpt-4', tools: ['web'] }), 'utf-8');

    const subagentLoaderStub = {
      loadAll: vi.fn().mockResolvedValue(new Map([['search', { name: 'search', model: 'gpt-4', tools: ['web'] }]])),
      list: vi.fn().mockReturnValue([{ name: 'search' }])
    };
    (server as any).subagentLoader = subagentLoaderStub;

    const res = await (server as any).server.inject({ method: 'GET', url: '/api/orchestrator/subagents' });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/orchestrator/subagents creates subagent file', async () => {
    (server as any).orchestratorManager = {} as any;
    (server as any).orchestratorStatus = { enabled: true, mode: 'manager-only', subagentsDir: tmpDir };
    (server as any).subagentLoader = {
      loadAll: vi.fn().mockResolvedValue(new Map()),
      list: vi.fn().mockReturnValue([])
    };

    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/orchestrator/subagents',
      payload: { name: 'new-agent', model: 'gpt-4', tools: ['search'] }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().success).toBe(true);

    // Verify file was written
    const content = await readFile(path.join(tmpDir, 'new-agent.json'), 'utf-8');
    expect(JSON.parse(content).name).toBe('new-agent');
  });

  it('POST /api/orchestrator/subagents returns 400 for invalid config', async () => {
    (server as any).orchestratorManager = {} as any;
    (server as any).orchestratorStatus = { enabled: true, mode: 'manager-only', subagentsDir: tmpDir };
    const res = await (server as any).server.inject({
      method: 'POST', url: '/api/orchestrator/subagents',
      payload: {} // missing required fields
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/orchestrator/subagents/:name deletes subagent', async () => {
    (server as any).orchestratorManager = {} as any;
    (server as any).orchestratorStatus = { enabled: true, mode: 'manager-only', subagentsDir: tmpDir };
    (server as any).subagentLoader = {
      loadAll: vi.fn().mockResolvedValue(new Map()),
      list: vi.fn().mockReturnValue([])
    };

    // Create file first
    const { writeFile: wf } = await import('fs/promises');
    await wf(path.join(tmpDir, 'to-delete.json'), '{}', 'utf-8');

    const res = await (server as any).server.inject({
      method: 'DELETE', url: '/api/orchestrator/subagents/to-delete'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('DELETE /api/orchestrator/subagents/:name returns 404 for missing', async () => {
    (server as any).orchestratorManager = {} as any;
    (server as any).orchestratorStatus = { enabled: true, mode: 'manager-only', subagentsDir: tmpDir };
    (server as any).subagentLoader = {
      loadAll: vi.fn().mockResolvedValue(new Map()),
      list: vi.fn().mockReturnValue([])
    };

    const res = await (server as any).server.inject({
      method: 'DELETE', url: '/api/orchestrator/subagents/nonexistent'
    });
    expect(res.statusCode).toBe(404);
  });
});

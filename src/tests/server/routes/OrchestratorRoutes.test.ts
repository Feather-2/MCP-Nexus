import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

// Mock plugins to avoid filesystem/network access during tests
const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

// Stubs for gateway internals used by server
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

const routerStub = {
  getMetrics: vi.fn().mockReturnValue({})
};

const adaptersStub = {
  createAdapter: vi.fn().mockResolvedValue({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: { tools: [] } }),
    sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: { tools: [] } }),
    isConnected: vi.fn().mockReturnValue(true)
  })
};

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

describe('OrchestratorRoutes - execute', () => {
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

  const logger: Logger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()
  };

  const configManagerStub = {
    getConfig: vi.fn().mockReturnValue(config),
    updateConfig: vi.fn(),
    get: vi.fn()
  } as any;

  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
  });

  it('returns 503 when orchestrator is disabled or missing', async () => {
    const res = await (server as any).server.inject({
      method: 'POST',
      url: '/api/orchestrator/execute',
      payload: { goal: 'test' }
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.success).toBe(false);
  });

  it('validates that goal or steps is required', async () => {
    // Enable orchestrator but send empty payload
    (server as any).orchestratorManager = {} as any;
    (server as any).orchestratorStatus = { enabled: true, mode: 'manager-only', subagentsDir: './config/subagents' };
    (server as any).orchestratorEngine = { execute: vi.fn() };
    (server as any).subagentLoader = { loadAll: vi.fn().mockResolvedValue(new Map()), list: vi.fn().mockReturnValue([]) };

    const res = await (server as any).server.inject({
      method: 'POST',
      url: '/api/orchestrator/execute',
      payload: {}
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
  });

  it('executes plan and returns plan/results/used', async () => {
    const executeMock = vi.fn().mockResolvedValue({
      success: true,
      plan: [{ subagent: 'search', tool: 'search', params: { query: 'kittens' } }],
      results: [{ step: { subagent: 'search', tool: 'search', params: { query: 'kittens' } }, ok: true, response: { demo: true }, durationMs: 5 }],
      used: { steps: 1, durationMs: 5 }
    });

    (server as any).orchestratorManager = {} as any;
    (server as any).orchestratorStatus = { enabled: true, mode: 'manager-only', subagentsDir: './config/subagents' };
    (server as any).orchestratorEngine = { execute: executeMock };
    (server as any).subagentLoader = { loadAll: vi.fn().mockResolvedValue(new Map()), list: vi.fn().mockReturnValue([]) };

    const res = await (server as any).server.inject({
      method: 'POST',
      url: '/api/orchestrator/execute',
      payload: { goal: 'search cats' }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.plan).toHaveLength(1);
    expect(body.results[0].ok).toBe(true);
    expect(body.used.steps).toBe(1);
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ goal: 'search cats' }));
  });

  it('invokes OrchestratorEngine end-to-end with adapter calls', async () => {
    const adapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendAndReceive: vi.fn().mockResolvedValue({ result: { ok: true, data: 'from-adapter' } })
    };

    const localServiceRegistry = {
      ...serviceRegistryStub,
      getTemplate: vi.fn().mockResolvedValue({
        name: 'brave-search',
        version: '0.1.0',
        transport: 'http',
        timeout: 1000,
        retries: 1
      })
    };

    const localAdapters = {
      ...adaptersStub,
      createAdapter: vi.fn().mockResolvedValue(adapter)
    };

    const orchestratorManagerStub = {
      getConfig: vi.fn().mockReturnValue({
        enabled: true,
        mode: 'manager-only',
        planner: { maxSteps: 4 },
        budget: { maxTimeMs: 5_000 },
        routing: {},
        subagentsDir: './config/subagents'
      })
    };

    const subagentLoaderStub = {
      loadAll: vi.fn().mockResolvedValue(new Map([['search', { name: 'search', tools: ['brave-search'] }]])),
      list: vi.fn().mockReturnValue([{ name: 'search', tools: ['brave-search'] }]),
      get: vi.fn().mockReturnValue({ name: 'search', tools: ['brave-search'] })
    };

    // Create a fresh server to wire the real orchestrator engine dependencies
    server = new HttpApiServer(config, logger, configManagerStub);

    const { OrchestratorEngine } = await import('../../../orchestrator/OrchestratorEngine.js');
    const engine = new OrchestratorEngine({
      logger,
      serviceRegistry: localServiceRegistry as any,
      protocolAdapters: localAdapters as any,
      orchestratorManager: orchestratorManagerStub as any,
      subagentLoader: subagentLoaderStub as any
    });

    (server as any).orchestratorManager = orchestratorManagerStub;
    (server as any).orchestratorStatus = { enabled: true, mode: 'manager-only', subagentsDir: './config/subagents' };
    (server as any).orchestratorEngine = engine;
    (server as any).subagentLoader = subagentLoaderStub;

    const res = await (server as any).server.inject({
      method: 'POST',
      url: '/api/orchestrator/execute',
      payload: { goal: 'search anything' }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.results[0].ok).toBe(true);
    expect(adapter.sendAndReceive).toHaveBeenCalled();
  });
});

import { HttpApiServer } from '../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => {
    done?.();
  }),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => {
    done?.();
  })
}));

vi.mock('@fastify/static', () => ({
  default: mockStaticPlugin
}));

vi.mock('@fastify/cors', () => ({
  default: mockCorsPlugin
}));

const serviceRegistryStub = {
  getRegistryStats: vi.fn().mockResolvedValue({}),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null),
  createServiceFromTemplate: vi.fn().mockResolvedValue('service-1'),
  stopService: vi.fn().mockResolvedValue(true),
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() }),
  getServiceLogs: vi.fn().mockResolvedValue([]),
  getHealthyInstances: vi.fn().mockResolvedValue([])
};

const authLayerStub = {
  authenticate: vi.fn().mockResolvedValue({ success: true }),
  getActiveTokenCount: vi.fn().mockReturnValue(0),
  getActiveApiKeyCount: vi.fn().mockReturnValue(0)
};

const routerStub = {
  getMetrics: vi.fn().mockReturnValue({})
};

const adaptersStub = {};

vi.mock('../../gateway/ServiceRegistryImpl.js', () => ({
  ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub)
}));

vi.mock('../../auth/AuthenticationLayerImpl.js', () => ({
  AuthenticationLayerImpl: vi.fn().mockImplementation(() => authLayerStub)
}));

vi.mock('../../router/GatewayRouterImpl.js', () => ({
  GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub)
}));

vi.mock('../../adapters/ProtocolAdaptersImpl.js', () => ({
  ProtocolAdaptersImpl: vi.fn().mockImplementation(() => adaptersStub)
}));

describe('HttpApiServer orchestrator routes', () => {
  const config: GatewayConfig = {
    port: 1234,
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
    corsOrigins: ['http://localhost'],
    maxRequestSize: 1024,
    metricsRetentionDays: 1,
    rateLimiting: {
      enabled: false,
      maxRequests: 100,
      windowMs: 60000
    },
    logLevel: 'info'
  };

  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const configManagerStub = {
    getConfig: vi.fn().mockReturnValue(config),
    updateConfig: vi.fn(),
    get: vi.fn()
  } as any;

  let intervalSpy: ReturnType<typeof vi.spyOn>;
  let server: HttpApiServer;
  let orchestratorStub: any;

  beforeEach(() => {
    vi.clearAllMocks();
    intervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue({
      ref() { return this; },
      unref() { return this; }
    } as any) as any;
    server = new HttpApiServer(config, logger, configManagerStub);
    orchestratorStub = {
      getConfig: vi.fn().mockReturnValue({ enabled: false, mode: 'manager-only', subagentsDir: './config/subagents' }),
      updateConfig: vi.fn().mockResolvedValue({ enabled: true, mode: 'auto', subagentsDir: './config/subagents' }),
      getStatus: vi.fn().mockReturnValue({ enabled: false, mode: 'manager-only', subagentsDir: './config/subagents' })
    };
    server.setOrchestratorManager(orchestratorStub);
  });

  afterEach(() => {
    intervalSpy.mockRestore();
  });

  it('returns disabled payload when status not initialized', async () => {
    const res = await (server as any).server.inject({
      method: 'GET',
      url: '/api/orchestrator/status'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: false,
      reason: 'orchestrator status unavailable',
      mode: 'manager-only'
    });
  });

  it('returns orchestrator status when available', async () => {
    server.updateOrchestratorStatus({
      enabled: true,
      mode: 'auto',
      subagentsDir: '/tmp/subagents'
    });

    const res = await (server as any).server.inject({
      method: 'GET',
      url: '/api/orchestrator/status'
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload).toMatchObject({
      enabled: true,
      mode: 'auto',
      subagentsDir: '/tmp/subagents'
    });
    expect('reason' in payload).toBe(false);
  });

  it('returns 503 when orchestrator manager missing', async () => {
    server.setOrchestratorManager(undefined as any);
    const res = await (server as any).server.inject({
      method: 'GET',
      url: '/api/orchestrator/config'
    });

    expect(res.statusCode).toBe(503);
  });

  it('returns orchestrator config when manager attached', async () => {
    const res = await (server as any).server.inject({
      method: 'GET',
      url: '/api/orchestrator/config'
    });

    expect(res.statusCode).toBe(200);
    expect(orchestratorStub.getConfig).toHaveBeenCalled();
    expect(res.json()).toEqual({ config: { enabled: false, mode: 'manager-only', subagentsDir: './config/subagents' } });
  });

  it('updates orchestrator config via PUT', async () => {
    orchestratorStub.getStatus.mockReturnValue({ enabled: true, mode: 'auto', subagentsDir: './config/subagents' });

    const res = await (server as any).server.inject({
      method: 'PUT',
      url: '/api/orchestrator/config',
      payload: { enabled: true, mode: 'auto' }
    });

    expect(res.statusCode).toBe(200);
    expect(orchestratorStub.updateConfig).toHaveBeenCalledWith({ enabled: true, mode: 'auto' });
    expect(res.json()).toEqual({ success: true, config: { enabled: true, mode: 'auto', subagentsDir: './config/subagents' } });
  });
});

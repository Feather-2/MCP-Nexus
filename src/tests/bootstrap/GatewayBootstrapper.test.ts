import { GatewayBootstrapper } from '../../bootstrap/GatewayBootstrapper.js';
import type { GatewayConfig } from '../../types/index.js';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: 19233,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    routingStrategy: 'performance',
    loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 50,
    requestTimeout: 30000,
    enableMetrics: true,
    enableHealthChecks: true,
    healthCheckInterval: 30000,
    maxRetries: 3,
    enableCors: true,
    corsOrigins: ['http://localhost:3000'],
    maxRequestSize: 10 * 1024 * 1024,
    metricsRetentionDays: 7,
    rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' as any },
    logLevel: 'info',
    ...overrides
  } as any;
}

describe('GatewayBootstrapper', () => {
  it('bootstraps default providers and is idempotent', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'pbmcp-bootstrap-'));
    const configPath = join(tmpRoot, 'gateway.json');
    const templatesDir = join(tmpRoot, 'templates');
    // Prevent ServiceTemplateManager.initializeDefaults() from racing cleanup by ensuring the dir
    // already contains at least one JSON file.
    await mkdir(templatesDir, { recursive: true });
    await writeFile(join(templatesDir, '__test__.json'), '{}', 'utf-8');

    const intervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue({
      ref() { return this; },
      unref() { return this; }
    } as any) as any;

    const prevTemplatesDir = process.env.PB_TEMPLATES_DIR;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;

    try {
      const bootstrapper = new GatewayBootstrapper({ configPath, logger });

      // Lazy config access should trigger bootstrap.
      const cfg = bootstrapper.getCurrentConfig();
      expect(cfg).toBeDefined();

      const runtime1 = bootstrapper.bootstrap();
      const runtime2 = bootstrapper.getRuntime();
      expect(runtime1).toBe(runtime2);

      expect(process.env.PB_TEMPLATES_DIR).toBe(join(tmpRoot, 'templates'));
    } finally {
      if (prevTemplatesDir === undefined) {
        delete process.env.PB_TEMPLATES_DIR;
      } else {
        process.env.PB_TEMPLATES_DIR = prevTemplatesDir;
      }
      intervalSpy.mockRestore();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('bootstraps using injected components', () => {
    const config = makeConfig({ enableMetrics: false });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;
    const configManager = { getConfig: vi.fn().mockReturnValue(config) } as any;
    const orchestratorManager = {} as any;
    const protocolAdapters = {} as any;
    const serviceRegistry = { setHealthProbe: vi.fn() } as any;
    const authLayer = {} as any;
    const router = {} as any;
    const httpServer = { setOrchestratorManager: vi.fn(), addMiddleware: vi.fn() } as any;

    const bootstrapper = new GatewayBootstrapper({
      overrides: {
        logger,
        configManager,
        orchestratorManager,
        protocolAdapters,
        serviceRegistry,
        authLayer,
        router,
        httpServer
      }
    });

    const runtime = bootstrapper.bootstrap();
    expect(runtime.configManager).toBe(configManager);
    expect(runtime.serviceRegistry).toBe(serviceRegistry);
    expect(runtime.httpServer).toBe(httpServer);

    expect(httpServer.setOrchestratorManager).toHaveBeenCalledWith(orchestratorManager);
    expect(httpServer.addMiddleware).toHaveBeenCalledTimes(1);
    expect(serviceRegistry.setHealthProbe).toHaveBeenCalledTimes(1);
    expect(typeof serviceRegistry.setHealthProbe.mock.calls[0][0]).toBe('function');
  });

  it('wires a default health probe that checks running instances', async () => {
    const config = makeConfig({ enableMetrics: false });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;
    const configManager = { getConfig: vi.fn().mockReturnValue(config) } as any;

    const serviceRegistry = {
      setHealthProbe: vi.fn(),
      getService: vi.fn(),
      setInstanceMetadata: vi.fn().mockResolvedValue(undefined)
    } as any;

    const adapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: { tools: [] } })
    };

    const protocolAdapters = { createAdapter: vi.fn().mockResolvedValue(adapter) } as any;

    const bootstrapper = new GatewayBootstrapper({
      overrides: {
        logger,
        configManager,
        orchestratorManager: {} as any,
        protocolAdapters,
        serviceRegistry,
        authLayer: {} as any,
        router: {} as any,
        httpServer: { setOrchestratorManager: vi.fn(), addMiddleware: vi.fn() } as any
      }
    });

    bootstrapper.bootstrap();
    const probe = serviceRegistry.setHealthProbe.mock.calls[0][0] as (serviceId: string) => Promise<any>;

    serviceRegistry.getService.mockResolvedValueOnce(null);
    await expect(probe('missing')).resolves.toMatchObject({ healthy: false, error: 'Service not found' });

    serviceRegistry.getService.mockResolvedValueOnce({ id: 'svc', state: 'idle' });
    await expect(probe('svc')).resolves.toMatchObject({ healthy: false, error: 'Service not running' });

    serviceRegistry.getService.mockResolvedValueOnce({
      id: 'svc',
      state: 'running',
      config: { name: 't', version: '2024-11-26', transport: 'stdio', command: 'echo', args: [], timeout: 1000, retries: 0 }
    });
    await expect(probe('svc')).resolves.toMatchObject({ healthy: true });
    expect(protocolAdapters.createAdapter).toHaveBeenCalledTimes(1);
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(adapter.disconnect).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when templates dir env setup fails', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;

    // Force dirname/join to throw by injecting an invalid configPath type.
    const bootstrapper = new GatewayBootstrapper({
      configPath: 123 as any,
      overrides: {
        logger,
        configManager: { getConfig: vi.fn().mockReturnValue(makeConfig({ enableMetrics: false })) } as any,
        orchestratorManager: {} as any,
        protocolAdapters: {} as any,
        serviceRegistry: { setHealthProbe: vi.fn() } as any,
        authLayer: {} as any,
        router: {} as any,
        httpServer: { setOrchestratorManager: vi.fn(), addMiddleware: vi.fn() } as any
      }
    });

    bootstrapper.bootstrap();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('start registers templates and updates orchestrator status', async () => {
    const config = makeConfig({ enableMetrics: true });
    const template1 = { name: 't1', version: '2024-11-26', transport: 'stdio', command: 'echo', args: ['1'] };
    const template2 = { name: 't2', version: '2024-11-26', transport: 'stdio', command: 'echo', args: ['2'] };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;

    const configManager = {
      getConfig: vi.fn().mockReturnValue(config),
      loadConfig: vi.fn().mockResolvedValue(config),
      loadTemplates: vi.fn().mockResolvedValue(undefined),
      getLoadedTemplates: vi.fn().mockReturnValue([template1, template2]),
      startConfigWatch: vi.fn(),
      stopConfigWatch: vi.fn()
    } as any;

    const orchestratorStatus = { enabled: false, mode: 'manager-only', subagentsDir: '/tmp/subagents' };
    const orchestratorManager = {
      loadConfig: vi.fn().mockResolvedValue({ enabled: false, mode: 'manager-only', subagentsDir: '/tmp/subagents' }),
      getStatus: vi.fn().mockReturnValue(orchestratorStatus)
    } as any;

    const serviceRegistry = {
      setHealthProbe: vi.fn(),
      registerTemplate: vi.fn().mockResolvedValue(undefined),
      listServices: vi.fn().mockResolvedValue([]),
      stopService: vi.fn().mockResolvedValue(true)
    } as any;

    const httpServer = {
      setOrchestratorManager: vi.fn(),
      addMiddleware: vi.fn(),
      updateOrchestratorStatus: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined)
    } as any;

    const bootstrapper = new GatewayBootstrapper({
      overrides: {
        logger,
        configManager,
        orchestratorManager,
        serviceRegistry,
        httpServer,
        protocolAdapters: {} as any,
        authLayer: {} as any,
        router: {} as any
      }
    });

    const prevDisable = process.env.DISABLE_HTTP_SERVER;
    process.env.DISABLE_HTTP_SERVER = '1';
    let result: any;
    try {
      result = await bootstrapper.start();
    } finally {
      if (prevDisable === undefined) {
        delete process.env.DISABLE_HTTP_SERVER;
      } else {
        process.env.DISABLE_HTTP_SERVER = prevDisable;
      }
    }
    expect(result.templatesCount).toBe(2);
    expect(httpServer.updateOrchestratorStatus).toHaveBeenCalledWith(orchestratorStatus);
    expect(serviceRegistry.registerTemplate).toHaveBeenCalledTimes(2);
    expect(configManager.startConfigWatch).toHaveBeenCalledTimes(1);
    expect(httpServer.start).not.toHaveBeenCalled(); // test env should not start the real server
  });

  it('stop shuts down services and watchers', async () => {
    const config = makeConfig({ enableMetrics: true });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;

    const configManager = {
      getConfig: vi.fn().mockReturnValue(config),
      stopConfigWatch: vi.fn()
    } as any;

    const serviceRegistry = {
      setHealthProbe: vi.fn(),
      listServices: vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]),
      stopService: vi.fn().mockResolvedValue(true)
    } as any;

    const httpServer = {
      setOrchestratorManager: vi.fn(),
      addMiddleware: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    } as any;

    const bootstrapper = new GatewayBootstrapper({
      overrides: {
        logger,
        configManager,
        orchestratorManager: {} as any,
        protocolAdapters: {} as any,
        serviceRegistry,
        authLayer: {} as any,
        router: {} as any,
        httpServer
      }
    });

    // Ensure runtime is constructed before stop
    bootstrapper.bootstrap();
    await bootstrapper.stop();

    expect(configManager.stopConfigWatch).toHaveBeenCalledTimes(1);
    expect(httpServer.stop).toHaveBeenCalledTimes(1);
    expect(serviceRegistry.stopService).toHaveBeenCalledWith('s1');
    expect(serviceRegistry.stopService).toHaveBeenCalledWith('s2');
  });

  it('start calls httpServer.start when not in test env, and logs enabled orchestrator', async () => {
    const config = makeConfig({ enableMetrics: false });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;
    const configManager = {
      getConfig: vi.fn().mockReturnValue(config),
      loadConfig: vi.fn().mockResolvedValue(config),
      loadTemplates: vi.fn().mockResolvedValue(undefined),
      getLoadedTemplates: vi.fn().mockReturnValue([]),
      startConfigWatch: vi.fn(),
      stopConfigWatch: vi.fn()
    } as any;

    const orchestratorStatus = { enabled: true, mode: 'auto', subagentsDir: '/tmp/subagents' };
    const orchestratorManager = {
      loadConfig: vi.fn().mockResolvedValue({ enabled: true, mode: 'auto', subagentsDir: '/tmp/subagents' }),
      getStatus: vi.fn().mockReturnValue(orchestratorStatus)
    } as any;

    const httpServer = {
      setOrchestratorManager: vi.fn(),
      addMiddleware: vi.fn(),
      updateOrchestratorStatus: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined)
    } as any;

    const bootstrapper = new GatewayBootstrapper({
      overrides: {
        logger,
        configManager,
        orchestratorManager,
        serviceRegistry: { setHealthProbe: vi.fn(), registerTemplate: vi.fn(), listServices: vi.fn(), stopService: vi.fn() } as any,
        httpServer,
        protocolAdapters: {} as any,
        authLayer: {} as any,
        router: {} as any
      }
    });

    const prevVitest = process.env.VITEST;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevDisable = process.env.DISABLE_HTTP_SERVER;
    process.env.VITEST = '';
    process.env.NODE_ENV = 'production';
    delete process.env.DISABLE_HTTP_SERVER;

    try {
      await bootstrapper.start();
    } finally {
      if (prevVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = prevVitest;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevDisable === undefined) delete process.env.DISABLE_HTTP_SERVER;
      else process.env.DISABLE_HTTP_SERVER = prevDisable;
    }

    expect(httpServer.start).toHaveBeenCalledTimes(1);
    expect(configManager.startConfigWatch).not.toHaveBeenCalled();
    expect(logger.info.mock.calls.some(([msg]: any[]) => msg === 'Orchestrator enabled')).toBe(true);
  });

  it('ignores undefined overrides and unknown keys', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;
    new GatewayBootstrapper({
      logger,
      overrides: {
        // Undefined values should be ignored.
        router: undefined,
        // Unknown keys should be ignored.
        __unknown__: 1
      } as any
    });
  });
});

import { dirname, join } from 'path';
import { Container } from './Container.js';
import type {
  GatewayConfig,
  Logger,
  McpServiceConfig,
  ServiceTemplate
} from '../types/index.js';
import { ConfigManagerImpl } from '../config/ConfigManagerImpl.js';
import { ProtocolAdaptersImpl } from '../adapters/ProtocolAdaptersImpl.js';
import { ServiceRegistryImpl } from '../gateway/ServiceRegistryImpl.js';
import { AuthenticationLayerImpl } from '../auth/AuthenticationLayerImpl.js';
import { GatewayRouterImpl } from '../router/GatewayRouterImpl.js';
import { HttpApiServer } from '../server/HttpApiServer.js';
import { PinoLogger } from '../utils/PinoLogger.js';
import { SecurityMiddleware } from '../middleware/SecurityMiddleware.js';
import { OrchestratorManager, type OrchestratorStatus } from '../orchestrator/OrchestratorManager.js';
import { startOpenTelemetry, shutdownOpenTelemetry } from '../observability/otel.js';

export type GatewayRuntime = {
  logger: Logger;
  configManager: ConfigManagerImpl;
  orchestratorManager: OrchestratorManager;
  protocolAdapters: ProtocolAdaptersImpl;
  serviceRegistry: ServiceRegistryImpl;
  authLayer: AuthenticationLayerImpl;
  router: GatewayRouterImpl;
  httpServer: HttpApiServer;
};

export type GatewayBootstrapStartResult = {
  config: GatewayConfig;
  templatesCount: number;
  orchestratorStatus: OrchestratorStatus;
};

export type GatewayBootstrapperOverrides = Partial<GatewayRuntime>;

export type GatewayBootstrapperOptions = {
  configPath?: string;
  logger?: Logger;
  container?: Container;
  overrides?: GatewayBootstrapperOverrides;
};

const TOKENS = {
  logger: Symbol('pbmcp:logger'),
  configPath: Symbol('pbmcp:configPath'),
  configManager: Symbol('pbmcp:configManager'),
  orchestratorManager: Symbol('pbmcp:orchestratorManager'),
  protocolAdapters: Symbol('pbmcp:protocolAdapters'),
  serviceRegistry: Symbol('pbmcp:serviceRegistry'),
  authLayer: Symbol('pbmcp:authLayer'),
  router: Symbol('pbmcp:router'),
  httpServer: Symbol('pbmcp:httpServer')
} as const;

export class GatewayBootstrapper {
  static readonly TOKENS = TOKENS;

  readonly container: Container;

  private readonly configPath: string;
  private readonly logger: Logger;

  private config: GatewayConfig | null = null;
  private runtime: GatewayRuntime | null = null;

  constructor(options: GatewayBootstrapperOptions = {}) {
    this.container = options.container ?? new Container();
    this.configPath = options.configPath ?? join(process.cwd(), 'config', 'gateway.json');
    this.logger = options.logger ?? new PinoLogger({ level: 'info' });

    if (!this.container.has(TOKENS.configPath)) {
      this.container.register(TOKENS.configPath, this.configPath);
    }
    if (!this.container.has(TOKENS.logger)) {
      this.container.register(TOKENS.logger, this.logger);
    }

    if (options.overrides) {
      this.applyOverrides(options.overrides);
    }
  }

  bootstrap(): GatewayRuntime {
    if (this.runtime) return this.runtime;

    const logger = this.container.resolve<Logger>(TOKENS.logger);
    const configPath = this.container.resolve<string>(TOKENS.configPath);

    this.applyTemplatesDirEnv(configPath, logger);

    this.registerDefaults();

    const configManager = this.container.resolve<ConfigManagerImpl>(TOKENS.configManager);
    this.config = configManager.getConfig();

    const runtime: GatewayRuntime = {
      logger,
      configManager,
      orchestratorManager: this.container.resolve<OrchestratorManager>(TOKENS.orchestratorManager),
      protocolAdapters: this.container.resolve<ProtocolAdaptersImpl>(TOKENS.protocolAdapters),
      serviceRegistry: this.container.resolve<ServiceRegistryImpl>(TOKENS.serviceRegistry),
      authLayer: this.container.resolve<AuthenticationLayerImpl>(TOKENS.authLayer),
      router: this.container.resolve<GatewayRouterImpl>(TOKENS.router),
      httpServer: this.container.resolve<HttpApiServer>(TOKENS.httpServer)
    };

    // Core wiring
    runtime.httpServer.setOrchestratorManager(runtime.orchestratorManager);
    runtime.httpServer.addMiddleware(new SecurityMiddleware());

    this.registerDefaultHealthProbe(runtime);

    this.runtime = runtime;
    return runtime;
  }

  getRuntime(): GatewayRuntime {
    return this.bootstrap();
  }

  /**
   * Keep ProtocolAdapters in sync after config loads/updates.
   */
  setCurrentConfig(config: GatewayConfig): void {
    this.config = config;
  }

  getCurrentConfig(): GatewayConfig {
    if (!this.config) {
      this.config = this.bootstrap().configManager.getConfig();
    }
    return this.config;
  }

  async start(): Promise<GatewayBootstrapStartResult> {
    const runtime = this.bootstrap();

    await startOpenTelemetry(runtime.logger, { serviceName: 'pb-mcpgateway' });
    runtime.logger.info('Starting PB MCP Nexus...');

    // Load configuration
    const config = await runtime.configManager.loadConfig();
    this.setCurrentConfig(config);
    runtime.logger.info('Configuration loaded', {
      authMode: config.authMode,
      port: config.port,
      host: config.host
    });

    // Load orchestrator configuration
    const orchestratorConfig = await runtime.orchestratorManager.loadConfig();
    const orchestratorStatus = runtime.orchestratorManager.getStatus();
    if (orchestratorStatus.enabled) {
      runtime.logger.info('Orchestrator enabled', {
        mode: orchestratorConfig.mode,
        subagentsDir: orchestratorStatus.subagentsDir
      });
    } else {
      runtime.logger.info('Orchestrator disabled', {
        reason: orchestratorStatus.reason || 'disabled by configuration'
      });
    }
    runtime.httpServer.updateOrchestratorStatus(orchestratorStatus);

    // Load service templates
    await runtime.configManager.loadTemplates();
    const templates = runtime.configManager.getLoadedTemplates();
    runtime.logger.info(`Loaded ${templates.length} service templates`);

    // Register templates with service registry
    for (const template of templates) {
      await runtime.serviceRegistry.registerTemplate(this.toMcpServiceConfig(template));
    }

    // Start HTTP API server (skip in test environments)
    const isTestEnv =
      Boolean(process.env.VITEST) ||
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_HTTP_SERVER === '1';
    if (!isTestEnv) {
      await runtime.httpServer.start();
    } else {
      runtime.logger.debug?.('HTTP server disabled in test environment');
    }

    // Start configuration watching if enabled
    if (config.enableMetrics) {
      runtime.configManager.startConfigWatch();
    }

    runtime.logger.info('PB MCP Nexus started successfully', {
      port: config.port,
      host: config.host,
      authMode: config.authMode,
      templates: templates.length
    });

    return { config, templatesCount: templates.length, orchestratorStatus };
  }

  async stop(): Promise<void> {
    const runtime = this.bootstrap();

    runtime.logger.info('Stopping PB MCP Nexus...');

    runtime.configManager.stopConfigWatch();

    await runtime.httpServer.stop();

    const services = await runtime.serviceRegistry.listServices();
    for (const service of services) {
      await runtime.serviceRegistry.stopService(service.id);
    }

    runtime.logger.info('PB MCP Nexus stopped successfully');
    await shutdownOpenTelemetry(runtime.logger);
  }

  private applyTemplatesDirEnv(configPath: string, logger: Logger): void {
    try {
      const templatesDir = join(dirname(configPath), 'templates');
      process.env.PB_TEMPLATES_DIR = templatesDir;
    } catch (error) {
      logger.warn('Failed to set templates directory:', error);
    }
  }

  private registerDefaults(): void {
    if (!this.container.has(TOKENS.configManager)) {
      this.container.singleton(TOKENS.configManager, (c) => {
        const configPath = c.resolve<string>(TOKENS.configPath);
        const logger = c.resolve<Logger>(TOKENS.logger);
        return new ConfigManagerImpl(configPath, logger);
      });
    }

    if (!this.container.has(TOKENS.orchestratorManager)) {
      this.container.singleton(TOKENS.orchestratorManager, (c) => {
        const configPath = c.resolve<string>(TOKENS.configPath);
        const logger = c.resolve<Logger>(TOKENS.logger);
        return new OrchestratorManager(configPath, logger);
      });
    }

    if (!this.container.has(TOKENS.protocolAdapters)) {
      this.container.singleton(TOKENS.protocolAdapters, (c) => {
        const logger = c.resolve<Logger>(TOKENS.logger);
        return new ProtocolAdaptersImpl(logger, () => this.getCurrentConfig());
      });
    }

    if (!this.container.has(TOKENS.serviceRegistry)) {
      this.container.singleton(TOKENS.serviceRegistry, (c) => {
        const logger = c.resolve<Logger>(TOKENS.logger);
        return new ServiceRegistryImpl(logger);
      });
    }

    if (!this.container.has(TOKENS.authLayer)) {
      this.container.singleton(TOKENS.authLayer, (c) => {
        const logger = c.resolve<Logger>(TOKENS.logger);
        // Preserve existing behavior: auth layer captures config at construction.
        return new AuthenticationLayerImpl(this.getCurrentConfig(), logger);
      });
    }

    if (!this.container.has(TOKENS.router)) {
      this.container.singleton(TOKENS.router, (c) => {
        const logger = c.resolve<Logger>(TOKENS.logger);
        return new GatewayRouterImpl(logger, this.getCurrentConfig().loadBalancingStrategy);
      });
    }

    if (!this.container.has(TOKENS.httpServer)) {
      this.container.singleton(TOKENS.httpServer, (c) => {
        const config = this.getCurrentConfig();
        const logger = c.resolve<Logger>(TOKENS.logger);
        const configManager = c.resolve<ConfigManagerImpl>(TOKENS.configManager);
        return new HttpApiServer(config, logger, configManager, {
          serviceRegistry: c.resolve<ServiceRegistryImpl>(TOKENS.serviceRegistry),
          authLayer: c.resolve<AuthenticationLayerImpl>(TOKENS.authLayer),
          router: c.resolve<GatewayRouterImpl>(TOKENS.router),
          protocolAdapters: c.resolve<ProtocolAdaptersImpl>(TOKENS.protocolAdapters)
        });
      });
    }
  }

  private applyOverrides(overrides: GatewayBootstrapperOverrides): void {
    for (const [key, value] of Object.entries(overrides) as Array<[keyof GatewayRuntime, any]>) {
      if (value === undefined) continue;
      const token = (TOKENS as any)[key] as symbol | undefined;
      if (!token) continue;
      this.container.register(token, value);
    }
  }

  private toMcpServiceConfig(template: ServiceTemplate): McpServiceConfig {
    return {
      name: template.name,
      version: template.version,
      transport: template.transport,
      command: template.command,
      args: template.args,
      env: template.env,
      workingDirectory: template.workingDirectory,
      timeout: template.timeout ?? 30000,
      retries: template.retries ?? 3,
      healthCheck: template.healthCheck,
      // Preserve extended fields when templates are authored via API / disk (defense-in-depth)
      container: (template as any).container,
      security: (template as any).security
    };
  }

  private registerDefaultHealthProbe(runtime: Pick<GatewayRuntime, 'serviceRegistry' | 'protocolAdapters'>): void {
    try {
      runtime.serviceRegistry.setHealthProbe(async (serviceId: string) => {
        const service = await runtime.serviceRegistry.getService(serviceId);
        if (!service) {
          return { healthy: false, error: 'Service not found', timestamp: new Date() } as any;
        }
        if ((service as any).state !== 'running') {
          return { healthy: false, error: 'Service not running', timestamp: new Date() } as any;
        }
        const start = Date.now();
        try {
          const adapter = await runtime.protocolAdapters.createAdapter(service.config);
          await adapter.connect();
          try {
            const msg: any = { jsonrpc: '2.0', id: `health-${Date.now()}`, method: 'tools/list', params: {} };
            const res = (adapter as any).sendAndReceive
              ? await (adapter as any).sendAndReceive(msg)
              : await adapter.send(msg as any);
            const latency = Date.now() - start;
            const ok = !!(res && (res as any).result);
            if (!ok && (res as any)?.error?.message) {
              try {
                await runtime.serviceRegistry.setInstanceMetadata(serviceId, 'lastProbeError', (res as any).error.message);
              } catch {}
            }
            return { healthy: ok, latency, timestamp: new Date() };
          } finally {
            await adapter.disconnect();
          }
        } catch (e: any) {
          const errMsg = e?.message || 'probe failed';
          try {
            await runtime.serviceRegistry.setInstanceMetadata(serviceId, 'lastProbeError', errMsg);
          } catch {}
          return { healthy: false, error: errMsg, latency: Date.now() - start, timestamp: new Date() } as any;
        }
      });
    } catch {}
  }
}


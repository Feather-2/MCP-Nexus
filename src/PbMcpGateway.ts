import {
  GatewayConfig,
  Logger,
  ServiceInstance,
  ServiceHealth,
  ServiceTemplate,
  McpServiceConfig,
  HealthCheckResult
} from './types/index.js';
import { ServiceRegistryImpl } from './gateway/ServiceRegistryImpl.js';
import { AuthenticationLayerImpl } from './auth/AuthenticationLayerImpl.js';
import { GatewayRouterImpl } from './router/GatewayRouterImpl.js';
import { ProtocolAdaptersImpl } from './adapters/ProtocolAdaptersImpl.js';
import { ConfigManagerImpl } from './config/ConfigManagerImpl.js';
import { SecurityMiddleware } from './middleware/SecurityMiddleware.js';
import { HttpApiServer } from './server/HttpApiServer.js';
import { ConsoleLogger } from './utils/ConsoleLogger.js';
import { EventEmitter } from 'events';
import { join } from 'path';
import { OrchestratorManager, OrchestratorStatus } from './orchestrator/OrchestratorManager.js';

export class PbMcpGateway extends EventEmitter {
  private config: GatewayConfig;
  private logger: Logger;
  private configManager: ConfigManagerImpl;
  private protocolAdapters: ProtocolAdaptersImpl;
  private _serviceRegistry: ServiceRegistryImpl;
  private authLayer: AuthenticationLayerImpl;
  private router: GatewayRouterImpl;
  private httpServer: HttpApiServer;
  private orchestratorManager: OrchestratorManager;
  private orchestratorStatus: OrchestratorStatus | null = null;
  private _isStarted = false;

  constructor(configPath?: string, logger?: Logger) {
    super();

    // Set up logger
    this.logger = logger || new ConsoleLogger('info');

    // Initialize config manager
    const defaultConfigPath = configPath || join(process.cwd(), 'config', 'gateway.json');
    // Ensure ServiceTemplateManager uses the same templates directory as ConfigManager
    try {
      const templatesDir = join(process.cwd(), 'config', 'templates');
      process.env.PB_TEMPLATES_DIR = templatesDir;
    } catch (error) {
      this.logger.warn('Failed to set templates directory:', error);
    }
    this.configManager = new ConfigManagerImpl(defaultConfigPath, this.logger);
    this.orchestratorManager = new OrchestratorManager(defaultConfigPath, this.logger);

    // Initialize default config
    this.config = this.configManager.getConfig();

    // Initialize core components
    this.protocolAdapters = new ProtocolAdaptersImpl(this.logger, () => this.config);
    this._serviceRegistry = new ServiceRegistryImpl(this.logger);
    this.authLayer = new AuthenticationLayerImpl(this.config, this.logger);
    this.router = new GatewayRouterImpl(this.logger, this.config.loadBalancingStrategy);
    this.httpServer = new HttpApiServer(this.config, this.logger, this.configManager);
    this.httpServer.setOrchestratorManager(this.orchestratorManager);

    // Register Security Middleware
    this.httpServer.addMiddleware(new SecurityMiddleware());

    this.setupEventHandlers();
  }

  isRunning(): boolean {
    return this._isStarted;
  }

  // Public property accessors for testing and external use
  get serviceRegistry(): ServiceRegistryImpl {
    return this._serviceRegistry;
  }

  async start(): Promise<void> {
    if (this._isStarted) {
      throw new Error('Gateway is already started');
    }

    try {
      this.logger.info('Starting PB MCP Nexus...');

      // Load configuration
      this.config = await this.configManager.loadConfig();
      this.logger.info('Configuration loaded', {
        authMode: this.config.authMode,
        port: this.config.port,
        host: this.config.host
      });

      // Load orchestrator configuration
      const orchestratorConfig = await this.orchestratorManager.loadConfig();
      this.orchestratorStatus = this.orchestratorManager.getStatus();
      if (this.orchestratorStatus.enabled) {
        this.logger.info('Orchestrator enabled', {
          mode: orchestratorConfig.mode,
          subagentsDir: this.orchestratorStatus.subagentsDir
        });
      } else {
        this.logger.info('Orchestrator disabled', {
          reason: this.orchestratorStatus.reason || 'disabled by configuration'
        });
      }
      this.httpServer.updateOrchestratorStatus(this.orchestratorStatus);

      // Load service templates
      await this.configManager.loadTemplates();
      const templates = this.configManager.getLoadedTemplates();
      this.logger.info(`Loaded ${templates.length} service templates`);

      // Register templates with service registry
      for (const template of templates) {
        // Convert ServiceTemplate to McpServiceConfig
        const serviceConfig: McpServiceConfig = {
          name: template.name,
          version: template.version,
          transport: template.transport,
          command: template.command,
          args: template.args,
          env: template.env,
          workingDirectory: template.workingDirectory,
          timeout: template.timeout ?? 30000, // Provide default
          retries: template.retries ?? 3, // Provide default
          healthCheck: template.healthCheck,
          // Preserve extended fields when templates are authored via API / disk (defense-in-depth)
          container: (template as any).container,
          security: (template as any).security
        };
        await this._serviceRegistry.registerTemplate(serviceConfig);
      }

      // Start HTTP API server (skip in test environments)
      const isTestEnv = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test' || process.env.DISABLE_HTTP_SERVER === '1';
      if (!isTestEnv) {
        await this.httpServer.start();
      } else {
        this.logger.debug?.('HTTP server disabled in test environment');
      }

      // Mark as started
      this._isStarted = true;

      this.logger.info('PB MCP Nexus started successfully', {
        port: this.config.port,
        host: this.config.host,
        authMode: this.config.authMode,
        templates: templates.length
      });

      this.emit('started', {
        config: this.config,
        templatesCount: templates.length
      });

      // Start configuration watching if enabled
      if (this.config.enableMetrics) {
        this.configManager.startConfigWatch();
      }

    } catch (error) {
      this.logger.error('Failed to start gateway:', error);
      this.emit('error', error);
      throw error;
    }
  }

  getOrchestratorStatus(): OrchestratorStatus {
    if (!this.orchestratorStatus) {
      return this.orchestratorManager.getStatus();
    }
    return this.orchestratorStatus;
  }

  async stop(): Promise<void> {
    if (!this._isStarted) {
      return;
    }

    try {
      this.logger.info('Stopping PB MCP Nexus...');

      // Stop configuration watching
      this.configManager.stopConfigWatch();

      // Stop HTTP server
      await this.httpServer.stop();

      // Stop all services
      const services = await this._serviceRegistry.listServices();
      for (const service of services) {
        await this._serviceRegistry.stopService(service.id);
      }

      this._isStarted = false;

      this.logger.info('PB MCP Nexus stopped successfully');
      this.emit('stopped');

    } catch (error) {
      this.logger.error('Error stopping gateway:', error);
      this.emit('error', error);
      throw error;
    }
  }

  // Service management methods
  async createService(templateName: string, instanceArgs: any = {}): Promise<string> {
    this.ensureStarted();
    return await this._serviceRegistry.createServiceFromTemplate(templateName, instanceArgs);
  }

  async stopService(serviceId: string): Promise<boolean> {
    this.ensureStarted();
    return await this._serviceRegistry.stopService(serviceId);
  }

  async getService(serviceId: string): Promise<ServiceInstance | null> {
    this.ensureStarted();
    return await this._serviceRegistry.getService(serviceId);
  }

  async listServices(): Promise<ServiceInstance[]> {
    this.ensureStarted();
    return await this._serviceRegistry.listServices();
  }

  async getServiceStatus(serviceId: string): Promise<ServiceHealth> {
    this.ensureStarted();
    const health = await this._serviceRegistry.checkHealth(serviceId);
    return this.convertHealthResult(health);
  }

  // Convert HealthCheckResult to ServiceHealth
  private convertHealthResult(result: HealthCheckResult): ServiceHealth {
    return {
      status: result.healthy ? 'healthy' : 'unhealthy',
      responseTime: result.latency || 0,
      lastCheck: result.timestamp,
      error: result.error
    };
  }

  // Template management methods
  async listTemplates(): Promise<ServiceTemplate[]> {
    return this.configManager.listTemplates();
  }

  async registerTemplate(template: ServiceTemplate): Promise<void> {
    await this.configManager.saveTemplate(template);

    // Convert ServiceTemplate to McpServiceConfig
    const serviceConfig: McpServiceConfig = {
      name: template.name,
      version: template.version,
      transport: template.transport,
      command: template.command,
      args: template.args,
      env: template.env,
      workingDirectory: template.workingDirectory,
      timeout: template.timeout ?? 30000, // Provide default
      retries: template.retries ?? 3, // Provide default
      healthCheck: template.healthCheck,
      container: (template as any).container,
      security: (template as any).security
    };
    await this._serviceRegistry.registerTemplate(serviceConfig);
  }

  async removeTemplate(templateName: string): Promise<boolean> {
    const removed = await this.configManager.removeTemplate(templateName);
    if (removed) {
      await this._serviceRegistry.removeTemplate(templateName);
    }
    return removed;
  }

  // Configuration management methods
  getConfig(): GatewayConfig {
    return this.configManager.getConfig();
  }

  async updateConfig(updates: Partial<GatewayConfig>): Promise<GatewayConfig> {
    const newConfig = await this.configManager.updateConfig(updates);
    this.config = newConfig;

    // Update components with new config
    if (updates.loadBalancingStrategy) {
      await this.router.updateLoadBalancingStrategy(updates.loadBalancingStrategy);
    }

    this.emit('configUpdated', newConfig);
    return newConfig;
  }

  async exportConfig(): Promise<string> {
    return await this.configManager.exportConfig();
  }

  async importConfig(configData: string): Promise<void> {
    await this.configManager.importConfig(configData);
    this.config = this.configManager.getConfig();
    this.emit('configImported');
  }

  // Authentication methods
  async generateToken(userId: string, permissions: string[], expiresInHours = 24): Promise<string> {
    this.ensureStarted();
    return await this.authLayer.generateToken(userId, permissions, expiresInHours);
  }

  async createApiKey(name: string, permissions: string[]): Promise<string> {
    this.ensureStarted();
    return await this.authLayer.createApiKey(name, permissions);
  }

  async revokeToken(token: string): Promise<boolean> {
    this.ensureStarted();
    return await this.authLayer.revokeToken(token);
  }

  async revokeApiKey(apiKey: string): Promise<boolean> {
    this.ensureStarted();
    return await this.authLayer.revokeApiKey(apiKey);
  }

  // Monitoring and metrics methods
  async getHealthStatus(): Promise<{
    gateway: { status: string; uptime: number };
    services: Array<{ id: string; name: string; status: 'healthy' | 'unhealthy' | 'unknown'; health: ServiceHealth }>;
    metrics: {
      totalServices: number;
      healthyServices: number;
      totalRequests: number;
      successRate: number;
    };
  }> {
    this.ensureStarted();

    const services = await this._serviceRegistry.listServices();
    const serviceHealths: Array<{ id: string; name: string; status: 'healthy' | 'unhealthy' | 'unknown'; health: ServiceHealth }> = [];
    let healthyCount = 0;

    for (const service of services) {
      try {
        const health = await this._serviceRegistry.checkHealth(service.id);
        const serviceHealth = this.convertHealthResult(health);
        serviceHealths.push({
          id: service.id,
          name: service.config.name,
          status: serviceHealth.status,
          health: serviceHealth
        });
        if (serviceHealth.status === 'healthy') {
          healthyCount++;
        }
      } catch (error) {
        serviceHealths.push({
          id: service.id,
          name: service.config.name,
          status: 'unhealthy' as const,
          health: {
            status: 'unhealthy' as const,
            responseTime: Infinity,
            lastCheck: new Date(),
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        });
      }
    }

    const routerMetrics = this.router.getMetrics();
    await this._serviceRegistry.getRegistryStats(); // Fetch stats but don't need to use them here

    return {
      gateway: {
        status: 'healthy',
        uptime: process.uptime() * 1000
      },
      services: serviceHealths,
      metrics: {
        totalServices: services.length,
        healthyServices: healthyCount,
        totalRequests: routerMetrics.totalRequests,
        successRate: routerMetrics.successRate
      }
    };
  }

  getMetrics(): {
    registry: ReturnType<ServiceRegistryImpl['getRegistryStats']>;
    router: ReturnType<GatewayRouterImpl['getMetrics']>;
    auth: { activeTokens: number; activeApiKeys: number };
  } {
    this.ensureStarted();

    return {
      registry: this._serviceRegistry.getRegistryStats(),
      router: this.router.getMetrics(),
      auth: {
        activeTokens: this.authLayer.getActiveTokenCount(),
        activeApiKeys: this.authLayer.getActiveApiKeyCount()
      }
    };
  }

  // Utility methods
  isStarted(): boolean {
    return this._isStarted;
  }

  getVersion(): string {
    return '1.0.0';
  }

  // Access to underlying components (for advanced usage)
  getServiceRegistry(): ServiceRegistryImpl {
    return this._serviceRegistry;
  }

  getAuthLayer(): AuthenticationLayerImpl {
    return this.authLayer;
  }

  getRouter(): GatewayRouterImpl {
    return this.router;
  }

  getHttpServer(): HttpApiServer {
    return this.httpServer;
  }

  getConfigManager(): ConfigManagerImpl {
    return this.configManager;
  }

  private setupEventHandlers(): void {
    // Forward events from components
    this._serviceRegistry.on('serviceCreated', (event) => {
      this.emit('serviceCreated', event);
    });

    this._serviceRegistry.on('serviceStopped', (event) => {
      this.emit('serviceStopped', event);
    });

    this._serviceRegistry.on('serviceHealthChanged', (event) => {
      this.emit('serviceHealthChanged', event);
    });

    this.authLayer.on('tokenGenerated', (event) => {
      this.emit('tokenGenerated', event);
    });

    this.authLayer.on('tokenRevoked', (event) => {
      this.emit('tokenRevoked', event);
    });

    this.router.on('requestRouted', (event) => {
      this.emit('requestRouted', event);
    });

    this.configManager.on('configUpdated', (event) => {
      this.emit('configUpdated', event);
    });

    // Handle process signals for graceful shutdown
    process.on('SIGINT', async () => {
      this.logger.info('Received SIGINT, shutting down gracefully...');
      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        this.logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    });

    process.on('SIGTERM', async () => {
      this.logger.info('Received SIGTERM, shutting down gracefully...');
      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        this.logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    });
  }

  private ensureStarted(): void {
    if (!this.isStarted) {
      throw new Error('Gateway is not started. Call start() first.');
    }
  }
}

// Factory function for easier instantiation
export function createGateway(
  config?: Partial<GatewayConfig & { configPath?: string }>,
  logger?: Logger
): PbMcpGateway {
  const { configPath, logLevel, ...gatewayConfig } = config || {};

  // Create logger with specified level if no logger provided
  const gatewayLogger = logger || new ConsoleLogger(logLevel || 'info');

  const gateway = new PbMcpGateway(configPath, gatewayLogger);

  if (Object.keys(gatewayConfig).length > 0) {
    // Apply config updates after construction
    gateway.updateConfig(gatewayConfig);
  }

  return gateway;
}

// Default export
export default PbMcpGateway;

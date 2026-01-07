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
import { HttpApiServer } from './server/HttpApiServer.js';
import { PinoLogger } from './utils/PinoLogger.js';
import { EventEmitter } from 'events';
import { OrchestratorManager, OrchestratorStatus } from './orchestrator/OrchestratorManager.js';
import { GatewayBootstrapper } from './bootstrap/GatewayBootstrapper.js';

export class PbMcpGateway extends EventEmitter {
  private logger: Logger;
  private configManager: ConfigManagerImpl;
  private protocolAdapters: ProtocolAdaptersImpl;
  private _serviceRegistry: ServiceRegistryImpl;
  private authLayer: AuthenticationLayerImpl;
  private router: GatewayRouterImpl;
  private httpServer: HttpApiServer;
  private orchestratorManager: OrchestratorManager;
  private readonly bootstrapper: GatewayBootstrapper;
  private orchestratorStatus: OrchestratorStatus | null = null;
  private _isStarted = false;

  constructor(configPath?: string, logger?: Logger, bootstrapper?: GatewayBootstrapper) {
    super();

    this.bootstrapper = bootstrapper ?? new GatewayBootstrapper({ configPath, logger });
    const runtime = this.bootstrapper.bootstrap();

    this.logger = runtime.logger;
    this.configManager = runtime.configManager;
    this.protocolAdapters = runtime.protocolAdapters;
    this._serviceRegistry = runtime.serviceRegistry;
    this.authLayer = runtime.authLayer;
    this.router = runtime.router;
    this.httpServer = runtime.httpServer;
    this.orchestratorManager = runtime.orchestratorManager;

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
      const result = await this.bootstrapper.start();
      this.orchestratorStatus = result.orchestratorStatus;

      // Mark as started
      this._isStarted = true;

      this.emit('started', {
        config: result.config,
        templatesCount: result.templatesCount
      });
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
      // Disable signal handlers if enabled
      this.disableGracefulShutdown();

      // Clean up event listeners from components
      this._serviceRegistry.removeAllListeners();
      this.authLayer.removeAllListeners();
      this.router.removeAllListeners();
      this.configManager.removeAllListeners();

      await this.bootstrapper.stop();

      this._isStarted = false;

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
    this.bootstrapper.setCurrentConfig(newConfig);

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
    const config = this.configManager.getConfig();
    this.bootstrapper.setCurrentConfig(config);
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
  }

  // Signal handlers stored for cleanup
  private signalHandlers: {
    SIGINT?: NodeJS.SignalsListener;
    SIGTERM?: NodeJS.SignalsListener;
  } = {};

  /**
   * Enable graceful shutdown on SIGINT/SIGTERM.
   * Call this from CLI/entry points, not during library usage.
   */
  enableGracefulShutdown(): void {
    if (this.signalHandlers.SIGINT) return; // Already enabled

    this.signalHandlers.SIGINT = async () => {
      this.logger.info('Received SIGINT, shutting down gracefully...');
      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        this.logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    this.signalHandlers.SIGTERM = async () => {
      this.logger.info('Received SIGTERM, shutting down gracefully...');
      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        this.logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', this.signalHandlers.SIGINT);
    process.on('SIGTERM', this.signalHandlers.SIGTERM);
  }

  /**
   * Disable graceful shutdown handlers (useful for tests).
   */
  disableGracefulShutdown(): void {
    if (this.signalHandlers.SIGINT) {
      process.off('SIGINT', this.signalHandlers.SIGINT);
      delete this.signalHandlers.SIGINT;
    }
    if (this.signalHandlers.SIGTERM) {
      process.off('SIGTERM', this.signalHandlers.SIGTERM);
      delete this.signalHandlers.SIGTERM;
    }
  }

  private ensureStarted(): void {
    if (!this._isStarted) {
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
  const gatewayLogger =
    logger ||
    new PinoLogger({ level: (logLevel || 'info') as any, pretty: process.env.PB_LOG_PRETTY === '1' });

  const gateway = new PbMcpGateway(configPath, gatewayLogger);

  if (Object.keys(gatewayConfig).length > 0) {
    // Apply config updates after construction
    gateway.updateConfig(gatewayConfig);
  }

  return gateway;
}

// Default export
export default PbMcpGateway;

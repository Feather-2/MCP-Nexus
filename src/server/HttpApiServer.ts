import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
// Local MCP 加密/握手逻辑已下放到路由模块，无需在此引入 crypto
import {
  Logger,
  GatewayConfig,
  ServiceHealth,
  HealthCheckResult
} from '../types/index.js';
import { ServiceRegistryImpl } from '../gateway/ServiceRegistryImpl.js';
import { AuthenticationLayerImpl } from '../auth/AuthenticationLayerImpl.js';
import { GatewayRouterImpl } from '../routing/GatewayRouterImpl.js';
import { ProtocolAdaptersImpl } from '../adapters/ProtocolAdaptersImpl.js';
import type { OrchestratorStatus, OrchestratorManager } from '../orchestrator/OrchestratorManager.js';
import { OrchestratorEngine } from '../orchestrator/OrchestratorEngine.js';
import { SubagentLoader } from '../orchestrator/SubagentLoader.js';
import { InstancePersistence } from '../gateway/InstancePersistence.js';
import { DeploymentPolicy } from '../security/DeploymentPolicy.js';
import { ToolListCache } from '../gateway/ToolListCache.js';
import { AdapterPool } from '../adapters/AdapterPool.js';
import {
  RouteContext,
  ServiceRoutes,
  AuthRoutes,
  ConfigRoutes,
  LogRoutes,
  TemplateRoutes,
  MonitoringRoutes,
  RoutingRoutes,
  ExternalImportRoutes,
  OrchestratorRoutes,
  LocalMcpProxyRoutes,
  SandboxRoutes,
  DeploymentRoutes,
  ToolRoutes,
  SkillRoutes,
  SkillApprovalRoutes
} from './routes/index.js';
import { Middleware } from '../middleware/types.js';
import {
  MiddlewareChain,
  MiddlewareTimeoutError,
  MiddlewareAbortedError,
  MiddlewareStageError
} from '../middleware/chain.js';
import { unrefTimer } from '../utils/async.js';
import { AuthMiddleware } from '../middleware/AuthMiddleware.js';
import { RateLimitMiddleware } from '../middleware/RateLimitMiddleware.js';
import { setupObservabilityHooks } from './ObservabilityHooks.js';
import { setupMiddlewareWiring } from './MiddlewareWiring.js';

// Fastify request/reply augmentation helpers (avoids per-line `as any`)
type AugmentedRequest = FastifyRequest & Record<string, unknown>;

export class HttpApiServer {
  private static readonly MAX_LOG_BUFFER_SIZE = 200;
  private static readonly API_VERSION = 'v1';
  private server: FastifyInstance;
  private serviceRegistry: ServiceRegistryImpl;
  private authLayer: AuthenticationLayerImpl;
  private router: GatewayRouterImpl;
  private protocolAdapters: ProtocolAdaptersImpl;
  private configManager: import('../config/ConfigManagerImpl.js').ConfigManagerImpl;
  private readonly apiRoutesToAlias: Record<string, unknown>[] = [];
  private logBuffer: Array<{ timestamp: string; level: string; message: string; service?: string; data?: unknown }> = [];
  private logStreamClients: Set<FastifyReply> = new Set();
  private static readonly MAX_SSE_CONNECTIONS = 200;
  private sandboxStatus: { nodeReady: boolean; pythonReady: boolean; goReady: boolean; packagesReady: boolean; details: Record<string, unknown> } = { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} };
  private sandboxInstalling: boolean = false;
  private orchestratorStatus: OrchestratorStatus | null = null;
  private orchestratorManager?: OrchestratorManager;
  private orchestratorEngine?: OrchestratorEngine;
  private subagentLoader?: SubagentLoader;
  private sandboxStreamClients: Set<FastifyReply> = new Set();
  private instancePersistence?: InstancePersistence;
  private deploymentPolicy?: DeploymentPolicy;
  private toolListCache?: ToolListCache;
  private adapterPool?: AdapterPool;
  private middlewares: Middleware[] = [];
  private readonly middlewareChain: MiddlewareChain;
  // Demo 日志与 SSE 清理定时器
  private demoLogTimer?: ReturnType<typeof setInterval>;
  private sseCleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private config: GatewayConfig,
    private logger: Logger,
    configManager: import('../config/ConfigManagerImpl.js').ConfigManagerImpl,
    components?: {
      serviceRegistry?: ServiceRegistryImpl;
      authLayer?: AuthenticationLayerImpl;
      router?: GatewayRouterImpl;
      protocolAdapters?: ProtocolAdaptersImpl;
      middlewareChain?: MiddlewareChain;
    }
  ) {
    this.server = Fastify({
      logger: false, // We'll use our own logger
      bodyLimit: 10 * 1024 * 1024 // 10MB
    });

    this.configManager = configManager;

    this.setupApiVersioning();
    setupObservabilityHooks(this.server, this.logger, this.config);

    // Initialize core components
    this.protocolAdapters = components?.protocolAdapters || new ProtocolAdaptersImpl(logger, () => this.configManager.getConfig());
    this.serviceRegistry = components?.serviceRegistry || new ServiceRegistryImpl(logger);
    this.authLayer = components?.authLayer || new AuthenticationLayerImpl(config, logger);
    this.router = components?.router || new GatewayRouterImpl(logger, config.loadBalancingStrategy);
    this.middlewareChain = components?.middlewareChain ?? new MiddlewareChain([], {
      stageTimeoutMs: { beforeAgent: this.config.requestTimeout ?? 0 }
    });

    // Built-in cross-cutting middleware (migrated from Fastify hooks).
    const configProvider = {
      getConfig: () =>
        typeof this.configManager?.getConfig === 'function'
          ? this.configManager.getConfig()
          : this.config
    };
    this.addMiddleware(
      new RateLimitMiddleware(configProvider, {
        respondError: this.respondError.bind(this),
        requiresRateLimit: (req) => req.url.startsWith('/api/') && !req.url.startsWith('/api/health')
      })
    );
    this.addMiddleware(
      new AuthMiddleware(this.authLayer, {
        respondError: this.respondError.bind(this),
        requiresAuth: (req) => req.url.startsWith('/api/')
      })
    );

    this.setupRoutes();
    this.registerApiVersionAliases();
    this.setupErrorHandlers();
    setupMiddlewareWiring(
      this.server,
      this.config,
      this.logger,
      this.middlewareChain,
      this.respondError.bind(this),
      this.mapMiddlewareError.bind(this)
    );

    // Initialize log system
    this.initializeLogSystem();

    // Auto-wire a default health probe only when core components are owned by this server instance.
    // When components are injected (e.g., via GatewayBootstrapper), wiring is centralized upstream.
    const shouldAutoWireHealthProbe = !components?.serviceRegistry || !components?.protocolAdapters;
    if (shouldAutoWireHealthProbe) {
      this.registerDefaultHealthProbe();
    }
  }

  private registerDefaultHealthProbe(): void {
    try {
      this.serviceRegistry.setHealthProbe(async (serviceId: string) => {
        const service = await this.serviceRegistry.getService(serviceId);
        if (!service) {
          return { healthy: false, error: 'Service not found', timestamp: new Date() };
        }
        // 仅对运行中的实例做探测，避免为非运行/一次性服务反复拉起进程
        if (service.state !== 'running') {
          return { healthy: false, error: 'Service not running', timestamp: new Date() };
        }
        const start = Date.now();
        try {
          const adapter = await this.protocolAdapters.createAdapter(service.config);
          await adapter.connect();
          try {
            const msg = { jsonrpc: '2.0' as const, id: `health-${Date.now()}`, method: 'tools/list', params: {} };
            const sendReceive = (adapter as unknown as { sendAndReceive?: (m: unknown) => Promise<unknown> }).sendAndReceive;
            const res = sendReceive
              ? await sendReceive(msg)
              : await adapter.send(msg);
            const latency = Date.now() - start;
            const r = res as Record<string, unknown> | null;
            const ok = !!(r && r.result);
            if (!ok && (r?.error as Record<string, unknown>)?.message) {
              try {
                await this.serviceRegistry.setInstanceMetadata(serviceId, 'lastProbeError', String((r!.error as Record<string, unknown>).message));
              } catch {}
            }
            return { healthy: ok, latency, timestamp: new Date() };
          } finally {
            this.protocolAdapters.releaseAdapter(service.config, adapter);
          }
        } catch (e: unknown) {
          const errMsg = (e as Error)?.message || 'probe failed';
          try {
            await this.serviceRegistry.setInstanceMetadata(serviceId, 'lastProbeError', errMsg);
          } catch {}
          return { healthy: false, error: errMsg, latency: Date.now() - start, timestamp: new Date() };
        }
      });
    } catch {}
  }

  private initializeLogSystem(): void {
    // Add some initial log entries
    this.addLogEntry('info', '系统启动成功', 'gateway');
    this.addLogEntry('info', 'API 服务已就绪', 'api');
    this.addLogEntry('info', '监控服务已启动', 'monitor');

    // Set up periodic log generation for demo (dev only)
    if (process.env.NODE_ENV !== 'production') {
      this.demoLogTimer = setInterval(() => {
        const messages = [
          '处理客户端连接请求',
          '服务健康检查完成',
          '缓存清理任务执行',
          '网关路由更新',
          '认证令牌验证成功',
          '配置热重载完成'
        ];
        const levels = ['info', 'debug', 'warn'];
        const services = ['gateway', 'api', 'auth', 'router', 'monitor'];

        const message = messages[Math.floor(Math.random() * messages.length)];
        const level = levels[Math.floor(Math.random() * levels.length)];
        const service = services[Math.floor(Math.random() * services.length)];

        this.addLogEntry(level, message, service);
      }, 3000 + Math.random() * 7000); // Random interval between 3-10 seconds
      unrefTimer(this.demoLogTimer);
    }

    // Periodic cleanup of disconnected SSE clients
    this.sseCleanupTimer = setInterval(() => {
      try {
        for (const client of Array.from(this.logStreamClients)) {
          const raw = client.raw as { writableEnded?: boolean; destroyed?: boolean } | undefined;
          if (!raw || raw.writableEnded || raw.destroyed) {
            this.logStreamClients.delete(client);
          }
        }
        for (const client of Array.from(this.sandboxStreamClients)) {
          const raw = client.raw as { writableEnded?: boolean; destroyed?: boolean } | undefined;
          if (!raw || raw.writableEnded || raw.destroyed) {
            this.sandboxStreamClients.delete(client);
          }
        }
      } catch {}
    }, 30000);
    unrefTimer(this.sseCleanupTimer);
  }

  private setupApiVersioning(): void {
    // Capture `/api/*` routes and add `/api/v1/*` aliases after all routes are registered.
    // Avoid calling `server.route()` inside `onRoute` to prevent Fastify hook re-entrancy issues.
    this.server.addHook('onRoute', (opts) => {
      const url = (opts as unknown as Record<string, unknown>)?.url;
      if (typeof url !== 'string') return;
      if (!url.startsWith('/api/')) return;
      if (url.startsWith(`/api/${HttpApiServer.API_VERSION}/`)) return;
      if (((opts as unknown as Record<string, unknown>).config as Record<string, unknown>)?.__apiVersionAlias) return;
      this.apiRoutesToAlias.push({ ...(opts as unknown as Record<string, unknown>) });
    });
  }

  private registerApiVersionAliases(): void {
    for (const opts of this.apiRoutesToAlias) {
      try {
        const url = (opts as unknown as Record<string, unknown>)?.url;
        if (typeof url !== 'string') continue;
        const aliasedUrl = `/api/${HttpApiServer.API_VERSION}${url.slice('/api'.length)}`;
        const routeOpts = opts as unknown as Record<string, unknown>;
        this.server.route({
          ...routeOpts,
          url: aliasedUrl,
          config: { ...(routeOpts.config as Record<string, unknown> || {}), __apiVersionAlias: true }
        } as unknown as Parameters<FastifyInstance['route']>[0]);
      } catch {
        // Ignore duplicate route errors (e.g., in tests that rebuild servers).
      }
    }
  }

  private addLogEntry(level: string, message: string, service?: string, data?: unknown): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service,
      data
    };

    // Keep only last MAX_LOG_BUFFER_SIZE log entries
    this.logBuffer.push(logEntry);
    if (this.logBuffer.length > HttpApiServer.MAX_LOG_BUFFER_SIZE) {
      this.logBuffer.shift();
    }

    // Broadcast to all connected clients
    this.broadcastLogEntry(logEntry);
  }

  private broadcastLogEntry(logEntry: Record<string, unknown>): void {
    const payload = { ...logEntry, serviceId: logEntry.service };
    const message = `data: ${JSON.stringify(payload)}\n\n`;

    for (const client of this.logStreamClients) {
      try {
        client.raw.write(message);
      } catch (error) {
        // Remove disconnected clients
        this.logStreamClients.delete(client);
      }
    }
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

  async start(): Promise<void> {
    try {
      const host = this.config.host || '127.0.0.1';
      const port = this.config.port || 19233;

      await this.server.listen({ host, port });
      this.logger.info(`HTTP API server started on http://${host}:${port}`);
    } catch (error) {
      this.logger.error('Failed to start HTTP API server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      // 清理日志与 SSE 相关定时器
      if (this.demoLogTimer) clearInterval(this.demoLogTimer);
      if (this.sseCleanupTimer) clearInterval(this.sseCleanupTimer);

      // 30秒超时保护
      let shutdownTimer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<void>((_, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error('Server shutdown timeout after 30s')), 30000);
      });

      try {
        await Promise.race([this.server.close(), timeout]);
      } finally {
        clearTimeout(shutdownTimer!);
      }
      this.logger.info('HTTP API server stopped');
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        this.logger.warn('Server shutdown timeout, forcing close');
      } else {
        this.logger.error('Error stopping HTTP API server:', error);
      }
      throw error;
    }
  }

  /**
   * Create route context for modular route handlers
   */
  private createRouteContext(): RouteContext {
    const self = this;
    return {
      server: this.server,
      logger: this.logger,
      serviceRegistry: this.serviceRegistry,
      authLayer: this.authLayer,
      router: this.router,
      protocolAdapters: this.protocolAdapters,
      configManager: this.configManager,
      get orchestratorManager() { return self.orchestratorManager; },
      get orchestratorEngine() { return self.orchestratorEngine; },
      get subagentLoader() { return self.subagentLoader; },
      getOrchestratorStatus: () => self.orchestratorStatus,
      getOrchestratorEngine: () => self.orchestratorEngine,
      getSubagentLoader: () => self.subagentLoader,
      logBuffer: this.logBuffer,
      logStreamClients: this.logStreamClients,
      sandboxStreamClients: this.sandboxStreamClients,
      sandboxStatus: this.sandboxStatus,
      sandboxInstalling: this.sandboxInstalling,
      addLogEntry: this.addLogEntry.bind(this),
      respondError: this.respondError.bind(this),
      canAcceptSseClient: () => self.logStreamClients.size + self.sandboxStreamClients.size < HttpApiServer.MAX_SSE_CONNECTIONS,
      middlewares: this.middlewares,
      middlewareChain: this.middlewareChain,
      get instancePersistence() { return self.instancePersistence; },
      get deploymentPolicy() { return self.deploymentPolicy; },
      get toolListCache() { return self.toolListCache; },
      get adapterPool() { return self.adapterPool; }
    } as unknown as RouteContext;
  }

  // SSE headers helper to reflect CORS policy (used by tests and streaming routes)
  public writeSseHeaders(reply: FastifyReply, request: FastifyRequest): void {
    const origin = (request.headers.origin as string | undefined) || '';
    const allowed = new Set(this.config.corsOrigins || []);
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    };
    if (origin && allowed.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    try {
      (reply.raw as unknown as { writeHead: (status: number, headers: Record<string, string>) => void }).writeHead(200, headers);
    } catch {}
  }

  private setupRoutes(): void {
    // Static file serving for GUI
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Resolve candidate roots relative to current working directory first, then module location
    const candidates = [
      resolve(process.cwd(), 'dist-gui'),
      resolve(process.cwd(), 'gui', 'dist'),
      resolve(__dirname, '../..', 'gui', 'dist')
    ];
    const staticRoot = candidates.find(p => existsSync(p)) || candidates[0];

    this.server.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/static/',
      decorateReply: true // Only the first registration decorates reply
    });
    // Serve vite assets under /assets/ to match index.html references
    this.server.register(fastifyStatic, {
      root: join(staticRoot, 'assets'),
      prefix: '/assets/',
      decorateReply: false // Prevent duplicate decorator error
    });

    // Serve index.html for root and SPA routes
    this.server.get('/', async (request, reply) => {
      const indexPath = join(staticRoot, 'index.html');
      if (!existsSync(indexPath)) {
        return reply.code(503).type('text/plain').send('GUI assets not found. Please build GUI into dist-gui or gui/dist.');
      }
      return reply.type('text/html').sendFile('index.html', staticRoot);
    });

    const spaRoutes = ['/dashboard*', '/services*', '/templates*', '/auth*', '/monitoring*', '/settings*', '/deployment*', '/performance*'];
    for (const route of spaRoutes) {
      this.server.get(route, async (request, reply) => {
        const indexPath = join(staticRoot, 'index.html');
        if (!existsSync(indexPath)) {
          return reply.code(503).type('text/plain').send('GUI assets not found. Please build GUI into dist-gui or gui/dist.');
        }
        return reply.type('text/html').sendFile('index.html', staticRoot);
      });
    }

    // Health check endpoint - FAST, no DB queries
    const healthHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send({ status: 'ok', ts: Date.now() });
    };
    this.server.get('/health', healthHandler);
    this.server.get('/api/health', healthHandler);

    // Detailed health endpoint for monitoring systems
    this.server.get('/health/detailed', async (_request: FastifyRequest, reply: FastifyReply) => {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        services: {
          registry: await this.serviceRegistry.getRegistryStats(),
          auth: {
            activeTokens: this.authLayer.getActiveTokenCount(),
            activeApiKeys: this.authLayer.getActiveApiKeyCount()
          },
          router: this.router.getMetrics()
        }
      };

      reply.send(health);
    });

    // Initialize route context for modular routes
    const routeContext = this.createRouteContext();

    // Service management endpoints (modularized)
    new ServiceRoutes(routeContext).setupRoutes();

    // Template management endpoints (modularized)
    new TemplateRoutes(routeContext).setupRoutes();

    // Authentication endpoints (modularized)
    new AuthRoutes(routeContext).setupRoutes();

    // Routing and proxy endpoints (modularized)
    new RoutingRoutes(routeContext).setupRoutes();

    // Monitoring and metrics endpoints (modularized)
    new MonitoringRoutes(routeContext).setupRoutes();

    // Log streaming endpoints (modularized)
    new LogRoutes(routeContext).setupRoutes();

    // Configuration management endpoints (modularized)
    new ConfigRoutes(routeContext).setupRoutes();

    // External MCP config import endpoints (modularized)
    new ExternalImportRoutes(routeContext).setupRoutes();

    // Sandbox inspection & install endpoints (modularized)
    new SandboxRoutes(routeContext).setupRoutes();

    // Orchestrator observability endpoints (modularized)
    new OrchestratorRoutes(routeContext).setupRoutes();

    // Local MCP Proxy endpoints (modularized)
    new LocalMcpProxyRoutes(routeContext).setupRoutes();

    // Tool API endpoints（统一逻辑工具入口，初始实现为模板直通）
    // 注意：当前实现为最小版本，后续会在 routes/ToolRoutes.ts 中增强映射与编排能力。
    new ToolRoutes(routeContext).setupRoutes();

    // Skills API endpoints（动态技能加载/匹配/审核）
    new SkillRoutes(routeContext).setupRoutes();

    // Skill approval workflow endpoints
    new SkillApprovalRoutes(routeContext).setupRoutes();

    // Deployment chain endpoints (resolve/install/policy/persistence)
    new DeploymentRoutes(routeContext).setupRoutes();
  }

  // Unified error response helper
  private respondError(reply: FastifyReply, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: unknown }) {
    const payload = {
      success: false,
      error: {
        message,
        code: opts?.code || 'INTERNAL_ERROR',
        recoverable: opts?.recoverable ?? false,
        meta: opts?.meta
      }
    };
    try { this.logger.error(message, { ...(opts || {}), httpStatus: status }); } catch {}
    return reply.code(status).send(payload);
  }

  private mapMiddlewareError(error: unknown): { status: number; code: string; message: string; recoverable: boolean; meta?: unknown } {
    const err = error instanceof Error ? error : new Error(String(error));
    const stageErr = err instanceof MiddlewareStageError ? err : undefined;
    const causeCandidate = stageErr?.cause ?? (err as Error & { cause?: unknown }).cause;
    const root = causeCandidate instanceof Error ? causeCandidate : err;

    if (root instanceof MiddlewareTimeoutError) {
      return {
        status: 504,
        code: 'MIDDLEWARE_TIMEOUT',
        message: root.message,
        recoverable: true,
        meta: { stage: root.stage, middlewareName: root.middlewareName, timeoutMs: root.timeoutMs }
      };
    }

    if (root instanceof MiddlewareAbortedError || root.name === 'AbortError') {
      return {
        status: 499,
        code: 'REQUEST_ABORTED',
        message: root.message,
        recoverable: true,
        meta: { stage: (root as Error & { stage?: string }).stage, middlewareName: (root as Error & { middlewareName?: string }).middlewareName }
      };
    }

    return {
      status: 500,
      code: 'MIDDLEWARE_ERROR',
      message: root.message || err.message || 'Middleware error',
      recoverable: false,
      meta: stageErr
        ? { stage: stageErr.stage, middlewareName: stageErr.middlewareName, cause: root.message }
        : { cause: root.message }
    };
  }

  setOrchestratorManager(manager: OrchestratorManager): void {
    this.orchestratorManager = manager;
  }

  setDeploymentComponents(persistence: InstancePersistence, policy: DeploymentPolicy): void {
    this.instancePersistence = persistence;
    this.deploymentPolicy = policy;
  }

  setPerformanceComponents(cache: ToolListCache, pool: AdapterPool): void {
    this.toolListCache = cache;
    this.adapterPool = pool;
  }

  updateOrchestratorStatus(status: OrchestratorStatus | null): void {
    this.orchestratorStatus = status;
    // Lazy init engine only when enabled; loader will be created on first execute
    if (this.orchestratorStatus?.enabled && this.orchestratorManager) {
      try {
        const subDir = this.orchestratorStatus.subagentsDir;
        this.subagentLoader = new SubagentLoader(subDir, this.logger);
        this.orchestratorEngine = new OrchestratorEngine({
          logger: this.logger,
          serviceRegistry: this.serviceRegistry,
          protocolAdapters: this.protocolAdapters,
          orchestratorManager: this.orchestratorManager,
          subagentLoader: this.subagentLoader
        });
      } catch (err) {
        this.logger.warn('Failed to initialize orchestrator engine', err);
      }
    } else {
      this.orchestratorEngine = undefined;
      this.subagentLoader = undefined;
    }
  }

  private setupErrorHandlers(): void {
    this.server.setErrorHandler(async (error, request, reply) => {
      try {
        const span = (request as AugmentedRequest).otelSpan as ReturnType<ReturnType<typeof trace.getTracer>['startSpan']> | undefined;
        if (span) {
          span.recordException?.(error instanceof Error ? error : new Error(String(error)));
          span.setStatus?.({ code: SpanStatusCode.ERROR, message: (error as Error)?.message || String(error) });
        }
      } catch {}

      const errorDetails = {
        method: request.method,
        url: request.url,
        message: (error as Error)?.message || String(error),
        stack: (error as Error)?.stack,
        code: (error as Record<string, unknown>)?.code,
        statusCode: (error as Record<string, unknown>)?.statusCode
      };
      this.logger.error('HTTP API error:', errorDetails);

      const safeMessage = process.env.NODE_ENV === 'production'
        ? 'Internal Server Error'
        : (error as Error).message;
      reply.code(500).send({
        error: 'Internal Server Error',
        message: safeMessage,
        timestamp: new Date().toISOString()
      });
    });

    this.server.setNotFoundHandler(async (request, reply) => {
      reply.code(404).send({
        error: 'Not Found',
        message: `Route ${request.method} ${request.url} not found`,
        timestamp: new Date().toISOString()
      });
    });
  }

  // Utility methods for external integration
  getServer(): FastifyInstance {
    return this.server;
  }

  getServiceRegistry(): ServiceRegistryImpl {
    return this.serviceRegistry;
  }

  getAuthLayer(): AuthenticationLayerImpl {
    return this.authLayer;
  }

  getRouter(): GatewayRouterImpl {
    return this.router;
  }

  addMiddleware(middleware: Middleware): void {
    this.middlewares.push(middleware);
    this.middlewareChain.use(middleware);
  }

}

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
// Local MCP 加密/握手逻辑已下放到路由模块，无需在此引入 crypto
import {
  Logger,
  GatewayConfig,
  ServiceHealth,
  HealthCheckResult,
  Disposable
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
import { registerDefaultHealthProbe } from '../gateway/HealthProbe.js';
import { buildRouteContext } from './RouteContextFactory.js';
import { SseManager } from './SseManager.js';
import { registerGuiAssetsRoutes } from './GuiAssetsRoutes.js';
import { registerHealthRoutes } from './HealthRoutes.js';
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
import type { RouteAuthenticationLayer, RouteServiceRegistry } from './routes/RouteContext.js';
import { Middleware } from '../middleware/types.js';
import {
  MiddlewareChain,
  MiddlewareTimeoutError,
  MiddlewareAbortedError,
  MiddlewareStageError
} from '../middleware/chain.js';
import { AuthMiddleware } from '../middleware/AuthMiddleware.js';
import { RateLimitMiddleware } from '../middleware/RateLimitMiddleware.js';
import { setupObservabilityHooks } from './ObservabilityHooks.js';
import { setupMiddlewareWiring } from './MiddlewareWiring.js';

// Fastify request/reply augmentation helpers (avoids per-line `as any`)
type AugmentedRequest = FastifyRequest & Record<string, unknown>;

export class HttpApiServer implements Disposable {
  private static readonly MAX_LOG_BUFFER_SIZE = 200;
  private static readonly API_VERSION = 'v1';
  private server: FastifyInstance;
  private serviceRegistry: ServiceRegistryImpl;
  private authLayer: AuthenticationLayerImpl;
  private router: GatewayRouterImpl;
  private protocolAdapters: ProtocolAdaptersImpl;
  private configManager: import('../config/ConfigManagerImpl.js').ConfigManagerImpl;
  private readonly apiRoutesToAlias: Record<string, unknown>[] = [];
  private static readonly MAX_SSE_CONNECTIONS = 200;
  private readonly sseManager: SseManager;
  private sandboxStatus: { nodeReady: boolean; pythonReady: boolean; goReady: boolean; packagesReady: boolean; details: Record<string, unknown> } = { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} };
  private sandboxInstalling: boolean = false;
  private orchestratorStatus: OrchestratorStatus | null = null;
  private orchestratorManager?: OrchestratorManager;
  private orchestratorEngine?: OrchestratorEngine;
  private subagentLoader?: SubagentLoader;
  private instancePersistence?: InstancePersistence;
  private localMcpProxy?: LocalMcpProxyRoutes;
  private deploymentPolicy?: DeploymentPolicy;
  private toolListCache?: ToolListCache;
  private adapterPool?: AdapterPool;
  private middlewares: Middleware[] = [];
  private readonly middlewareChain: MiddlewareChain;

  // Backward compatibility for tests that access `server.logBuffer` directly
  private get logBuffer() {
    return this.sseManager.getLogBuffer();
  }

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
    this.sseManager = new SseManager(this.logger, {
      maxLogBufferSize: HttpApiServer.MAX_LOG_BUFFER_SIZE,
      maxSseConnections: HttpApiServer.MAX_SSE_CONNECTIONS,
      enableDemoLogs: process.env.NODE_ENV !== 'production'
    });

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
      new AuthMiddleware(this.authLayer, {
        respondError: this.respondError.bind(this),
        requiresAuth: (req) => {
          const url = req.url.split('?')[0];
          if (url.startsWith('/api/')) return true;
          if (url === '/mcp' || url === '/events' || url === '/sse') return true;
          if (url === '/tools' || url === '/call') return true;
          if (url.startsWith('/local-proxy/call')) return true;
          if (url.startsWith('/local-proxy/tools')) return true;
          if (url === '/handshake/approve') return true;
          return false;
        }
      })
    );
    this.addMiddleware(
      new RateLimitMiddleware(configProvider, {
        respondError: this.respondError.bind(this),
        requiresRateLimit: (req) => {
          const url = req.url.split('?')[0];
          if (url === '/health' || url.startsWith('/api/health')) return false;
          if (url.startsWith('/api/')) return true;
          if (url === '/mcp' || url === '/tools' || url === '/call') return true;
          if (url.startsWith('/local-proxy/call') || url.startsWith('/local-proxy/tools')) return true;
          return false;
        }
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
      registerDefaultHealthProbe(this.serviceRegistry, this.protocolAdapters);
    }
  }

  private initializeLogSystem(): void {
    this.sseManager.initialize();
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
      } catch { /* best-effort: ignore duplicate route errors in tests */ }
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
      this.sseManager.stop();

      // Shutdown middleware resources (e.g. Redis clients)
      for (const mw of this.middlewares) {
        if (typeof (mw as unknown as { shutdown?: () => Promise<void> }).shutdown === 'function') {
          try { await (mw as unknown as { shutdown: () => Promise<void> }).shutdown(); } catch { /* best-effort */ }
        }
      }

      // Clean up LocalMcpProxy timers
      this.localMcpProxy?.cleanup();

      // 30秒超时保护
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((_, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error('Server shutdown timeout after 30s')), 30000);
      });

      try {
        await Promise.race([this.server.close(), timeout]);
      } finally {
        if (shutdownTimer) clearTimeout(shutdownTimer);
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

  private disposed = false;
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await this.stop(); }

  /**
   * Create route context for modular route handlers
   */
  private createRouteContext(): RouteContext {
    return buildRouteContext({
      server: this.server,
      logger: this.logger,
      serviceRegistry: this.serviceRegistry as unknown as RouteServiceRegistry,
      authLayer: this.authLayer as unknown as RouteAuthenticationLayer,
      router: this.router,
      protocolAdapters: this.protocolAdapters,
      configManager: this.configManager,
      getOrchestratorManager: () => this.orchestratorManager,
      getOrchestratorEngine: () => this.orchestratorEngine,
      getSubagentLoader: () => this.subagentLoader,
      getOrchestratorStatus: () => this.orchestratorStatus,
      middlewares: this.middlewares,
      middlewareChain: this.middlewareChain,
      getInstancePersistence: () => this.instancePersistence,
      getDeploymentPolicy: () => this.deploymentPolicy,
      getToolListCache: () => this.toolListCache,
      getAdapterPool: () => this.adapterPool,
      logBuffer: this.sseManager.getLogBuffer(),
      logStreamClients: this.sseManager.getLogStreamClients(),
      sandboxStreamClients: this.sseManager.getSandboxStreamClients(),
      sandboxStatus: this.sandboxStatus,
      getSandboxInstalling: () => this.sandboxInstalling,
      setSandboxInstalling: (value: boolean) => { this.sandboxInstalling = value; },
      addLogEntry: this.sseManager.addLogEntry.bind(this.sseManager),
      respondError: this.respondError.bind(this),
      canAcceptSseClient: () => this.sseManager.canAcceptSseClient()
    });
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
    } catch { /* best-effort: headers may already be sent */ }
  }

  private setupRoutes(): void {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    registerGuiAssetsRoutes(this.server, { moduleDir: __dirname });
    registerHealthRoutes(this.server, {
      serviceRegistry: this.serviceRegistry,
      authLayer: this.authLayer,
      router: this.router
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
    this.localMcpProxy = new LocalMcpProxyRoutes(routeContext);
    this.localMcpProxy.setupRoutes();

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
    try { this.logger.error(message, { ...(opts || {}), httpStatus: status }); } catch { /* best-effort logging */ }
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
        // Dispose previous engine if it exists to prevent resource leaks
        if (this.orchestratorEngine) {
          (this.orchestratorEngine as unknown as { dispose?: () => void })?.dispose?.();
        }
        const subDir = this.orchestratorStatus.subagentsDir;
        this.subagentLoader = new SubagentLoader(subDir, this.logger);
        this.orchestratorEngine = new OrchestratorEngine({
          logger: this.logger,
          serviceRegistry: this.serviceRegistry,
          protocolAdapters: this.protocolAdapters,
          orchestratorManager: this.orchestratorManager,
          subagentLoader: this.subagentLoader
        });
      } catch (error) {
        this.logger.warn('Failed to initialize orchestrator engine', { error: (error as Error)?.message });
      }
    } else {
      if (this.orchestratorEngine) {
        (this.orchestratorEngine as unknown as { dispose?: () => void })?.dispose?.();
      }
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
      } catch { /* best-effort OTel span annotation */ }

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
        : (error as Error)?.message;
      reply.code(500).send({
        success: false,
        error: {
          message: safeMessage || 'Internal Server Error',
          code: 'INTERNAL_ERROR',
          recoverable: false
        }
      });
    });

    this.server.setNotFoundHandler(async (request, reply) => {
      reply.code(404).send({
        success: false,
        error: {
          message: `Route ${request.method} ${request.url} not found`,
          code: 'NOT_FOUND',
          recoverable: false
        }
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

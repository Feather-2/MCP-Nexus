import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
// Local MCP 加密/握手逻辑已下放到路由模块，无需在此引入 crypto
import {
  Logger,
  GatewayConfig,
  McpServiceConfig,
  ServiceInstance,
  AuthRequest,
  RouteRequest,
  ServiceHealth,
  HealthCheckResult,
  OrchestratorConfig,
  SubagentConfig
} from '../types/index.js';
import { ServiceRegistryImpl } from '../gateway/ServiceRegistryImpl.js';
import { AuthenticationLayerImpl } from '../auth/AuthenticationLayerImpl.js';
import { GatewayRouterImpl } from '../router/GatewayRouterImpl.js';
import { ProtocolAdaptersImpl } from '../adapters/ProtocolAdaptersImpl.js';
import type { OrchestratorStatus, OrchestratorManager } from '../orchestrator/OrchestratorManager.js';
import { OrchestratorEngine } from '../orchestrator/OrchestratorEngine.js';
import { SubagentLoader } from '../orchestrator/SubagentLoader.js';
import { McpGenerator } from '../generator/McpGenerator.js';
import type {
  GenerateRequest,
  ExportRequest,
  ImportRequest
} from '../types/index.js';
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
  GeneratorRoutes,
  OrchestratorRoutes,
  LocalMcpProxyRoutes,
  AiRoutes,
  SandboxRoutes,
  ToolRoutes
} from './routes/index.js';
import { Middleware } from '../middleware/types.js';
import { MiddlewareChain } from '../middleware/chain.js';

interface RouteRequestBody {
  method: string;
  params?: any;
  serviceGroup?: string;
  contentType?: string;
  contentLength?: number;
}

export class HttpApiServer {
  private static readonly MAX_LOG_BUFFER_SIZE = 200;
  private server: FastifyInstance;
  private serviceRegistry: ServiceRegistryImpl;
  private authLayer: AuthenticationLayerImpl;
  private router: GatewayRouterImpl;
  private protocolAdapters: ProtocolAdaptersImpl;
  private configManager: import('../config/ConfigManagerImpl.js').ConfigManagerImpl;
  private logBuffer: Array<{ timestamp: string; level: string; message: string; service?: string; data?: any }> = [];
  private logStreamClients: Set<FastifyReply> = new Set();
  private sandboxStatus: { nodeReady: boolean; pythonReady: boolean; goReady: boolean; packagesReady: boolean; details: Record<string, any> } = { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} };
  private sandboxInstalling: boolean = false;
  private orchestratorStatus: OrchestratorStatus | null = null;
  private orchestratorManager?: OrchestratorManager;
  private orchestratorEngine?: OrchestratorEngine;
  private subagentLoader?: SubagentLoader;
  private mcpGenerator?: McpGenerator;
  private sandboxStreamClients: Set<FastifyReply> = new Set();
  private middlewares: Middleware[] = [];
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

    // Initialize core components
    this.protocolAdapters = components?.protocolAdapters || new ProtocolAdaptersImpl(logger, () => this.configManager.getConfig());
    this.serviceRegistry = components?.serviceRegistry || new ServiceRegistryImpl(logger);
    this.authLayer = components?.authLayer || new AuthenticationLayerImpl(config, logger);
    this.router = components?.router || new GatewayRouterImpl(logger, config.loadBalancingStrategy);
    if (components?.middlewareChain) {
      (this as any)._componentsMiddlewareChain = components.middlewareChain;
    }

    this.setupRoutes();
    this.setupErrorHandlers();
    this.setupMiddleware();

    // Initialize log system
    this.initializeLogSystem();

    // Wire health probe into ServiceRegistry's HealthChecker (centralized)
    try {
      this.serviceRegistry.setHealthProbe(async (serviceId: string) => {
        const service = await this.serviceRegistry.getService(serviceId);
        if (!service) {
          return { healthy: false, error: 'Service not found', timestamp: new Date() } as any;
        }
        // 仅对运行中的实例做探测，避免为非运行/一次性服务反复拉起进程
        if ((service as any).state !== 'running') {
          return { healthy: false, error: 'Service not running', timestamp: new Date() } as any;
        }
        const start = Date.now();
        try {
          const adapter = await this.protocolAdapters.createAdapter(service.config);
          await adapter.connect();
          try {
            const msg: any = { jsonrpc: '2.0', id: `health-${Date.now()}`, method: 'tools/list', params: {} };
            const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg as any);
            const latency = Date.now() - start;
            const ok = !!(res && (res as any).result);
            if (!ok && (res as any)?.error?.message) {
              // Attach last error to instance metadata for quick surfacing in UI
              try { await this.serviceRegistry.setInstanceMetadata(serviceId, 'lastProbeError', (res as any).error.message); } catch {}
            }
            return { healthy: ok, latency, timestamp: new Date() };
          } finally { await adapter.disconnect(); }
        } catch (e: any) {
          // Surface known env-related missing variable errors from stderr or message
          const errMsg = e?.message || 'probe failed';
          try { await this.serviceRegistry.setInstanceMetadata(serviceId, 'lastProbeError', errMsg); } catch {}
          return { healthy: false, error: errMsg, latency: Date.now() - start, timestamp: new Date() } as any;
        }
      });
    } catch {}
  }

  private initializeLogSystem(): void {
    // Add some initial log entries
    this.addLogEntry('info', '系统启动成功', 'gateway');
    this.addLogEntry('info', 'API 服务已就绪', 'api');
    this.addLogEntry('info', '监控服务已启动', 'monitor');

    // Set up periodic log generation for demo
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

    // Periodic cleanup of disconnected SSE clients
    this.sseCleanupTimer = setInterval(() => {
      try {
        for (const client of Array.from(this.logStreamClients)) {
          const raw: any = client.raw as any;
          if (!raw || raw.writableEnded || raw.destroyed) {
            this.logStreamClients.delete(client);
          }
        }
        for (const client of Array.from(this.sandboxStreamClients)) {
          const raw: any = client.raw as any;
          if (!raw || raw.writableEnded || raw.destroyed) {
            this.sandboxStreamClients.delete(client);
          }
        }
      } catch {}
    }, 30000);
  }

  private addLogEntry(level: string, message: string, service?: string, data?: any): void {
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

  private broadcastLogEntry(logEntry: any): void {
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
      // Initialize MCP Generator
      this.mcpGenerator = new McpGenerator({
        logger: this.logger,
        templateManager: this.serviceRegistry.getTemplateManager(),
        registry: this.serviceRegistry
      });

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

      await this.server.close();
      this.logger.info('HTTP API server stopped');
    } catch (error) {
      this.logger.error('Error stopping HTTP API server:', error);
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
      get mcpGenerator() { return self.mcpGenerator; },
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
      middlewares: this.middlewares,
      middlewareChain: this.componentsMiddlewareChain()
    } as any;
  }

  /**
   * Resolve middleware chain, allowing external injection for tests/custom stacks.
   */
  private componentsMiddlewareChain(): MiddlewareChain {
    const fromComponents = (this as any)._componentsMiddlewareChain as MiddlewareChain | undefined;
    if (fromComponents) return fromComponents;
    return new MiddlewareChain(this.middlewares);
  }

  

  private setupMiddleware(): void {
    // Distributed-friendly rate limiting (fallback to memory store by default)
    if (this.config.rateLimiting?.enabled) {
      const cfg = this.config.rateLimiting as any;
      const base = {
        max: cfg.maxRequests,
        timeWindow: cfg.windowMs,
        keyGenerator: (req: any) => {
          const apiKey = this.extractApiKey(req) || this.extractBearerToken(req) || '';
          return apiKey ? `key:${apiKey.slice(0, 32)}` : `ip:${req.ip}`;
        },
        allowList: [] as string[]
      } as any;

      // Optional Redis store
      if (cfg.store === 'redis' && cfg.redis) {
        base.name = 'rate-limit';
        base.redis = cfg.redis;
      }
      this.server.register(rateLimit as any, base);
    }

    // Security headers via helmet (production-ready defaults)
    this.server.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"]
        }
      },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: this.config.host === '127.0.0.1' || this.config.host === 'localhost' ? false : { maxAge: 31536000 }
    } as any);

    // CORS middleware
    this.server.register(cors, {
      origin: (origin, cb) => {
        try {
          // Always allow requests without origin (same-origin, non-browser, curl, etc.)
          if (!origin) return cb(null, true);

          // If CORS is disabled, only allow same-origin
          if (!this.config.enableCors) {
            const selfOrigin = `http://${this.config.host || '127.0.0.1'}:${this.config.port || 19233}`;
            const isSameOrigin = origin === selfOrigin ||
                                 origin === selfOrigin.replace('127.0.0.1', 'localhost') ||
                                 origin === selfOrigin.replace('localhost', '127.0.0.1');
            return cb(null, isSameOrigin);
          }

          // Check if origin is the server itself
          const selfOrigin = `http://${this.config.host || '127.0.0.1'}:${this.config.port || 19233}`;
          if (origin === selfOrigin ||
              origin === selfOrigin.replace('127.0.0.1', 'localhost') ||
              origin === selfOrigin.replace('localhost', '127.0.0.1')) {
            return cb(null, true);
          }

          // Check configured origins
          const allowed = new Set(this.config.corsOrigins || []);
          if (allowed.has(origin)) return cb(null, true);

          // Allow subpath variants without trailing slash issues
          const o = origin.replace(/\/$/, '');
          for (const a of allowed) {
            if (o === a.replace(/\/$/, '')) return cb(null, true);
          }

          return cb(new Error('CORS origin not allowed'), false);
        } catch (e) {
          return cb(e as Error, false);
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
    });

    // Authentication middleware
    this.server.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      // Skip auth for health check and public endpoints (including static files)
      // Require auth for /api/*
      const requiresAuth = request.url.startsWith('/api/');
      if (request.url === '/health' || request.url === '/api/health' || !requiresAuth) {
        return;
      }

      const authRequest: AuthRequest = {
        token: this.extractBearerToken(request),
        apiKey: this.extractApiKey(request),
        clientIp: request.ip,
        method: request.method,
        resource: request.url
      };

      const authResponse = await this.authLayer.authenticate(authRequest);

      if (!authResponse.success) {
        return this.respondError(reply, 401, authResponse.error || 'Unauthorized', { code: 'UNAUTHORIZED', recoverable: true });
      }

      // Attach auth info to request
      (request as any).auth = authResponse;
    });

    // Remove custom per-request sliding window limiter in favor of plugin above

    // Request logging
    this.server.addHook('onRequest', async (request: FastifyRequest) => {
      this.logger.debug(`${request.method} ${request.url}`, {
        ip: request.ip,
        userAgent: request.headers['user-agent']
      });
    });

    // Response logging (helmet handles security headers)
    this.server.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: any) => {
      const elapsed = (reply as any).elapsedTime ?? undefined;
      this.logger.debug(`${request.method} ${request.url} - ${reply.statusCode}`, { responseTime: elapsed });
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
      (reply as any).raw.writeHead(200, headers);
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

    this.server.get('/dashboard*', async (request, reply) => {
      const indexPath = join(staticRoot, 'index.html');
      if (!existsSync(indexPath)) {
        return reply.code(503).type('text/plain').send('GUI assets not found. Please build GUI into dist-gui or gui/dist.');
      }
      return reply.type('text/html').sendFile('index.html', staticRoot);
    });

    this.server.get('/services*', async (request, reply) => {
      const indexPath = join(staticRoot, 'index.html');
      if (!existsSync(indexPath)) {
        return reply.code(503).type('text/plain').send('GUI assets not found. Please build GUI into dist-gui or gui/dist.');
      }
      return reply.type('text/html').sendFile('index.html', staticRoot);
    });

    this.server.get('/templates*', async (request, reply) => {
      const indexPath = join(staticRoot, 'index.html');
      if (!existsSync(indexPath)) {
        return reply.code(503).type('text/plain').send('GUI assets not found. Please build GUI into dist-gui or gui/dist.');
      }
      return reply.type('text/html').sendFile('index.html', staticRoot);
    });

    this.server.get('/auth*', async (request, reply) => {
      const indexPath = join(staticRoot, 'index.html');
      if (!existsSync(indexPath)) {
        return reply.code(503).type('text/plain').send('GUI assets not found. Please build GUI into dist-gui or gui/dist.');
      }
      return reply.type('text/html').sendFile('index.html', staticRoot);
    });

    this.server.get('/monitoring*', async (request, reply) => {
      const indexPath = join(staticRoot, 'index.html');
      if (!existsSync(indexPath)) {
        return reply.code(503).type('text/plain').send('GUI assets not found. Please build GUI into dist-gui or gui/dist.');
      }
      return reply.type('text/html').sendFile('index.html', staticRoot);
    });

    this.server.get('/settings*', async (request, reply) => {
      const indexPath = join(staticRoot, 'index.html');
      if (!existsSync(indexPath)) {
        return reply.code(503).type('text/plain').send('GUI assets not found. Please build GUI into dist-gui or gui/dist.');
      }
      return reply.type('text/html').sendFile('index.html', staticRoot);
    });

    // Health check endpoint
    this.server.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
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

    // MCP Generator endpoints (modularized)
    new GeneratorRoutes(routeContext).setupRoutes();

    // AI provider configuration & test endpoints (modularized)
    new AiRoutes(routeContext).setupRoutes();

    // Sandbox inspection & install endpoints (modularized)
    new SandboxRoutes(routeContext).setupRoutes();

    // Orchestrator observability endpoints (modularized)
    new OrchestratorRoutes(routeContext).setupRoutes();

    // Local MCP Proxy endpoints (modularized)
    new LocalMcpProxyRoutes(routeContext).setupRoutes();

    // Tool API endpoints（统一逻辑工具入口，初始实现为模板直通）
    // 注意：当前实现为最小版本，后续会在 routes/ToolRoutes.ts 中增强映射与编排能力。
    new ToolRoutes(routeContext).setupRoutes();
  }

  // Unified error response helper
  private respondError(reply: FastifyReply, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: any }) {
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
    return reply.code(status).send(payload as any);
  }

  setOrchestratorManager(manager: OrchestratorManager): void {
    this.orchestratorManager = manager;
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
      const errorDetails = {
        method: request.method,
        url: request.url,
        message: (error as any)?.message || String(error),
        stack: (error as any)?.stack,
        code: (error as any)?.code,
        statusCode: (error as any)?.statusCode
      };
      this.logger.error('HTTP API error:', errorDetails);

      reply.code(500).send({
        error: 'Internal Server Error',
        message: error.message,
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

  private extractBearerToken(request: FastifyRequest): string | undefined {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return undefined;
  }

  private extractApiKey(request: FastifyRequest): string | undefined {
    // Try multiple common API key headers
    return (request.headers['x-api-key'] as string) ||
           (request.headers['x-api-token'] as string) ||
           (request.headers['apikey'] as string) ||
           undefined;
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
  }

}

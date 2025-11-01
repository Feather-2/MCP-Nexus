import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { randomBytes, createHash, createHmac, pbkdf2Sync, scryptSync, randomUUID } from 'crypto';
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
  LocalMcpProxyRoutes
} from './routes/index.js';

interface RouteRequestBody {
  method: string;
  params?: any;
  serviceGroup?: string;
  contentType?: string;
  contentLength?: number;
}

export class HttpApiServer {
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
  private _marketplaceCache?: { items: any[]; loadedAt: number };
  private sandboxProgress?: (evt: any) => void;
  private sandboxStreamClients: Set<FastifyReply> = new Set();

  // Local MCP Proxy state (handshake + token + code rotation)
  private currentVerificationCode: string = '';
  private previousVerificationCode: string = '';
  private codeExpiresAt: number = 0;
  private codeRotationMs: number = 60_000; // 60s
  private codeRotationTimer?: ReturnType<typeof setInterval>;
  private handshakeStore: Map<string, { id: string; origin: string; clientNonce: string; serverNonce: string; kdf: 'pbkdf2' | 'scrypt'; kdfParams: any; approved: boolean; expiresAt: number } > = new Map();
  private tokenStore: Map<string, { origin: string; expiresAt: number }> = new Map();
  private rateCounters: Map<string, number[]> = new Map(); // key -> timestamps

  constructor(
    private config: GatewayConfig,
    private logger: Logger,
    configManager: import('../config/ConfigManagerImpl.js').ConfigManagerImpl
  ) {
    this.server = Fastify({
      logger: false, // We'll use our own logger
      bodyLimit: 10 * 1024 * 1024 // 10MB
    });

    this.configManager = configManager;

    // Initialize core components
    this.protocolAdapters = new ProtocolAdaptersImpl(logger);
    this.serviceRegistry = new ServiceRegistryImpl(logger);
    this.authLayer = new AuthenticationLayerImpl(config, logger);
    this.router = new GatewayRouterImpl(logger, config.loadBalancingStrategy);

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
    setInterval(() => {
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
    setInterval(() => {
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

    // Keep only last 200 log entries
    this.logBuffer.push(logEntry);
    if (this.logBuffer.length > 200) {
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

  private writeSseHeaders(reply: FastifyReply, request: FastifyRequest): void {
    const origin = request.headers['origin'] as string | undefined;
    const allowed = Array.isArray(this.config.corsOrigins) ? this.config.corsOrigins : [];
    const isAllowed = origin && allowed.includes(origin);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...(isAllowed ? { 'Access-Control-Allow-Origin': origin!, 'Vary': 'Origin' } : {})
    });
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

      // Initialize and rotate Local MCP Proxy verification code
      // 保证 /local-proxy/code 与握手流程有可用验证码
      this.rotateVerificationCode();
      this.codeRotationTimer = setInterval(() => this.rotateVerificationCode(), this.codeRotationMs);

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
      // 清理本地 MCP 验证码轮换定时器
      if (this.codeRotationTimer) {
        clearInterval(this.codeRotationTimer);
        this.codeRotationTimer = undefined;
      }

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
    return {
      server: this.server,
      logger: this.logger,
      serviceRegistry: this.serviceRegistry,
      authLayer: this.authLayer,
      router: this.router,
      protocolAdapters: this.protocolAdapters,
      configManager: this.configManager,
      orchestratorManager: this.orchestratorManager,
      mcpGenerator: this.mcpGenerator,
      logBuffer: this.logBuffer,
      logStreamClients: this.logStreamClients,
      sandboxStreamClients: this.sandboxStreamClients,
      sandboxStatus: this.sandboxStatus,
      sandboxInstalling: this.sandboxInstalling,
      addLogEntry: this.addLogEntry.bind(this),
      respondError: this.respondError.bind(this)
    };
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

    // AI provider configuration & test endpoints
    this.setupAiRoutes();

    // Sandbox inspection & install endpoints
    this.setupSandboxRoutes();

    // Orchestrator observability endpoints (modularized)
    new OrchestratorRoutes(routeContext).setupRoutes();

    // Local MCP Proxy endpoints (modularized)
    new LocalMcpProxyRoutes(routeContext).setupRoutes();
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

  private setupAiRoutes(): void {
    // Get current AI config (non-secret)
    this.server.get('/api/ai/config', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const cfg = await this.configManager.get('ai');
        reply.send({ config: cfg || { provider: 'none' } });
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });

    // Update AI config (non-secret). Secrets must be provided via environment variables
    this.server.put('/api/ai/config', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body as any) || {};
        const allowed: any = {};
        if (typeof body.provider === 'string') allowed.provider = body.provider;
        if (typeof body.model === 'string') allowed.model = body.model;
        if (typeof body.endpoint === 'string') allowed.endpoint = body.endpoint;
        if (typeof body.timeoutMs === 'number') allowed.timeoutMs = body.timeoutMs;
        if (typeof body.streaming === 'boolean') allowed.streaming = body.streaming;

        const updated = await this.configManager.updateConfig({ ai: { ...(await this.configManager.get('ai')), ...allowed } as any });
        reply.send({ success: true, config: (updated as any).ai });
      } catch (error) {
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Test AI connectivity/settings without persisting secrets
    this.server.post('/api/ai/test', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body as any) || {};
        const provider = String(body.provider || (await this.configManager.get<any>('ai'))?.provider || 'none');
        const endpoint = String(body.endpoint || (await this.configManager.get<any>('ai'))?.endpoint || '');
        const model = String(body.model || (await this.configManager.get<any>('ai'))?.model || '');
        const mode = (body.mode as string) || 'env-only';

        const envStatus = this.checkAiEnv(provider);

        // By default do not attempt outbound network calls; allow explicit opt-in via mode='ping'
        let pingResult: { ok: boolean; note?: string } | undefined;
        if (mode === 'ping') {
          try {
            // Minimal safe probe: only for local providers (ollama) or when endpoint is localhost
            const isLocal = endpoint.includes('127.0.0.1') || endpoint.includes('localhost') || provider === 'ollama';
            if (!isLocal) {
              pingResult = { ok: false, note: 'Skipping non-local endpoint probe in sandbox' };
            } else {
              const fetch = (await import('node-fetch')).default as any;
              const url = provider === 'ollama' ? (endpoint || 'http://127.0.0.1:11434') + '/api/tags' : endpoint;
              const res = await fetch(url, { method: 'GET' });
              pingResult = { ok: res.ok, note: `HTTP ${res.status}` };
            }
          } catch (e: any) {
            pingResult = { ok: false, note: e?.message || 'probe failed' };
          }
        }

        reply.send({
          success: envStatus.ok && (pingResult ? pingResult.ok : true),
          provider,
          model,
          endpoint,
          env: envStatus,
          ping: pingResult
        });
      } catch (error) {
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Simple chat endpoint (non-streaming). If provider/env not configured, returns a heuristic assistant reply.
    this.server.post('/api/ai/chat', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body as any) || {};
        const messages: Array<{ role: string; content: string }> = Array.isArray(body.messages) ? body.messages : [];
        const ai = (await this.configManager.get<any>('ai')) || {};
        const provider = String(ai.provider || 'none');

        // If provider configured and env is present, attempt real call
        const envCheck = this.checkAiEnv(provider);
        if (provider !== 'none' && envCheck.ok) {
          const result = await this.nonStreamingAiCall(provider, ai, messages);
          reply.send({ success: true, message: { role: 'assistant', content: result }, provider });
          return;
        }

        // Fallback: heuristic plan builder
        const assistant = this.buildHeuristicPlan(messages);
        reply.send({ success: true, message: { role: 'assistant', content: assistant }, provider });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'AI chat error', { code: 'AI_ERROR' });
      }
    });

    // Streaming chat (SSE): GET /api/ai/chat/stream?q=...
    this.server.get('/api/ai/chat/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { q } = (request.query as any) || {};
        const user = String(q || '');
        const ai = (await this.configManager.get<any>('ai')) || {};
        const provider = String(ai.provider || 'none');

        // Prepare SSE response headers with strict CORS reflection (no wildcard)
        this.writeSseHeaders(reply, request);

        const send = (obj: any) => {
          try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
        };
        send({ event: 'start' });

        // If provider configured and env ok, attempt real streaming call
        const envCheck = this.checkAiEnv(provider);
        if (provider !== 'none' && envCheck.ok) {
          try {
            await this.streamingAiCall(provider, ai, user, (delta) => send({ event: 'delta', delta }), () => {
              send({ event: 'done' });
              try { reply.raw.end(); } catch {}
            });
            return;
          } catch (e: any) {
            send({ event: 'error', error: e?.message || 'stream failed' });
            try { reply.raw.end(); } catch {}
            return;
          }
        }

        // Fallback: heuristic stream
        const lines = this.buildHeuristicPlanLines(user);
        let idx = 0;
        const timer = setInterval(() => {
          if (idx < lines.length) {
            send({ event: 'delta', delta: (idx ? '\n' : '') + lines[idx] });
            idx++;
          } else {
            clearInterval(timer);
            send({ event: 'done' });
            try { reply.raw.end(); } catch {}
          }
        }, 120);
      } catch (error) {
        try {
          reply.raw.write(`data: ${JSON.stringify({ event: 'error', error: (error as Error).message })}\n\n`);
        } catch {}
        try { reply.raw.end(); } catch {}
      }
    });
  }

  private buildHeuristicPlan(messages: Array<{ role: string; content: string }>): string {
    const last = messages.length ? messages[messages.length - 1] : undefined;
    const userContent = last?.role === 'user' ? String(last.content || '') : '';
    const lines = this.buildHeuristicPlanLines(userContent);
    return lines.join('\n');
  }

  private buildHeuristicPlanLines(user: string): string[] {
    const urlMatch = user.match(/https?:\/\/[^\s)]+/i);
    const url = urlMatch ? urlMatch[0] : 'https://api.example.com/v1/echo';
    const method = /\b(post|put|patch|delete|get)\b/i.exec(user)?.[0]?.toUpperCase?.() || 'GET';
    const needApiKey = /api[-_ ]?key|token/i.test(user);
    return [
      `已理解你的需求。建议基于以下接口生成 MCP 模板：`,
      '',
      `# Service Plan`,
      `Base URL: ${new URL(url).origin}`,
      '',
      `Endpoint: ${method} ${new URL(url).pathname}`,
      needApiKey ? `Auth: API Key header: X-API-Key` : `Auth: none`,
      `Parameters:`,
      `- q: string (optional)`
    ];
  }

  private async nonStreamingAiCall(provider: string, aiCfg: any, messages: Array<{ role: string; content: string }>): Promise<string> {
    switch (provider) {
      case 'openai':
        return await this.callOpenAI(aiCfg, messages);
      case 'anthropic':
        return await this.callAnthropic(aiCfg, messages);
      case 'azure-openai':
        return await this.callAzureOpenAI(aiCfg, messages);
      case 'ollama':
        return await this.callOllama(aiCfg, messages);
      default:
        return this.buildHeuristicPlan(messages);
    }
  }

  private async streamingAiCall(provider: string, aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    switch (provider) {
      case 'openai':
        await this.streamOpenAI(aiCfg, prompt, onDelta, onDone);
        return;
      case 'azure-openai':
        await this.streamAzureOpenAI(aiCfg, prompt, onDelta, onDone);
        return;
      case 'anthropic':
        await this.streamAnthropic(aiCfg, prompt, onDelta, onDone);
        return;
      case 'ollama':
        await this.streamOllama(aiCfg, prompt, onDelta, onDone);
        return;
      // Anthropic streaming can be added similarly; fallback to non-stream call
      default: {
        const text = await this.nonStreamingAiCall(provider, aiCfg, [{ role: 'user', content: prompt }]);
        onDelta(text);
        onDone();
      }
    }
  }

  // ===== Provider calls (best-effort; rely on env, network may be restricted) =====
  private async callOpenAI(aiCfg: any, messages: any[]): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY as string;
    const model = aiCfg.model || 'gpt-4o-mini';
    const endpoint = aiCfg.endpoint || 'https://api.openai.com/v1/chat/completions';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, stream: false })
    });
    const json = await resp.json();
    return json?.choices?.[0]?.message?.content || '';
  }

  private async streamOpenAI(aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY as string;
    const model = aiCfg.model || 'gpt-4o-mini';
    const endpoint = aiCfg.endpoint || 'https://api.openai.com/v1/chat/completions';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true })
    } as any);
    const reader = (res as any).body?.getReader?.();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        // OpenAI SSE: lines starting with data:
        const lines = chunk.split(/\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') onDelta(delta);
          } catch {}
        }
      }
    }
    onDone();
  }

  private async callAnthropic(aiCfg: any, messages: any[]): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY as string;
    const model = aiCfg.model || 'claude-3-haiku-20240307';
    const endpoint = aiCfg.endpoint || 'https://api.anthropic.com/v1/messages';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens: 1024, messages })
    } as any);
    const json = await resp.json();
    // Extract text content blocks
    const parts = (json?.content || []).map((b: any) => b?.text).filter(Boolean);
    return parts.join('');
  }

  private async callAzureOpenAI(aiCfg: any, messages: any[]): Promise<string> {
    const apiKey = process.env.AZURE_OPENAI_API_KEY as string;
    const base = process.env.AZURE_OPENAI_ENDPOINT as string; // like https://res.openai.azure.com
    const deployment = aiCfg.model || 'gpt-4o-mini';
    const apiVersion = '2024-08-01-preview';
    const endpoint = `${base.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ messages, stream: false })
    } as any);
    const json = await resp.json();
    return json?.choices?.[0]?.message?.content || '';
  }

  private async streamAzureOpenAI(aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    const apiKey = process.env.AZURE_OPENAI_API_KEY as string;
    const base = process.env.AZURE_OPENAI_ENDPOINT as string;
    const deployment = aiCfg.model || 'gpt-4o-mini';
    const apiVersion = '2024-08-01-preview';
    const endpoint = `${base.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: prompt }] })
    } as any);
    const reader = (res as any).body?.getReader?.();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') onDelta(delta);
          } catch {}
        }
      }
    }
    onDone();
  }

  private async streamAnthropic(aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY as string;
    const model = aiCfg.model || 'claude-3-haiku-20240307';
    const endpoint = aiCfg.endpoint || 'https://api.anthropic.com/v1/messages';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: prompt }] })
    } as any);
    const reader = (res as any).body?.getReader?.();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith('event:') && !line.startsWith('data:')) continue;
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            try {
              const obj = JSON.parse(payload);
              // Anthropic streaming delta
              if (obj?.type === 'content_block_delta' && obj?.delta?.type === 'text_delta') {
                const delta = obj.delta?.text;
                if (typeof delta === 'string') onDelta(delta);
              }
            } catch {}
          }
        }
      }
    }
    onDone();
  }

  private async callOllama(aiCfg: any, messages: any[]): Promise<string> {
    const model = aiCfg.model || 'llama3.1:8b';
    const base = aiCfg.endpoint || 'http://127.0.0.1:11434';
    const endpoint = `${base.replace(/\/$/, '')}/api/chat`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false })
    } as any);
    const json = await resp.json();
    return json?.message?.content || '';
  }

  private async streamOllama(aiCfg: any, prompt: string, onDelta: (t: string) => void, onDone: () => void): Promise<void> {
    const model = aiCfg.model || 'llama3.1:8b';
    const base = aiCfg.endpoint || 'http://127.0.0.1:11434';
    const endpoint = `${base.replace(/\/$/, '')}/api/chat`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true })
    } as any);
    const reader = (res as any).body?.getReader?.();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split(/\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const delta = obj?.message?.content;
            if (typeof delta === 'string') onDelta(delta);
          } catch {}
        }
      }
    }
    onDone();
  }

  private checkAiEnv(provider: string): { ok: boolean; required: string[]; missing: string[] } {
    const req: string[] = [];
    switch (provider) {
      case 'openai':
        req.push('OPENAI_API_KEY');
        break;
      case 'anthropic':
        req.push('ANTHROPIC_API_KEY');
        break;
      case 'azure-openai':
        req.push('AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT');
        break;
      case 'ollama':
        // local runtime; no key required
        break;
      default:
        break;
    }
    const missing = req.filter(k => !process.env[k]);
    return { ok: missing.length === 0, required: req, missing };
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

  private setupSandboxRoutes(): void {
    // Status
    this.server.get('/api/sandbox/status', async (_request: FastifyRequest, reply: FastifyReply) => {
      const status = await this.inspectSandbox();
      reply.send(status);
    });

    // Install components: { components?: string[] }（与流式共用互斥锁）
    this.server.post('/api/sandbox/install', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (this.sandboxInstalling) {
          return this.respondError(reply, 409, 'Sandbox installer busy', { code: 'BUSY', recoverable: true });
        }
        this.sandboxInstalling = true;
        const body = (request.body as any) || {};
        const components: string[] = Array.isArray(body.components) && body.components.length ? body.components : ['node', 'packages'];
        const result = await this.installSandboxComponents(components);
        reply.send({ success: true, result });
      } catch (error) {
        this.logger.error('Sandbox install failed:', error);
        return this.respondError(reply, 500, (error as Error).message || 'Sandbox install failed');
      } finally {
        this.sandboxInstalling = false;
      }
    });
    
    // Streaming install via SSE: GET /api/sandbox/install/stream?components=a,b,c
    this.server.get('/api/sandbox/install/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Prepare SSE response (strict CORS reflection)
        this.writeSseHeaders(reply, request);

        const sendTo = (r: FastifyReply, obj: any) => { try { r.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
        const broadcast = (obj: any) => {
          for (const r of Array.from(this.sandboxStreamClients)) {
            try { sendTo(r, obj); } catch { this.sandboxStreamClients.delete(r); }
          }
        };

        // Register this client
        this.sandboxStreamClients.add(reply);
        const onClose = () => { this.sandboxStreamClients.delete(reply); };
        request.socket.on('close', onClose);
        request.socket.on('end', onClose);
        request.socket.on('error', onClose);

        const q = (request.query as any) || {};
        const compsStr: string = (q.components as string) || '';
        const components: string[] = compsStr
          ? compsStr.split(',').map((s: string) => s.trim()).filter(Boolean)
          : ['node', 'python', 'go', 'packages'];

        sendTo(reply, { event: 'start', components });

        // If an installation is already in progress, attach and do not start a new one
        if (this.sandboxInstalling) {
          sendTo(reply, { event: 'attach' });
          return; // keep connection open to receive broadcasts
        }

        // Mark installing and set broadcaster
        this.sandboxInstalling = true;
        this.sandboxProgress = (evt: any) => broadcast(evt);

        const total = components.length;
        let done = 0;
        for (const c of components) {
          broadcast({ event: 'component_start', component: c, progress: Math.floor((done / total) * 100) });
          try {
            await this.installSandboxComponents([c]);
            done += 1;
            broadcast({ event: 'component_done', component: c, progress: Math.floor((done / total) * 100) });
          } catch (e: any) {
            this.logger.error('Streaming sandbox install component failed', e);
            broadcast({ event: 'error', component: c, error: (e as Error).message });
            break;
          }
        }

        const status = await this.inspectSandbox();
        broadcast({ event: 'complete', progress: 100, status });
        this.sandboxProgress = undefined;
        this.sandboxInstalling = false;
        // End all client streams gracefully
        for (const r of Array.from(this.sandboxStreamClients)) {
          try { r.raw.end(); } catch {}
          this.sandboxStreamClients.delete(r);
        }
      } catch (error) {
        this.logger.error('Sandbox streaming install failed:', error);
        this.sandboxProgress = undefined;
        this.sandboxInstalling = false;
        try { reply.code(500).send({ success: false, error: (error as Error).message }); } catch {}
      }
    });

    // Repair missing components only（共用互斥锁）
    this.server.post('/api/sandbox/repair', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (this.sandboxInstalling) {
          return reply.code(409).send({ success: false, error: 'Sandbox installer busy', code: 'BUSY' } as any);
        }
        this.sandboxInstalling = true;
        const body = (request.body as any) || {};
        const wants: string[] = Array.isArray(body.components) && body.components.length ? body.components : ['node','python','go','packages'];
        const status = await this.inspectSandbox();
        const missing: string[] = [];
        if (wants.includes('node') && !status.nodeReady) missing.push('node');
        if (wants.includes('python') && !status.pythonReady) missing.push('python');
        if (wants.includes('go') && !status.goReady) missing.push('go');
        if (wants.includes('packages') && !status.packagesReady) missing.push('packages');
        if (missing.length === 0) {
          reply.send({ success: true, result: status, message: 'No missing components' });
          return;
        }
        const result = await this.installSandboxComponents(missing);
        reply.send({ success: true, result });
      } catch (error) {
        this.logger.error('Sandbox repair failed:', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      } finally {
        this.sandboxInstalling = false;
      }
    });

    // Cleanup leftover archives
    this.server.post('/api/sandbox/cleanup', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const path = await import('path');
        const fs = await import('fs/promises');
        const root = process.cwd();
        const runtimesDir = path.resolve(root, '../mcp-sandbox/runtimes');
        const dirs = ['nodejs','python','go'].map(d => path.join(runtimesDir, d));
        for (const d of dirs) {
          try {
            const items = await fs.readdir(d);
            for (const it of items) {
              if (it.endsWith('.zip') || it.endsWith('.tar.gz') || it.endsWith('.tgz')) {
                await fs.unlink(path.join(d, it)).catch(() => {});
              }
            }
          } catch {}
        }
        const status = await this.inspectSandbox();
        reply.send({ success: true, result: status });
      } catch (error) {
        this.logger.error('Sandbox cleanup failed:', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });
  }

  // Load marketplace items from file or env URL (JSON). Simple cache to reduce disk IO.
  private async loadMarketplaceItems(): Promise<any[]> {
    try {
      // If cached within 10s, return
      const now = Date.now();
      if (this._marketplaceCache && (now - this._marketplaceCache.loadedAt) < 10_000) {
        return this._marketplaceCache.items;
      }
      const pathMod = await import('path');
      const fs = await import('fs/promises');
      const filePath = process.env.PB_MARKETPLACE_PATH || pathMod.join(process.cwd(), 'docs', 'marketplace.static.json');
      const url = process.env.PB_MARKETPLACE_URL;

      const merge = (a: any[], b: any[]) => {
        const map = new Map<string, any>();
        for (const it of [...a, ...b]) {
          const key = (it && (it.id || it.name)) || Math.random().toString();
          if (!map.has(key)) map.set(key, it);
        }
        return Array.from(map.values());
      };

      let fromFile: any[] = [];
      let fromUrl: any[] = [];

      // Load from file if exists
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        fromFile = Array.isArray(parsed) ? parsed : (parsed.items || []);
      } catch {}

      // Load from remote URL if provided
      if (url) {
        try {
          const headers: Record<string, string> = { 'Accept': 'application/json' };
          if (process.env.PB_MARKETPLACE_TOKEN) headers['Authorization'] = `Bearer ${process.env.PB_MARKETPLACE_TOKEN}`;
          if (process.env.PB_MARKETPLACE_BASIC_AUTH && !headers['Authorization']) {
            const b = Buffer.from(process.env.PB_MARKETPLACE_BASIC_AUTH).toString('base64');
            headers['Authorization'] = `Basic ${b}`;
          }
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const parsed = await res.json();
            let itemsObj: any = parsed;
            // HMAC integrity check if configured (expect parsed = { items, hmac })
            const secret = process.env.PB_MARKETPLACE_HMAC_SECRET;
            const itemsArr: any[] = Array.isArray(parsed) ? parsed : (parsed.items || []);
            if (secret && !Array.isArray(parsed)) {
              try {
                const payload = JSON.stringify(itemsArr);
                const h = createHmac('sha256', secret).update(payload).digest('hex');
                const provided = String(parsed.hmac || '');
                if (h !== provided) {
                  this.logger.warn('Marketplace HMAC verification failed; ignoring remote items');
                } else {
                  fromUrl = itemsArr;
                }
              } catch (e) {
                this.logger.warn('Marketplace HMAC verify error; ignoring remote items', e);
              }
            } else {
              fromUrl = itemsArr;
            }
          } else {
            this.logger.warn('Failed to fetch marketplace url', { status: res.status, statusText: res.statusText });
          }
        } catch (e) {
          this.logger.warn('Marketplace URL fetch error', e);
        }
      }

      let items: any[] = [];
      if (fromUrl.length || fromFile.length) {
        items = merge(fromUrl, fromFile);
      } else {
        // Fallback to minimal built-ins
        items = [
          {
            id: 'filesystem',
            name: 'filesystem',
            description: 'Local filesystem access (portable)',
            tags: ['local', 'filesystem'],
            template: {
              name: 'filesystem',
              version: '2024-11-26',
              transport: 'stdio',
              command: 'npm',
              args: process.platform === 'win32' ? ['exec','-y','@modelcontextprotocol/server-filesystem','C:/Users/Public'] : ['exec','@modelcontextprotocol/server-filesystem','/tmp'],
              env: { SANDBOX: 'portable' },
              timeout: 30000,
              retries: 3
            }
          }
        ];
      }
      this._marketplaceCache = { items, loadedAt: now };
      return items;
    } catch (e) {
      this.logger.warn('loadMarketplaceItems failed', e);
      return [];
    }
  }

  private async inspectSandbox() {
    const path = await import('path');
    const fs = await import('fs/promises');
    const { spawn } = await import('child_process');
    const root = process.cwd();
    const runtimesDir = path.resolve(root, '../mcp-sandbox/runtimes');
    const pkgsDir = path.resolve(root, '../mcp-sandbox/packages/@modelcontextprotocol');

    const exists = async (p: string) => { try { await fs.access(p); return true; } catch { return false; } };

    // Windows: support both node.exe at root and npm.cmd at root or under bin
    let nodeReady = false;
    if (process.platform === 'win32') {
      const nodeExe = path.join(runtimesDir, 'nodejs', 'node.exe');
      const npmCmdRoot = path.join(runtimesDir, 'nodejs', 'npm.cmd');
      const npmCmdBin = path.join(runtimesDir, 'nodejs', 'bin', 'npm.cmd');
      nodeReady = (await exists(nodeExe)) && (await exists(npmCmdRoot) || await exists(npmCmdBin));
    } else {
      const nodeBin = path.join(runtimesDir, 'nodejs', 'bin', 'node');
      const npmBin = path.join(runtimesDir, 'nodejs', 'bin', 'npm');
      nodeReady = await exists(nodeBin) && await exists(npmBin);
    }
    const pythonReady = await exists(path.join(runtimesDir, 'python', process.platform === 'win32' ? 'Scripts' : 'bin'));
    const goReady = await exists(path.join(runtimesDir, 'go', 'bin'));
    const packagesReady = await exists(path.join(pkgsDir, 'server-filesystem')) && await exists(path.join(pkgsDir, 'server-memory'));

    // 附加可执行路径详情，便于前端与排错
    const details: Record<string, any> = { runtimesDir, pkgsDir };
    if (process.platform === 'win32') {
      details.nodePath = await exists(path.join(runtimesDir, 'nodejs', 'node.exe')) ? path.join(runtimesDir, 'nodejs', 'node.exe') : undefined;
      details.npmPath = await exists(path.join(runtimesDir, 'nodejs', 'npm.cmd')) ? path.join(runtimesDir, 'nodejs', 'npm.cmd')
        : (await exists(path.join(runtimesDir, 'nodejs', 'bin', 'npm.cmd')) ? path.join(runtimesDir, 'nodejs', 'bin', 'npm.cmd') : undefined);
      details.pythonPath = await exists(path.join(runtimesDir, 'python', 'python.exe')) ? path.join(runtimesDir, 'python', 'python.exe') : undefined;
      details.goPath = await exists(path.join(runtimesDir, 'go', 'bin', 'go.exe')) ? path.join(runtimesDir, 'go', 'bin', 'go.exe') : undefined;
      details.packagesDir = pkgsDir;
    } else {
      details.nodePath = await exists(path.join(runtimesDir, 'nodejs', 'bin', 'node')) ? path.join(runtimesDir, 'nodejs', 'bin', 'node') : undefined;
      details.npmPath = await exists(path.join(runtimesDir, 'nodejs', 'bin', 'npm')) ? path.join(runtimesDir, 'nodejs', 'bin', 'npm') : undefined;
      details.pythonPath = await exists(path.join(runtimesDir, 'python', 'bin', 'python3')) ? path.join(runtimesDir, 'python', 'bin', 'python3') : undefined;
      details.goPath = await exists(path.join(runtimesDir, 'go', 'bin', 'go')) ? path.join(runtimesDir, 'go', 'bin', 'go') : undefined;
      details.packagesDir = pkgsDir;
    }
    // 轻量版本探针（超时 1s），不影响总体状态
    const getVersion = async (cmd?: string, args: string[] = [], timeoutMs = 1000): Promise<string | undefined> => {
      if (!cmd) return undefined;
      try {
        return await new Promise<string | undefined>((resolve) => {
          let settled = false;
          const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
          let out = '';
          let err = '';
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch {}
            resolve(undefined);
          }, timeoutMs);
          child.stdout?.on('data', (d) => { out += d.toString(); });
          child.stderr?.on('data', (d) => { err += d.toString(); });
          child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const text = (out || err || '').toString().trim();
            resolve(text || undefined);
          });
          child.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(undefined);
          });
        });
      } catch { return undefined; }
    };
    try { if (details.nodePath) details.nodeVersion = await getVersion(details.nodePath as string, ['-v']); } catch {}
    try { if (details.pythonPath) details.pythonVersion = await getVersion(details.pythonPath as string, ['--version']); } catch {}
    try { if (details.goPath) details.goVersion = await getVersion(details.goPath as string, ['version']); } catch {}

    this.sandboxStatus = { nodeReady, pythonReady, goReady, packagesReady, details };
    return this.sandboxStatus;
  }

  private async installSandboxComponents(components: string[]) {
    const path = await import('path');
    const fs = await import('fs/promises');
    const { spawn } = await import('child_process');
    const https = await import('https');
    const http = await import('http');
    const { createWriteStream } = await import('fs');
    const { pipeline } = await import('stream');
    const { promisify } = await import('util');
    const root = process.cwd();

    const pipelineAsync = promisify(pipeline);
    const ensureDir = async (p: string) => { try { await fs.mkdir(p, { recursive: true }); } catch {} };
    const copyDir = async (src: string, dest: string) => {
      await ensureDir(dest);
      const entries = await fs.readdir(src, { withFileTypes: true } as any);
      for (const entry of entries as any[]) {
        const s = join(src, entry.name);
        const d = join(dest, entry.name);
        if (entry.isDirectory()) {
          await copyDir(s, d);
        } else {
          await fs.copyFile(s, d).catch(async () => {
            await fs.rm(d, { force: true } as any).catch(() => {});
            await fs.copyFile(s, d);
          });
        }
      }
    };

    const run = (cmd: string, args: string[], cwd?: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', cwd });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)));
      child.on('error', reject);
    });

    // 跨平台下载函数
    const download = async (url: string, filePath: string, redirectsLeft: number = 5): Promise<void> => {
      await ensureDir(path.dirname(filePath));
      const client = url.startsWith('https') ? https : http;

      return new Promise((resolve, reject) => {
        client.get(url, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            // 处理重定向（限制最大次数）
            const next = response.headers.location;
            if (!next) { reject(new Error('重定向无 Location')); return; }
            if (redirectsLeft <= 0) { reject(new Error('重定向次数过多')); return; }
            return download(next, filePath, redirectsLeft - 1).then(resolve).catch(reject);
          }
          if (response.statusCode !== 200) {
            reject(new Error(`下载失败: ${response.statusCode}`));
            return;
          }

          const fileStream = createWriteStream(filePath);
          pipelineAsync(response, fileStream)
            .then(() => resolve())
            .catch(reject);
        }).on('error', reject);
      });
    };

    // 跨平台解压函数
    const extract = async (archivePath: string, extractPath: string): Promise<void> => {
      await ensureDir(extractPath);

      if (archivePath.endsWith('.zip')) {
        // Windows ZIP解压
        if (process.platform === 'win32') {
          await run('powershell', ['-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractPath}" -Force`]);
        } else {
          try {
            await run('unzip', ['-q', '-o', archivePath, '-d', extractPath]);
          } catch {
            try {
              const dynamicImport: any = new Function('m', 'return import(m)');
              const AdmZipMod: any = await dynamicImport('adm-zip');
              const AdmZip = AdmZipMod?.default || AdmZipMod;
              const zip = new AdmZip(archivePath);
              zip.extractAllTo(extractPath, true);
            } catch (e) {
              throw new Error('无法解压 ZIP：需要 unzip 或 adm-zip');
            }
          }
        }
      } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
        // Unix/Linux TAR.GZ解压
        try {
          await run('tar', ['-xzf', archivePath, '-C', extractPath, '--strip-components=1']);
        } catch {
          try {
            const dynamicImport: any = new Function('m', 'return import(m)');
            const tar = await dynamicImport('tar');
            await (tar as any).extract({ file: archivePath, cwd: extractPath, strip: 1 });
          } catch (e) {
            throw new Error('无法解压 TAR.GZ：需要 tar 或 npm 包 tar');
          }
        }
      }
    };

    // 跨平台运行时下载配置
    const getRuntimeConfig = () => {
      const platform = process.platform as 'win32'|'linux'|'darwin';
      const archRaw = process.arch;
      const nodeArch = archRaw === 'arm64' ? 'arm64' : 'x64';
      const goArch = archRaw === 'arm64' ? 'arm64' : 'amd64';
      const pyArch = archRaw === 'arm64' ? 'aarch64' : 'x86_64';

      return {
        node: {
          version: 'v20.15.0',
          urls: {
            win32: `https://nodejs.org/dist/v20.15.0/node-v20.15.0-win-${nodeArch}.zip`,
            linux: `https://nodejs.org/dist/v20.15.0/node-v20.15.0-linux-${nodeArch}.tar.gz`,
            darwin: `https://nodejs.org/dist/v20.15.0/node-v20.15.0-darwin-${nodeArch}.tar.gz`
          }
        },
        python: {
          version: '3.11.9',
          urls: {
            win32: `https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-${nodeArch === 'arm64' ? 'arm64' : 'amd64'}.zip`,
            linux: `https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-${pyArch}-unknown-linux-gnu-install_only.tar.gz`,
            darwin: `https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-${pyArch}-apple-darwin-install_only.tar.gz`
          }
        },
        go: {
          version: '1.22.5',
          urls: {
            win32: `https://golang.org/dl/go1.22.5.windows-${goArch}.zip`,
            linux: `https://golang.org/dl/go1.22.5.linux-${goArch}.tar.gz`,
            darwin: `https://golang.org/dl/go1.22.5.darwin-${goArch}.tar.gz`
          }
        }
      };
    };

    const config = getRuntimeConfig();
    const platform = process.platform as 'win32' | 'linux' | 'darwin';
    const platformLabel = platform === 'win32' ? 'Windows' : (platform === 'darwin' ? 'macOS' : 'Linux');

    const logger = this.logger; // 提取logger引用避免this作用域问�?
    const actions: Record<string, () => Promise<void>> = {
      async node() {
        const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/nodejs');
        const binDir = path.join(runtimeDir, 'bin');

        // 检查是否已安装
        try {
          if (platform === 'win32') {
            const nodeExe = path.join(runtimeDir, 'node.exe');
            const npmCmdRoot = path.join(runtimeDir, 'npm.cmd');
            const npmCmdBin = path.join(binDir, 'npm.cmd');
            const nodeOk = await fs.access(nodeExe).then(() => true).catch(() => false);
            const npmOk = (await fs.access(npmCmdRoot).then(() => true).catch(() => false)) || (await fs.access(npmCmdBin).then(() => true).catch(() => false));
            if (nodeOk && npmOk) {
              const st = await fs.stat(nodeExe);
              if (st.size > 1024) return; // 已安装
            }
          } else {
            const nodeBin = path.join(binDir, 'node');
            const npmBin = path.join(binDir, 'npm');
            const nodeOk = await fs.access(nodeBin).then(() => true).catch(() => false);
            const npmOk = await fs.access(npmBin).then(() => true).catch(() => false);
            if (nodeOk && npmOk) {
              const st = await fs.stat(nodeBin);
              if (st.size > 1024) return; // 已安装
            }
          }
        } catch {}

        // 下载并安装Node.js
        const downloadUrl = config.node.urls[platform];
        const fileName = downloadUrl.split('/').pop()!;
        const archivePath = path.join(runtimeDir, fileName);

        logger.info(`下载Node.js ${config.node.version} for ${platformLabel}...`);
        await download(downloadUrl, archivePath);
        // Optional SHA256 verification
        if (process.env.PB_RUNTIME_SHA256_NODE) {
          try {
            const fs = await import('fs/promises');
            const crypto = await import('crypto');
            const buf = await fs.readFile(archivePath);
            const h = crypto.createHash('sha256').update(buf).digest('hex');
            if (h !== process.env.PB_RUNTIME_SHA256_NODE) throw new Error('Node archive SHA256 mismatch');
          } catch (e) { throw e; }
        }

        logger.info('解压Node.js...');
        await extract(archivePath, runtimeDir);

        // 重新整理目录结构（Windows zip 解压后为 node-vXX-win-arch）
        if (platform === 'win32') {
          const archSuffix = process.arch === 'arm64' ? 'arm64' : 'x64';
          const extractedDir = path.join(runtimeDir, `node-${config.node.version}-win-${archSuffix}`);
          if (await fs.access(extractedDir).then(() => true).catch(() => false)) {
            // 在移动前尽量删除目标处已存在的同名文件/目录，避免 EPERM rename
            await ensureDir(binDir);
            const files = await fs.readdir(extractedDir);
            for (const file of files) {
              const from = path.join(extractedDir, file);
              const to = path.join(runtimeDir, file);
              try {
                // 若目标已存在，先尝试删除（文件/目录分别处理）
                await fs.rm(to, { recursive: true, force: true } as any).catch(() => {});
                await fs.rename(from, to);
              } catch (err: any) {
                if (err?.code === 'EPERM' || err?.code === 'EEXIST') {
                  // 回退为复制 + 删除，规避占用/权限问题
                  try {
                    const fsp = await import('fs/promises');
                    const stat = await fsp.stat(from);
                    if (stat.isDirectory()) {
                      await copyDir(from, to);
                      await fsp.rm(from, { recursive: true, force: true } as any);
                    } else {
                      await fsp.copyFile(from, to);
                      await fsp.unlink(from).catch(() => {});
                    }
                  } catch {}
                } else {
                  throw err;
                }
              }
            }
            await fs.rmdir(extractedDir).catch(() => {});
          }
        }

        // 清理下载文件
        await fs.unlink(archivePath).catch(() => {});

        logger.info('Node.js安装完成');
      },

      async python() {
        const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/python');
        const binDir = path.join(runtimeDir, platform === 'win32' ? '' : 'bin');

        // 检查是否已安装
        const pythonBin = platform === 'win32' ? 'python.exe' : 'python3';

        try {
          const pythonPath = path.join(platform === 'win32' ? runtimeDir : binDir, pythonBin);
          await fs.access(pythonPath);
          const pythonStats = await fs.stat(pythonPath);
          if (pythonStats.size > 1024) {
            return; // 已安装
          }
        } catch {}

        // 下载并安装Python
        const downloadUrl = config.python.urls[platform];
        const fileName = downloadUrl.split('/').pop()!;
        const archivePath = path.join(runtimeDir, fileName);

        logger.info(`下载Python ${config.python.version} for ${platformLabel}...`);
        await download(downloadUrl, archivePath);
        if (process.env.PB_RUNTIME_SHA256_PYTHON) {
          try {
            const fs = await import('fs/promises');
            const crypto = await import('crypto');
            const buf = await fs.readFile(archivePath);
            const h = crypto.createHash('sha256').update(buf).digest('hex');
            if (h !== process.env.PB_RUNTIME_SHA256_PYTHON) throw new Error('Python archive SHA256 mismatch');
          } catch (e) { throw e; }
        }

        logger.info('解压Python...');
        await extract(archivePath, runtimeDir);

        // Windows需要创建Scripts目录
        if (platform === 'win32') {
          await ensureDir(path.join(runtimeDir, 'Scripts'));
          // 创建pip.exe链接
          const pipPath = path.join(runtimeDir, 'Scripts', 'pip.exe');
          const pythonExe = path.join(runtimeDir, 'python.exe');
          await fs.writeFile(pipPath, `@echo off\n"${pythonExe}" -m pip %*`);
        }

        // 清理下载文件
        await fs.unlink(archivePath).catch(() => {});

        logger.info('Python安装完成');
      },

      async go() {
        const runtimeDir = path.resolve(root, '../mcp-sandbox/runtimes/go');
        const binDir = path.join(runtimeDir, 'bin');

        // 检查是否已安装
        const goBin = platform === 'win32' ? 'go.exe' : 'go';

        try {
          await fs.access(path.join(binDir, goBin));
          const goStats = await fs.stat(path.join(binDir, goBin));
          if (goStats.size > 1024) {
            return; // 已安装
          }
        } catch {}

        // 下载并安装Go
        const downloadUrl = config.go.urls[platform];
        const fileName = downloadUrl.split('/').pop()!;
        const archivePath = path.join(runtimeDir, fileName);

        logger.info(`下载Go ${config.go.version} for ${platformLabel}...`);
        await download(downloadUrl, archivePath);
        if (process.env.PB_RUNTIME_SHA256_GO) {
          try {
            const fs = await import('fs/promises');
            const crypto = await import('crypto');
            const buf = await fs.readFile(archivePath);
            const h = crypto.createHash('sha256').update(buf).digest('hex');
            if (h !== process.env.PB_RUNTIME_SHA256_GO) throw new Error('Go archive SHA256 mismatch');
          } catch (e) { throw e; }
        }

        logger.info('解压Go...');
        await extract(archivePath, runtimeDir);

        // 重新整理目录结构 - Go 解压后会在 go/ 子目录，加入 EPERM 回退
        const extractedGoDir = path.join(runtimeDir, 'go');
        if (await fs.access(extractedGoDir).then(() => true).catch(() => false)) {
          const files = await fs.readdir(extractedGoDir);
          for (const file of files) {
            const from = path.join(extractedGoDir, file);
            const to = path.join(runtimeDir, file);
            try {
              await fs.rm(to, { recursive: true, force: true } as any).catch(() => {});
              await fs.rename(from, to);
            } catch (err: any) {
              if (err?.code === 'EPERM' || err?.code === 'EEXIST') {
                try {
                  const stat = await fs.stat(from);
                  if (stat.isDirectory()) {
                    await copyDir(from, to);
                    await fs.rm(from, { recursive: true, force: true } as any);
                  } else {
                    await fs.copyFile(from, to);
                    await fs.unlink(from).catch(() => {});
                  }
                } catch {}
              } else {
                throw err;
              }
            }
          }
          await fs.rmdir(extractedGoDir).catch(() => {});
        }

        // 清理下载文件
        await fs.unlink(archivePath).catch(() => {});

        logger.info('Go安装完成');
      },

      async packages() {
        const orgDir = path.resolve(root, '../mcp-sandbox/packages/@modelcontextprotocol');
        await ensureDir(orgDir);

        // 使用便携式Node.js来安装包
        const nodeDir = path.resolve(root, '../mcp-sandbox/runtimes/nodejs');
        // Windows 兼容：node.exe 位于根目录，npm.cmd 可能在根或 bin 下
        const nodeBin = platform === 'win32' ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node');
        let npmScript = platform === 'win32' ? (await fs.access(path.join(nodeDir, 'npm.cmd')).then(() => path.join(nodeDir, 'npm.cmd')).catch(() => path.join(nodeDir, 'bin', 'npm.cmd'))) : path.join(nodeDir, 'bin', 'npm');

        // 检查Node.js是否可用
        try {
          await fs.access(nodeBin);
        } catch {
          throw new Error('请先安装 Node.js 运行时');
        }

        const npmExists = await fs.access(npmScript).then(() => true).catch(() => false);
        const npmCliJs = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const installArgs = ['install', '--no-audit', '--no-fund', '@modelcontextprotocol/server-filesystem', '@modelcontextprotocol/server-memory'];
        if (npmExists) {
          await run(npmScript, installArgs, orgDir);
        } else {
          await run(nodeBin, [npmCliJs, ...installArgs], orgDir);
        }
      }
    };

    for (const c of components) {
      if (actions[c]) {
        this.logger.info(`Installing sandbox component: ${c}`);
        await actions[c]();
      }
    }

    return await this.inspectSandbox();
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

  // ============ Local MCP Proxy per docs/LOCAL-MCP-PROXY.md ============
  private extractLocalMcpToken(request: FastifyRequest): string | undefined {
    const auth = request.headers.authorization as string | undefined;
    if (!auth) return undefined;
    const prefix = 'LocalMCP ';
    if (auth.startsWith(prefix)) return auth.substring(prefix.length).trim();
    return undefined;
  }

  private validateToken(token: string, origin?: string): boolean {
    const rec = this.tokenStore.get(token);
    if (!rec) return false;
    if (!origin || rec.origin !== origin) return false;
    if (Date.now() > rec.expiresAt) {
      this.tokenStore.delete(token);
      return false;
    }
    return true;
  }

  private async findTargetService(serviceId?: string | null) {
    if (serviceId) {
      const svc = await this.serviceRegistry.getService(serviceId);
      return svc || null;
    }
    const list = await this.serviceRegistry.listServices();
    // Prefer running stdio services
    const running = list.filter(s => s.state === 'running');
    const stdioFirst = running.find(s => s.config.transport === 'stdio') || running[0];
    return stdioFirst || list[0] || null;
  }

  private isLocalHost(hostHeader?: string): boolean {
    if (!hostHeader) return false;
    const host = hostHeader.toLowerCase();
    return host.startsWith('127.0.0.1:') || host.startsWith('localhost:');
  }

  private requireAndValidateOrigin(request: FastifyRequest, reply: FastifyReply): string | undefined {
    const host = request.headers['host'];
    if (!this.isLocalHost(typeof host === 'string' ? host : undefined)) {
      reply.code(403).send({ success: false, error: 'Host not allowed', code: 'HOST_FORBIDDEN' });
      return undefined;
    }
    const origin = request.headers['origin'];
    if (!origin || typeof origin !== 'string') {
      reply.code(400).send({ success: false, error: 'Origin required', code: 'ORIGIN_REQUIRED' });
      return undefined;
    }
    // Basic Sec-Fetch-Site check
    const sfs = request.headers['sec-fetch-site'];
    if (sfs && typeof sfs === 'string' && sfs.toLowerCase() === 'cross-site') {
      reply.code(403).send({ success: false, error: 'Cross-site not allowed', code: 'FETCH_SITE_FORBIDDEN' });
      return undefined;
    }
    return origin;
  }

  private rotateVerificationCode(): void {
    const newCode = (Math.floor(Math.random() * 1_0000_0000)).toString().padStart(8, '0');
    this.previousVerificationCode = this.currentVerificationCode;
    this.currentVerificationCode = newCode;
    this.codeExpiresAt = Date.now() + this.codeRotationMs;
    this.addLogEntry('info', 'mcp.local.code_rotate');
  }

  private checkRateLimit(key: string, maxCount: number, windowMs: number): boolean {
    const now = Date.now();
    const arr = this.rateCounters.get(key) || [];
    const recent = arr.filter(ts => now - ts < windowMs);
    recent.push(now);
    this.rateCounters.set(key, recent);
    return recent.length <= maxCount;
  }
}

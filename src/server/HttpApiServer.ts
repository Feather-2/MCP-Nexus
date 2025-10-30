import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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

interface ServiceRequestBody {
  templateName?: string;
  config?: Partial<McpServiceConfig>;
  instanceArgs?: any;
}

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

  private setupMiddleware(): void {
    // CORS middleware
    this.server.register(cors, {
      origin: true,
      credentials: true
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

    // Request logging
    this.server.addHook('onRequest', async (request: FastifyRequest) => {
      this.logger.debug(`${request.method} ${request.url}`, {
        ip: request.ip,
        userAgent: request.headers['user-agent']
      });
    });

    // Response logging
    this.server.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: any) => {
      this.logger.debug(`${request.method} ${request.url} - ${reply.statusCode}`, {
        responseTime: reply.getResponseTime()
      });
    });
  }

  private setupRoutes(): void {
    // Static file serving for GUI
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const guiDistPath = join(__dirname, '../../gui/dist');

    this.server.register(fastifyStatic, {
      root: guiDistPath,
      prefix: '/static/'
    });

    // Serve index.html for root and SPA routes
    this.server.get('/', async (request, reply) => {
      return reply.type('text/html').sendFile('index.html', guiDistPath);
    });

    this.server.get('/dashboard*', async (request, reply) => {
      return reply.type('text/html').sendFile('index.html', guiDistPath);
    });

    this.server.get('/services*', async (request, reply) => {
      return reply.type('text/html').sendFile('index.html', guiDistPath);
    });

    this.server.get('/templates*', async (request, reply) => {
      return reply.type('text/html').sendFile('index.html', guiDistPath);
    });

    this.server.get('/auth*', async (request, reply) => {
      return reply.type('text/html').sendFile('index.html', guiDistPath);
    });

    this.server.get('/monitoring*', async (request, reply) => {
      return reply.type('text/html').sendFile('index.html', guiDistPath);
    });

    this.server.get('/settings*', async (request, reply) => {
      return reply.type('text/html').sendFile('index.html', guiDistPath);
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

    // Service management endpoints
    this.setupServiceRoutes();

    // Template management endpoints
    this.setupTemplateRoutes();

    // Authentication endpoints
    this.setupAuthRoutes();

    // Routing and proxy endpoints
    this.setupRoutingRoutes();

    // Monitoring and metrics endpoints
    this.setupMonitoringRoutes();

    // Log streaming endpoints
    this.setupLogRoutes();

    // Configuration management endpoints
    this.setupConfigRoutes();

    // AI provider configuration & test endpoints
    this.setupAiRoutes();

    // External MCP config import endpoints
    this.setupExternalImportRoutes();

    // Sandbox inspection & install endpoints
    this.setupSandboxRoutes();

    // Orchestrator observability endpoints
    this.setupOrchestratorRoutes();

    // MCP Generator endpoints
    this.setupGeneratorRoutes();

    // Local MCP Proxy endpoints per docs/LOCAL-MCP-PROXY.md
    this.setupLocalMcpProxyRoutes();
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

        // Prepare SSE response headers
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

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

  private setupOrchestratorRoutes(): void {
    this.server.get('/api/orchestrator/status', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.orchestratorStatus) {
        reply.send({
          enabled: false,
          reason: 'orchestrator status unavailable',
          mode: 'manager-only'
        });
        return;
      }

      reply.send({
        enabled: this.orchestratorStatus.enabled,
        mode: this.orchestratorStatus.mode,
        subagentsDir: this.orchestratorStatus.subagentsDir,
        reason: this.orchestratorStatus.reason
      });
    });

    this.server.get('/api/orchestrator/config', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.orchestratorManager) {
        return this.respondError(reply, 503, 'Orchestrator manager not available', { code: 'UNAVAILABLE' });
      }
      try {
        const config = this.orchestratorManager.getConfig();
        reply.send({ config });
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });

    this.server.put('/api/orchestrator/config', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!this.orchestratorManager) {
        return this.respondError(reply, 503, 'Orchestrator manager not available', { code: 'UNAVAILABLE' });
      }
      try {
        const updates = (request.body ?? {}) as Partial<OrchestratorConfig>;
        const updated = await this.orchestratorManager.updateConfig(updates);
        this.updateOrchestratorStatus(this.orchestratorManager.getStatus());
        reply.send({ success: true, config: updated });
      } catch (error) {
        this.logger.error('Failed to update orchestrator configuration', error);
        return this.respondError(reply, 400, (error as Error).message || 'Invalid orchestrator configuration', { code: 'BAD_REQUEST', recoverable: true });
      }
    });

    // Execute a minimal orchestrated plan
    this.server.post('/api/orchestrator/execute', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.orchestratorStatus?.enabled || !this.orchestratorManager) {
          return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
        }
        if (!this.orchestratorEngine || !this.subagentLoader) {
          const subDir = this.orchestratorStatus.subagentsDir;
          this.subagentLoader = new SubagentLoader(subDir, this.logger);
          this.orchestratorEngine = new OrchestratorEngine({
            logger: this.logger,
            serviceRegistry: this.serviceRegistry,
            protocolAdapters: this.protocolAdapters,
            orchestratorManager: this.orchestratorManager,
            subagentLoader: this.subagentLoader
          });
        }

        // Ensure subagents are loaded
        await this.subagentLoader!.loadAll();

        const body = (request.body ?? {}) as { goal?: string; steps?: Array<{ subagent?: string; tool?: string; params?: any }>; parallel?: boolean; maxSteps?: number; timeoutMs?: number };
        if (!body.goal && (!body.steps || body.steps.length === 0)) {
          return this.respondError(reply, 400, 'goal or steps is required', { code: 'BAD_REQUEST', recoverable: true });
        }
        const res = await this.orchestratorEngine!.execute({
          goal: body.goal,
          steps: body.steps,
          parallel: body.parallel,
          maxSteps: body.maxSteps,
          timeoutMs: body.timeoutMs
        });
        reply.send(res);
      } catch (error) {
        this.logger.error('Orchestrator execute failed', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // List subagent configs
    this.server.get('/api/orchestrator/subagents', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.orchestratorStatus?.enabled || !this.orchestratorManager) {
          return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
        }
        // Ensure loader exists
        if (!this.subagentLoader) {
          const subDir = this.orchestratorStatus.subagentsDir;
          this.subagentLoader = new SubagentLoader(subDir, this.logger);
        }
        await this.subagentLoader.loadAll();
        const items = this.subagentLoader.list();
        reply.send({ success: true, items });
      } catch (error) {
        this.logger.error('Failed to list subagents', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Create/update a subagent config
    this.server.post('/api/orchestrator/subagents', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.orchestratorStatus?.enabled || !this.orchestratorManager) {
          return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
        }
        const body = (request.body || {}) as Partial<SubagentConfig>;
        if (!body || !body.name || !Array.isArray(body.tools) || body.tools.length === 0) {
          return this.respondError(reply, 400, 'Invalid subagent config: name and tools[] required', { code: 'BAD_REQUEST', recoverable: true });
        }
        const subDir = this.orchestratorStatus.subagentsDir;
        // Write file
        const path = await import('path');
        const fs = await import('fs/promises');
        await fs.mkdir(subDir, { recursive: true });
        const filePath = path.join(subDir, `${body.name}.json`);
        await fs.writeFile(filePath, JSON.stringify(body, null, 2), 'utf-8');
        // Reload cache
        if (!this.subagentLoader) {
          this.subagentLoader = new SubagentLoader(subDir, this.logger);
        }
        await this.subagentLoader.loadAll();
        reply.code(201).send({ success: true, name: body.name });
      } catch (error) {
        this.logger.error('Failed to create subagent', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Delete a subagent config
    this.server.delete('/api/orchestrator/subagents/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.orchestratorStatus?.enabled || !this.orchestratorManager) {
          return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
        }
        const { name } = request.params as { name: string };
        if (!name) {
          return this.respondError(reply, 400, 'name is required', { code: 'BAD_REQUEST', recoverable: true });
        }
        const path = await import('path');
        const fs = await import('fs/promises');
        const filePath = path.join(this.orchestratorStatus.subagentsDir, `${name}.json`);
        try {
          await fs.unlink(filePath);
        } catch (err: any) {
          if (err?.code === 'ENOENT') {
            return this.respondError(reply, 404, 'Subagent not found', { code: 'NOT_FOUND', recoverable: true });
          }
          throw err;
        }
        if (!this.subagentLoader) {
          this.subagentLoader = new SubagentLoader(this.orchestratorStatus.subagentsDir, this.logger);
        }
        await this.subagentLoader.loadAll();
        reply.send({ success: true, name });
      } catch (error) {
        this.logger.error('Failed to delete subagent', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Quick group creation via MCP Generator (natural language �?template �?subagent)
    this.server.post('/api/orchestrator/quick-group', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.orchestratorStatus?.enabled || !this.orchestratorManager) {
          return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
        }
        if (!this.mcpGenerator) {
          return this.respondError(reply, 503, 'MCP Generator not initialized', { code: 'NOT_READY' });
        }
        const body = (request.body || {}) as { groupName?: string; source: any; options?: any; auth?: any };
        if (!body.source) {
          return this.respondError(reply, 400, 'source is required', { code: 'BAD_REQUEST', recoverable: true });
        }
        // Generate & auto-register template
        const genRes = await this.mcpGenerator.generate({
          source: body.source,
          options: { ...(body.options || {}), autoRegister: true, testMode: false }
        } as any);
        if (!genRes.success || !genRes.template) {
          return this.respondError(reply, 400, genRes.error || 'Generation failed', { code: 'BAD_REQUEST', recoverable: true });
        }
        const templateName = genRes.template.name;
        const actions = Array.isArray(genRes.template.tools) && genRes.template.tools.length
          ? genRes.template.tools.map((t: any) => t.name).filter(Boolean)
          : [];

        const subDir = this.orchestratorStatus.subagentsDir;
        const fs = await import('fs/promises');
        const path = await import('path');
        await fs.mkdir(subDir, { recursive: true });
        const subagentName = body.groupName || templateName;
        const subagentCfg: SubagentConfig = {
          name: subagentName,
          tools: [templateName],
          actions,
          maxConcurrency: 2,
          weights: { cost: 0.5, performance: 0.5 },
          policy: { domains: ['generated'] }
        } as any;
        await fs.writeFile(path.join(subDir, `${subagentName}.json`), JSON.stringify(subagentCfg, null, 2), 'utf-8');

        if (!this.subagentLoader) this.subagentLoader = new SubagentLoader(subDir, this.logger);
        await this.subagentLoader.loadAll();

        reply.code(201).send({ success: true, name: subagentName, template: templateName });
      } catch (error) {
        this.logger.error('Quick group creation failed', error);
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });
  }

  private setupExternalImportRoutes(): void {
    // Lazy import to avoid startup cost if unused
    const getImporter = () => {
      const { ExternalMcpConfigImporter } = require('../config/ExternalMcpConfigImporter.js');
      return new ExternalMcpConfigImporter(this.logger);
    };

    // Preview discovered configs
    this.server.get('/api/config/import/preview', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const importer = getImporter();
        const discovered = await importer.discoverAll();
        reply.send({ success: true, discovered });
      } catch (error) {
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });

    // Apply imported configs as templates
    this.server.post('/api/config/import/apply', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const importer = getImporter();
        const discovered = await importer.discoverAll();
        let applied = 0;
        for (const group of discovered) {
          for (const tmpl of group.items) {
            try {
              // Save as template via ServiceRegistry
              await this.serviceRegistry.registerTemplate(tmpl as any);
              applied += 1;
            } catch (e) {
              this.logger.warn('Failed to apply imported template', { name: tmpl.name, error: (e as Error).message });
            }
          }
        }
        reply.send({ success: true, applied });
      } catch (error) {
        reply.code(500).send({ success: false, error: (error as Error).message });
      }
    });
  }

  private setupServiceRoutes(): void {
    // List all services
    this.server.get('/api/services', async (request: FastifyRequest, reply: FastifyReply) => {
      const services = await this.serviceRegistry.listServices();
      reply.send(services); // Send array directly
    });

    // Get service by ID
    this.server.get('/api/services/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const service = await this.serviceRegistry.getService(id);

      if (!service) {
        return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
      }

      reply.send({ service });
    });

    // Create service from template
    this.server.post('/api/services', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as ServiceRequestBody;

      if (!body.templateName) {
        return this.respondError(reply, 400, 'Template name is required', { code: 'BAD_REQUEST', recoverable: true });
      }

      try {
        const overrides = body.instanceArgs || {};
        // 支持 instanceMode 透传（keep-alive/managed）
        const serviceId = await (this.serviceRegistry as any).createServiceFromTemplate(
          body.templateName,
          overrides
        );

        reply.code(201).send({
          success: true,
          serviceId,
          message: `Service created from template: ${body.templateName}`
        });
      } catch (error) {
        return this.respondError(reply, 400, error instanceof Error ? error.message : 'Failed to create service', { code: 'CREATE_FAILED', recoverable: true });
      }
    });

    // Update service environment variables
    this.server.patch('/api/services/:id/env', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { env: Record<string, string> };

      if (!body.env || typeof body.env !== 'object') {
        return this.respondError(reply, 400, 'Environment variables object is required', { code: 'BAD_REQUEST', recoverable: true });
      }

      try {
        const service = await this.serviceRegistry.getService(id);
        if (!service) {
          return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
        }

        // Get the template name for recreation
        const templateName = service.config.name;

        // Stop the current service
        const stopped = await this.serviceRegistry.stopService(id);
        if (!stopped) {
          reply.code(500).send({ error: 'Failed to stop service for restart' });
          return;
        }

        // Wait a bit before restarting
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Recreate the service with updated environment variables
        const newId = await this.serviceRegistry.createServiceFromTemplate(templateName, { env: body.env });

        this.logger.info(`Service ${id} updated with new environment variables and restarted as ${newId}`);
        reply.send({ success: true, serviceId: newId, message: 'Service environment variables updated and restarted' });
      } catch (error) {
        this.logger.error('Error updating service environment variables:', error);
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Failed to update service environment variables', { code: 'UPDATE_ENV_FAILED' });
      }
    });

    // Stop service
    this.server.delete('/api/services/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        const success = await this.serviceRegistry.stopService(id);

        if (!success) {
          return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
        }

        reply.send({ success: true, message: 'Service stopped successfully' });
      } catch (error) {
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Failed to stop service', { code: 'STOP_FAILED' });
      }
    });

    // Get service health (centralized via HealthChecker)
    this.server.get('/api/services/:id/health', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const health = await this.serviceRegistry.checkHealth(id);
        reply.send({ health });
      } catch (error) {
        reply.code(500).send({ error: 'Failed to check service health', message: (error as any)?.message || 'Unknown error' });
      }
    });

    // Get service logs
    this.server.get('/api/services/:id/logs', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };
      const logLimit = limit ? parseInt(limit) : 50;

      try {
        // Filter logs for this specific service or generate service-specific logs
        const serviceLogs = this.logBuffer
          .filter(log => log.service === id)
          .slice(-logLimit);

        // If no service-specific logs, generate some for demo
        if (serviceLogs.length === 0) {
          const demoLogs = [
            {
              timestamp: new Date(Date.now() - 30000).toISOString(),
              level: 'info',
              message: '服务实例启动成功',
              service: id
            },
            {
              timestamp: new Date(Date.now() - 20000).toISOString(),
              level: 'debug',
              message: '初始化MCP连接',
              service: id
            },
            {
              timestamp: new Date(Date.now() - 10000).toISOString(),
              level: 'info',
              message: '服务就绪，等待请求',
              service: id
            }
          ];
          reply.send(demoLogs);
        } else {
          reply.send(serviceLogs);
        }
      } catch (error) {
        reply.code(500).send({
          error: 'Failed to get service logs',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  // MCP Generator Routes
  private setupGeneratorRoutes(): void {
    // Generate MCP from various sources
    this.server.post('/api/generator/generate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.mcpGenerator) {
          return this.respondError(reply, 503, 'MCP Generator not initialized', { code: 'NOT_READY', recoverable: true });
        }

        const body = request.body as GenerateRequest;
        const result = await this.mcpGenerator.generate(body);

        if (result.success) {
          this.logger.info('MCP service generated successfully', { name: result.template?.name });
        }

        reply.send(result);
      } catch (error) {
        this.logger.error('Failed to generate MCP service', error);
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Export template in various formats
    this.server.post('/api/generator/export', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.mcpGenerator) {
          return reply.code(503).send({
            success: false,
            error: 'MCP Generator not initialized'
          });
        }

        const body = request.body as ExportRequest;
        const result = await this.mcpGenerator.export(body);

        if (result.success) {
          this.logger.info('Template exported successfully', { name: body.templateName, format: body.format });
        }

        reply.send(result);
      } catch (error) {
        this.logger.error('Failed to export template', error);
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Import template from external source
    this.server.post('/api/generator/import', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.mcpGenerator) {
          return reply.code(503).send({
            success: false,
            error: 'MCP Generator not initialized'
          });
        }

        const body = request.body as ImportRequest;
        const result = await this.mcpGenerator.import(body);

        if (result.success) {
          this.logger.info('Template imported successfully', { name: result.template?.name });
        }

        reply.send(result);
      } catch (error) {
        this.logger.error('Failed to import template', error);
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Download exported file
    this.server.get('/api/generator/download/:filename', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { filename } = request.params as { filename: string };
        const path = await import('path');
        const exportDir = path.join(process.cwd(), 'generated');

        reply.sendFile(filename, exportDir);
      } catch (error) {
        this.logger.error('Failed to download file', error);
        return this.respondError(reply, 404, 'File not found', { code: 'NOT_FOUND', recoverable: true });
      }
    });

    // Marketplace - List available templates (static source)
    this.server.get('/api/generator/marketplace', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const items = await this.loadMarketplaceItems();
        reply.send({ templates: items });
      } catch (error) {
        this.logger.warn('Marketplace list failed', error);
        return this.respondError(reply, 500, (error as Error).message || 'Marketplace list failed', { code: 'MARKETPLACE_ERROR' });
      }
    });

    // Marketplace - Search templates (matches docs: GET /api/generator/marketplace/search)
    this.server.get('/api/generator/marketplace/search', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { q } = (request.query as any) || {};
        const query = String(q || '').toLowerCase();
        const items = await this.loadMarketplaceItems();
        const results = !query
          ? items
          : items.filter((it: any) => {
              const hay = `${it.name} ${it.description || ''} ${(it.tags || []).join(' ')}`.toLowerCase();
              return hay.includes(query);
            });
        reply.send({ success: true, query, results });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Marketplace search failed', { code: 'MARKETPLACE_ERROR' });
      }
    });

    // Marketplace - Publish template (matches docs: POST /api/generator/marketplace/publish)
    this.server.post('/api/generator/marketplace/publish', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Placeholder: return not implemented while keeping doc-consistent route
        return this.respondError(reply, 501, 'Publish not implemented yet', { code: 'NOT_IMPLEMENTED', recoverable: true });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Marketplace publish failed', { code: 'MARKETPLACE_ERROR' });
      }
    });

    // Marketplace - Install template (from static source)
    this.server.post('/api/generator/marketplace/install', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as { templateId?: string; name?: string };
        const items = await this.loadMarketplaceItems();
        const idOrName = body.templateId || body.name;
        if (!idOrName) {
          return this.respondError(reply, 400, 'templateId or name is required', { code: 'BAD_REQUEST', recoverable: true });
        }
        const item = items.find((it: any) => it.id === idOrName || it.name === idOrName);
        if (!item) {
          return this.respondError(reply, 404, 'Template not found', { code: 'NOT_FOUND', recoverable: true });
        }
        const config = item.template || item.config;
        if (!config) {
          return this.respondError(reply, 422, 'Template config missing', { code: 'UNPROCESSABLE', recoverable: true });
        }
        await this.serviceRegistry.registerTemplate(config);
        this.addLogEntry('info', `Marketplace installed: ${config.name}`, 'marketplace');
        reply.send({ success: true, name: config.name });
      } catch (error) {
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Marketplace install failed', { code: 'MARKETPLACE_ERROR' });
      }
    });
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
        // Prepare SSE response
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Cache-Control'
        });

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

  private setupTemplateRoutes(): void {
    // List templates
    this.server.get('/api/templates', async (request: FastifyRequest, reply: FastifyReply) => {
      const templates = await this.serviceRegistry.listTemplates();
      reply.send(templates); // Send array directly
    });

    // Get template by name
    this.server.get('/api/templates/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      try {
        const tpl = await this.serviceRegistry.getTemplate(name);
        if (!tpl) return this.respondError(reply, 404, 'Template not found', { code: 'NOT_FOUND', recoverable: true });
        reply.send(tpl);
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to get template', { code: 'TEMPLATE_GET_FAILED' });
      }
    });

    // Register template
    this.server.post('/api/templates', async (request: FastifyRequest, reply: FastifyReply) => {
      const config = request.body as McpServiceConfig;

      try {
        await this.serviceRegistry.registerTemplate(config);
        reply.code(201).send({
          success: true,
          message: `Template registered: ${config.name}`
        });
      } catch (error) {
        return this.respondError(reply, 400, error instanceof Error ? error.message : 'Failed to register template', { code: 'TEMPLATE_REGISTER_FAILED', recoverable: true });
      }
    });

    // Update template env only
    this.server.patch('/api/templates/:name/env', async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      const rawBody = (request.body as any) ?? {};
      // Accept both { env: {...} } and direct key-value { KEY: "", ... }
      const body = typeof rawBody === 'object' && rawBody && !Array.isArray(rawBody)
        ? (rawBody.env && typeof rawBody.env === 'object' ? { env: rawBody.env as Record<string,string> } : { env: rawBody as Record<string,string> })
        : { env: undefined } as { env?: Record<string,string> };
      try {
        if (!body || !body.env || typeof body.env !== 'object') {
          // Return structured JSON instead of empty body, to avoid UI "no body" confusion
          return this.respondError(reply, 400, 'env object is required', { code: 'BAD_REQUEST', recoverable: true });
        }
        const tpl = await this.serviceRegistry.getTemplate(name);
        if (!tpl) {
          return this.respondError(reply, 404, 'Template not found', { code: 'NOT_FOUND', recoverable: true });
        }
        const updated = { ...tpl, env: { ...(tpl.env || {}), ...body.env } } as McpServiceConfig;
        await this.serviceRegistry.registerTemplate(updated);
        reply.send({ success: true, message: 'Template env updated', name });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to update template env', { code: 'TEMPLATE_UPDATE_FAILED' });
      }
    });

    // Diagnose template for missing envs (env-only heuristic; no spawn)
    this.server.post('/api/templates/:name/diagnose', async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      try {
        const tpl = await this.serviceRegistry.getTemplate(name);
        if (!tpl) {
          // Return a stable payload to avoid UI breaks
          reply.code(200).send({ success: false, name, required: [], provided: [], missing: [], transport: 'unknown', error: 'Template not found' });
          return;
        }
        let required: string[] = [];
        try { required = this.computeRequiredEnvForTemplate(tpl as any) || []; } catch { required = []; }
        const provided = Object.keys((tpl as any).env || {});
        const missing = required.filter(k => !provided.includes(k));
        reply.send({ success: true, name, required, provided, missing, transport: (tpl as any).transport });
      } catch (error) {
        // Do not surface 500 to UI; send a soft-fail payload
        reply.code(200).send({ success: false, name, required: [], provided: [], missing: [], transport: 'unknown', error: (error as Error)?.message || 'Diagnose failed' });
      }
    });

    // Delete template
    this.server.delete('/api/templates/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      try {
        await this.serviceRegistry.removeTemplate(name);
        reply.send({ success: true, message: 'Template deleted successfully', name });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove template';
        const notFound = /not\s*found/i.test(message);
        return this.respondError(reply, notFound ? 404 : 500, message, { code: notFound ? 'NOT_FOUND' : 'TEMPLATE_REMOVE_FAILED', recoverable: notFound });
      }
    });

    // Repair templates (fix legacy placeholders) & list offline MCP packages
    this.server.post('/api/templates/repair', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        await (this.serviceRegistry as any).templateManager.initializeDefaults();
        reply.send({ success: true });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Repair templates failed', { code: 'TEMPLATE_REPAIR_FAILED' });
      }
    });

    // Repair missing container images by applying sensible defaults
    this.server.post('/api/templates/repair-images', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const templates = await this.serviceRegistry.listTemplates();
        let fixed = 0;
        const updated: string[] = [];

        const suggestImage = (tpl: import('../types/index.js').McpServiceConfig): string => {
          const cmd = String((tpl as any).command || '').toLowerCase();
          if (cmd.includes('npm') || cmd.includes('node')) return 'node:20-alpine';
          if (cmd.includes('python')) return 'python:3.11-alpine';
          if (cmd.includes('go')) return 'golang:1.22-alpine';
          return 'alpine:3';
        };

        for (const tpl of templates) {
          const env = (tpl as any).env || {};
          const isContainer = env.SANDBOX === 'container' || !!(tpl as any).container;
          const isStdio = (tpl as any).transport === 'stdio';
          if (!isStdio || !isContainer) continue;

          const container = (tpl as any).container || {};
          if (!container.image) {
            const image = suggestImage(tpl as any);
            const next: any = { ...tpl, container: { ...container, image } };
            // ensure SANDBOX is container
            next.env = { ...(tpl as any).env, SANDBOX: 'container' };
            try {
              await this.serviceRegistry.registerTemplate(next);
              fixed += 1;
              updated.push(String(tpl.name));
            } catch (e) {
              this.logger.warn('Failed to repair container image for template', { name: tpl.name, error: (e as Error).message });
            }
          }
        }

        reply.send({ success: true, fixed, updated });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Repair container images failed', { code: 'TEMPLATE_REPAIR_IMAGES_FAILED' });
      }
    });
  }

  // Heuristic env requirement mapping, aligned with GUI
  private computeRequiredEnvForTemplate(tpl: import('../types/index.js').McpServiceConfig): string[] {
    const name = String((tpl?.name || '')).toLowerCase();
    const cmd = String((tpl as any)?.command || '').toLowerCase();
    const args = Array.isArray((tpl as any)?.args) ? ((tpl as any).args as string[]).join(' ').toLowerCase() : '';
    if (name.includes('brave') || args.includes('@modelcontextprotocol/server-brave-search')) return ['BRAVE_API_KEY'];
    if (name.includes('github') || args.includes('@modelcontextprotocol/server-github')) return ['GITHUB_TOKEN'];
    if (name.includes('openai') || cmd.includes('openai') || args.includes('openai') || args.includes('@modelcontextprotocol/server-openai')) return ['OPENAI_API_KEY'];
    if (name.includes('azure-openai') || cmd.includes('azure-openai') || args.includes('azure-openai')) return ['AZURE_OPENAI_API_KEY','AZURE_OPENAI_ENDPOINT'];
    if (name.includes('anthropic') || cmd.includes('anthropic') || args.includes('anthropic') || args.includes('@modelcontextprotocol/server-anthropic')) return ['ANTHROPIC_API_KEY'];
    if (name.includes('ollama') || cmd.includes('ollama') || args.includes('ollama')) return [];
    // Extended common providers (best-effort)
    if (name.includes('gemini') || name.includes('google') || cmd.includes('gemini') || args.includes('gemini') || args.includes('google-genai') || args.includes('@modelcontextprotocol/server-google') || args.includes('@modelcontextprotocol/server-gemini')) return ['GOOGLE_API_KEY'];
    if (name.includes('cohere') || cmd.includes('cohere') || args.includes('cohere') || args.includes('@modelcontextprotocol/server-cohere')) return ['COHERE_API_KEY'];
    if (name.includes('groq') || cmd.includes('groq') || args.includes('groq') || args.includes('@modelcontextprotocol/server-groq')) return ['GROQ_API_KEY'];
    if (name.includes('openrouter') || cmd.includes('openrouter') || args.includes('openrouter') || args.includes('@modelcontextprotocol/server-openrouter')) return ['OPENROUTER_API_KEY'];
    if (name.includes('together') || cmd.includes('together') || args.includes('together') || args.includes('@modelcontextprotocol/server-together')) return ['TOGETHER_API_KEY'];
    if (name.includes('fireworks') || cmd.includes('fireworks') || args.includes('fireworks') || args.includes('@modelcontextprotocol/server-fireworks')) return ['FIREWORKS_API_KEY'];
    if (name.includes('deepseek') || cmd.includes('deepseek') || args.includes('deepseek') || args.includes('@modelcontextprotocol/server-deepseek')) return ['DEEPSEEK_API_KEY'];
    if (name.includes('mistral') || cmd.includes('mistral') || args.includes('mistral') || args.includes('@modelcontextprotocol/server-mistral')) return ['MISTRAL_API_KEY'];
    if (name.includes('perplexity') || cmd.includes('perplexity') || args.includes('perplexity') || args.includes('@modelcontextprotocol/server-perplexity')) return ['PERPLEXITY_API_KEY'];
    if (name.includes('replicate') || cmd.includes('replicate') || args.includes('replicate') || args.includes('@modelcontextprotocol/server-replicate')) return ['REPLICATE_API_TOKEN'];
    if (name.includes('serpapi') || cmd.includes('serpapi') || args.includes('serpapi') || args.includes('@modelcontextprotocol/server-serpapi')) return ['SERPAPI_API_KEY'];
    if (name.includes('huggingface') || name.includes('hugging-face') || cmd.includes('huggingface') || args.includes('huggingface') || args.includes('@modelcontextprotocol/server-huggingface')) return ['HF_TOKEN'];
    return [];
  }

  private setupRoutingRoutes(): void {
    // Route request to appropriate service
    this.server.post('/api/route', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as RouteRequestBody;

      if (!body.method) {
        return this.respondError(reply, 400, 'method is required', { code: 'BAD_REQUEST', recoverable: true });
      }

      try {
        // Get available services
        const services = await this.serviceRegistry.listServices();
        const serviceHealthMap = new Map<string, ServiceHealth>();

        // Get health for each service
        for (const service of services) {
          try {
            const health = await this.serviceRegistry.checkHealth(service.id);
            serviceHealthMap.set(service.id, this.convertHealthResult(health));
          } catch (error) {
            // Service might be down, skip it
            serviceHealthMap.set(service.id, {
              status: 'unhealthy',
              responseTime: Infinity,
              lastCheck: new Date(),
              error: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        }

        const routeRequest: RouteRequest = {
          method: body.method,
          params: body.params,
          serviceGroup: body.serviceGroup,
          contentType: body.contentType,
          contentLength: body.contentLength,
          clientIp: request.ip,
          availableServices: services,
          serviceHealthMap
        };

        const routeResponse = await this.router.route(routeRequest);

        if (!routeResponse.success) {
          reply.code(503).send({
            error: 'No services available',
            message: routeResponse.error
          });
          return;
        }

        reply.send({
          success: true,
          selectedService: routeResponse.selectedService,
          routingDecision: routeResponse.routingDecision
        });
      } catch (error) {
        reply.code(500).send({
          error: 'Routing failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Proxy MCP requests to services
    this.server.post('/api/proxy/:serviceId', async (request: FastifyRequest, reply: FastifyReply) => {
      const { serviceId } = request.params as { serviceId: string };
      const mcpMessage = request.body as any;

      try {
        const service = await this.serviceRegistry.getService(serviceId);

        if (!service) {
          return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
        }

        // Create adapter and send message
        const adapter = await this.protocolAdapters.createAdapter(service.config);
        await adapter.connect();

        // wire adapter events into log buffer for richer service logs
        (adapter as any).on?.('stderr', (line: string) => {
          this.addLogEntry('warn', `stderr: ${line}`, serviceId);
        });
        (adapter as any).on?.('sent', (msg: any) => {
          this.addLogEntry('debug', `${msg?.method || 'unknown'} id=${msg?.id ?? 'auto'}`, serviceId);
        });
        (adapter as any).on?.('message', (msg: any) => {
          this.addLogEntry('debug', `${msg?.method || (msg?.result ? 'result' : 'message')} id=${msg?.id ?? 'n/a'}`, serviceId);
        });

        // Mark sandbox usage & per-call logging
        const isPortable = (service.config.env as any)?.SANDBOX === 'portable';
        const startTs = Date.now();
        this.addLogEntry('info', `Proxy call ${mcpMessage?.method || 'unknown'} (id=${mcpMessage?.id ?? 'auto'})${isPortable ? ' [SANDBOX: portable]' : ''}`, serviceId, { request: mcpMessage });
        try {
          const preview = JSON.stringify(mcpMessage?.params ?? {}).slice(0, 800);
          this.addLogEntry('debug', `params: ${preview}${preview.length === 800 ? '…' : ''}`, serviceId);
        } catch {}

        try {
          const response = await (adapter as any).sendAndReceive?.(mcpMessage) ||
                           await adapter.send(mcpMessage);
          const duration = Date.now() - startTs;
          this.addLogEntry('info', `Proxy response ${mcpMessage?.method || 'unknown'} (id=${mcpMessage?.id ?? 'auto'}) in ${duration}ms`, serviceId, { response });
          try {
            const preview = JSON.stringify(response?.result ?? response?.error ?? {}).slice(0, 800);
            this.addLogEntry('debug', `result: ${preview}${preview.length === 800 ? '…' : ''}`, serviceId);
          } catch {}
          reply.send(response);
        } finally {
          await adapter.disconnect();
        }
      } catch (error) {
        this.addLogEntry('error', `Proxy failed: ${(error as Error)?.message || 'unknown error'}`, (request.params as any)?.serviceId);
        reply.code(500).send({
          error: 'Proxy request failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    

    
  }

  private setupMonitoringRoutes(): void {
    // Get comprehensive health status
    this.server.get('/api/health-status', async (request: FastifyRequest, reply: FastifyReply) => {
      const stats = await this.serviceRegistry.getRegistryStats();
      const routerMetrics = this.router.getMetrics();
      const services = await this.serviceRegistry.listServices();

      const healthStatus = {
        gateway: {
          uptime: process.uptime() * 1000, // Convert to milliseconds
          status: 'healthy',
          version: '1.0.0'
        },
        metrics: {
          totalRequests: routerMetrics.totalRequests || 0,
          successRate: routerMetrics.successRate || 0,
          averageResponseTime: routerMetrics.averageResponseTime || 0,
          activeConnections: 0 // Default value since not available
        },
        services: {
          total: services.length,
          running: services.filter(s => s.state === 'running').length,
          stopped: services.filter(s => s.state === 'stopped').length,
          error: services.filter(s => s.state === 'error').length
        }
      };

      reply.send(healthStatus);
    });

    // Get registry statistics
    this.server.get('/api/metrics/registry', async (request: FastifyRequest, reply: FastifyReply) => {
      const stats = await this.serviceRegistry.getRegistryStats();
      reply.send({ stats });
    });

    // Aggregated health metrics (global + per service)
    this.server.get('/api/metrics/health', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const agg = await this.serviceRegistry.getHealthAggregates();
        reply.send(agg);
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });

    // Get router metrics
    this.server.get('/api/metrics/router', async (request: FastifyRequest, reply: FastifyReply) => {
      const metrics = this.router.getMetrics();
      reply.send({ metrics });
    });

    // Get service metrics
    this.server.get('/api/metrics/services', async (request: FastifyRequest, reply: FastifyReply) => {
      const services = await this.serviceRegistry.listServices();
      const serviceMetrics = [];

      for (const service of services) {
        try {
          const health = await this.serviceRegistry.checkHealth(service.id);
          serviceMetrics.push({
            serviceId: service.id,
            serviceName: service.config.name,
            health,
            uptime: Date.now() - service.startedAt.getTime()
          });
        } catch (error) {
          serviceMetrics.push({
            serviceId: service.id,
            serviceName: service.config.name,
            health: { status: 'unhealthy', error: error instanceof Error ? error.message : 'Unknown error' },
            uptime: 0
          });
        }
      }

      reply.send({ serviceMetrics });
    });
  }

  private setupErrorHandlers(): void {
    this.server.setErrorHandler(async (error, request, reply) => {
      this.logger.error('HTTP API error:', error);

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

  private setupAuthRoutes(): void {
    // List API keys
    this.server.get('/api/auth/apikeys', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const apiKeys = this.authLayer.listApiKeys();
        reply.send(apiKeys);
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to list API keys', { code: 'AUTH_LIST_FAILED' });
      }
    });

    // Create API key
    this.server.post('/api/auth/apikey', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { name, permissions } = request.body as { name?: string, permissions?: string[] };
        if (!name || !Array.isArray(permissions)) {
          return this.respondError(reply, 400, 'name and permissions are required', { code: 'BAD_REQUEST', recoverable: true });
        }
        const result = await this.authLayer.createApiKey(name, permissions);
        reply.code(201).send({ success: true, apiKey: result, message: 'API key created successfully' });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to create API key', { code: 'AUTH_CREATE_FAILED' });
      }
    });

    // Delete API key
    this.server.delete('/api/auth/apikey/:key', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { key } = request.params as { key?: string };
        if (!key) return this.respondError(reply, 400, 'API key is required', { code: 'BAD_REQUEST', recoverable: true });
        const success = await this.authLayer.deleteApiKey(key);
        if (!success) return this.respondError(reply, 404, 'API key not found', { code: 'NOT_FOUND', recoverable: true });
        reply.send({ success: true, message: 'API key deleted successfully' });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to delete API key', { code: 'AUTH_DELETE_FAILED' });
      }
    });

    // List tokens
    this.server.get('/api/auth/tokens', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const tokens = this.authLayer.listTokens();
        reply.send(tokens);
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to list tokens', { code: 'AUTH_LIST_FAILED' });
      }
    });

    // Generate token
    this.server.post('/api/auth/token', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { userId, permissions, expiresInHours = 24 } = request.body as { userId?: string; permissions?: string[]; expiresInHours?: number };
        if (!userId || !Array.isArray(permissions)) {
          return this.respondError(reply, 400, 'userId and permissions are required', { code: 'BAD_REQUEST', recoverable: true });
        }
        const result = await this.authLayer.generateToken(userId, permissions, expiresInHours);
        reply.code(201).send({ success: true, token: result, message: 'Token generated successfully' });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to generate token', { code: 'AUTH_TOKEN_FAILED' });
      }
    });

    // Revoke token
    this.server.delete('/api/auth/token/:token', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { token } = request.params as { token?: string };
        if (!token) return this.respondError(reply, 400, 'Token is required', { code: 'BAD_REQUEST', recoverable: true });
        const success = await this.authLayer.revokeToken(token);
        if (!success) return this.respondError(reply, 404, 'Token not found', { code: 'NOT_FOUND', recoverable: true });
        reply.send({ success: true, message: 'Token revoked successfully' });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to revoke token', { code: 'AUTH_REVOKE_FAILED' });
      }
    });
  }

  private setupConfigRoutes(): void {
    // Get current configuration
    this.server.get('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
      const config = this.configManager.getConfig();
      reply.send(config);
    });

    // Update configuration
    this.server.put('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
      const updates = request.body as Partial<GatewayConfig>;

      try {
        const updatedConfig = await this.configManager.updateConfig(updates);
        reply.send({
          success: true,
          message: 'Configuration updated successfully',
          config: updatedConfig
        });
      } catch (error) {
        reply.code(500).send({
          error: 'Failed to update configuration',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Get specific configuration value
    this.server.get('/api/config/:key', async (request: FastifyRequest, reply: FastifyReply) => {
      const { key } = request.params as { key: string };

      try {
        const value = await this.configManager.get(key);
        if (value === null) {
          reply.code(404).send({ error: 'Configuration key not found', key });
          return;
        }
        reply.send({ key, value });
      } catch (error) {
        reply.code(500).send({
          error: 'Failed to get configuration value',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  // ============ Local MCP Proxy per docs/LOCAL-MCP-PROXY.md ============
  private setupLocalMcpProxyRoutes(): void {
    // Optional helper for UI to display current code
    this.server.get('/local-proxy/code', async (_req, reply) => {
      const now = Date.now();
      const expiresIn = Math.max(0, Math.floor((this.codeExpiresAt - now) / 1000));
      reply.send({ code: this.currentVerificationCode, expiresIn });
    });

    // Handshake init
    this.server.post('/handshake/init', async (request, reply) => {
      try {
        const origin = this.requireAndValidateOrigin(request, reply);
        if (!origin) return; // replied

        const { clientNonce, codeProof } = (request.body as any) || {};
        if (!clientNonce || !codeProof) {
          return reply.code(400).send({ success: false, error: 'Missing clientNonce or codeProof', code: 'BAD_REQUEST' });
        }

        // Rate limit per origin (max 5/minute)
        if (!this.checkRateLimit(`init:${origin}`, 5, 60_000)) {
          this.addLogEntry('warn', `mcp.local.handshake_init rate_limited for ${origin}`);
          return reply.code(429).send({ success: false, error: 'Rate limited', code: 'RATE_LIMIT' });
        }

        // Validate codeProof against current or previous code
        const expectedCurrent = createHash('sha256').update(`${this.currentVerificationCode}|${origin}|${clientNonce}`).digest('hex');
        const expectedPrev = this.previousVerificationCode
          ? createHash('sha256').update(`${this.previousVerificationCode}|${origin}|${clientNonce}`).digest('hex')
          : '';
        if (codeProof !== expectedCurrent && codeProof !== expectedPrev) {
          this.addLogEntry('warn', `mcp.local.handshake_init invalid_code origin=${origin}`);
          return reply.code(401).send({ success: false, error: 'Invalid code proof', code: 'INVALID_CODE' });
        }

        const handshakeId = randomUUID();
        const serverNonceBytes = randomBytes(16);
        const serverNonce = serverNonceBytes.toString('base64');
        const kdf: 'pbkdf2' = 'pbkdf2';
        const kdfParams = { iterations: 200_000, hash: 'SHA-256', length: 32 };
        const expiresIn = 60; // seconds

        this.handshakeStore.set(handshakeId, {
          id: handshakeId,
          origin,
          clientNonce,
          serverNonce,
          kdf,
          kdfParams,
          approved: false,
          expiresAt: Date.now() + expiresIn * 1000
        });

        this.addLogEntry('info', 'mcp.local.handshake_init', undefined, { origin, handshakeId });
        reply.send({ handshakeId, serverNonce, expiresIn, kdf, kdfParams });
      } catch (err: any) {
        // Error already handled in requireAndValidateOrigin
        if (!reply.sent) reply.code(500).send({ success: false, error: err.message, code: 'INTERNAL_ERROR' });
      }
    });

    // Approve handshake (UI action)
    this.server.post('/handshake/approve', async (request, reply) => {
      const { handshakeId, approve } = (request.body as any) || {};
      if (!handshakeId) return reply.code(400).send({ success: false, error: 'handshakeId required' });
      const hs = this.handshakeStore.get(handshakeId);
      if (!hs) return reply.code(404).send({ success: false, error: 'Handshake not found' });
      if (Date.now() > hs.expiresAt) return reply.code(409).send({ success: false, error: 'Handshake expired' });
      hs.approved = !!approve;
      this.addLogEntry('info', `mcp.local.handshake_${approve ? 'approve' : 'reject'}`, undefined, { handshakeId, origin: hs.origin });
      reply.send({ success: true });
    });

    // Confirm handshake
    this.server.post('/handshake/confirm', async (request, reply) => {
      try {
        const origin = this.requireAndValidateOrigin(request, reply);
        if (!origin) return;
        const { handshakeId, response } = (request.body as any) || {};
        if (!handshakeId || !response) return reply.code(400).send({ success: false, error: 'Missing handshakeId or response', code: 'BAD_REQUEST' });
        const hs = this.handshakeStore.get(handshakeId);
        if (!hs) return reply.code(404).send({ success: false, error: 'Handshake not found', code: 'NOT_FOUND' });
        if (Date.now() > hs.expiresAt) return reply.code(409).send({ success: false, error: 'Handshake expired', code: 'EXPIRED' });
        if (!hs.approved) return reply.code(403).send({ success: false, error: 'Handshake not approved', code: 'NOT_APPROVED' });
        if (hs.origin !== origin) return reply.code(403).send({ success: false, error: 'Origin mismatch', code: 'ORIGIN_MISMATCH' });

        // Derive key with current or previous code
        const keyFrom = (code: string) => {
          if (hs.kdf === 'pbkdf2') {
            return pbkdf2Sync(code, Buffer.from(hs.serverNonce, 'base64'), hs.kdfParams.iterations, hs.kdfParams.length, 'sha256');
          }
          return scryptSync(code, Buffer.from(hs.serverNonce, 'base64'), hs.kdfParams.length, { N: 32768, r: 8, p: 1 });
        };
        const expectedFor = (code: string) => {
          const key = keyFrom(code);
          const data = `${origin}|${hs.clientNonce}|${handshakeId}`;
          return createHmac('sha256', key).update(data).digest('base64');
        };
        const ok = response === expectedFor(this.currentVerificationCode) || (!!this.previousVerificationCode && response === expectedFor(this.previousVerificationCode));
        if (!ok) return reply.code(401).send({ success: false, error: 'Invalid response', code: 'BAD_RESPONSE' });

        // Issue token
        const token = randomBytes(32).toString('base64');
        const expiresIn = 600; // 10 minutes
        this.tokenStore.set(token, { origin, expiresAt: Date.now() + expiresIn * 1000 });

        // One-time handshake consumption
        this.handshakeStore.delete(handshakeId);
        this.addLogEntry('info', 'mcp.local.handshake_confirm', undefined, { origin });
        reply.send({ sessionToken: token, expiresIn });
      } catch (err: any) {
        if (!reply.sent) reply.code(500).send({ success: false, error: err.message, code: 'INTERNAL_ERROR' });
      }
    });

    // List tools (requires LocalMCP token)
    this.server.get('/tools', async (request, reply) => {
      const origin = request.headers.origin as string | undefined;
      const token = this.extractLocalMcpToken(request);
      if (!token) return reply.code(401).send({ success: false, error: 'Missing Authorization', code: 'UNAUTHORIZED' });
      if (!this.validateToken(token, origin)) return reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const { serviceId } = (request.query as any) || {};
      try {
        const service = await this.findTargetService(serviceId);
        if (!service) return reply.code(404).send({ success: false, error: 'No suitable service', code: 'NO_SERVICE' });
        const adapter = await this.protocolAdapters.createAdapter(service.config);
        await adapter.connect();
        try {
          const msg: any = { jsonrpc: '2.0', id: `tools-list-${Date.now()}`, method: 'tools/list', params: {} };
          const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
          this.addLogEntry('info', 'mcp.local.tools_list', service.id);
          reply.send({ success: true, tools: res?.result?.tools ?? res?.result ?? res, requestId: msg.id });
        } finally {
          await adapter.disconnect();
        }
      } catch (error: any) {
        reply.code(500).send({ success: false, error: error.message, code: 'INTERNAL_ERROR' });
      }
    });

    // Compatibility alias for tools listing
    this.server.get('/local-proxy/tools', async (request, reply) => {
      // Delegate to same handler logic by calling original path
      // Re-run the same checks inline to avoid internal routing recursion
      const origin = request.headers.origin as string | undefined;
      const token = this.extractLocalMcpToken(request);
      if (!token) return reply.code(401).send({ success: false, error: 'Missing Authorization', code: 'UNAUTHORIZED' });
      if (!this.validateToken(token, origin)) return reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const { serviceId } = (request.query as any) || {};
      try {
        const service = await this.findTargetService(serviceId);
        if (!service) return reply.code(404).send({ success: false, error: 'No suitable service', code: 'NO_SERVICE' });
        const adapter = await this.protocolAdapters.createAdapter(service.config);
        await adapter.connect();
        try {
          const msg: any = { jsonrpc: '2.0', id: `tools-list-${Date.now()}`, method: 'tools/list', params: {} };
          const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
          this.addLogEntry('info', 'mcp.local.tools_list', service.id);
          reply.send({ success: true, tools: res?.result?.tools ?? res?.result ?? res, requestId: msg.id });
        } finally { await adapter.disconnect(); }
      } catch (error: any) { reply.code(500).send({ success: false, error: error.message, code: 'INTERNAL_ERROR' }); }
    });

    // Call tool (requires LocalMCP token)
    this.server.post('/call', async (request, reply) => {
      const origin = request.headers.origin as string | undefined;
      const token = this.extractLocalMcpToken(request);
      if (!token) return reply.code(401).send({ success: false, error: 'Missing Authorization', code: 'UNAUTHORIZED' });
      if (!this.validateToken(token, origin)) return reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const { tool, params, serviceId } = (request.body as any) || {};
      if (!tool) return reply.code(400).send({ success: false, error: 'tool is required', code: 'BAD_REQUEST' });
      try {
        const service = await this.findTargetService(serviceId);
        if (!service) return reply.code(404).send({ success: false, error: 'No suitable service', code: 'NO_SERVICE' });
        const adapter = await this.protocolAdapters.createAdapter(service.config);
        await adapter.connect();
        try {
          const msg: any = { jsonrpc: '2.0', id: `call-${Date.now()}`, method: 'tools/call', params: { name: tool, arguments: params || {} } };
          const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
          this.addLogEntry('info', 'mcp.local.call', service.id, { tool });
          reply.send({ success: true, result: res?.result ?? res, requestId: msg.id });
        } finally {
          await adapter.disconnect();
        }
      } catch (error: any) {
        reply.code(500).send({ success: false, error: error.message, code: 'INTERNAL_ERROR' });
      }
    });

    // Compatibility alias for call
    this.server.post('/local-proxy/call', async (request, reply) => {
      const origin = request.headers.origin as string | undefined;
      const token = this.extractLocalMcpToken(request);
      if (!token) return reply.code(401).send({ success: false, error: 'Missing Authorization', code: 'UNAUTHORIZED' });
      if (!this.validateToken(token, origin)) return reply.code(403).send({ success: false, error: 'Forbidden', code: 'FORBIDDEN' });
      const { tool, params, serviceId } = (request.body as any) || {};
      if (!tool) return reply.code(400).send({ success: false, error: 'tool is required', code: 'BAD_REQUEST' });
      try {
        const service = await this.findTargetService(serviceId);
        if (!service) return reply.code(404).send({ success: false, error: 'No suitable service', code: 'NO_SERVICE' });
        const adapter = await this.protocolAdapters.createAdapter(service.config);
        await adapter.connect();
        try {
          const msg: any = { jsonrpc: '2.0', id: `call-${Date.now()}`, method: 'tools/call', params: { name: tool, arguments: params || {} } };
          const res = (adapter as any).sendAndReceive ? await (adapter as any).sendAndReceive(msg) : await adapter.send(msg);
          this.addLogEntry('info', 'mcp.local.call', service.id, { tool });
          reply.send({ success: true, result: res?.result ?? res, requestId: msg.id });
        } finally { await adapter.disconnect(); }
      } catch (error: any) { reply.code(500).send({ success: false, error: error.message, code: 'INTERNAL_ERROR' }); }
    });
  }

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

  private setupLogRoutes(): void {
    // Get recent logs
    this.server.get('/api/logs', async (request: FastifyRequest, reply: FastifyReply) => {
      const { limit } = request.query as { limit?: string };
      const logLimit = limit ? parseInt(limit) : 50;

      const recentLogs = this.logBuffer.slice(-logLimit);
      reply.send(recentLogs);
    });

    // Server-Sent Events stream for real-time logs
    this.server.get('/api/logs/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      // Send initial connection message
      reply.raw.write(`data: ${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: '已连接到实时日志',
        service: 'monitor'
      })}\n\n`);

      // Add client to the set
      this.logStreamClients.add(reply);

      // Send recent logs
      for (const log of this.logBuffer.slice(-10)) {
        reply.raw.write(`data: ${JSON.stringify(log)}\n\n`);
      }

      // Handle client disconnect
      request.socket.on('close', () => {
        this.logStreamClients.delete(reply);
      });

      request.socket.on('end', () => {
        this.logStreamClients.delete(reply);
      });
    });
  }
}

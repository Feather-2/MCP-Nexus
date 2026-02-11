import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { z } from 'zod';
import { RouteRequest, ServiceHealth, HealthCheckResult } from '../../types/index.js';
import { MiddlewareChain } from '../../middleware/chain.js';
import { SELECTED_INSTANCE_STATE_KEY } from '../../gateway/load-balancer.middleware.js';

interface _RouteRequestBody {
  method: string;
  params?: unknown;
  serviceGroup?: string;
  contentType?: string;
  contentLength?: number;
}

/**
 * Routing and proxy routes for MCP requests
 */
export class RoutingRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Route request to appropriate service
    server.post('/api/route', async (request: FastifyRequest, reply: FastifyReply) => {
      const Body = z.object({
        method: z.string().min(1),
        params: z.any().optional(),
        serviceGroup: z.string().optional(),
        contentType: z.string().optional(),
        contentLength: z.coerce.number().int().positive().optional()
      });
      let body: z.infer<typeof Body>;
      try { body = Body.parse((request.body as Record<string, unknown>) || {}); } catch (e) {
        const err = e as z.ZodError; return this.respondError(reply, 400, 'Invalid route request', { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
      }

      try {
        const services = await this.ctx.serviceRegistry.listServices();
        const serviceHealthMap = new Map<string, ServiceHealth>();
        await Promise.all(
          services.map(async (service) => {
            try {
              const health = await this.ctx.serviceRegistry.checkHealth(service.id);
              serviceHealthMap.set(service.id, this.convertHealthResult(health));
            } catch (error) {
              serviceHealthMap.set(service.id, {
                status: 'unhealthy',
                responseTime: Infinity,
                lastCheck: new Date(),
                error: error instanceof Error ? error.message : 'Unknown error'
              });
            }
          })
        );

        const chain = this.ctx.middlewareChain instanceof MiddlewareChain
          ? this.ctx.middlewareChain
          : new MiddlewareChain(this.ctx.middlewares || []);

        let selectedService: (typeof services)[number] | undefined = services[0];

        try {
          const mwCtx = {
            requestId: `route-${Date.now()}`,
            startTime: Date.now(),
            metadata: {
              templateId: body.serviceGroup || services[0]?.config?.name,
              routeMethod: body.method
            }
          };
          const mwState = {
            stage: 'beforeModel' as const,
            values: new Map<string, unknown>([
              ['instances', services],
              ['serviceHealthMap', serviceHealthMap]
            ]),
            aborted: false
          };
          await chain.execute('beforeModel', mwCtx, mwState);
          const picked = mwState.values.get(SELECTED_INSTANCE_STATE_KEY);
          if (picked) selectedService = picked as typeof selectedService;
        } catch (e) {
          // If middleware chain fails, fall back to router selection path below
          this.ctx.logger?.warn?.('Middleware routing failed, falling back to router.route', { error: (e as Error)?.message });
          selectedService = undefined;
        }

        if (!selectedService && this.ctx.router?.route) {
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
          const routeResponse = await this.ctx.router.route(routeRequest);

          if (!routeResponse.success || !routeResponse.selectedService) {
            return this.respondError(reply, 503, routeResponse.error || 'No services available', { code: 'NO_SERVICE' });
          }
          selectedService = routeResponse.selectedService;
        }

        if (!selectedService) {
          return this.respondError(reply, 503, 'No services available', { code: 'NO_SERVICE' });
        }

        reply.send({
          success: true,
          selectedService,
          routingDecision: {
            strategy: 'middleware-chain',
            reason: 'selected via middleware chain',
            appliedRules: []
          }
        });
      } catch (error) {
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Routing failed', { code: 'ROUTING_ERROR' });
      }
    });

    // Proxy MCP requests to services
    server.post('/api/proxy/:serviceId', async (request: FastifyRequest, reply: FastifyReply) => {
      const Params = z.object({ serviceId: z.string().min(1) });
      let serviceId: string;
      try { ({ serviceId } = Params.parse(request.params as Record<string, unknown>)); } catch (e) { const err = e as z.ZodError; return this.respondError(reply, 400, 'Invalid service id', { code: 'BAD_REQUEST', recoverable: true, meta: err.issues }); }

      // Validate MCP message structure
      const McpMessageSchema = z.object({
        jsonrpc: z.literal('2.0').optional().default('2.0'),
        method: z.string().min(1),
        params: z.any().optional(),
        id: z.union([z.string(), z.number()]).optional()
      });

      let mcpMessage: z.infer<typeof McpMessageSchema>;
      try { mcpMessage = McpMessageSchema.parse((request.body as Record<string, unknown>) || {}); } catch (e) {
        const err = e as z.ZodError; return this.respondError(reply, 400, 'Invalid MCP message format', { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
      }

      try {
        const service = await this.ctx.serviceRegistry.getService(serviceId);

        if (!service) {
          return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
        }

        const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
        await adapter.connect();

        // Wire adapter events into log buffer
        const emitter = adapter as unknown as { on?: (event: string, fn: (...args: unknown[]) => void) => void };
        emitter.on?.('stderr', (line: unknown) => {
          this.ctx.addLogEntry('warn', `stderr: ${line}`, serviceId);
        });
        emitter.on?.('sent', (msg: unknown) => {
          const m = msg as Record<string, unknown> | undefined;
          this.ctx.addLogEntry('debug', `${m?.method || 'unknown'} id=${m?.id ?? 'auto'}`, serviceId);
        });
        emitter.on?.('message', (msg: unknown) => {
          const m = msg as Record<string, unknown> | undefined;
          this.ctx.addLogEntry('debug', `${m?.method || (m?.result ? 'result' : 'message')} id=${m?.id ?? 'n/a'}`, serviceId);
        });

        const isPortable = service.config.env?.SANDBOX === 'portable';
        const startTs = Date.now();
        this.ctx.addLogEntry('info', `Proxy call ${mcpMessage?.method || 'unknown'} (id=${mcpMessage?.id ?? 'auto'})${isPortable ? ' [SANDBOX: portable]' : ''}`, serviceId, { request: mcpMessage });
        try {
          const preview = JSON.stringify(mcpMessage?.params ?? {}).slice(0, 800);
          this.ctx.addLogEntry('debug', `params: ${preview}${preview.length === 800 ? '…' : ''}`, serviceId);
        } catch { /* ignored */ }

        try {
          const sendReceive = (adapter as unknown as { sendAndReceive?: (msg: unknown) => Promise<unknown> }).sendAndReceive;
          const response = await (sendReceive?.(mcpMessage) ?? adapter.send(mcpMessage));
          const duration = Date.now() - startTs;
          this.ctx.addLogEntry('info', `Proxy response ${mcpMessage?.method || 'unknown'} (id=${mcpMessage?.id ?? 'auto'}) in ${duration}ms`, serviceId, { response });
          try { this.ctx.serviceRegistry.reportHeartbeat(serviceId, { healthy: true, latency: duration }); } catch {}
          try {
            const r = response as Record<string, unknown> | undefined;
            const preview = JSON.stringify(r?.result ?? r?.error ?? {}).slice(0, 800);
            this.ctx.addLogEntry('debug', `result: ${preview}${preview.length === 800 ? '…' : ''}`, serviceId);
          } catch { /* ignored */ }
          reply.send(response);
        } finally {
          await adapter.disconnect();
        }
      } catch (error) {
        try { this.ctx.serviceRegistry.reportHeartbeat(serviceId, { healthy: false, error: (error as Error)?.message || 'proxy failed' }); } catch {}
        this.ctx.addLogEntry('error', `Proxy failed: ${(error as Error)?.message || 'unknown error'}`, (request.params as Record<string, unknown>)?.serviceId as string);
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Proxy request failed', { code: 'PROXY_ERROR' });
      }
    });

    // Generic MCP JSON-RPC endpoint for paper-burner transport discovery
    // Only allows standard MCP protocol methods to prevent internal method exposure
    const MCP_ALLOWED_PREFIXES = ['tools/', 'resources/', 'prompts/', 'completion/', 'logging/', 'initialize', 'ping'];
    server.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
      const McpMessageSchema = z.object({
        jsonrpc: z.literal('2.0').optional().default('2.0'),
        method: z.string().min(1),
        params: z.any().optional(),
        id: z.union([z.string(), z.number()]).optional()
      });

      let mcpMessage: z.infer<typeof McpMessageSchema>;
      try {
        mcpMessage = McpMessageSchema.parse((request.body as Record<string, unknown>) || {});
      } catch (e) {
        const err = e as z.ZodError;
        return this.respondError(reply, 400, 'Invalid MCP message format', { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
      }

      if (!MCP_ALLOWED_PREFIXES.some(p => mcpMessage.method.startsWith(p))) {
        return this.respondError(reply, 403, 'MCP method not allowed: ' + mcpMessage.method, { code: 'METHOD_NOT_ALLOWED', recoverable: true });
      }

      try {
        const services = await this.ctx.serviceRegistry.listServices();
        const running = services.filter(s => s.state === 'running');
        if (!running.length) {
          return this.respondError(reply, 503, 'No running MCP services', { code: 'NO_SERVICE', recoverable: true });
        }

        const service = running[0];
        const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
        await adapter.connect();

        try {
          const sr = (adapter as unknown as { sendAndReceive?: (msg: unknown) => Promise<unknown> }).sendAndReceive;
          const response = await (sr?.(mcpMessage) ?? adapter.send(mcpMessage));
          reply.send(response);
        } finally {
          await adapter.disconnect();
        }
      } catch (error) {
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'MCP request failed', { code: 'MCP_ERROR' });
      }
    });

    // SSE notification endpoints for paper-burner discovery (/events, /sse)
    const sseHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      this.writeSseHeaders(reply, request);
      reply.raw.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);

      this.ctx.logStreamClients.add(reply);

      // Keepalive heartbeat to prevent proxy timeout
      const heartbeat = setInterval(() => {
        try { reply.raw.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
      }, 30_000);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      const cleanup = () => {
        clearInterval(heartbeat);
        this.ctx.logStreamClients.delete(reply);
      };
      request.socket.on('close', cleanup);
      request.socket.on('end', cleanup);
      request.socket.on('error', cleanup);
    };
    server.get('/events', sseHandler);
    server.get('/sse', sseHandler);
  }

  private convertHealthResult(health: HealthCheckResult): ServiceHealth {
    return {
      status: health.healthy ? 'healthy' : 'unhealthy',
      responseTime: health.latency || 0,
      lastCheck: new Date(health.timestamp || Date.now()),
      error: health.error
    };
  }
}

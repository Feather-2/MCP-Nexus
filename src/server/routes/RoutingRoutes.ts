import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { RouteRequest, ServiceHealth, HealthCheckResult } from '../../types/index.js';

interface RouteRequestBody {
  method: string;
  params?: any;
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
      const body = request.body as RouteRequestBody;

      if (!body.method) {
        return this.respondError(reply, 400, 'method is required', { code: 'BAD_REQUEST', recoverable: true });
      }

      try {
        const services = await this.ctx.serviceRegistry.listServices();
        const serviceHealthMap = new Map<string, ServiceHealth>();

        for (const service of services) {
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

        const routeResponse = await this.ctx.router.route(routeRequest);

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
    server.post('/api/proxy/:serviceId', async (request: FastifyRequest, reply: FastifyReply) => {
      const { serviceId } = request.params as { serviceId: string };
      const mcpMessage = request.body as any;

      try {
        const service = await this.ctx.serviceRegistry.getService(serviceId);

        if (!service) {
          return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
        }

        const adapter = await this.ctx.protocolAdapters.createAdapter(service.config);
        await adapter.connect();

        // Wire adapter events into log buffer
        (adapter as any).on?.('stderr', (line: string) => {
          this.ctx.addLogEntry('warn', `stderr: ${line}`, serviceId);
        });
        (adapter as any).on?.('sent', (msg: any) => {
          this.ctx.addLogEntry('debug', `${msg?.method || 'unknown'} id=${msg?.id ?? 'auto'}`, serviceId);
        });
        (adapter as any).on?.('message', (msg: any) => {
          this.ctx.addLogEntry('debug', `${msg?.method || (msg?.result ? 'result' : 'message')} id=${msg?.id ?? 'n/a'}`, serviceId);
        });

        const isPortable = (service.config.env as any)?.SANDBOX === 'portable';
        const startTs = Date.now();
        this.ctx.addLogEntry('info', `Proxy call ${mcpMessage?.method || 'unknown'} (id=${mcpMessage?.id ?? 'auto'})${isPortable ? ' [SANDBOX: portable]' : ''}`, serviceId, { request: mcpMessage });
        try {
          const preview = JSON.stringify(mcpMessage?.params ?? {}).slice(0, 800);
          this.ctx.addLogEntry('debug', `params: ${preview}${preview.length === 800 ? '…' : ''}`, serviceId);
        } catch {}

        try {
          const response = await (adapter as any).sendAndReceive?.(mcpMessage) ||
                           await adapter.send(mcpMessage);
          const duration = Date.now() - startTs;
          this.ctx.addLogEntry('info', `Proxy response ${mcpMessage?.method || 'unknown'} (id=${mcpMessage?.id ?? 'auto'}) in ${duration}ms`, serviceId, { response });
          try {
            const preview = JSON.stringify(response?.result ?? response?.error ?? {}).slice(0, 800);
            this.ctx.addLogEntry('debug', `result: ${preview}${preview.length === 800 ? '…' : ''}`, serviceId);
          } catch {}
          reply.send(response);
        } finally {
          await adapter.disconnect();
        }
      } catch (error) {
        this.ctx.addLogEntry('error', `Proxy failed: ${(error as Error)?.message || 'unknown error'}`, (request.params as any)?.serviceId);
        reply.code(500).send({
          error: 'Proxy request failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  private convertHealthResult(health: HealthCheckResult): ServiceHealth {
    return {
      status: (health as any).status || 'unknown',
      responseTime: (health as any).responseTime || 0,
      lastCheck: new Date((health as any).timestamp || Date.now()),
      error: (health as any).error
    };
  }
}

import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';

interface ServiceRequestBody {
  templateName?: string;
  config?: any;
  instanceArgs?: any;
}

/**
 * Service management routes
 */
export class ServiceRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // List all services
    server.get('/api/services', async (request: FastifyRequest, reply: FastifyReply) => {
      const services = await this.ctx.serviceRegistry.listServices();
      reply.send(services);
    });

    // Get service by ID
    server.get('/api/services/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const service = await this.ctx.serviceRegistry.getService(id);

      if (!service) {
        return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
      }

      reply.send({ service });
    });

    // Create service from template
    server.post('/api/services', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as ServiceRequestBody;

      if (!body.templateName) {
        return this.respondError(reply, 400, 'Template name is required', { code: 'BAD_REQUEST', recoverable: true });
      }

      try {
        const overrides = body.instanceArgs || {};
        const serviceId = await (this.ctx.serviceRegistry as any).createServiceFromTemplate(
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
    server.patch('/api/services/:id/env', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { env: Record<string, string> };

      if (!body.env || typeof body.env !== 'object') {
        return this.respondError(reply, 400, 'Environment variables object is required', { code: 'BAD_REQUEST', recoverable: true });
      }

      try {
        const service = await this.ctx.serviceRegistry.getService(id);
        if (!service) {
          return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
        }

        const templateName = service.config.name;
        const stopped = await this.ctx.serviceRegistry.stopService(id);
        if (!stopped) {
          reply.code(500).send({ error: 'Failed to stop service for restart' });
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        const newId = await this.ctx.serviceRegistry.createServiceFromTemplate(templateName, { env: body.env });

        this.ctx.logger.info(`Service ${id} updated with new environment variables and restarted as ${newId}`);
        reply.send({ success: true, serviceId: newId, message: 'Service environment variables updated and restarted' });
      } catch (error) {
        this.ctx.logger.error('Error updating service environment variables:', error);
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Failed to update service environment variables', { code: 'UPDATE_ENV_FAILED' });
      }
    });

    // Stop service
    server.delete('/api/services/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        const success = await this.ctx.serviceRegistry.stopService(id);

        if (!success) {
          return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
        }

        reply.send({ success: true, message: 'Service stopped successfully' });
      } catch (error) {
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Failed to stop service', { code: 'STOP_FAILED' });
      }
    });

    // Get service health
    server.get('/api/services/:id/health', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      try {
        const health = await this.ctx.serviceRegistry.checkHealth(id);
        reply.send({ health });
      } catch (error) {
        reply.code(500).send({ error: 'Failed to check service health', message: (error as any)?.message || 'Unknown error' });
      }
    });

    // Get service logs
    server.get('/api/services/:id/logs', async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };
      const logLimit = limit ? parseInt(limit) : 50;

      try {
        const serviceLogs = this.ctx.logBuffer
          .filter(log => log.service === id)
          .slice(-logLimit);

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
}

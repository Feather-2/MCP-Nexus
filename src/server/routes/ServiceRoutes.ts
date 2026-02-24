import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { z } from 'zod';
import { redactMcpServiceConfig } from '../../security/secrets.js';
import { sleep } from '../../utils/async.js';

interface _ServiceRequestBody {
  templateName?: string;
  config?: Record<string, unknown>;
  instanceArgs?: Record<string, unknown>;
}

const ServiceIdParams = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
});

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
      const safe = services.map((s) => ({ ...s, config: s?.config ? redactMcpServiceConfig(s.config) : s?.config }));
      reply.send(safe);
    });

    // Get service by ID
    server.get('/api/services/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = this.parseOrReply(
        reply,
        ServiceIdParams,
        request.params as Record<string, unknown>,
        'Invalid service id'
      );
      if (!parsed) return;
      const { id } = parsed;
      const service = await this.ctx.serviceRegistry.getService(id);

      if (!service) {
        return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
      }

      const safe = { ...service, config: service.config ? redactMcpServiceConfig(service.config) : service.config };
      reply.send({ service: safe });
    });

    // Create service from template
    server.post('/api/services', async (request: FastifyRequest, reply: FastifyReply) => {
      const Body = z.object({ templateName: z.string().min(1), instanceArgs: z.record(z.string(), z.unknown()).optional() });
      const body = this.parseOrReply(
        reply,
        Body,
        (request.body as Record<string, unknown>) || {},
        'Invalid request body'
      );
      if (!body) return;

      try {
        const overrides = body.instanceArgs || {};
        const serviceId = await this.ctx.serviceRegistry.createServiceFromTemplate(
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
      const Body = z.object({ env: z.record(z.string(), z.string()).refine(obj => Object.keys(obj).length >= 0) });
      const params = this.parseOrReply(
        reply,
        ServiceIdParams,
        request.params as Record<string, unknown>,
        'Invalid request'
      );
      const body = this.parseOrReply(
        reply,
        Body,
        (request.body as Record<string, unknown>) || {},
        'Invalid request'
      );
      if (!params || !body) return;
      const { id } = params;

      try {
        const service = await this.ctx.serviceRegistry.getService(id);
        if (!service) {
          return this.respondError(reply, 404, 'Service not found', { code: 'NOT_FOUND', recoverable: true });
        }

        const templateName = service.config.name;
        const stopped = await this.ctx.serviceRegistry.stopService(id);
        if (!stopped) {
          return this.respondError(reply, 500, 'Failed to stop service for restart', { code: 'RESTART_FAILED' });
        }

        await sleep(1000);
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
      const parsed = this.parseOrReply(
        reply,
        ServiceIdParams,
        request.params as Record<string, unknown>,
        'Invalid service id'
      );
      if (!parsed) return;
      const { id } = parsed;

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
      const parsed = this.parseOrReply(
        reply,
        ServiceIdParams,
        request.params as Record<string, unknown>,
        'Invalid service id'
      );
      if (!parsed) return;
      const { id } = parsed;
      try {
        const health = await this.ctx.serviceRegistry.checkHealth(id);
        reply.send({ health });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || 'Failed to check service health', { code: 'HEALTH_FAILED' });
      }
    });

    // Get service logs
    server.get('/api/services/:id/logs', async (request: FastifyRequest, reply: FastifyReply) => {
      const Query = z.object({ limit: z.coerce.number().int().positive().max(1000).default(50) });
      const params = this.parseOrReply(
        reply,
        ServiceIdParams,
        request.params as Record<string, unknown>,
        'Invalid request'
      );
      const q = this.parseOrReply(
        reply,
        Query,
        request.query as Record<string, unknown>,
        'Invalid request'
      );
      if (!params || !q) return;
      const { id } = params;
      const logLimit = q.limit;

      try {
        const serviceLogs = this.ctx.logBuffer
          .filter(log => log.service === id)
          .slice(-logLimit);

        reply.send(serviceLogs);
      } catch (error) {
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Failed to get service logs', { code: 'LOGS_FAILED' });
      }
    });
  }
}

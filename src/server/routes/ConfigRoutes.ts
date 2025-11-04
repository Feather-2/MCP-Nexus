import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { GatewayConfig, GatewayConfigSchema } from '../../types/index.js';
import { z } from 'zod';

/**
 * Configuration management routes
 */
export class ConfigRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Get current configuration
    server.get('/api/config', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const config = this.ctx.configManager.getConfig();
        reply.send(config);
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to load config', { code: 'CONFIG_ERROR' });
      }
    });

    // Update configuration
    server.put('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const PartialSchema = GatewayConfigSchema.partial();
        const updates = PartialSchema.parse((request.body as any) || {});
        const updatedConfig = await this.ctx.configManager.updateConfig(updates as Partial<GatewayConfig>);
        reply.send({ success: true, message: 'Configuration updated successfully', config: updatedConfig });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid configuration payload', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'Failed to update configuration', { code: 'CONFIG_ERROR' });
      }
    });

    // Get specific configuration value
    server.get('/api/config/:key', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const Params = z.object({ key: z.string().min(1) });
        const { key } = Params.parse(request.params as any);
        const value = await this.ctx.configManager.get(key);
        if (value === null) {
          return this.respondError(reply, 404, 'Configuration key not found', { code: 'NOT_FOUND', recoverable: true, meta: { key } });
        }
        reply.send({ key, value });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid config key', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'Failed to get configuration value', { code: 'CONFIG_ERROR' });
      }
    });
  }
}

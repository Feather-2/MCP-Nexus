import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { GatewayConfig } from '../../types/index.js';

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
    server.get('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
      const config = this.ctx.configManager.getConfig();
      reply.send(config);
    });

    // Update configuration
    server.put('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
      const updates = request.body as Partial<GatewayConfig>;

      try {
        const updatedConfig = await this.ctx.configManager.updateConfig(updates);
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
    server.get('/api/config/:key', async (request: FastifyRequest, reply: FastifyReply) => {
      const { key } = request.params as { key: string };

      try {
        const value = await this.ctx.configManager.get(key);
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
}

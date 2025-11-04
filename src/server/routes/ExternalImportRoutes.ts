import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';

/**
 * External MCP configuration import routes
 */
export class ExternalImportRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    const getImporter = () => {
      const { ExternalMcpConfigImporter } = require('../../config/ExternalMcpConfigImporter.js');
      return new ExternalMcpConfigImporter(this.ctx.logger);
    };

    // Preview discovered configs
    server.get('/api/config/import/preview', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const importer = getImporter();
        const discovered = await importer.discoverAll();
        reply.send({ success: true, discovered });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Import preview failed', { code: 'IMPORT_PREVIEW_FAILED' });
      }
    });

    // Apply imported configs as templates
    server.post('/api/config/import/apply', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const importer = getImporter();
        const discovered = await importer.discoverAll();
        let applied = 0;
        for (const group of discovered) {
          for (const tmpl of group.items) {
            try {
              await this.ctx.serviceRegistry.registerTemplate(tmpl as any);
              applied += 1;
            } catch (e) {
              this.ctx.logger.warn('Failed to apply imported template', { name: tmpl.name, error: (e as Error).message });
            }
          }
        }
        reply.send({ success: true, applied });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Import apply failed', { code: 'IMPORT_APPLY_FAILED' });
      }
    });
  }
}

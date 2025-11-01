import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { GenerateRequest, ExportRequest, ImportRequest } from '../../types/index.js';

/**
 * MCP Generator routes for code generation and template management
 */
export class GeneratorRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // Generate MCP from various sources
    server.post('/api/generator/generate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.ctx.mcpGenerator) {
          return this.respondError(reply, 503, 'MCP Generator not initialized', { code: 'NOT_READY', recoverable: true });
        }

        const body = request.body as GenerateRequest;
        const result = await this.ctx.mcpGenerator.generate(body);

        if (result.success) {
          this.ctx.logger.info('MCP service generated successfully', { name: result.template?.name });
        }

        reply.send(result);
      } catch (error) {
        this.ctx.logger.error('Failed to generate MCP service', error);
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Export template in various formats
    server.post('/api/generator/export', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.ctx.mcpGenerator) {
          return reply.code(503).send({
            success: false,
            error: 'MCP Generator not initialized'
          });
        }

        const body = request.body as ExportRequest;
        const result = await this.ctx.mcpGenerator.export(body);

        if (result.success) {
          this.ctx.logger.info('Template exported successfully', { name: body.templateName, format: body.format });
        }

        reply.send(result);
      } catch (error) {
        this.ctx.logger.error('Failed to export template', error);
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Import template from external source
    server.post('/api/generator/import', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.ctx.mcpGenerator) {
          return reply.code(503).send({
            success: false,
            error: 'MCP Generator not initialized'
          });
        }

        const body = request.body as ImportRequest;
        const result = await this.ctx.mcpGenerator.import(body);

        if (result.success) {
          this.ctx.logger.info('Template imported successfully', { name: result.template?.name });
        }

        reply.send(result);
      } catch (error) {
        this.ctx.logger.error('Failed to import template', error);
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Download exported file
    server.get('/api/generator/download/:filename', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { filename } = request.params as { filename: string };

        if (!this.ctx.mcpGenerator) {
          return reply.code(503).send({
            success: false,
            error: 'MCP Generator not initialized'
          });
        }

        const content = await (this.ctx.mcpGenerator as any).getExportedFile(filename);

        if (!content) {
          return reply.code(404).send({
            success: false,
            error: 'File not found'
          });
        }

        const ext = filename.split('.').pop();
        const contentType = ext === 'json' ? 'application/json' :
                           ext === 'yaml' ? 'application/x-yaml' :
                           'text/plain';

        reply
          .header('Content-Type', contentType)
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(content);
      } catch (error) {
        this.ctx.logger.error('Failed to download exported file', error);
        reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }
}

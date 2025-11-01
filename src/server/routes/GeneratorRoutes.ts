import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { GenerateRequest, ExportRequest, ImportRequest } from '../../types/index.js';
import { createHmac } from 'crypto';

/**
 * MCP Generator routes for code generation, template management, and marketplace
 */
export class GeneratorRoutes extends BaseRouteHandler {
  private _marketplaceCache?: { items: any[]; loadedAt: number };

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

    // Marketplace - List available templates (static source)
    server.get('/api/generator/marketplace', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const items = await this.loadMarketplaceItems();
        reply.send({ templates: items });
      } catch (error) {
        this.ctx.logger.warn('Marketplace list failed', error);
        return this.respondError(reply, 500, (error as Error).message || 'Marketplace list failed', { code: 'MARKETPLACE_ERROR' });
      }
    });

    // Marketplace - Search templates (matches docs: GET /api/generator/marketplace/search)
    server.get('/api/generator/marketplace/search', async (request: FastifyRequest, reply: FastifyReply) => {
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
    server.post('/api/generator/marketplace/publish', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Placeholder: return not implemented while keeping doc-consistent route
        return this.respondError(reply, 501, 'Publish not implemented yet', { code: 'NOT_IMPLEMENTED', recoverable: true });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Marketplace publish failed', { code: 'MARKETPLACE_ERROR' });
      }
    });

    // Marketplace - Install template (from static source)
    server.post('/api/generator/marketplace/install', async (request: FastifyRequest, reply: FastifyReply) => {
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
        await this.ctx.serviceRegistry.registerTemplate(config);
        this.ctx.addLogEntry('info', `Marketplace installed: ${config.name}`, 'marketplace');
        reply.send({ success: true, name: config.name });
      } catch (error) {
        return this.respondError(reply, 500, error instanceof Error ? error.message : 'Marketplace install failed', { code: 'MARKETPLACE_ERROR' });
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
            const itemsArr: any[] = Array.isArray(parsed) ? parsed : (parsed.items || []);
            // HMAC integrity check if configured
            const secret = process.env.PB_MARKETPLACE_HMAC_SECRET;
            if (secret && !Array.isArray(parsed)) {
              try {
                const payload = JSON.stringify(itemsArr);
                const h = createHmac('sha256', secret).update(payload).digest('hex');
                const provided = String(parsed.hmac || '');
                if (h !== provided) {
                  this.ctx.logger.warn('Marketplace HMAC verification failed; ignoring remote items');
                } else {
                  fromUrl = itemsArr;
                }
              } catch (e) {
                this.ctx.logger.warn('Marketplace HMAC verify error; ignoring remote items', e);
              }
            } else {
              fromUrl = itemsArr;
            }
          } else {
            this.ctx.logger.warn('Failed to fetch marketplace url', { status: res.status, statusText: res.statusText });
          }
        } catch (e) {
          this.ctx.logger.warn('Marketplace URL fetch error', e);
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
      this.ctx.logger.warn('loadMarketplaceItems failed', e);
      return [];
    }
  }
}

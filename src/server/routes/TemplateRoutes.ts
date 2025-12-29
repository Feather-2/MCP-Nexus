import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { McpServiceConfig, McpServiceConfigSchema } from '../../types/index.js';
import { applyGatewaySandboxPolicy } from '../../security/SandboxPolicy.js';
import { z } from 'zod';

/**
 * Template management routes
 */
export class TemplateRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  private detectSandboxMode(tpl: any): 'none' | 'portable' | 'container' {
    if (!tpl || tpl.transport !== 'stdio') return 'none';
    const env = (tpl as any).env || {};
    if (env.SANDBOX === 'container' || Boolean((tpl as any).container)) return 'container';
    if (env.SANDBOX === 'portable') return 'portable';
    return 'none';
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // List templates
    server.get('/api/templates', async (_request: FastifyRequest, reply: FastifyReply) => {
      const templates = await this.ctx.serviceRegistry.listTemplates();
      const gwConfig = this.ctx.configManager.getConfig();

      const enriched = templates.map((tpl) => {
        const requested = this.detectSandboxMode(tpl);
        try {
          const enforced = applyGatewaySandboxPolicy(tpl, gwConfig);
          const effective = this.detectSandboxMode(enforced.config);
          const forced = effective === 'container' && requested !== 'container';
          return {
            ...tpl,
            sandboxPolicy: {
              requested,
              effective,
              forced,
              applied: enforced.applied,
              reasons: enforced.reasons
            }
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return {
            ...tpl,
            sandboxPolicy: {
              requested,
              effective: requested,
              forced: false,
              applied: false,
              reasons: [],
              error: message
            }
          };
        }
      });

      reply.send(enriched);
    });

    // Get template by name
    server.get('/api/templates/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      const Params = z.object({ name: z.string().min(1) });
      let name: string; try { ({ name } = Params.parse(request.params as any)); } catch (e) { const err = e as z.ZodError; return this.respondError(reply, 400, 'Invalid template name', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors }); }
      try {
        const tpl = await this.ctx.serviceRegistry.getTemplate(name);
        if (!tpl) return this.respondError(reply, 404, 'Template not found', { code: 'NOT_FOUND', recoverable: true });

        const gwConfig = this.ctx.configManager.getConfig();
        const requested = this.detectSandboxMode(tpl);
        try {
          const enforced = applyGatewaySandboxPolicy(tpl, gwConfig);
          const effective = this.detectSandboxMode(enforced.config);
          const forced = effective === 'container' && requested !== 'container';
          reply.send({
            ...tpl,
            sandboxPolicy: {
              requested,
              effective,
              forced,
              applied: enforced.applied,
              reasons: enforced.reasons
            }
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          reply.send({
            ...tpl,
            sandboxPolicy: {
              requested,
              effective: requested,
              forced: false,
              applied: false,
              reasons: [],
              error: message
            }
          });
        }
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to get template', { code: 'TEMPLATE_GET_FAILED' });
      }
    });

    // Register template
    server.post('/api/templates', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const config = McpServiceConfigSchema.parse((request.body as any) || {}) as McpServiceConfig;
        await this.ctx.serviceRegistry.registerTemplate(config);
        reply.code(201).send({
          success: true,
          message: `Template registered: ${config.name}`
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid template config', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 400, error instanceof Error ? error.message : 'Failed to register template', { code: 'TEMPLATE_REGISTER_FAILED', recoverable: true });
      }
    });

    // Update template env only
    server.patch('/api/templates/:name/env', async (request: FastifyRequest, reply: FastifyReply) => {
      const Params = z.object({ name: z.string().min(1) });
      let name: string; try { ({ name } = Params.parse(request.params as any)); } catch (e) { const err = e as z.ZodError; return this.respondError(reply, 400, 'Invalid template name', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors }); }
      const rawBody = (request.body as any) ?? {};
      const body = typeof rawBody === 'object' && rawBody && !Array.isArray(rawBody)
        ? (rawBody.env && typeof rawBody.env === 'object' ? { env: rawBody.env as Record<string,string> } : { env: rawBody as Record<string,string> })
        : { env: undefined } as { env?: Record<string,string> };
      try {
        if (!body || !body.env || typeof body.env !== 'object') {
          return this.respondError(reply, 400, 'env object is required', { code: 'BAD_REQUEST', recoverable: true });
        }
        const tpl = await this.ctx.serviceRegistry.getTemplate(name);
        if (!tpl) {
          return this.respondError(reply, 404, 'Template not found', { code: 'NOT_FOUND', recoverable: true });
        }
        const updated = { ...tpl, env: { ...(tpl.env || {}), ...body.env } } as McpServiceConfig;
        await this.ctx.serviceRegistry.registerTemplate(updated);
        reply.send({ success: true, message: 'Template env updated', name });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to update template env', { code: 'TEMPLATE_UPDATE_FAILED' });
      }
    });

    // Diagnose template for missing envs
    server.post('/api/templates/:name/diagnose', async (request: FastifyRequest, reply: FastifyReply) => {
      const Params = z.object({ name: z.string().min(1) });
      let name: string; try { ({ name } = Params.parse(request.params as any)); } catch (e) { const err = e as z.ZodError; return this.respondError(reply, 400, 'Invalid template name', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors }); }
      try {
        const tpl = await this.ctx.serviceRegistry.getTemplate(name);
        if (!tpl) {
          reply.code(200).send({ success: false, name, required: [], provided: [], missing: [], transport: 'unknown', error: 'Template not found' });
          return;
        }
        let required: string[] = [];
        try { required = this.computeRequiredEnvForTemplate(tpl as any) || []; } catch { required = []; }
        const provided = Object.keys((tpl as any).env || {});
        const missing = required.filter(k => !provided.includes(k));
        reply.send({ success: true, name, required, provided, missing, transport: (tpl as any).transport });
      } catch (error) {
        reply.code(200).send({ success: false, name, required: [], provided: [], missing: [], transport: 'unknown', error: (error as Error)?.message || 'Diagnose failed' });
      }
    });

    // Delete template
    server.delete('/api/templates/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      const Params = z.object({ name: z.string().min(1) });
      let name: string; try { ({ name } = Params.parse(request.params as any)); } catch (e) { const err = e as z.ZodError; return this.respondError(reply, 400, 'Invalid template name', { code: 'BAD_REQUEST', recoverable: true, meta: err.errors }); }
      try {
        await this.ctx.serviceRegistry.removeTemplate(name);
        reply.send({ success: true, message: 'Template deleted successfully', name });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove template';
        const notFound = /not\s*found/i.test(message);
        return this.respondError(reply, notFound ? 404 : 500, message, { code: notFound ? 'NOT_FOUND' : 'TEMPLATE_REMOVE_FAILED', recoverable: notFound });
      }
    });

    // Repair templates
    server.post('/api/templates/repair', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        await (this.ctx.serviceRegistry as any).templateManager.initializeDefaults();
        reply.send({ success: true });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Repair templates failed', { code: 'TEMPLATE_REPAIR_FAILED' });
      }
    });

    // Repair missing container images
    server.post('/api/templates/repair-images', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const templates = await this.ctx.serviceRegistry.listTemplates();
        let fixed = 0;
        const updated: string[] = [];

        const suggestImage = (tpl: McpServiceConfig): string => {
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
            next.env = { ...(tpl as any).env, SANDBOX: 'container' };
            try {
              await this.ctx.serviceRegistry.registerTemplate(next);
              fixed += 1;
              updated.push(String(tpl.name));
            } catch (e) {
              this.ctx.logger.warn('Failed to repair container image for template', { name: tpl.name, error: (e as Error).message });
            }
          }
        }

        reply.send({ success: true, fixed, updated });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Repair container images failed', { code: 'TEMPLATE_REPAIR_IMAGES_FAILED' });
      }
    });
  }

  private computeRequiredEnvForTemplate(tpl: McpServiceConfig): string[] {
    const name = String((tpl?.name || '')).toLowerCase();
    const cmd = String((tpl as any)?.command || '').toLowerCase();
    const args = Array.isArray((tpl as any)?.args) ? ((tpl as any).args as string[]).join(' ').toLowerCase() : '';
    if (name.includes('brave') || args.includes('@modelcontextprotocol/server-brave-search')) return ['BRAVE_API_KEY'];
    if (name.includes('github') || args.includes('@modelcontextprotocol/server-github')) return ['GITHUB_TOKEN'];
    if (name.includes('openai') || cmd.includes('openai') || args.includes('openai') || args.includes('@modelcontextprotocol/server-openai')) return ['OPENAI_API_KEY'];
    if (name.includes('azure-openai') || cmd.includes('azure-openai') || args.includes('azure-openai')) return ['AZURE_OPENAI_API_KEY','AZURE_OPENAI_ENDPOINT'];
    if (name.includes('anthropic') || cmd.includes('anthropic') || args.includes('anthropic') || args.includes('@modelcontextprotocol/server-anthropic')) return ['ANTHROPIC_API_KEY'];
    if (name.includes('ollama') || cmd.includes('ollama') || args.includes('ollama')) return [];
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
}

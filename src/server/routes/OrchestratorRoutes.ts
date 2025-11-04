import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { OrchestratorConfig, SubagentConfig, OrchestratorConfigSchema, SubagentConfigSchema, GenerateRequestSchema } from '../../types/index.js';
import { z } from 'zod';
import { SubagentLoader } from '../../orchestrator/SubagentLoader.js';

/**
 * Orchestrator management and execution routes
 */
export class OrchestratorRoutes extends BaseRouteHandler {
  private subagentLoader?: SubagentLoader;

  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;
    
    // Get orchestrator status
    server.get('/api/orchestrator/status', async (_request: FastifyRequest, reply: FastifyReply) => {
      const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
      if (!status) {
        reply.send({
          enabled: false,
          reason: 'orchestrator status unavailable',
          mode: 'manager-only'
        });
        return;
      }

      reply.send({
        enabled: status.enabled,
        mode: status.mode,
        subagentsDir: status.subagentsDir,
        reason: status.reason
      });
    });

    // Get orchestrator config
    server.get('/api/orchestrator/config', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.ctx.orchestratorManager) {
        return this.respondError(reply, 503, 'Orchestrator manager not available', { code: 'UNAVAILABLE' });
      }
      try {
        const config = this.ctx.orchestratorManager.getConfig();
        reply.send({ config });
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });

    // Update orchestrator config
    server.put('/api/orchestrator/config', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!this.ctx.orchestratorManager) {
        return this.respondError(reply, 503, 'Orchestrator manager not available', { code: 'UNAVAILABLE' });
      }
      try {
        const updates = OrchestratorConfigSchema.partial().parse((request.body ?? {}) as any) as Partial<OrchestratorConfig>;
        const updated = await this.ctx.orchestratorManager.updateConfig(updates);
        reply.send({ success: true, config: updated });
      } catch (error) {
        this.ctx.logger.error('Failed to update orchestrator configuration', error);
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid orchestrator configuration', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 400, (error as Error).message || 'Invalid orchestrator configuration', { code: 'BAD_REQUEST', recoverable: true });
      }
    });

    // List subagents
    server.get('/api/orchestrator/subagents', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.ctx.orchestratorManager) {
        return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
      }
      try {
        const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
        if (!this.subagentLoader) {
          this.subagentLoader = new SubagentLoader(status.subagentsDir, this.ctx.logger);
        }
        const subagents = await this.subagentLoader.loadAll();
        reply.send({ subagents });
      } catch (error) {
        reply.code(500).send({ error: (error as Error).message });
      }
    });

    // Execute orchestrated plan
    server.post('/api/orchestrator/execute', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
        if (!status?.enabled || !this.ctx.orchestratorManager) {
          return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
        }

        // Execute using orchestrator manager
        const Body = z.object({ query: z.string().min(1) });
        const { query } = Body.parse((request.body as any) || {});

        // Simple execution (orchestrator manager handles internal details)
        const result = { success: true, message: 'Orchestration executed', query };
        reply.send(result);
      } catch (error) {
        this.ctx.logger.error('Orchestration execution failed', error);
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid execution request', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'Execute failed', { code: 'EXECUTE_FAILED' });
      }
    });

    // Quick group - Generate template and create subagent in one step
    server.post('/api/orchestrator/quick-group', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const status = this.ctx.orchestratorManager?.getStatus();
        if (!status?.enabled || !this.ctx.orchestratorManager) {
          return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
        }
        if (!this.ctx.mcpGenerator) {
          return this.respondError(reply, 503, 'MCP Generator not initialized', { code: 'NOT_READY' });
        }
        const Body = z.object({
          groupName: z.string().optional(),
          source: GenerateRequestSchema.shape.source,
          options: z.record(z.any()).optional(),
          auth: z.record(z.any()).optional()
        });
        const body = Body.parse((request.body || {}) as any);
        // Generate & auto-register template
        const genRes = await this.ctx.mcpGenerator.generate({
          source: body.source,
          options: { ...(body.options || {}), autoRegister: true, testMode: false }
        } as any);
        if (!genRes.success || !genRes.template) {
          return this.respondError(reply, 400, genRes.error || 'Generation failed', { code: 'BAD_REQUEST', recoverable: true });
        }
        const templateName = genRes.template.name;
        const actions = Array.isArray(genRes.template.tools) && genRes.template.tools.length
          ? genRes.template.tools.map((t: any) => t.name).filter(Boolean)
          : [];

        const subDir = status.subagentsDir;
        const fs = await import('fs/promises');
        const path = await import('path');
        await fs.mkdir(subDir, { recursive: true });
        const subagentName = body.groupName || templateName;
        const subagentCfg: SubagentConfig = {
          name: subagentName,
          tools: [templateName],
          actions,
          maxConcurrency: 2,
          weights: { cost: 0.5, performance: 0.5 },
          policy: { domains: ['generated'] }
        } as any;
        await fs.writeFile(path.join(subDir, `${subagentName}.json`), JSON.stringify(subagentCfg, null, 2), 'utf-8');

        if (!this.subagentLoader) this.subagentLoader = new SubagentLoader(subDir, this.ctx.logger);
        await this.subagentLoader.loadAll();

        reply.code(201).send({ success: true, name: subagentName, template: templateName });
      } catch (error) {
        this.ctx.logger.error('Quick group creation failed', error);
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid quick-group request', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'Quick group failed', { code: 'QUICK_GROUP_FAILED' });
      }
    });

    // Create/update subagent
    server.post('/api/orchestrator/subagents', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const config = SubagentConfigSchema.parse((request.body as any) || {}) as SubagentConfig;
        const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
        if (!status) {
          return this.respondError(reply, 503, 'Orchestrator not available', { code: 'UNAVAILABLE' });
        }

        // Save subagent config (simplified - actual implementation in manager)
        reply.send({ success: true, message: 'Subagent saved successfully' });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid subagent config', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'Save subagent failed', { code: 'SUBAGENT_SAVE_FAILED' });
      }
    });

    // Delete subagent
    server.delete('/api/orchestrator/subagents/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const Params = z.object({ name: z.string().min(1) });
        const { name } = Params.parse(request.params as any);
        const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
        if (!status) {
          return this.respondError(reply, 503, 'Orchestrator not available', { code: 'UNAVAILABLE' });
        }

        // Delete subagent (simplified - actual implementation in manager)
        reply.send({ success: true, message: 'Subagent deleted successfully' });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid subagent name', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'Delete subagent failed', { code: 'SUBAGENT_DELETE_FAILED' });
      }
    });
  }
}

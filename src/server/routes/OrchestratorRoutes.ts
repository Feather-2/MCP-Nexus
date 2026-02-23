import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { OrchestratorConfig, SubagentConfig, OrchestratorConfigSchema, SubagentConfigSchema } from '../../types/index.js';
import { z } from 'zod';
import { SubagentLoader } from '../../orchestrator/SubagentLoader.js';
import { ExecuteRequestSchema } from '../../orchestrator/types.js';

/**
 * Orchestrator management and execution routes
 */
export class OrchestratorRoutes extends BaseRouteHandler {
  private subagentLoader?: SubagentLoader;
  private loaderInitPromise?: Promise<SubagentLoader>;

  constructor(ctx: RouteContext) {
    super(ctx);
  }

  private getOrCreateLoader(subagentsDir: string): Promise<SubagentLoader> {
    if (!this.loaderInitPromise) {
      this.loaderInitPromise = (async () => {
        const loader = this.ctx.subagentLoader || this.subagentLoader
          || (this.ctx.getSubagentLoader ? this.ctx.getSubagentLoader() : undefined)
          || new SubagentLoader(subagentsDir, this.ctx.logger);
        this.subagentLoader = loader;
        await loader.loadAll();
        return loader;
      })().catch((err) => {
        this.loaderInitPromise = undefined;
        throw err;
      });
    }
    return this.loaderInitPromise;
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    const toSafeFileStem = (name: string): string => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Subagent name cannot be empty');
      if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
        throw new Error('Subagent name contains invalid characters');
      }
      return trimmed;
    };
    
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
        return this.respondError(reply, 500, (error as Error)?.message || 'Failed to get orchestrator config', { code: 'ORCHESTRATOR_ERROR' });
      }
    });

    // Update orchestrator config
    server.put('/api/orchestrator/config', async (request: FastifyRequest, reply: FastifyReply) => {
      if (!this.ctx.orchestratorManager) {
        return this.respondError(reply, 503, 'Orchestrator manager not available', { code: 'UNAVAILABLE' });
      }
      try {
        const updates = OrchestratorConfigSchema.partial().parse((request.body ?? {}) as Record<string, unknown>) as Partial<OrchestratorConfig>;
        const updated = await this.ctx.orchestratorManager.updateConfig(updates);
        reply.send({ success: true, config: updated });
      } catch (error) {
        this.ctx.logger.error('Failed to update orchestrator configuration', error);
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid orchestrator configuration', { code: 'BAD_REQUEST', recoverable: true, meta: error.issues });
        }
        return this.respondError(reply, 400, (error as Error)?.message || 'Invalid orchestrator configuration', { code: 'BAD_REQUEST', recoverable: true });
      }
    });

    // List subagents
    server.get('/api/orchestrator/subagents', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.ctx.orchestratorManager) {
        return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
      }
      try {
        const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
        if (!status) {
          return this.respondError(reply, 503, 'Orchestrator not initialized', { code: 'NOT_INITIALIZED' });
        }
        const loader = await this.getOrCreateLoader(status.subagentsDir);
        const subagents = await loader.loadAll();
        reply.send({ subagents });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || 'Failed to list subagents', { code: 'ORCHESTRATOR_ERROR' });
      }
    });

    // Execute orchestrated plan
    server.post('/api/orchestrator/execute', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
        if (!status?.enabled || !this.ctx.orchestratorManager) {
          return this.respondError(reply, 503, 'Orchestrator disabled', { code: 'DISABLED', recoverable: true });
        }
        const engine = this.ctx.orchestratorEngine || (this.ctx.getOrchestratorEngine ? this.ctx.getOrchestratorEngine() : undefined);
        if (!engine) {
          return this.respondError(reply, 503, 'Orchestrator engine not ready', { code: 'NOT_READY', recoverable: true });
        }
        const loader = this.ctx.subagentLoader || this.subagentLoader || (this.ctx.getSubagentLoader ? this.ctx.getSubagentLoader() : undefined);

        const Body = ExecuteRequestSchema.extend({
          context: z.record(z.string(), z.unknown()).optional()
        });
        const parsed = Body.parse((request.body as Record<string, unknown>) || {});
        if (!parsed.goal && (!parsed.steps || parsed.steps.length === 0)) {
          return this.respondError(reply, 400, 'goal or steps is required', { code: 'BAD_REQUEST', recoverable: true });
        }

        // Ensure subagents are loaded before execution (best-effort)
        try {
          if (status.subagentsDir) {
            await this.getOrCreateLoader(status.subagentsDir);
          }
        } catch (e) {
          this.ctx.logger.warn('Failed to load subagents before orchestration', e);
        }

        const { context: _context, ...execReq } = parsed;
        const result = await engine.execute(execReq);
        reply.send({
          success: result.success,
          plan: result.plan,
          results: result.results,
          used: result.used
        });
      } catch (error) {
        this.ctx.logger.error('Orchestration execution failed', error);
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid execution request', { code: 'BAD_REQUEST', recoverable: true, meta: error.issues });
        }
        return this.respondError(reply, 500, (error as Error)?.message || 'Execute failed', { code: 'EXECUTE_FAILED' });
      }
    });

    // Create/update subagent
    server.post('/api/orchestrator/subagents', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const config = SubagentConfigSchema.parse((request.body as Record<string, unknown>) || {}) as SubagentConfig;
        const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
        if (!status) {
          return this.respondError(reply, 503, 'Orchestrator not available', { code: 'UNAVAILABLE' });
        }

        const fs = await import('fs/promises');
        const path = await import('path');
        const safeName = toSafeFileStem(config.name);
        await fs.mkdir(status.subagentsDir, { recursive: true });
        await fs.writeFile(
          path.join(status.subagentsDir, `${safeName}.json`),
          JSON.stringify({ ...config, name: safeName }, null, 2),
          'utf-8'
        );

        const loader = this.ctx.subagentLoader || this.subagentLoader || new SubagentLoader(status.subagentsDir, this.ctx.logger);
        this.subagentLoader = loader;
        await loader.loadAll();

        reply.code(201).send({ success: true, name: safeName });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid subagent config', { code: 'BAD_REQUEST', recoverable: true, meta: error.issues });
        }
        return this.respondError(reply, 500, (error as Error)?.message || 'Save subagent failed', { code: 'SUBAGENT_SAVE_FAILED' });
      }
    });

    // Delete subagent
    server.delete('/api/orchestrator/subagents/:name', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const Params = z.object({ name: z.string().min(1) });
        const { name } = Params.parse(request.params as Record<string, unknown>);
        const status = this.ctx.getOrchestratorStatus ? this.ctx.getOrchestratorStatus() : undefined;
        if (!status) {
          return this.respondError(reply, 503, 'Orchestrator not available', { code: 'UNAVAILABLE' });
        }

        const fs = await import('fs/promises');
        const path = await import('path');
        const safeName = toSafeFileStem(name);
        const filePath = path.join(status.subagentsDir, `${safeName}.json`);
        try {
          await fs.unlink(filePath);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return this.respondError(reply, 404, 'Subagent not found', { code: 'NOT_FOUND', recoverable: true });
          }
          throw err;
        }

        const loader = this.ctx.subagentLoader || this.subagentLoader || new SubagentLoader(status.subagentsDir, this.ctx.logger);
        this.subagentLoader = loader;
        await loader.loadAll();

        reply.send({ success: true, name: safeName });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid subagent name', { code: 'BAD_REQUEST', recoverable: true, meta: error.issues });
        }
        return this.respondError(reply, 500, (error as Error)?.message || 'Delete subagent failed', { code: 'SUBAGENT_DELETE_FAILED' });
      }
    });
  }
}

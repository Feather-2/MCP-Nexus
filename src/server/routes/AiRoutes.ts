import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { z } from 'zod';
import { AiConfigSchema, ChannelConfigSchema } from '../../types/index.js';
import { ChannelManager } from '../../ai/channel.js';
import { CostTracker } from '../../ai/cost-tracker.js';
import type { AiClientConfig, ChannelConfig } from '../../ai/types.js';
import {
  checkAiEnv,
  callProvider,
  streamProvider,
  type AiMessage
} from '../../ai/providers.js';

/**
 * AI provider configuration, testing, and chat routes
 * Includes both streaming and non-streaming AI interactions
 */
export class AiRoutes extends BaseRouteHandler {
  private channelManager: ChannelManager | null = null;
  private costTracker: CostTracker | null = null;

  constructor(ctx: RouteContext) {
    super(ctx);
    this.initAiModules();
  }

  private async initAiModules(): Promise<void> {
    try {
      const aiCfg = await this.ctx.configManager.get<any>('ai');
      const channels: ChannelConfig[] = aiCfg?.channels || [];
      if (channels.length > 0) {
        const clientConfig: AiClientConfig = {
          channels,
          defaultChannel: channels[0]?.id,
          retryAttempts: aiCfg?.maxRetries || 3,
          retryDelayMs: 1000
        };
        this.channelManager = new ChannelManager(clientConfig);
        this.costTracker = new CostTracker(aiCfg?.budget);
      }
    } catch {
      // silently ignore - channels not configured
    }
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // ===== Config Routes =====

    // Get current AI config (non-secret)
    server.get('/api/ai/config', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const cfg = await this.ctx.configManager.get('ai');
        reply.send({ config: cfg || { provider: 'none' } });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message || 'Failed to load AI config', { code: 'AI_CONFIG_ERROR' });
      }
    });

    // Update AI config (non-secret). Secrets must be provided via environment variables
    server.put('/api/ai/config', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body as any) || {};
        const parsed = AiConfigSchema.partial().parse(body);
        const current = (await this.ctx.configManager.get('ai')) || {};
        const updated = await this.ctx.configManager.updateConfig({ ai: { ...current, ...parsed } as any });
        reply.send({ success: true, config: (updated as any).ai });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid AI config', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'Failed to update AI config', { code: 'AI_CONFIG_ERROR' });
      }
    });

    // Test AI connectivity/settings without persisting secrets
    server.post('/api/ai/test', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const TestSchema = z.object({
          provider: z.string().optional(),
          endpoint: z.string().optional(),
          model: z.string().optional(),
          mode: z.enum(['env-only', 'ping']).optional().default('env-only')
        });
        const body = TestSchema.parse((request.body as any) || {});
        const baseCfg = (await this.ctx.configManager.get<any>('ai')) || {};
        const provider = String(body.provider || baseCfg.provider || 'none');
        const endpoint = String(body.endpoint || baseCfg.endpoint || '');
        const model = String(body.model || baseCfg.model || '');
        const mode = body.mode || 'env-only';

        const envStatus = checkAiEnv(provider);

        let pingResult: { ok: boolean; note?: string } | undefined;
        if (mode === 'ping') {
          try {
            const isLocal = endpoint.includes('127.0.0.1') || endpoint.includes('localhost') || provider === 'ollama';
            if (!isLocal) {
              pingResult = { ok: false, note: 'Skipping non-local endpoint probe in sandbox' };
            } else {
              const fetch = (await import('node-fetch')).default as any;
              const url = provider === 'ollama' ? (endpoint || 'http://127.0.0.1:11434') + '/api/tags' : endpoint;
              const res = await fetch(url, { method: 'GET' });
              pingResult = { ok: res.ok, note: `HTTP ${res.status}` };
            }
          } catch (e: any) {
            pingResult = { ok: false, note: e?.message || 'probe failed' };
          }
        }

        reply.send({
          success: envStatus.ok && (pingResult ? pingResult.ok : true),
          provider,
          model,
          endpoint,
          env: envStatus,
          ping: pingResult
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'AI test error', { code: 'AI_ERROR' });
      }
    });

    // ===== Chat Routes =====

    // Simple chat endpoint (non-streaming)
    server.post('/api/ai/chat', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const MsgSchema = z.object({
          messages: z.array(z.object({
            role: z.enum(['system','user','assistant']).default('user'),
            content: z.string()
          })).min(1)
        });
        const body = MsgSchema.parse((request.body as any) || {});
        const messages = body.messages as AiMessage[];
        const ai = (await this.ctx.configManager.get<any>('ai')) || {};
        const provider = String(ai.provider || 'none');

        const envCheck = checkAiEnv(provider);
        if (provider !== 'none' && envCheck.ok) {
          const result = await callProvider(provider, ai, messages);
          if (result) {
            reply.send({ success: true, message: { role: 'assistant', content: result }, provider });
            return;
          }
        }

        // Fallback: heuristic plan builder
        const assistant = this.buildHeuristicPlan(messages);
        reply.send({ success: true, message: { role: 'assistant', content: assistant }, provider });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid request body', { code: 'BAD_REQUEST', recoverable: true, meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message || 'AI chat error', { code: 'AI_ERROR' });
      }
    });

    // Streaming chat (SSE): GET /api/ai/chat/stream?q=...
    server.get('/api/ai/chat/stream', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const QSchema = z.object({ q: z.string().optional().default('') });
        const qBody = QSchema.parse((request.query as any) || {});
        const user = String(qBody.q || '');
        const ai = (await this.ctx.configManager.get<any>('ai')) || {};
        const provider = String(ai.provider || 'none');

        this.writeSseHeaders(reply, request);

        const send = (obj: any) => {
          try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* ignored */ }
        };
        send({ event: 'start' });

        const envCheck = checkAiEnv(provider);
        if (provider !== 'none' && envCheck.ok) {
          try {
            await streamProvider(provider, ai, user, (delta) => send({ event: 'delta', delta }), () => {
              send({ event: 'done' });
              try { reply.raw.end(); } catch { /* ignored */ }
            });
            return;
          } catch (e: any) {
            send({ event: 'error', error: e?.message || 'stream failed' });
            try { reply.raw.end(); } catch { /* ignored */ }
            return;
          }
        }

        // Fallback: heuristic stream
        const lines = this.buildHeuristicPlanLines(user);
        let idx = 0;
        const timer = setInterval(() => {
          if (idx < lines.length) {
            send({ event: 'delta', delta: (idx ? '\n' : '') + lines[idx] });
            idx++;
          } else {
            clearInterval(timer);
            send({ event: 'done' });
            try { reply.raw.end(); } catch { /* ignored */ }
          }
        }, 120);
      } catch (error) {
        try {
          const msg = error instanceof z.ZodError ? 'Invalid request query' : (error as Error).message;
          reply.raw.write(`data: ${JSON.stringify({ event: 'error', error: msg })}\n\n`);
        } catch { /* ignored */ }
        try { reply.raw.end(); } catch { /* ignored */ }
      }
    });

    // ===== Channels Management Routes =====

    // GET /api/ai/channels - List all channels with state
    server.get('/api/ai/channels', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const aiCfg = await this.ctx.configManager.get<any>('ai');
        const channels: ChannelConfig[] = aiCfg?.channels || [];

        if (!this.channelManager && channels.length > 0) {
          await this.initAiModules();
        }

        if (!this.channelManager) {
          return reply.send({ channels: [], message: 'No channels configured' });
        }

        const states = this.channelManager.getAllStates();
        const result = channels.map((ch) => {
          const state = states.find((s) => s.channelId === ch.id);
          return {
            id: ch.id,
            provider: ch.provider,
            model: ch.model,
            weight: ch.weight ?? 1,
            tags: ch.tags,
            enabled: state?.enabled ?? ch.enabled ?? true,
            state: state ? {
              consecutiveFailures: state.consecutiveFailures,
              cooldownUntil: state.cooldownUntil,
              metrics: state.metrics,
              keys: state.keys.map((k) => ({
                index: k.index,
                enabled: k.enabled,
                errorCount: k.errorCount,
                totalRequests: k.totalRequests
              }))
            } : null
          };
        });

        reply.send({ channels: result });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message, { code: 'AI_CHANNELS_ERROR' });
      }
    });

    // GET /api/ai/channels/:id - Get single channel
    server.get('/api/ai/channels/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };

        if (!this.channelManager) {
          return this.respondError(reply, 404, 'Channels not configured', { code: 'NOT_FOUND' });
        }

        const state = this.channelManager.getState(id);
        if (!state) {
          return this.respondError(reply, 404, `Channel not found: ${id}`, { code: 'NOT_FOUND' });
        }

        const aiCfg = await this.ctx.configManager.get<any>('ai');
        const channelCfg = (aiCfg?.channels || []).find((c: ChannelConfig) => c.id === id);

        reply.send({
          id,
          provider: channelCfg?.provider,
          model: channelCfg?.model,
          weight: channelCfg?.weight ?? 1,
          tags: channelCfg?.tags,
          enabled: state.enabled,
          state: {
            consecutiveFailures: state.consecutiveFailures,
            cooldownUntil: state.cooldownUntil,
            metrics: state.metrics,
            keys: state.keys.map((k) => ({
              index: k.index,
              enabled: k.enabled,
              errorCount: k.errorCount,
              totalRequests: k.totalRequests
            }))
          }
        });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message, { code: 'AI_CHANNEL_ERROR' });
      }
    });

    // POST /api/ai/channels/:id/disable
    server.post('/api/ai/channels/:id/disable', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const body = (request.body as any) || {};
        const reason = body.reason || 'Manual disable';
        const durationMs = body.durationMs;

        if (!this.channelManager) {
          return this.respondError(reply, 404, 'Channels not configured', { code: 'NOT_FOUND' });
        }

        this.channelManager.disableChannel(id, reason, durationMs);
        reply.send({ success: true, id, enabled: false });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message, { code: 'AI_CHANNEL_ERROR' });
      }
    });

    // POST /api/ai/channels/:id/enable
    server.post('/api/ai/channels/:id/enable', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };

        if (!this.channelManager) {
          return this.respondError(reply, 404, 'Channels not configured', { code: 'NOT_FOUND' });
        }

        this.channelManager.enableChannel(id);
        reply.send({ success: true, id, enabled: true });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message, { code: 'AI_CHANNEL_ERROR' });
      }
    });

    // POST /api/ai/channels - Add new channel to config
    server.post('/api/ai/channels', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as any;
        const parsed = ChannelConfigSchema.parse(body);

        const aiCfg = (await this.ctx.configManager.get<any>('ai')) || {};
        const channels: ChannelConfig[] = aiCfg.channels || [];

        if (channels.some((c) => c.id === parsed.id)) {
          return this.respondError(reply, 400, `Channel with id '${parsed.id}' already exists`, { code: 'DUPLICATE_ID' });
        }

        channels.push(parsed as ChannelConfig);
        await this.ctx.configManager.updateConfig({ ai: { ...aiCfg, channels } });

        await this.initAiModules();

        reply.send({ success: true, channel: parsed });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return this.respondError(reply, 400, 'Invalid channel config', { code: 'BAD_REQUEST', meta: error.errors });
        }
        return this.respondError(reply, 500, (error as Error).message, { code: 'AI_CHANNEL_ERROR' });
      }
    });

    // DELETE /api/ai/channels/:id - Remove channel from config
    server.delete('/api/ai/channels/:id', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };

        const aiCfg = (await this.ctx.configManager.get<any>('ai')) || {};
        const channels: ChannelConfig[] = aiCfg.channels || [];
        const idx = channels.findIndex((c) => c.id === id);

        if (idx === -1) {
          return this.respondError(reply, 404, `Channel not found: ${id}`, { code: 'NOT_FOUND' });
        }

        channels.splice(idx, 1);
        await this.ctx.configManager.updateConfig({ ai: { ...aiCfg, channels } });

        await this.initAiModules();

        reply.send({ success: true, id });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message, { code: 'AI_CHANNEL_ERROR' });
      }
    });

    // ===== Usage Routes =====

    // GET /api/ai/usage - Get cost tracking stats
    server.get('/api/ai/usage', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!this.costTracker) {
          return reply.send({ usage: null, message: 'Cost tracking not enabled' });
        }

        const usage = this.costTracker.getUsage();
        const byModel = this.costTracker.getUsageByModel();

        reply.send({
          usage: {
            totalCost: usage.totalCostUsd,
            inputTokens: usage.totalPromptTokens,
            outputTokens: usage.totalCompletionTokens,
            budgetUsd: usage.budgetUsd,
            budgetRemaining: usage.budgetRemaining,
            periodStart: usage.periodStart,
            periodEnd: usage.periodEnd
          },
          byModel
        });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error).message, { code: 'AI_USAGE_ERROR' });
      }
    });
  }

  // ===== Helper Methods =====

  private buildHeuristicPlan(messages: Array<{ role: string; content: string }>): string {
    const last = messages.length ? messages[messages.length - 1] : undefined;
    const userContent = last?.role === 'user' ? String(last.content || '') : '';
    const lines = this.buildHeuristicPlanLines(userContent);
    return lines.join('\n');
  }

  private buildHeuristicPlanLines(user: string): string[] {
    const urlMatch = user.match(/https?:\/\/[^\s)]+/i);
    const url = urlMatch ? urlMatch[0] : 'https://api.example.com/v1/echo';
    const method = /\b(post|put|patch|delete|get)\b/i.exec(user)?.[0]?.toUpperCase?.() || 'GET';
    const needApiKey = /api[-_ ]?key|token/i.test(user);
    return [
      `已理解你的需求。建议基于以下接口生成 MCP 模板：`,
      '',
      `# Service Plan`,
      `Base URL: ${new URL(url).origin}`,
      '',
      `Endpoint: ${method} ${new URL(url).pathname}`,
      needApiKey ? `Auth: API Key header: X-API-Key` : `Auth: none`,
      `Parameters:`,
      `- q: string (optional)`
    ];
  }
}

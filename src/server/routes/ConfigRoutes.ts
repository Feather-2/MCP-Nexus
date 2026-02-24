import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { GatewayConfig, GatewayConfigSchema } from '../../types/index.js';
import { z } from 'zod';

const SENSITIVE_KEY_RE = /(?:password|secret|token|key|credential|private)/i;

function redactConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object') return config;
  if (Array.isArray(config)) return config.map(redactConfig);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = '***REDACTED***';
    } else if (v && typeof v === 'object') {
      out[k] = redactConfig(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

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
        reply.send(redactConfig(config));
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || 'Failed to load config', { code: 'CONFIG_ERROR' });
      }
    });

    // Update configuration
    server.put('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
      const PartialSchema = GatewayConfigSchema.partial();
      const updates = this.parseOrReply(
        reply,
        PartialSchema,
        (request.body as Record<string, unknown>) || {},
        'Invalid configuration payload'
      );
      if (!updates) return;

      try {
        const updatedConfig = await this.ctx.configManager.updateConfig(updates as Partial<GatewayConfig>);
        reply.send({ success: true, message: 'Configuration updated successfully', config: redactConfig(updatedConfig) });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || 'Failed to update configuration', { code: 'CONFIG_ERROR' });
      }
    });

    // Get specific configuration value
    server.get('/api/config/:key', async (request: FastifyRequest, reply: FastifyReply) => {
      const Params = z.object({ key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/) });
      const parsed = this.parseOrReply(
        reply,
        Params,
        request.params as Record<string, unknown>,
        'Invalid config key'
      );
      if (!parsed) return;
      const { key } = parsed;

      try {
        const value = await this.ctx.configManager.get(key);
        if (value === null) {
          return this.respondError(reply, 404, 'Configuration key not found', { code: 'NOT_FOUND', recoverable: true, meta: { key } });
        }
        const safeValue = (typeof value === 'object' && value !== null) ? redactConfig(value) : (SENSITIVE_KEY_RE.test(key.split('.').pop() || '') && typeof value === 'string' && value.length > 0 ? '***REDACTED***' : value);
        reply.send({ key, value: safeValue });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || 'Failed to get configuration value', { code: 'CONFIG_ERROR' });
      }
    });
  }
}

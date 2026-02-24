import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { t } from '../../i18n/index.js';

const ApiKeyCreateBody = z.object({
  name: z.string().min(1).max(128),
  permissions: z.array(z.string().min(1).max(64))
});

const TokenCreateBody = z.object({
  userId: z.string().min(1).max(128),
  permissions: z.array(z.string().min(1).max(64)),
  expiresInHours: z.number().positive().max(8760).optional().default(24)
});

const SafeKeyParam = z.object({ key: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/) });
const SafeTokenParam = z.object({ token: z.string().min(1).max(512) });

/**
 * Authentication and authorization routes
 */
export class AuthRoutes extends BaseRouteHandler {
  constructor(ctx: RouteContext) {
    super(ctx);
  }

  setupRoutes(): void {
    const { server } = this.ctx;

    // List API keys
    server.get('/api/auth/apikeys', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const apiKeys = this.ctx.authLayer.listApiKeys();
        const masked = Array.isArray(apiKeys)
          ? apiKeys.map((k: Record<string, unknown>) => ({
            ...k,
            key: typeof k.key === 'string' && k.key.length > 8
              ? `${k.key.slice(0, 4)}****${k.key.slice(-4)}`
              : '****'
          }))
          : apiKeys;
        reply.send(masked);
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || t('errors.auth_list_failed'), { code: 'AUTH_LIST_FAILED' });
      }
    });

    // Create API key
    server.post('/api/auth/apikey', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parsed = this.parseOrReply(
          reply,
          ApiKeyCreateBody,
          request.body,
          t('auth.name_permissions_required')
        );
        if (!parsed) return;
        const { name, permissions } = parsed;
        const result = await this.ctx.authLayer.createApiKey(name, permissions);
        reply.code(201).send({ success: true, apiKey: result, message: 'API key created successfully' });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || t('errors.auth_create_failed'), { code: 'AUTH_CREATE_FAILED' });
      }
    });

    // Delete API key
    server.delete('/api/auth/apikey/:key', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parsed = this.parseOrReply(
          reply,
          SafeKeyParam,
          request.params,
          t('auth.api_key_required')
        );
        if (!parsed) return;
        const { key } = parsed;
        const success = await this.ctx.authLayer.deleteApiKey(key);
        if (!success) return this.respondError(reply, 404, t('auth.api_key_not_found'), { code: 'NOT_FOUND', recoverable: true });
        reply.send({ success: true, message: 'API key deleted successfully' });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || t('errors.auth_delete_failed'), { code: 'AUTH_DELETE_FAILED' });
      }
    });

    // List tokens
    server.get('/api/auth/tokens', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const tokens = this.ctx.authLayer.listTokens();
        reply.send(tokens);
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || t('errors.auth_list_failed'), { code: 'AUTH_LIST_FAILED' });
      }
    });

    // Generate token
    server.post('/api/auth/token', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parsed = this.parseOrReply(
          reply,
          TokenCreateBody,
          request.body,
          t('auth.userid_permissions_required')
        );
        if (!parsed) return;
        const { userId, permissions, expiresInHours } = parsed;
        const result = await this.ctx.authLayer.generateToken(userId, permissions, expiresInHours);
        reply.code(201).send({ success: true, token: result, message: 'Token generated successfully' });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || t('errors.auth_token_failed'), { code: 'AUTH_TOKEN_FAILED' });
      }
    });

    // Revoke token
    server.delete('/api/auth/token/:token', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parsed = this.parseOrReply(
          reply,
          SafeTokenParam,
          request.params,
          t('auth.token_required')
        );
        if (!parsed) return;
        const { token } = parsed;
        const success = await this.ctx.authLayer.revokeToken(token);
        if (!success) return this.respondError(reply, 404, t('auth.token_not_found'), { code: 'NOT_FOUND', recoverable: true });
        reply.send({ success: true, message: 'Token revoked successfully' });
      } catch (error) {
        return this.respondError(reply, 500, (error as Error)?.message || t('errors.auth_revoke_failed'), { code: 'AUTH_REVOKE_FAILED' });
      }
    });
  }
}

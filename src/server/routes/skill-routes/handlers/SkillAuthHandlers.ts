import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../RouteContext.js';
import type { SkillRegistry, SkillAuthorization } from '../../../../skills/index.js';
import type { SkillCapabilities } from '../../../../security/CapabilityManifest.js';
import { AuthorizeBodySchema } from '../schemas/SkillSchemas.js';
import { t } from '../../../../i18n/index.js';

export function createGetPermissionsHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  authorization: SkillAuthorization,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      const authState = await authorization.getState(params.name);
      reply.send({
        success: true,
        permissions: skill.capabilities,
        authorization: authState
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: error.issues });
      }
      const message = error instanceof Error ? error.message : t('errors.skill_permissions_get_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_PERMISSIONS_GET_FAILED' });
    }
  };
}

export function createAuthorizeHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  authorization: SkillAuthorization,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof AuthorizeBodySchema>;
    try {
      body = AuthorizeBodySchema.parse((request.body as Record<string, unknown>) || {});
    } catch (error) {
      const err = error as z.ZodError;
      return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
    }

    try {
      const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      const authState = await authorization.authorize(params.name, {
        capabilities: body.capabilities as Partial<SkillCapabilities> | undefined,
        userId: body.userId
      });

      reply.send({ success: true, authorization: authState });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: error.issues });
      }
      const message = error instanceof Error ? error.message : t('errors.skill_authorize_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_AUTHORIZE_FAILED' });
    }
  };
}

export function createRevokeHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  authorization: SkillAuthorization,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      const authState = await authorization.revoke(params.name);
      reply.send({ success: true, authorization: authState });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: error.issues });
      }
      const message = error instanceof Error ? error.message : t('errors.skill_revoke_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_REVOKE_FAILED' });
    }
  };
}

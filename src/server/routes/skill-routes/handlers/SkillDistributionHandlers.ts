import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../RouteContext.js';
import type { SkillRegistry, SkillLocalizer } from '../../../../skills/index.js';
import { LocalizedSkillQuerySchema, DistributeBodySchema } from '../schemas/SkillSchemas.js';
import { normalizePlatform, normalizePlatforms } from '../helpers/SkillHelpers.js';
import { t } from '../../../../i18n/index.js';

export function createGetLocalizedHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  localizer: SkillLocalizer,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);
    const query = LocalizedSkillQuerySchema.parse((request.query as Record<string, unknown>) || {});

    try {
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      const platform = normalizePlatform(query.platform);
      const localized = localizer.localize(skill, platform);

      reply.send({ success: true, localized });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_localize_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_LOCALIZE_FAILED' });
    }
  };
}

export function createDistributeHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  localizer: SkillLocalizer,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);

    let body: z.infer<typeof DistributeBodySchema>;
    try {
      body = DistributeBodySchema.parse((request.body as Record<string, unknown>) || {});
    } catch (error) {
      const err = error as z.ZodError;
      return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
    }

    try {
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      const distributed = await localizer.distribute(skill, normalizePlatforms(body.platforms));
      reply.send({ success: true, distributed });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_distribute_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_DISTRIBUTE_FAILED' });
    }
  };
}

export function createUndistributeHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  localizer: SkillLocalizer,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);

    let body: z.infer<typeof DistributeBodySchema>;
    try {
      body = DistributeBodySchema.parse((request.body as Record<string, unknown>) || {});
    } catch (error) {
      const err = error as z.ZodError;
      return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
    }

    try {
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      await localizer.undistribute(params.name, normalizePlatforms(body.platforms));
      reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_undistribute_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_UNDISTRIBUTE_FAILED' });
    }
  };
}

export function createGetPlatformsHandler(
  ctx: RouteContext,
  localizer: SkillLocalizer
) {
  return async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const platforms = localizer.getSupportedPlatforms();
      reply.send({ success: true, platforms });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_platforms_list_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_PLATFORMS_LIST_FAILED' });
    }
  };
}

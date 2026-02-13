import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../RouteContext.js';
import type { SkillRegistry, SkillLoader, SkillAuthorization, SkillLocalizer } from '../../../../skills/index.js';
import { ListQuerySchema, GetSkillQuerySchema, RegisterSkillBodySchema } from '../schemas/SkillSchemas.js';
import { t } from '../../../../i18n/index.js';

export function createListHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  authorization: SkillAuthorization,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await initPromise;
      const query = ListQuerySchema.parse((request.query as Record<string, unknown>) || {});
      const q = query.q?.trim().toLowerCase();
      const scope = query.scope;

      let skills = registry.list();
      if (scope) skills = skills.filter((s) => s.scope === scope);
      if (q) {
        const tokens = q.split(/\s+/).filter(Boolean);
        skills = skills.filter((s) => {
          const hay = `${s.name} ${s.description} ${(s.shortDescription || '')}`.toLowerCase();
          if (hay.includes(q)) return true;
          return tokens.some((t) => s.keywordsAll.includes(t));
        });
      }

      const filteredSkills = [];
      for (const s of skills) {
        const state = await authorization.getState(s.name);
        const isExplicitlyDisabled = state.authorizedAt !== undefined && !state.enabled;
        if (!isExplicitlyDisabled) filteredSkills.push(s);
      }

      reply.send({ success: true, skills: filteredSkills });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skills_list_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILLS_LIST_FAILED' });
    }
  };
}

export function createGetHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  supportLoader: SkillLoader,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);
    const query = GetSkillQuerySchema.parse((request.query as Record<string, unknown>) || {});

    try {
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      if (!query.includeSupportFiles) {
        reply.send({ success: true, skill: { metadata: skill.metadata, body: skill.body } });
        return;
      }

      const loaded = await supportLoader.loadSkillFromSkillMd(skill.metadata.path);
      const supportFiles = loaded?.supportFiles ? Object.fromEntries(loaded.supportFiles.entries()) : {};
      reply.send({
        success: true,
        skill: {
          metadata: skill.metadata,
          body: loaded?.body ?? skill.body,
          supportFiles
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_get_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_GET_FAILED' });
    }
  };
}

export function createGetContentHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  supportLoader: SkillLoader,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);

    try {
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      const loaded = await supportLoader.loadSkillFromSkillMd(skill.metadata.path);
      const supportFiles = loaded?.supportFiles ? Object.fromEntries(loaded.supportFiles.entries()) : {};
      reply.send({
        body: loaded?.body ?? skill.body,
        supportFiles,
        metadata: skill.metadata
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_get_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_GET_FAILED' });
    }
  };
}

export function createRegisterHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  localizer: SkillLocalizer,
  initPromise: Promise<void>,
  onRegistryChange: () => void
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof RegisterSkillBodySchema>;
    try {
      body = RegisterSkillBodySchema.parse((request.body as Record<string, unknown>) || {});
    } catch (e) {
      const err = e as z.ZodError;
      return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
    }

    try {
      await initPromise;
      const skill = await registry.register(body);
      onRegistryChange();
      reply.send({ success: true, skill: { metadata: skill.metadata } });
      localizer.distribute(skill).catch((e: unknown) => {
        ctx.logger?.warn?.('Auto-distribute failed after register', {
          skill: skill.metadata.name,
          error: (e as Error)?.message || String(e)
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_register_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_REGISTER_FAILED' });
    }
  };
}

export function createDeleteHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  initPromise: Promise<void>,
  onRegistryChange: () => void
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);

    try {
      await initPromise;
      const deleted = await registry.delete(params.name);
      if (deleted) {
        onRegistryChange();
      }
      reply.send({ success: true, deleted });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_delete_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_DELETE_FAILED' });
    }
  };
}

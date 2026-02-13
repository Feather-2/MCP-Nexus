import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../RouteContext.js';
import type { SkillRegistry, SkillVersionStore, SkillLoader, SkillLocalizer } from '../../../../skills/index.js';
import type { Skill } from '../../../../skills/types.js';
import { CreateVersionBodySchema } from '../schemas/SkillSchemas.js';
import { t } from '../../../../i18n/index.js';

async function collectVersionFiles(skill: Skill, supportLoader: SkillLoader): Promise<Record<string, string>> {
  const loaded = await supportLoader.loadSkillFromSkillMd(skill.metadata.path);
  const files: Record<string, string> = {
    'SKILL.md': loaded?.body ?? skill.body
  };

  const supportFiles = loaded?.supportFiles ?? skill.supportFiles;
  if (supportFiles) {
    for (const [filePath, content] of supportFiles.entries()) {
      files[filePath] = content;
    }
  }

  return files;
}

export function createListVersionsHandler(
  ctx: RouteContext,
  versionStore: SkillVersionStore,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);

    try {
      await initPromise;
      const versions = await versionStore.list(params.name);
      reply.send({ success: true, versions });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_versions_list_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_VERSIONS_LIST_FAILED' });
    }
  };
}

export function createCreateVersionHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  versionStore: SkillVersionStore,
  supportLoader: SkillLoader,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params as Record<string, unknown>);

    let body: z.infer<typeof CreateVersionBodySchema>;
    try {
      body = CreateVersionBodySchema.parse((request.body as Record<string, unknown>) || {});
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

      const files = await collectVersionFiles(skill, supportLoader);
      const snapshot = await versionStore.save(params.name, files, body.reason);
      reply.send({ success: true, snapshot });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_version_save_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_VERSION_SAVE_FAILED' });
    }
  };
}

export function createRollbackHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  versionStore: SkillVersionStore,
  localizer: SkillLocalizer,
  initPromise: Promise<void>,
  onRegistryChange: () => void
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({
      name: z.string().min(1),
      versionId: z.string().min(1)
    }).parse(request.params as Record<string, unknown>);

    try {
      await initPromise;
      const skill = registry.get(params.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: params.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      const snapshot = await versionStore.rollback(params.name, params.versionId);
      if (!snapshot) {
        return ctx.respondError(reply, 404, t('errors.skill_version_not_found', { versionId: params.versionId }), {
          code: 'SKILL_VERSION_NOT_FOUND',
          recoverable: true
        });
      }

      await registry.reload();
      onRegistryChange();

      reply.send({ success: true, snapshot });
      const rolledBackSkill = registry.get(params.name);
      if (rolledBackSkill) {
        localizer.distribute(rolledBackSkill).catch((e: unknown) => {
          ctx.logger?.warn?.('Auto-distribute failed after rollback', {
            skill: params.name,
            error: (e as Error)?.message || String(e)
          });
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_rollback_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_ROLLBACK_FAILED' });
    }
  };
}

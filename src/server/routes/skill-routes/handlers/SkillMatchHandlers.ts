import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../RouteContext.js';
import type { SkillMatcher, SkillLoader, SkillAuthorization } from '../../../../skills/index.js';
import { MatchBodySchema } from '../schemas/SkillSchemas.js';
import { t } from '../../../../i18n/index.js';

export function createMatchHandler(
  ctx: RouteContext,
  matcher: SkillMatcher,
  supportLoader: SkillLoader,
  authorization: SkillAuthorization,
  getMatcherIndex: () => ReturnType<SkillMatcher['buildIndex']>,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof MatchBodySchema>;
    try {
      body = MatchBodySchema.parse((request.body as Record<string, unknown>) || {});
    } catch (e) {
      const err = e as z.ZodError;
      return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: err.issues });
    }

    try {
      await initPromise;
      const matches = matcher.match(body.input, getMatcherIndex(), {
        maxResults: body.maxResults,
        minScore: body.minScore
      });

      const enabledMatches = [];
      for (const m of matches) {
        const state = await authorization.getState(m.skill.metadata.name);
        const isExplicitlyDisabled = state.authorizedAt !== undefined && !state.enabled;
        if (!isExplicitlyDisabled) enabledMatches.push(m);
      }

      const includeBodies = Boolean(body.includeBodies);
      const includeSupportFiles = Boolean(body.includeSupportFiles);

      const payload = await Promise.all(enabledMatches.map(async (m) => {
        if (!includeBodies && !includeSupportFiles) {
          return { metadata: m.skill.metadata, ...m.result };
        }
        const loaded = includeSupportFiles
          ? await supportLoader.loadSkillFromSkillMd(m.skill.metadata.path)
          : undefined;
        const supportFiles = includeSupportFiles && loaded?.supportFiles ? Object.fromEntries(loaded.supportFiles.entries()) : undefined;
        return {
          metadata: m.skill.metadata,
          ...m.result,
          body: includeBodies ? (loaded?.body ?? m.skill.body) : undefined,
          supportFiles
        };
      }));

      const injection = includeBodies ? matcher.formatInjection(enabledMatches.map((m) => m.skill)) : undefined;
      reply.send({ success: true, matches: payload, injection });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_match_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_MATCH_FAILED' });
    }
  };
}

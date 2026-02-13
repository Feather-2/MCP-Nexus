import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../RouteContext.js';
import type { SkillRegistry, SkillAuditor } from '../../../../skills/index.js';
import { AuditBodySchema, SkillDefinitionSchema } from '../schemas/SkillSchemas.js';
import { buildSkillFromDefinition } from '../helpers/SkillHelpers.js';
import { t } from '../../../../i18n/index.js';

export function createAuditHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  auditor: SkillAuditor,
  initPromise: Promise<void>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const raw = (request.body as Record<string, unknown>) || {};

      const isDefinition =
        raw &&
        typeof raw === 'object' &&
        raw.metadata &&
        typeof raw.metadata === 'object' &&
        typeof raw.body === 'string';

      if (isDefinition) {
        const def = SkillDefinitionSchema.parse(raw);
        let skill;
        try {
          skill = buildSkillFromDefinition(def);
        } catch (e: unknown) {
          return ctx.respondError(reply, 400, (e as Error)?.message || t('errors.invalid_skill_definition'), {
            code: 'BAD_REQUEST',
            recoverable: true
          });
        }
        const result = await auditor.auditSecurity(skill);
        reply.send({ success: true, result });
        return;
      }

      const body = AuditBodySchema.parse(raw);
      await initPromise;
      const skill = registry.get(body.name);
      if (!skill) {
        return ctx.respondError(reply, 404, t('errors.skill_not_found', { name: body.name }), { code: 'SKILL_NOT_FOUND', recoverable: true });
      }

      const result = await auditor.auditSkill(skill, { dryRun: body.dryRun, timeoutMsPerTool: body.timeoutMsPerTool });
      reply.send({ success: true, result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return ctx.respondError(reply, 400, t('errors.invalid_request_body'), { code: 'BAD_REQUEST', recoverable: true, meta: error.issues });
      }
      const message = error instanceof Error ? error.message : t('errors.skill_audit_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_AUDIT_FAILED' });
    }
  };
}

export function createAuditSummaryHandler(
  ctx: RouteContext,
  registry: SkillRegistry,
  auditor: SkillAuditor,
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

      const securityResult = await auditor.auditSecurity(skill);
      const errors = securityResult.findings
        .filter((finding) => finding.severity === 'high' || finding.severity === 'critical')
        .map((finding) => finding.message);
      const warnings = securityResult.findings
        .filter((finding) => finding.severity !== 'high' && finding.severity !== 'critical')
        .map((finding) => finding.message);
      const issueCount = errors.length + warnings.length;
      const riskLevel = issueCount === 0 ? 'low' : issueCount <= 2 ? 'medium' : 'high';

      reply.send({
        success: true,
        summary: {
          passed: securityResult.decision !== 'reject' && errors.length === 0,
          riskLevel,
          errors,
          warnings,
          capabilities: skill.capabilities
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.skill_audit_summary_failed');
      return ctx.respondError(reply, 500, message, { code: 'SKILL_AUDIT_SUMMARY_FAILED' });
    }
  };
}

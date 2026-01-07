/**
 * Audit Routes - API endpoints for audit visualization and explanation.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RouteContext } from './RouteContext.js';
import { AuditExplainer, AuditExplanation } from '../../security/AuditExplainer.js';
import { AuditPipeline, AuditResult } from '../../security/AuditPipeline.js';

interface AuditRoutesDeps {
  auditPipeline?: AuditPipeline;
}

export class AuditRoutes {
  private readonly explainer = new AuditExplainer();
  private readonly auditPipeline?: AuditPipeline;

  // In-memory store for explanations (would use Redis in production)
  private readonly explanations = new Map<string, AuditExplanation>();
  private readonly pendingAudits = new Map<string, { skillName: string; skillDescription?: string; startTime: number }>();

  constructor(deps?: AuditRoutesDeps) {
    this.auditPipeline = deps?.auditPipeline;
  }

  register(server: FastifyInstance, ctx: RouteContext): void {
    const prefix = '/api/audit';

    // GET /api/audit/explain/:requestId - Get explanation for a completed audit
    server.get(`${prefix}/explain/:requestId`, async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string };

      // Check local cache first
      const cached = this.explanations.get(requestId);
      if (cached) {
        return reply.send(cached);
      }

      // Check if audit is pending
      const pending = this.pendingAudits.get(requestId);
      if (pending) {
        return reply.status(202).send({
          requestId,
          status: 'pending',
          skill: { name: pending.skillName, description: pending.skillDescription },
          elapsedMs: Date.now() - pending.startTime,
          message: 'Audit is still in progress'
        });
      }

      // Check pipeline async status
      if (this.auditPipeline) {
        const status = this.auditPipeline.getAsyncAuditStatus(requestId);

        if (status.status === 'pending') {
          return reply.status(202).send({
            requestId,
            status: 'pending',
            message: 'Audit is still in progress'
          });
        }

        if (status.status === 'completed' && status.result) {
          const explanation = this.explainer.explain(
            requestId,
            'unknown', // Would need to store skill metadata
            undefined,
            status.result
          );
          this.explanations.set(requestId, explanation);
          return reply.send(explanation);
        }

        if (status.status === 'failed') {
          return reply.status(500).send({
            requestId,
            status: 'failed',
            error: 'Audit failed'
          });
        }
      }

      return reply.status(404).send({
        error: 'Audit not found',
        requestId
      });
    });

    // GET /api/audit/list - List recent audits
    server.get(`${prefix}/list`, async (request: FastifyRequest, reply: FastifyReply) => {
      const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };

      const all = Array.from(this.explanations.entries())
        .map(([id, exp]) => ({
          requestId: id,
          skillName: exp.skill.name,
          decision: exp.decision,
          score: exp.finalScore,
          generatedAt: exp.generatedAt
        }))
        .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
        .slice(offset, offset + limit);

      return reply.send({
        audits: all,
        total: this.explanations.size,
        limit,
        offset
      });
    });

    // GET /api/audit/stats - Get audit statistics
    server.get(`${prefix}/stats`, async (request: FastifyRequest, reply: FastifyReply) => {
      const decisions = { approve: 0, reject: 0, review: 0, provisional_approve: 0 };
      let totalScore = 0;

      for (const exp of this.explanations.values()) {
        decisions[exp.decision]++;
        totalScore += exp.finalScore;
      }

      const total = this.explanations.size;

      return reply.send({
        total,
        decisions,
        averageScore: total > 0 ? totalScore / total : 0,
        pendingCount: this.pendingAudits.size
      });
    });

    // POST /api/audit/register - Register a pending audit (internal use)
    server.post(`${prefix}/register`, async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId, skillName, skillDescription } = request.body as {
        requestId: string;
        skillName: string;
        skillDescription?: string;
      };

      if (!requestId || !skillName) {
        return reply.status(400).send({ error: 'requestId and skillName are required' });
      }

      this.pendingAudits.set(requestId, {
        skillName,
        skillDescription,
        startTime: Date.now()
      });

      return reply.status(201).send({ registered: true, requestId });
    });

    // POST /api/audit/complete - Complete a pending audit (internal use)
    server.post(`${prefix}/complete`, async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId, result } = request.body as {
        requestId: string;
        result: AuditResult;
      };

      if (!requestId || !result) {
        return reply.status(400).send({ error: 'requestId and result are required' });
      }

      const pending = this.pendingAudits.get(requestId);
      if (!pending) {
        return reply.status(404).send({ error: 'Pending audit not found' });
      }

      const explanation = this.explainer.explain(
        requestId,
        pending.skillName,
        pending.skillDescription,
        result
      );

      this.explanations.set(requestId, explanation);
      this.pendingAudits.delete(requestId);

      return reply.send(explanation);
    });

    // DELETE /api/audit/:requestId - Delete an audit record
    server.delete(`${prefix}/:requestId`, async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string };

      const deleted = this.explanations.delete(requestId) || this.pendingAudits.delete(requestId);

      if (!deleted) {
        return reply.status(404).send({ error: 'Audit not found' });
      }

      return reply.send({ deleted: true, requestId });
    });

    ctx.logger.info('AuditRoutes registered');
  }

  /**
   * Store an explanation directly (for use by other components).
   */
  storeExplanation(requestId: string, explanation: AuditExplanation): void {
    this.explanations.set(requestId, explanation);
    this.pendingAudits.delete(requestId);
  }

  /**
   * Get an explanation by request ID.
   */
  getExplanation(requestId: string): AuditExplanation | undefined {
    return this.explanations.get(requestId);
  }
}

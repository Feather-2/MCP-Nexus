import path from 'path';
import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { SkillModificationApprover } from '../../skills/SkillModificationApprover.js';
import { SkillResigner } from '../../skills/SkillResigner.js';
import { AuditLogger } from '../../security/AuditLogger.js';

const ApprovalIdParam = z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/) });
const ApprovalActionBody = z.object({
  userId: z.string().min(1).max(128),
  reason: z.string().max(1024).optional()
});

export class SkillApprovalRoutes extends BaseRouteHandler {
  private approver?: SkillModificationApprover;

  get logger() {
    return this.ctx.logger;
  }

  setupRoutes(): void {
    const storeFilePath = path.join(process.cwd(), 'data', 'skill-approvals.json');
    const auditLogPath = path.join(process.cwd(), 'data', 'audit.log');
    const auditLogger = new AuditLogger({ filePath: auditLogPath, logger: this.logger });
    const resigner = new SkillResigner({ logger: this.logger });

    this.approver = new SkillModificationApprover({
      storeFilePath,
      auditLogger,
      resigner,
      logger: this.logger
    });

    this.ctx.server.get('/api/skills/approvals', this.listAll.bind(this));
    this.ctx.server.get('/api/skills/approvals/pending', this.listPending.bind(this));
    this.ctx.server.post(
      '/api/skills/approvals/:id/approve',
      this.approve.bind(this)
    );
    this.ctx.server.post(
      '/api/skills/approvals/:id/reject',
      this.reject.bind(this)
    );
  }

  private async listAll(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!this.approver) {
      this.respondError(reply, 503, 'Approval subsystem not initialized', { code: 'NOT_READY' });
      return;
    }
    const records = await this.approver.list();
    return reply.send({ records });
  }

  private async listPending(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!this.approver) {
      this.respondError(reply, 503, 'Approval subsystem not initialized', { code: 'NOT_READY' });
      return;
    }
    const records = await this.approver.list('pending');
    return reply.send({ records });
  }

  private async approve(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const paramsParsed = this.parseOrReply(reply, ApprovalIdParam, request.params, 'Invalid approval id');
    if (!paramsParsed) return;
    const bodyParsed = this.parseOrReply(reply, ApprovalActionBody, request.body, 'Invalid body');
    if (!bodyParsed) return;

    const { id } = paramsParsed;
    const { userId, reason } = bodyParsed;

    if (!this.approver) {
      this.respondError(reply, 503, 'Approval subsystem not initialized', { code: 'NOT_READY' });
      return;
    }
    const record = await this.approver.approve(id, userId, reason);
    if (!record) {
      return reply.status(404).send({ error: 'Record not found' });
    }

    return reply.send({ record });
  }

  private async reject(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const paramsParsed = this.parseOrReply(reply, ApprovalIdParam, request.params, 'Invalid approval id');
    if (!paramsParsed) return;
    const bodyParsed = this.parseOrReply(reply, ApprovalActionBody, request.body, 'Invalid body');
    if (!bodyParsed) return;

    const { id } = paramsParsed;
    const { userId, reason } = bodyParsed;

    if (!this.approver) {
      this.respondError(reply, 503, 'Approval subsystem not initialized', { code: 'NOT_READY' });
      return;
    }
    const record = await this.approver.reject(id, userId, reason);
    if (!record) {
      return reply.status(404).send({ error: 'Record not found' });
    }

    return reply.send({ record });
  }
}

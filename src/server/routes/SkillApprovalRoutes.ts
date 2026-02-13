import path from 'path';
import { FastifyRequest, FastifyReply } from 'fastify';
import { BaseRouteHandler, RouteContext } from './RouteContext.js';
import { SkillModificationApprover } from '../../skills/SkillModificationApprover.js';
import { SkillResigner } from '../../skills/SkillResigner.js';
import { AuditLogger } from '../../security/AuditLogger.js';

interface ApprovalActionBody {
  userId: string;
  reason?: string;
}

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
    this.ctx.server.post<{ Params: { id: string }; Body: ApprovalActionBody }>(
      '/api/skills/approvals/:id/approve',
      this.approve.bind(this)
    );
    this.ctx.server.post<{ Params: { id: string }; Body: ApprovalActionBody }>(
      '/api/skills/approvals/:id/reject',
      this.reject.bind(this)
    );
  }

  private async listAll(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const records = await this.approver!.list();
    return reply.send({ records });
  }

  private async listPending(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const records = await this.approver!.list('pending');
    return reply.send({ records });
  }

  private async approve(
    request: FastifyRequest<{ Params: { id: string }; Body: ApprovalActionBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { userId, reason } = request.body;

    if (!userId) {
      return reply.status(400).send({ error: 'userId is required' });
    }

    const record = await this.approver!.approve(id, userId, reason);
    if (!record) {
      return reply.status(404).send({ error: 'Record not found' });
    }

    return reply.send({ record });
  }

  private async reject(
    request: FastifyRequest<{ Params: { id: string }; Body: ApprovalActionBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { userId, reason } = request.body;

    if (!userId) {
      return reply.status(400).send({ error: 'userId is required' });
    }

    const record = await this.approver!.reject(id, userId, reason);
    if (!record) {
      return reply.status(404).send({ error: 'Record not found' });
    }

    return reply.send({ record });
  }
}

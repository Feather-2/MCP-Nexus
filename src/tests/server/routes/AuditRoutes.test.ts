import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../types/index.js';
import { AuditRoutes } from '../../../server/routes/AuditRoutes.js';
import type { AuditExplanation } from '../../../security/AuditExplainer.js';
import type { AuditResult } from '../../../security/AuditPipeline.js';

const { explainMock } = vi.hoisted(() => ({
  explainMock: vi.fn()
}));

vi.mock('../../../security/AuditExplainer.js', () => ({
  AuditExplainer: class {
    explain = explainMock;
  }
}));

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(logger: Logger) {
  return { logger } as any;
}

function makeExplanation(opts: {
  requestId: string;
  skillName: string;
  skillDescription?: string;
  decision?: AuditExplanation['decision'];
  finalScore?: number;
  generatedAt?: Date;
}): AuditExplanation {
  return {
    requestId: opts.requestId,
    skill: { name: opts.skillName, description: opts.skillDescription },
    timeline: [],
    scoring: [],
    finalScore: opts.finalScore ?? 0,
    decision: opts.decision ?? 'approve',
    recommendation: 'ok',
    findings: [],
    generatedAt: opts.generatedAt ?? new Date('2025-01-01T00:00:00.000Z')
  };
}

function serializeExplanation(exp: AuditExplanation) {
  return JSON.parse(JSON.stringify(exp));
}

function makeAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    decision: 'approve',
    score: 80,
    findings: [],
    reviewRequired: false,
    ...overrides
  };
}

async function makeServer(deps?: { auditPipeline?: any }) {
  const server = Fastify({ logger: false });
  const logger = makeLogger();
  const routes = new AuditRoutes({ auditPipeline: deps?.auditPipeline });
  routes.register(server, makeCtx(logger));
  return { server, routes, logger };
}

describe('AuditRoutes', () => {
  let server: FastifyInstance | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  describe('GET /api/audit/explain/:requestId', () => {
    it('returns cached explanation when cache hit', async () => {
      const auditPipeline = { getAsyncAuditStatus: vi.fn() };
      const setup = await makeServer({ auditPipeline });
      server = setup.server;

      const explanation = makeExplanation({
        requestId: 'req-cache',
        skillName: 'skill-a',
        finalScore: 55,
        decision: 'review',
        generatedAt: new Date('2025-01-02T03:04:05.000Z')
      });
      setup.routes.storeExplanation('req-cache', explanation);

      const res = await server.inject({ method: 'GET', url: '/api/audit/explain/req-cache' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(serializeExplanation(explanation));
      expect(auditPipeline.getAsyncAuditStatus).not.toHaveBeenCalled();
      expect(explainMock).not.toHaveBeenCalled();
    });

    it('returns 202 with progress when pending audit is registered', async () => {
      const setup = await makeServer();
      server = setup.server;

      const register = await server.inject({
        method: 'POST',
        url: '/api/audit/register',
        payload: { requestId: 'req-pending', skillName: 'skill-a', skillDescription: 'desc' }
      });
      expect(register.statusCode).toBe(201);

      const res = await server.inject({ method: 'GET', url: '/api/audit/explain/req-pending' });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toEqual(
        expect.objectContaining({
          requestId: 'req-pending',
          status: 'pending',
          skill: { name: 'skill-a', description: 'desc' },
          message: expect.stringContaining('still in progress')
        })
      );
      expect(body.elapsedMs).toEqual(expect.any(Number));
      expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(explainMock).not.toHaveBeenCalled();
    });

    it('returns 202 when pipeline async status is pending', async () => {
      const auditPipeline = { getAsyncAuditStatus: vi.fn().mockReturnValue({ status: 'pending' }) };
      const setup = await makeServer({ auditPipeline });
      server = setup.server;

      const res = await server.inject({ method: 'GET', url: '/api/audit/explain/req-async-pending' });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        requestId: 'req-async-pending',
        status: 'pending',
        message: 'Audit is still in progress'
      });
      expect(auditPipeline.getAsyncAuditStatus).toHaveBeenCalledWith('req-async-pending');
      expect(explainMock).not.toHaveBeenCalled();
    });

    it('generates and caches explanation when pipeline is completed', async () => {
      const result = makeAuditResult({ score: 42, decision: 'reject' });
      const auditPipeline = { getAsyncAuditStatus: vi.fn().mockReturnValue({ status: 'completed', result }) };

      const setup = await makeServer({ auditPipeline });
      server = setup.server;

      const explanation = makeExplanation({
        requestId: 'req-async-completed',
        skillName: 'unknown',
        decision: 'reject',
        finalScore: 42,
        generatedAt: new Date('2025-01-03T00:00:00.000Z')
      });
      explainMock.mockReturnValueOnce(explanation);

      const first = await server.inject({ method: 'GET', url: '/api/audit/explain/req-async-completed' });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual(serializeExplanation(explanation));
      expect(explainMock).toHaveBeenCalledWith('req-async-completed', 'unknown', undefined, result);

      const second = await server.inject({ method: 'GET', url: '/api/audit/explain/req-async-completed' });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(serializeExplanation(explanation));
      expect(explainMock).toHaveBeenCalledTimes(1);
      expect(auditPipeline.getAsyncAuditStatus).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when pipeline async status is failed', async () => {
      const auditPipeline = { getAsyncAuditStatus: vi.fn().mockReturnValue({ status: 'failed' }) };
      const setup = await makeServer({ auditPipeline });
      server = setup.server;

      const res = await server.inject({ method: 'GET', url: '/api/audit/explain/req-async-failed' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        requestId: 'req-async-failed',
        status: 'failed',
        error: 'Audit failed'
      });
      expect(explainMock).not.toHaveBeenCalled();
    });

    it('returns 404 when audit is not found', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({ method: 'GET', url: '/api/audit/explain/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Audit not found', requestId: 'missing' });
    });

    it('returns 404 when pipeline is present but has no result', async () => {
      const auditPipeline = { getAsyncAuditStatus: vi.fn().mockReturnValue({ status: 'completed' }) };
      const setup = await makeServer({ auditPipeline });
      server = setup.server;

      const res = await server.inject({ method: 'GET', url: '/api/audit/explain/req-no-result' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Audit not found', requestId: 'req-no-result' });
      expect(auditPipeline.getAsyncAuditStatus).toHaveBeenCalledWith('req-no-result');
    });
  });

  describe('GET /api/audit/list', () => {
    it('returns audit list sorted by time desc', async () => {
      const setup = await makeServer();
      server = setup.server;

      const expOld = makeExplanation({
        requestId: 'req-1',
        skillName: 'skill-a',
        decision: 'approve',
        finalScore: 10,
        generatedAt: new Date('2025-01-01T00:00:00.000Z')
      });
      const expNew = makeExplanation({
        requestId: 'req-2',
        skillName: 'skill-b',
        decision: 'reject',
        finalScore: 20,
        generatedAt: new Date('2025-01-03T00:00:00.000Z')
      });
      const expMid = makeExplanation({
        requestId: 'req-3',
        skillName: 'skill-c',
        decision: 'review',
        finalScore: 15,
        generatedAt: new Date('2025-01-02T00:00:00.000Z')
      });

      setup.routes.storeExplanation(expOld.requestId, expOld);
      setup.routes.storeExplanation(expNew.requestId, expNew);
      setup.routes.storeExplanation(expMid.requestId, expMid);

      const res = await server.inject({ method: 'GET', url: '/api/audit/list' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.audits.map((a: any) => a.requestId)).toEqual(['req-2', 'req-3', 'req-1']);
      expect(body.audits[0]).toEqual(
        expect.objectContaining({
          requestId: 'req-2',
          skillName: 'skill-b',
          decision: 'reject',
          score: 20,
          generatedAt: '2025-01-03T00:00:00.000Z'
        })
      );
    });

    it('supports pagination via limit/offset', async () => {
      const setup = await makeServer();
      server = setup.server;

      setup.routes.storeExplanation('r1', makeExplanation({ requestId: 'r1', skillName: 's1', generatedAt: new Date('2025-01-01T00:00:00.000Z') }));
      setup.routes.storeExplanation('r2', makeExplanation({ requestId: 'r2', skillName: 's2', generatedAt: new Date('2025-01-02T00:00:00.000Z') }));
      setup.routes.storeExplanation('r3', makeExplanation({ requestId: 'r3', skillName: 's3', generatedAt: new Date('2025-01-03T00:00:00.000Z') }));

      const res = await server.inject({ method: 'GET', url: '/api/audit/list?limit=1&offset=1' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(1);
      expect(body.audits).toHaveLength(1);
      expect(body.audits[0].requestId).toBe('r2');
    });

    it('returns empty list when no audits exist', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({ method: 'GET', url: '/api/audit/list' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ audits: [], total: 0, limit: 50, offset: 0 });
    });
  });

  describe('GET /api/audit/stats', () => {
    it('returns statistics including decisions, averageScore, and pendingCount', async () => {
      const setup = await makeServer();
      server = setup.server;

      setup.routes.storeExplanation('a1', makeExplanation({ requestId: 'a1', skillName: 's', decision: 'approve', finalScore: 80 }));
      setup.routes.storeExplanation('a2', makeExplanation({ requestId: 'a2', skillName: 's', decision: 'reject', finalScore: 20 }));
      setup.routes.storeExplanation('a3', makeExplanation({ requestId: 'a3', skillName: 's', decision: 'review', finalScore: 40 }));
      setup.routes.storeExplanation('a4', makeExplanation({ requestId: 'a4', skillName: 's', decision: 'provisional_approve', finalScore: 60 }));

      await server.inject({ method: 'POST', url: '/api/audit/register', payload: { requestId: 'p1', skillName: 'skill-x' } });
      await server.inject({ method: 'POST', url: '/api/audit/register', payload: { requestId: 'p2', skillName: 'skill-y' } });

      const res = await server.inject({ method: 'GET', url: '/api/audit/stats' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(4);
      expect(body.pendingCount).toBe(2);
      expect(body.decisions).toEqual({ approve: 1, reject: 1, review: 1, provisional_approve: 1 });
      expect(body.averageScore).toBeCloseTo((80 + 20 + 40 + 60) / 4, 6);
    });

    it('returns averageScore=0 when no data', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({ method: 'GET', url: '/api/audit/stats' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        total: 0,
        decisions: { approve: 0, reject: 0, review: 0, provisional_approve: 0 },
        averageScore: 0,
        pendingCount: 0
      });
    });
  });

  describe('POST /api/audit/register', () => {
    it('registers a pending audit', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({
        method: 'POST',
        url: '/api/audit/register',
        payload: { requestId: 'req-reg', skillName: 'skill-a', skillDescription: 'desc' }
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ registered: true, requestId: 'req-reg' });

      const explain = await server.inject({ method: 'GET', url: '/api/audit/explain/req-reg' });
      expect(explain.statusCode).toBe(202);
      expect(explain.json()).toEqual(expect.objectContaining({ requestId: 'req-reg', status: 'pending' }));
    });

    it('returns 400 when requestId missing', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({ method: 'POST', url: '/api/audit/register', payload: { skillName: 'skill-a' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'requestId and skillName are required' });
    });

    it('returns 400 when skillName missing', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({ method: 'POST', url: '/api/audit/register', payload: { requestId: 'x' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'requestId and skillName are required' });
    });
  });

  describe('POST /api/audit/complete', () => {
    it('completes a pending audit and returns explanation', async () => {
      const setup = await makeServer();
      server = setup.server;

      await server.inject({ method: 'POST', url: '/api/audit/register', payload: { requestId: 'req-done', skillName: 'skill-a', skillDescription: 'desc' } });

      const result = makeAuditResult({ decision: 'approve', score: 99 });
      const explanation = makeExplanation({
        requestId: 'req-done',
        skillName: 'skill-a',
        skillDescription: 'desc',
        decision: 'approve',
        finalScore: 99,
        generatedAt: new Date('2025-01-04T00:00:00.000Z')
      });
      explainMock.mockReturnValueOnce(explanation);

      const complete = await server.inject({ method: 'POST', url: '/api/audit/complete', payload: { requestId: 'req-done', result } });
      expect(complete.statusCode).toBe(200);
      expect(complete.json()).toEqual(serializeExplanation(explanation));
      expect(explainMock).toHaveBeenCalledWith('req-done', 'skill-a', 'desc', result);

      const explain = await server.inject({ method: 'GET', url: '/api/audit/explain/req-done' });
      expect(explain.statusCode).toBe(200);
      expect(explain.json()).toEqual(serializeExplanation(explanation));
    });

    it('returns 400 when requestId missing', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({ method: 'POST', url: '/api/audit/complete', payload: { result: makeAuditResult() } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'requestId and result are required' });
    });

    it('returns 400 when result missing', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({ method: 'POST', url: '/api/audit/complete', payload: { requestId: 'x' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'requestId and result are required' });
    });

    it('returns 404 when pending audit does not exist', async () => {
      const setup = await makeServer();
      server = setup.server;

      const res = await server.inject({ method: 'POST', url: '/api/audit/complete', payload: { requestId: 'missing', result: makeAuditResult() } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Pending audit not found' });
    });
  });

  describe('DELETE /api/audit/:requestId', () => {
    it('deletes a completed audit', async () => {
      const setup = await makeServer();
      server = setup.server;

      const explanation = makeExplanation({ requestId: 'del-exp', skillName: 's' });
      setup.routes.storeExplanation('del-exp', explanation);

      const del = await server.inject({ method: 'DELETE', url: '/api/audit/del-exp' });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ deleted: true, requestId: 'del-exp' });

      const explain = await server.inject({ method: 'GET', url: '/api/audit/explain/del-exp' });
      expect(explain.statusCode).toBe(404);
    });

    it('deletes a pending audit', async () => {
      const setup = await makeServer();
      server = setup.server;

      await server.inject({ method: 'POST', url: '/api/audit/register', payload: { requestId: 'del-pending', skillName: 's' } });

      const del = await server.inject({ method: 'DELETE', url: '/api/audit/del-pending' });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ deleted: true, requestId: 'del-pending' });

      const explain = await server.inject({ method: 'GET', url: '/api/audit/explain/del-pending' });
      expect(explain.statusCode).toBe(404);
    });

    it('returns 404 when audit not found', async () => {
      const setup = await makeServer();
      server = setup.server;

      const del = await server.inject({ method: 'DELETE', url: '/api/audit/nope' });
      expect(del.statusCode).toBe(404);
      expect(del.json()).toEqual({ error: 'Audit not found' });
    });
  });

  describe('helper methods', () => {
    it('storeExplanation stores explanation and clears pending; getExplanation reads it', async () => {
      const setup = await makeServer();
      server = setup.server;

      await server.inject({ method: 'POST', url: '/api/audit/register', payload: { requestId: 'helper-1', skillName: 's' } });

      const explanation = makeExplanation({ requestId: 'helper-1', skillName: 's', decision: 'approve' });
      setup.routes.storeExplanation('helper-1', explanation);

      expect(setup.routes.getExplanation('helper-1')).toEqual(explanation);
      expect(setup.routes.getExplanation('missing')).toBeUndefined();

      const res = await server.inject({ method: 'GET', url: '/api/audit/explain/helper-1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(serializeExplanation(explanation));
    });
  });
});

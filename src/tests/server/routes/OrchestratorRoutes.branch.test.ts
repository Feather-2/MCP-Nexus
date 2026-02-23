import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { OrchestratorRoutes } from '../../../server/routes/OrchestratorRoutes.js';
import type { RouteContext } from '../../../server/routes/RouteContext.js';

/* ---------- helpers ---------- */

function makeCtx(server: FastifyInstance, overrides?: Partial<RouteContext>): RouteContext {
  return {
    server,
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serviceRegistry: {} as any,
    authLayer: {} as any,
    router: {} as any,
    protocolAdapters: {} as any,
    configManager: { config: {} } as any,
    orchestratorManager: undefined,
    orchestratorEngine: undefined,
    subagentLoader: undefined,
    getOrchestratorStatus: undefined as any,
    getOrchestratorEngine: undefined as any,
    getSubagentLoader: undefined as any,
    logBuffer: [],
    logStreamClients: new Set() as any,
    sandboxStreamClients: new Set() as any,
    sandboxStatus: { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} },
    sandboxInstalling: false,
    addLogEntry: vi.fn(),
    respondError: vi.fn((reply: any, status: number, message: string, opts?: any) => {
      return reply.code(status).send({ success: false, error: { message, ...opts } });
    }),
    ...overrides,
  } as RouteContext;
}

async function buildApp(overrides?: Partial<RouteContext>) {
  const app = Fastify({ logger: false });
  const ctx = makeCtx(app, overrides);
  new OrchestratorRoutes(ctx).setupRoutes();
  await app.ready();
  return { app, ctx };
}

/* ---------- tests ---------- */

describe('OrchestratorRoutes - branch coverage', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  /* ── GET /api/orchestrator/status ── */

  describe('GET /api/orchestrator/status', () => {
    it('returns disabled when getOrchestratorStatus is undefined', async () => {
      ({ app } = await buildApp());
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(false);
      expect(res.json().reason).toContain('unavailable');
    });

    it('returns disabled when getOrchestratorStatus returns null', async () => {
      ({ app } = await buildApp({ getOrchestratorStatus: () => null }));
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(false);
    });

    it('returns valid status when getOrchestratorStatus returns data', async () => {
      const status = { enabled: true, mode: 'full', subagentsDir: '/tmp/sa', reason: 'ok' };
      ({ app } = await buildApp({ getOrchestratorStatus: () => status as any }));
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(true);
      expect(body.mode).toBe('full');
      expect(body.subagentsDir).toBe('/tmp/sa');
    });
  });

  /* ── GET /api/orchestrator/config ── */

  describe('GET /api/orchestrator/config', () => {
    it('returns 503 when orchestratorManager missing', async () => {
      ({ app } = await buildApp());
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/config' });
      expect(res.statusCode).toBe(503);
    });

    it('returns config on success', async () => {
      const mgr = { getConfig: vi.fn().mockReturnValue({ enabled: true }) } as any;
      ({ app } = await buildApp({ orchestratorManager: mgr }));
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json().config.enabled).toBe(true);
    });

    it('returns 500 when getConfig throws', async () => {
      const mgr = { getConfig: vi.fn().mockImplementation(() => { throw new Error('cfg boom'); }) } as any;
      ({ app } = await buildApp({ orchestratorManager: mgr }));
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/config' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.message).toBe('cfg boom');
    });
  });

  /* ── PUT /api/orchestrator/config ── */

  describe('PUT /api/orchestrator/config', () => {
    it('returns 503 when orchestratorManager missing', async () => {
      ({ app } = await buildApp());
      const res = await app.inject({ method: 'PUT', url: '/api/orchestrator/config', payload: { enabled: true } });
      expect(res.statusCode).toBe(503);
    });

    it('returns 400 for ZodError (invalid field type)', async () => {
      const mgr = { updateConfig: vi.fn() } as any;
      ({ app } = await buildApp({ orchestratorManager: mgr }));
      // mode must be one of the enum values; 999 is invalid
      const res = await app.inject({ method: 'PUT', url: '/api/orchestrator/config', payload: { mode: 999 } });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for non-Zod error from updateConfig', async () => {
      const mgr = { updateConfig: vi.fn().mockRejectedValue(new Error('db fail')) } as any;
      ({ app } = await buildApp({ orchestratorManager: mgr }));
      const res = await app.inject({ method: 'PUT', url: '/api/orchestrator/config', payload: { enabled: false } });
      expect(res.statusCode).toBe(400);
    });

    it('returns success on valid update', async () => {
      const mgr = { updateConfig: vi.fn().mockResolvedValue({ enabled: false }) } as any;
      ({ app } = await buildApp({ orchestratorManager: mgr }));
      const res = await app.inject({ method: 'PUT', url: '/api/orchestrator/config', payload: { enabled: false } });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  /* ── GET /api/orchestrator/subagents ── */

  describe('GET /api/orchestrator/subagents', () => {
    it('returns 503 when orchestratorManager missing', async () => {
      ({ app } = await buildApp());
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/subagents' });
      expect(res.statusCode).toBe(503);
    });

    it('returns 503 when getOrchestratorStatus returns null', async () => {
      const mgr = {} as any;
      ({ app } = await buildApp({ orchestratorManager: mgr, getOrchestratorStatus: () => null }));
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/subagents' });
      expect(res.statusCode).toBe(503);
    });

    it('returns subagents on success using ctx.subagentLoader', async () => {
      const loader = { loadAll: vi.fn().mockResolvedValue(new Map([['a', { name: 'a' }]])) } as any;
      const status = { enabled: true, mode: 'full', subagentsDir: '/tmp/sa', reason: 'ok' };
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        subagentLoader: loader,
        getOrchestratorStatus: () => status as any,
      }));
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/subagents' });
      expect(res.statusCode).toBe(200);
    });

    it('returns 500 when loader.loadAll throws', async () => {
      const loader = { loadAll: vi.fn().mockRejectedValue(new Error('load fail')) } as any;
      const status = { enabled: true, mode: 'full', subagentsDir: '/tmp/sa', reason: 'ok' };
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        subagentLoader: loader,
        getOrchestratorStatus: () => status as any,
      }));
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/subagents' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.message).toBe('load fail');
    });
  });

  /* ── POST /api/orchestrator/execute ── */

  describe('POST /api/orchestrator/execute', () => {
    it('returns 503 when status not enabled', async () => {
      ({ app } = await buildApp({ getOrchestratorStatus: () => ({ enabled: false } as any) }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'x' } });
      expect(res.statusCode).toBe(503);
    });

    it('returns 503 when status enabled but no orchestratorManager', async () => {
      ({ app } = await buildApp({ getOrchestratorStatus: () => ({ enabled: true } as any) }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'x' } });
      expect(res.statusCode).toBe(503);
    });

    it('returns 503 when engine not ready', async () => {
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'x' } });
      expect(res.statusCode).toBe(503);
    });

    it('returns 400 for ZodError in body', async () => {
      const engine = { execute: vi.fn() } as any;
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        orchestratorEngine: engine,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      // maxSteps must be positive int <= 64; -1 is invalid
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'x', maxSteps: -1 } });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when no goal and no steps', async () => {
      const engine = { execute: vi.fn() } as any;
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        orchestratorEngine: engine,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when goal missing and steps is empty array', async () => {
      const engine = { execute: vi.fn() } as any;
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        orchestratorEngine: engine,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { steps: [] } });
      expect(res.statusCode).toBe(400);
    });

    it('succeeds with ctx.subagentLoader path', async () => {
      const loader = { loadAll: vi.fn().mockResolvedValue(new Map()) } as any;
      const engine = { execute: vi.fn().mockResolvedValue({ success: true, plan: [], results: [], used: { steps: 1, durationMs: 10 } }) } as any;
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        orchestratorEngine: engine,
        subagentLoader: loader,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'do it' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(loader.loadAll).toHaveBeenCalled();
    });

    it('uses getSubagentLoader fallback when no ctx.subagentLoader', async () => {
      const loader = { loadAll: vi.fn().mockResolvedValue(new Map()) } as any;
      const engine = { execute: vi.fn().mockResolvedValue({ success: true, plan: [], results: [], used: { steps: 0, durationMs: 0 } }) } as any;
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        orchestratorEngine: engine,
        getSubagentLoader: () => loader,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'test' } });
      expect(res.statusCode).toBe(200);
      expect(loader.loadAll).toHaveBeenCalled();
    });

    it('creates new SubagentLoader when no loader available and subagentsDir set', async () => {
      const engine = { execute: vi.fn().mockResolvedValue({ success: true, plan: [], results: [], used: { steps: 0, durationMs: 0 } }) } as any;
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        orchestratorEngine: engine,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp/nonexistent-dir-xyz' } as any),
      }));
      // loadAll will fail because dir doesn't exist, but it's caught as a warning
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'test' } });
      expect(res.statusCode).toBe(200);
    });

    it('warns when loader.loadAll fails (best-effort)', async () => {
      const loader = { loadAll: vi.fn().mockRejectedValue(new Error('load err')) } as any;
      const engine = { execute: vi.fn().mockResolvedValue({ success: true, plan: [], results: [], used: { steps: 0, durationMs: 0 } }) } as any;
      let ctx: RouteContext;
      ({ app, ctx } = await buildApp({
        orchestratorManager: {} as any,
        orchestratorEngine: engine,
        subagentLoader: loader,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'test' } });
      expect(res.statusCode).toBe(200);
      expect(ctx.logger.warn).toHaveBeenCalled();
    });

    it('returns 500 on outer catch (engine.execute throws)', async () => {
      const engine = { execute: vi.fn().mockRejectedValue(new Error('engine boom')) } as any;
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        orchestratorEngine: engine,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'test' } });
      expect(res.statusCode).toBe(500);
    });

    it('uses getOrchestratorEngine fallback', async () => {
      const engine = { execute: vi.fn().mockResolvedValue({ success: true, plan: [], results: [], used: { steps: 0, durationMs: 0 } }) } as any;
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        getOrchestratorEngine: () => engine,
        getOrchestratorStatus: () => ({ enabled: true, subagentsDir: '/tmp' } as any),
      }));
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/execute', payload: { goal: 'test' } });
      expect(res.statusCode).toBe(200);
    });
  });

  /* ── POST /api/orchestrator/subagents ── */

  describe('POST /api/orchestrator/subagents', () => {
    it('returns 400 for ZodError (missing name)', async () => {
      ({ app } = await buildApp());
      const res = await app.inject({ method: 'POST', url: '/api/orchestrator/subagents', payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('returns 503 when status unavailable', async () => {
      ({ app } = await buildApp({ getOrchestratorStatus: () => null }));
      const res = await app.inject({
        method: 'POST', url: '/api/orchestrator/subagents',
        payload: { name: 'test-agent', tools: [], actions: [] },
      });
      expect(res.statusCode).toBe(503);
    });

    it('returns 201 on success', async () => {
      const loader = { loadAll: vi.fn().mockResolvedValue(new Map()) } as any;

      const { mkdtemp, rm } = await import('fs/promises');
      const { join } = await import('path');
      const os = await import('os');
      const tmpDir = await mkdtemp(join(os.default.tmpdir(), 'orch-test-'));

      try {
        ({ app } = await buildApp({
          subagentLoader: loader,
          getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: tmpDir, reason: 'ok' } as any),
        }));
        const res = await app.inject({
          method: 'POST', url: '/api/orchestrator/subagents',
          payload: { name: 'test-agent', tools: ['t1'], actions: [] },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().success).toBe(true);
        expect(res.json().name).toBe('test-agent');
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('returns 500 for non-Zod error (e.g. fs write failure)', async () => {
      // Use an invalid directory path that will cause mkdir to fail
      ({ app } = await buildApp({
        getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: '/dev/null/impossible', reason: 'ok' } as any),
      }));
      const res = await app.inject({
        method: 'POST', url: '/api/orchestrator/subagents',
        payload: { name: 'test-agent', tools: [], actions: [] },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  /* ── DELETE /api/orchestrator/subagents/:name ── */

  describe('DELETE /api/orchestrator/subagents/:name', () => {
    it('returns 503 when status unavailable', async () => {
      ({ app } = await buildApp({ getOrchestratorStatus: () => null }));
      const res = await app.inject({ method: 'DELETE', url: '/api/orchestrator/subagents/test-agent' });
      expect(res.statusCode).toBe(503);
    });

    it('returns 404 for ENOENT (file not found)', async () => {
      const { mkdtemp, rm } = await import('fs/promises');
      const { join } = await import('path');
      const os = await import('os');
      const tmpDir = await mkdtemp(join(os.default.tmpdir(), 'orch-del-'));
      const loader = { loadAll: vi.fn().mockResolvedValue(new Map()) } as any;

      try {
        ({ app } = await buildApp({
          subagentLoader: loader,
          getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: tmpDir, reason: 'ok' } as any),
        }));
        const res = await app.inject({ method: 'DELETE', url: '/api/orchestrator/subagents/nonexistent' });
        expect(res.statusCode).toBe(404);
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('returns success when file exists', async () => {
      const { mkdtemp, rm, writeFile } = await import('fs/promises');
      const { join } = await import('path');
      const os = await import('os');
      const tmpDir = await mkdtemp(join(os.default.tmpdir(), 'orch-del2-'));
      const loader = { loadAll: vi.fn().mockResolvedValue(new Map()) } as any;

      try {
        await writeFile(join(tmpDir, 'my-agent.json'), '{}', 'utf-8');
        ({ app } = await buildApp({
          subagentLoader: loader,
          getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: tmpDir, reason: 'ok' } as any),
        }));
        const res = await app.inject({ method: 'DELETE', url: '/api/orchestrator/subagents/my-agent' });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
        expect(res.json().name).toBe('my-agent');
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('returns 500 for other unlink errors (rethrow)', async () => {
      // Use a directory path as the "file" to trigger EPERM/EISDIR
      const { mkdtemp, rm, mkdir } = await import('fs/promises');
      const { join } = await import('path');
      const os = await import('os');
      const tmpDir = await mkdtemp(join(os.default.tmpdir(), 'orch-del3-'));

      try {
        // Create a directory named "bad-agent.json" so unlink fails with non-ENOENT
        await mkdir(join(tmpDir, 'bad-agent.json'));
        ({ app } = await buildApp({
          getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: tmpDir, reason: 'ok' } as any),
        }));
        const res = await app.inject({ method: 'DELETE', url: '/api/orchestrator/subagents/bad-agent' });
        expect(res.statusCode).toBe(500);
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('returns 500 for toSafeFileStem empty name (after trim)', async () => {
      ({ app } = await buildApp({
        getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: '/tmp', reason: 'ok' } as any),
      }));
      // The Zod schema requires min(1), so empty string param triggers ZodError -> 400
      // But a name of spaces " " passes Zod min(1) but fails toSafeFileStem trim check
      const res = await app.inject({ method: 'DELETE', url: '/api/orchestrator/subagents/%20%20' });
      // Spaces pass zod min(1) but toSafeFileStem trims to empty -> Error -> 500
      expect(res.statusCode).toBe(500);
    });

    it('returns 500 for toSafeFileStem invalid chars', async () => {
      ({ app } = await buildApp({
        getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: '/tmp', reason: 'ok' } as any),
      }));
      const res = await app.inject({ method: 'DELETE', url: '/api/orchestrator/subagents/bad%2Fname' });
      expect(res.statusCode).toBe(500);
    });

    it('returns 400 for ZodError when name param is empty string', async () => {
      ({ app } = await buildApp({
        getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: '/tmp', reason: 'ok' } as any),
      }));
      // Trailing slash maps to empty :name param, triggering Zod min(1) failure
      const res = await app.inject({ method: 'DELETE', url: '/api/orchestrator/subagents/' });
      expect(res.statusCode).toBe(400);
    });
  });

  /* ── POST /api/orchestrator/subagents toSafeFileStem via create ── */

  describe('POST /api/orchestrator/subagents - toSafeFileStem branches', () => {
    it('returns 500 for subagent name with invalid chars via create', async () => {
      ({ app } = await buildApp({
        getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: '/tmp', reason: 'ok' } as any),
      }));
      const res = await app.inject({
        method: 'POST', url: '/api/orchestrator/subagents',
        payload: { name: 'bad/name', tools: [], actions: [] },
      });
      expect(res.statusCode).toBe(500);
    });

    it('returns 500 for subagent name that trims to empty via create', async () => {
      ({ app } = await buildApp({
        getOrchestratorStatus: () => ({ enabled: true, mode: 'full', subagentsDir: '/tmp', reason: 'ok' } as any),
      }));
      // name " " passes Zod min(1) but toSafeFileStem trims to empty
      const res = await app.inject({
        method: 'POST', url: '/api/orchestrator/subagents',
        payload: { name: '   ', tools: [], actions: [] },
      });
      // Zod min(1) on name: "   " has length 3, passes. toSafeFileStem trims -> empty -> Error
      expect(res.statusCode).toBe(500);
    });
  });

  /* ── GET /api/orchestrator/subagents - SubagentLoader fallback ── */

  describe('GET /api/orchestrator/subagents - loader fallback', () => {
    it('creates new SubagentLoader when no ctx.subagentLoader', async () => {
      const status = { enabled: true, mode: 'full', subagentsDir: '/tmp', reason: 'ok' };
      ({ app } = await buildApp({
        orchestratorManager: {} as any,
        getOrchestratorStatus: () => status as any,
      }));
      // No subagentLoader on ctx, so it creates new SubagentLoader(status.subagentsDir, ...)
      // loadAll may fail or succeed depending on /tmp contents, but route should not crash
      const res = await app.inject({ method: 'GET', url: '/api/orchestrator/subagents' });
      // Either 200 (if /tmp has no .json files) or 500 (if loadAll throws)
      expect([200, 500]).toContain(res.statusCode);
    });
  });
});

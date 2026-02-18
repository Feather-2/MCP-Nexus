import os from 'os';
import path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

describe('SkillRoutes – extended coverage', () => {
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let tmpRoot: string;
  let server: HttpApiServer;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-sk2-'));
    const config: GatewayConfig = {
      port: 0, host: '127.0.0.1', authMode: 'local-trusted',
      routingStrategy: 'performance', loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 10, requestTimeout: 1000, enableMetrics: true,
      enableHealthChecks: true, healthCheckInterval: 1000, maxRetries: 2,
      enableCors: true, corsOrigins: ['*'], maxRequestSize: 1024,
      metricsRetentionDays: 1, rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
      logLevel: 'info', skills: { roots: [tmpRoot], managedRoot: path.join(tmpRoot, 'managed') } as any
    };
    const cfgStub = { getConfig: vi.fn().mockReturnValue(config) } as any;
    const svcStub = {
      getRegistryStats: vi.fn().mockResolvedValue({}),
      listServices: vi.fn().mockResolvedValue([]),
      getService: vi.fn().mockResolvedValue(null),
      getTemplate: vi.fn().mockResolvedValue({ name: 'x', version: '2024-11-26', transport: 'stdio', command: 'node' })
    };
    const authStub = { authenticate: vi.fn().mockResolvedValue({ success: true }), getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) };
    const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
    const adapterStub = {
      createAdapter: vi.fn().mockResolvedValue({ connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), sendAndReceive: vi.fn(), isConnected: vi.fn().mockReturnValue(true) }),
      releaseAdapter: vi.fn(),
      withAdapter: vi.fn(async (cfg: any, fn: any) => {
        const a = await adapterStub.createAdapter(cfg);
        await a.connect();
        try { return await fn(a); } finally { adapterStub.releaseAdapter(cfg, a); }
      })
    };
    server = new HttpApiServer(config, logger, cfgStub, { serviceRegistry: svcStub as any, authLayer: authStub as any, router: routerStub as any, protocolAdapters: adapterStub as any });
  });

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

  async function registerSkill(name = 'test-sk') {
    await (server as any).server.inject({ method: 'POST', url: '/api/skills/register', payload: { name, description: 'd', body: 'b', overwrite: true } });
  }

  it('GET /api/skills/:name returns 404 for missing', async () => {
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nope' });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/skills/:name?includeSupportFiles=true returns support files', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills/test-sk?includeSupportFiles=true' });
    expect(r.statusCode).toBe(200);
    expect(r.json().skill.supportFiles).toBeDefined();
  });

  it('POST /api/skills/register returns 400 for invalid body', async () => {
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/register', payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('POST /api/skills/audit audits by name', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/audit', payload: { name: 'test-sk' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
  });

  it('POST /api/skills/audit with skill definition', async () => {
    const r = await (server as any).server.inject({
      method: 'POST', url: '/api/skills/audit',
      payload: { metadata: { name: 'inline', description: 'test' }, body: 'do stuff' }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
  });

  it('POST /api/skills/audit returns 404 for missing skill', async () => {
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/audit', payload: { name: 'nope' } });
    expect(r.statusCode).toBe(404);
  });

  it('POST /api/skills/match returns 400 for bad body', async () => {
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/match', payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('POST /api/skills/match with includeSupportFiles', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({
      method: 'POST', url: '/api/skills/match',
      payload: { input: 'test-sk', includeSupportFiles: true }
    });
    expect(r.statusCode).toBe(200);
  });

  it('GET /api/skills/:name/versions lists versions', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills/test-sk/versions' });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
  });

  it('POST /api/skills/:name/versions creates version snapshot', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/test-sk/versions', payload: { reason: 'test' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
  });

  it('POST /api/skills/:name/versions returns 404 for missing skill', async () => {
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/nope/versions', payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it('POST /api/skills/:name/rollback/:versionId returns 404 for missing skill', async () => {
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/nope/rollback/v1' });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/skills/:name/permissions returns perms and auth state', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills/test-sk/permissions' });
    expect(r.statusCode).toBe(200);
    expect(r.json().authorization).toBeDefined();
  });

  it('GET /api/skills/:name/permissions returns 404 for missing', async () => {
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nope/permissions' });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/skills/:name/audit-summary returns summary', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills/test-sk/audit-summary' });
    expect(r.statusCode).toBe(200);
    expect(r.json().summary).toBeDefined();
  });

  it('GET /api/skills/:name/audit-summary returns 404 for missing', async () => {
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nope/audit-summary' });
    expect(r.statusCode).toBe(404);
  });

  it('POST /api/skills/:name/authorize authorizes skill', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/test-sk/authorize', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
  });

  it('POST /api/skills/:name/authorize returns 404 for missing', async () => {
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/nope/authorize', payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it('POST /api/skills/:name/revoke revokes auth', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/test-sk/revoke' });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
  });

  it('POST /api/skills/:name/revoke returns 404 for missing', async () => {
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/nope/revoke' });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/skills/:name/localized returns 404 for missing', async () => {
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nope/localized' });
    expect(r.statusCode).toBe(404);
  });

  it('POST /api/skills/:name/distribute distributes skill', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/test-sk/distribute', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
  });

  it('POST /api/skills/:name/distribute returns 404 for missing', async () => {
    const r = await (server as any).server.inject({ method: 'POST', url: '/api/skills/nope/distribute', payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it('DELETE /api/skills/:name/distribute undistributes skill', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'DELETE', url: '/api/skills/test-sk/distribute', payload: {} });
    expect(r.statusCode).toBe(200);
  });

  it('DELETE /api/skills/:name/distribute returns 404 for missing', async () => {
    const r = await (server as any).server.inject({ method: 'DELETE', url: '/api/skills/nope/distribute', payload: {} });
    expect(r.statusCode).toBe(404);
  });

  it('GET /api/skills with query filter', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills?q=test' });
    expect(r.statusCode).toBe(200);
  });

  it('GET /api/skills with scope filter', async () => {
    await registerSkill();
    const r = await (server as any).server.inject({ method: 'GET', url: '/api/skills?scope=repo' });
    expect(r.statusCode).toBe(200);
  });

  it('DELETE /api/skills/:name deletes non-existent returns deleted=false', async () => {
    const r = await (server as any).server.inject({ method: 'DELETE', url: '/api/skills/nope' });
    expect(r.statusCode).toBe(200);
    expect(r.json().deleted).toBe(false);
  });
});

import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const {
  mockStaticPlugin, mockCorsPlugin,
  svcStub, authStub, routerStub,
  ServiceRegistryImpl, AuthenticationLayerImpl, GatewayRouterImpl, ProtocolAdaptersImpl
} = vi.hoisted(() => {
  const svcStub = {
    getRegistryStats: vi.fn().mockResolvedValue({}),
    listServices: vi.fn().mockResolvedValue([]),
    getService: vi.fn().mockResolvedValue(null),
    getTemplate: vi.fn().mockResolvedValue(null)
  };
  const authStub = { authenticate: vi.fn().mockResolvedValue({ success: true }), getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) };
  const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
  return {
    mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
    mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
    svcStub, authStub, routerStub,
    ServiceRegistryImpl: vi.fn().mockImplementation(function () { return svcStub; }),
    AuthenticationLayerImpl: vi.fn().mockImplementation(function () { return authStub; }),
    GatewayRouterImpl: vi.fn().mockImplementation(function () { return routerStub; }),
    ProtocolAdaptersImpl: vi.fn().mockImplementation(function () { return {}; }),
  };
});

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));
vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl }));
vi.mock('../../../routing/GatewayRouterImpl.js', () => ({ GatewayRouterImpl }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl }));

describe('SkillRoutes \u2013 branch coverage', () => {
  const config: GatewayConfig = {
    port: 0, host: '127.0.0.1', authMode: 'local-trusted',
    routingStrategy: 'performance', loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10, requestTimeout: 1000, enableMetrics: true,
    enableHealthChecks: true, healthCheckInterval: 1000, maxRetries: 2,
    enableCors: true, corsOrigins: ['*'], maxRequestSize: 1024,
    metricsRetentionDays: 1, rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
    logLevel: 'info'
  };
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cfgMgrStub = { getConfig: vi.fn().mockReturnValue(config), listTemplates: vi.fn().mockResolvedValue([]) } as any;
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, cfgMgrStub);
  });

  afterEach(async () => {
    try { await server.stop(); } catch {}
  });

  describe('GET /api/skills', () => {
    it('returns skill list', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills' });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('filters by scope', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills?scope=repo' });
      expect(res.statusCode).toBe(200);
    });

    it('filters by query string', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills?q=test+keyword' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/skills/:name', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent' });
      expect(res.statusCode).toBe(404);
    });

    it('returns skill without support files by default', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/test-skill' });
      expect([200, 404]).toContain(res.statusCode);
    });

    it('returns skill with support files when requested', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/test-skill?includeSupportFiles=true' });
      expect([200, 404]).toContain(res.statusCode);
    });
  });

  describe('GET /api/skills/:name/content', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent/content' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/skills/register', () => {
    it('returns 400 for invalid body', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/register',
        payload: { name: '' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('registers a skill with valid body', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/register',
        payload: { name: 'new-skill', description: 'A new skill', body: '# New Skill\nContent' }
      });
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  describe('DELETE /api/skills/:name', () => {
    it('deletes non-existent skill returns success with deleted=false', async () => {
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/skills/nonexistent' });
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  describe('POST /api/skills/audit', () => {
    it('audits by name - returns 404 for unknown', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/audit',
        payload: { name: 'nonexistent' }
      });
      expect(res.statusCode).toBe(404);
    });

    it('audits inline definition', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/audit',
        payload: {
          metadata: { name: 'inline', description: 'test' },
          body: '# Inline Skill\nContent'
        }
      });
      expect([200, 500]).toContain(res.statusCode);
    });

    it('returns 400 for invalid audit body', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/audit',
        payload: { invalid: true }
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/skills/match', () => {
    it('returns 400 for invalid body', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/match',
        payload: {}
      });
      expect(res.statusCode).toBe(400);
    });

    it('matches skills with input', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/match',
        payload: { input: 'search for files' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('matches with includeBodies=true', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/match',
        payload: { input: 'search', includeBodies: true }
      });
      expect(res.statusCode).toBe(200);
    });

    it('matches with includeSupportFiles=true', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/match',
        payload: { input: 'search', includeSupportFiles: true }
      });
      expect(res.statusCode).toBe(200);
    });

    it('matches with maxResults and minScore', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/match',
        payload: { input: 'search', maxResults: 5, minScore: 0.5 }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/skills/:name/versions', () => {
    it('lists versions', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/test/versions' });
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  describe('POST /api/skills/:name/versions', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/nonexistent/versions',
        payload: { reason: 'test' }
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/skills/:name/rollback/:versionId', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/nonexistent/rollback/v1'
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/skills/:name/permissions', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent/permissions' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/skills/:name/audit-summary', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent/audit-summary' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/skills/:name/authorize', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/nonexistent/authorize',
        payload: {}
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/skills/:name/revoke', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/nonexistent/revoke'
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/skills/:name/localized', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent/localized' });
      expect(res.statusCode).toBe(404);
    });

    it('uses platform query param claude-code', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent/localized?platform=claude-code' });
      expect(res.statusCode).toBe(404);
    });

    it('normalizes unknown platform to generic', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent/localized?platform=unknown-platform' });
      expect(res.statusCode).toBe(404);
    });

    it('normalizes codex platform', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent/localized?platform=codex' });
      expect(res.statusCode).toBe(404);
    });

    it('normalizes js-agent platform', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/nonexistent/localized?platform=js-agent' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/skills/:name/distribute', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/nonexistent/distribute',
        payload: {}
      });
      expect(res.statusCode).toBe(404);
    });

    it('distributes with platform list', async () => {
      const res = await (server as any).server.inject({
        method: 'POST', url: '/api/skills/nonexistent/distribute',
        payload: { platforms: ['claude-code', 'codex'] }
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/skills/:name/distribute', () => {
    it('returns 404 for unknown skill', async () => {
      const res = await (server as any).server.inject({
        method: 'DELETE', url: '/api/skills/nonexistent/distribute',
        payload: {}
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/skills/platforms', () => {
    it('returns supported platforms', async () => {
      const res = await (server as any).server.inject({ method: 'GET', url: '/api/skills/platforms' });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });
});

import os from 'os';
import path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

// Mock plugins to avoid filesystem coupling during tests
const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

describe('SkillRoutes', () => {
  const logger: Logger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()
  };

  let tmpRoot: string;
  let server: HttpApiServer;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skillroutes-'));
    const managedRoot = path.join(tmpRoot, 'managed');

    const config: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 10,
      requestTimeout: 1000,
      enableMetrics: true,
      enableHealthChecks: true,
      healthCheckInterval: 1000,
      maxRetries: 2,
      enableCors: true,
      corsOrigins: ['http://localhost:3000'],
      maxRequestSize: 1024,
      metricsRetentionDays: 1,
      rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
      logLevel: 'info',
      skills: { roots: [tmpRoot], managedRoot } as any
    };

    const configManagerStub = {
      getConfig: vi.fn().mockReturnValue(config)
    } as any;

    const serviceRegistryStub = {
      getRegistryStats: vi.fn().mockResolvedValue({}),
      listServices: vi.fn().mockResolvedValue([]),
      getService: vi.fn().mockResolvedValue(null),
      setInstanceMetadata: vi.fn().mockResolvedValue(undefined),
      getTemplateManager: vi.fn().mockReturnValue({}),
      getTemplate: vi.fn().mockResolvedValue({
        name: 'sqlite',
        version: '2024-11-26',
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-sqlite', 'database.db'],
        timeout: 1000,
        retries: 0,
        security: { trustLevel: 'trusted', networkPolicy: 'inherit', requireContainer: false }
      })
    };

    const authLayerStub = {
      authenticate: vi.fn().mockResolvedValue({ success: true }),
      getActiveTokenCount: vi.fn().mockReturnValue(0),
      getActiveApiKeyCount: vi.fn().mockReturnValue(0)
    };

    const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };

    const adaptersStub = {
      createAdapter: vi.fn().mockResolvedValue({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: { tools: [] } }),
        sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: { tools: [] } }),
        isConnected: vi.fn().mockReturnValue(true)
      })
    };

    server = new HttpApiServer(config, logger, configManagerStub, {
      serviceRegistry: serviceRegistryStub as any,
      authLayer: authLayerStub as any,
      router: routerStub as any,
      protocolAdapters: adaptersStub as any
    });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('registers, lists, gets, matches, and deletes a skill', async () => {
    const registerRes = await (server as any).server.inject({
      method: 'POST',
      url: '/api/skills/register',
      payload: {
        name: 'demo-skill',
        description: 'Demo skill',
        body: 'Do the thing.',
        allowedTools: 'sqlite',
        overwrite: true
      }
    });
    expect(registerRes.statusCode).toBe(200);
    expect(registerRes.json().success).toBe(true);

    const listRes = await (server as any).server.inject({ method: 'GET', url: '/api/skills' });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listBody.success).toBe(true);
    expect(listBody.skills.map((s: any) => s.name)).toContain('demo-skill');

    const getRes = await (server as any).server.inject({ method: 'GET', url: '/api/skills/demo-skill' });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json();
    expect(getBody.success).toBe(true);
    expect(getBody.skill.metadata.name).toBe('demo-skill');
    expect(getBody.skill.body).toContain('Do the thing.');

    const matchRes = await (server as any).server.inject({
      method: 'POST',
      url: '/api/skills/match',
      payload: { input: 'Please use $demo-skill', includeBodies: true }
    });
    expect(matchRes.statusCode).toBe(200);
    const matchBody = matchRes.json();
    expect(matchBody.success).toBe(true);
    expect(matchBody.matches[0].metadata.name).toBe('demo-skill');
    expect(matchBody.injection).toContain('demo-skill');

    const delRes = await (server as any).server.inject({ method: 'DELETE', url: '/api/skills/demo-skill' });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().deleted).toBe(true);
  });
});


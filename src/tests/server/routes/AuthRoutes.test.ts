import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

describe('AuthRoutes', () => {
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
    // Avoid scanning host ~/.codex/skills during tests
    skills: { roots: ['__test_skills__'], managedRoot: '__test_skills_managed__' } as any
  };

  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  let server: HttpApiServer;
  let authLayerStub: any;

  beforeEach(() => {
    vi.clearAllMocks();

    const configManagerStub = {
      getConfig: vi.fn().mockReturnValue(config),
      get: vi.fn().mockResolvedValue(null),
      updateConfig: vi.fn().mockImplementation(async (patch: any) => ({ ...config, ...(patch || {}) }))
    } as any;

    const serviceRegistryStub = {
      getRegistryStats: vi.fn().mockResolvedValue({}),
      listServices: vi.fn().mockResolvedValue([]),
      getService: vi.fn().mockResolvedValue(null),
      getTemplateManager: vi.fn().mockReturnValue({}),
      setInstanceMetadata: vi.fn().mockResolvedValue(undefined)
    } as any;

    authLayerStub = {
      authenticate: vi.fn().mockResolvedValue({ success: true }),
      getActiveTokenCount: vi.fn().mockReturnValue(0),
      getActiveApiKeyCount: vi.fn().mockReturnValue(0),

      listApiKeys: vi.fn().mockReturnValue([]),
      createApiKey: vi.fn().mockResolvedValue('api-key-1'),
      deleteApiKey: vi.fn().mockResolvedValue(true),

      listTokens: vi.fn().mockReturnValue([]),
      generateToken: vi.fn().mockResolvedValue('token-1'),
      revokeToken: vi.fn().mockResolvedValue(true)
    };

    const routerStub = { getMetrics: vi.fn().mockReturnValue({}) } as any;
    const adaptersStub = {} as any;

    server = new HttpApiServer(config, logger, configManagerStub, {
      serviceRegistry: serviceRegistryStub,
      authLayer: authLayerStub,
      router: routerStub,
      protocolAdapters: adaptersStub
    });
  });

  afterEach(async () => {
    try {
      await server?.stop();
    } catch {
      // best-effort cleanup
    }
  });

  describe('GET /api/auth/apikeys', () => {
    it('successfully lists API keys', async () => {
      const apiKeys = [{ id: 'k1', name: 'key1', key: 'abc', permissions: ['read'], createdAt: 't1', lastUsed: 't2' }];
      authLayerStub.listApiKeys.mockReturnValueOnce(apiKeys);

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/auth/apikeys' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(apiKeys);
      expect(authLayerStub.listApiKeys).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when authLayer throws', async () => {
      authLayerStub.listApiKeys.mockImplementationOnce(() => {
        throw new Error('boom-list');
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/auth/apikeys' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_LIST_FAILED');
      expect(res.json().error?.message).toContain('boom-list');
    });

    it('uses fallback error message when thrown error has no message', async () => {
      authLayerStub.listApiKeys.mockImplementationOnce(() => {
        throw new Error('');
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/auth/apikeys' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_LIST_FAILED');
      expect(res.json().error?.message).toBe('Failed to list API keys');
    });
  });

  describe('POST /api/auth/apikey', () => {
    it('successfully creates an API key (201)', async () => {
      authLayerStub.createApiKey.mockResolvedValueOnce('api-key-created');

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/apikey',
        payload: { name: 'demo', permissions: ['read', 'write'] }
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ success: true, apiKey: 'api-key-created', message: 'API key created successfully' });
      expect(authLayerStub.createApiKey).toHaveBeenCalledWith('demo', ['read', 'write']);
    });

    it('returns 400 when missing name', async () => {
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/apikey',
        payload: { permissions: ['read'] }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
      expect(res.json().error?.message).toContain('name and permissions are required');
    });

    it('returns 400 when missing permissions', async () => {
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/apikey',
        payload: { name: 'demo' }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
      expect(res.json().error?.message).toContain('name and permissions are required');
    });

    it('returns 400 when permissions is not an array', async () => {
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/apikey',
        payload: { name: 'demo', permissions: 'read' }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
    });

    it('returns 500 when authLayer throws', async () => {
      authLayerStub.createApiKey.mockRejectedValueOnce(new Error('boom-create'));

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/apikey',
        payload: { name: 'demo', permissions: ['read'] }
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_CREATE_FAILED');
      expect(res.json().error?.message).toContain('boom-create');
    });

    it('uses fallback error message when thrown error has no message', async () => {
      authLayerStub.createApiKey.mockRejectedValueOnce(new Error(''));

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/apikey',
        payload: { name: 'demo', permissions: ['read'] }
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_CREATE_FAILED');
      expect(res.json().error?.message).toBe('Failed to create API key');
    });
  });

  describe('DELETE /api/auth/apikey/:key', () => {
    it('successfully deletes an API key', async () => {
      authLayerStub.deleteApiKey.mockResolvedValueOnce(true);

      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/apikey/key-1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, message: 'API key deleted successfully' });
      expect(authLayerStub.deleteApiKey).toHaveBeenCalledWith('key-1');
    });

    it('returns 400 when key is empty', async () => {
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/apikey/' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
    });

    it('returns 404 when key is not found', async () => {
      authLayerStub.deleteApiKey.mockResolvedValueOnce(false);

      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/apikey/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error?.code).toBe('NOT_FOUND');
      expect(res.json().error?.message).toContain('API key not found');
    });

    it('returns 500 when authLayer throws', async () => {
      authLayerStub.deleteApiKey.mockRejectedValueOnce(new Error('boom-delete'));

      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/apikey/key-err' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_DELETE_FAILED');
      expect(res.json().error?.message).toContain('boom-delete');
    });

    it('uses fallback error message when thrown error has no message', async () => {
      authLayerStub.deleteApiKey.mockRejectedValueOnce(new Error(''));

      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/apikey/key-err' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_DELETE_FAILED');
      expect(res.json().error?.message).toBe('Failed to delete API key');
    });
  });

  describe('GET /api/auth/tokens', () => {
    it('successfully lists tokens', async () => {
      const tokens = [{ token: 't1...', userId: 'u1', permissions: ['read'], expiresAt: 'e1', lastUsed: 'l1' }];
      authLayerStub.listTokens.mockReturnValueOnce(tokens);

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/auth/tokens' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(tokens);
      expect(authLayerStub.listTokens).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when authLayer throws', async () => {
      authLayerStub.listTokens.mockImplementationOnce(() => {
        throw new Error('boom-tokens');
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/auth/tokens' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_LIST_FAILED');
      expect(res.json().error?.message).toContain('boom-tokens');
    });

    it('uses fallback error message when thrown error has no message', async () => {
      authLayerStub.listTokens.mockImplementationOnce(() => {
        throw new Error('');
      });

      const res = await (server as any).server.inject({ method: 'GET', url: '/api/auth/tokens' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_LIST_FAILED');
      expect(res.json().error?.message).toBe('Failed to list tokens');
    });
  });

  describe('POST /api/auth/token', () => {
    it('successfully generates a token (201)', async () => {
      authLayerStub.generateToken.mockResolvedValueOnce('token-created');

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/token',
        payload: { userId: 'user-1', permissions: ['read'] }
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ success: true, token: 'token-created', message: 'Token generated successfully' });
      expect(authLayerStub.generateToken).toHaveBeenCalledWith('user-1', ['read'], 24);
    });

    it('returns 400 when missing userId', async () => {
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/token',
        payload: { permissions: ['read'] }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
      expect(res.json().error?.message).toContain('userId and permissions are required');
    });

    it('returns 400 when missing permissions', async () => {
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/token',
        payload: { userId: 'user-1' }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
      expect(res.json().error?.message).toContain('userId and permissions are required');
    });

    it('returns 400 when permissions is not an array', async () => {
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/token',
        payload: { userId: 'user-1', permissions: 'read' }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
    });

    it('supports custom expiresInHours', async () => {
      authLayerStub.generateToken.mockResolvedValueOnce('token-2h');

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/token',
        payload: { userId: 'user-1', permissions: ['read'], expiresInHours: 2 }
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().token).toBe('token-2h');
      expect(authLayerStub.generateToken).toHaveBeenCalledWith('user-1', ['read'], 2);
    });

    it('returns 500 when authLayer throws', async () => {
      authLayerStub.generateToken.mockRejectedValueOnce(new Error('boom-generate'));

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/token',
        payload: { userId: 'user-1', permissions: ['read'] }
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_TOKEN_FAILED');
      expect(res.json().error?.message).toContain('boom-generate');
    });

    it('uses fallback error message when thrown error has no message', async () => {
      authLayerStub.generateToken.mockRejectedValueOnce(new Error(''));

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/api/auth/token',
        payload: { userId: 'user-1', permissions: ['read'] }
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_TOKEN_FAILED');
      expect(res.json().error?.message).toBe('Failed to generate token');
    });
  });

  describe('DELETE /api/auth/token/:token', () => {
    it('successfully revokes a token', async () => {
      authLayerStub.revokeToken.mockResolvedValueOnce(true);

      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/token/token-1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, message: 'Token revoked successfully' });
      expect(authLayerStub.revokeToken).toHaveBeenCalledWith('token-1');
    });

    it('returns 400 when token is empty', async () => {
      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/token/' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('BAD_REQUEST');
    });

    it('returns 404 when token is not found', async () => {
      authLayerStub.revokeToken.mockResolvedValueOnce(false);

      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/token/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error?.code).toBe('NOT_FOUND');
      expect(res.json().error?.message).toContain('Token not found');
    });

    it('returns 500 when authLayer throws', async () => {
      authLayerStub.revokeToken.mockRejectedValueOnce(new Error('boom-revoke'));

      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/token/token-err' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_REVOKE_FAILED');
      expect(res.json().error?.message).toContain('boom-revoke');
    });

    it('uses fallback error message when thrown error has no message', async () => {
      authLayerStub.revokeToken.mockRejectedValueOnce(new Error(''));

      const res = await (server as any).server.inject({ method: 'DELETE', url: '/api/auth/token/token-err' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error?.code).toBe('AUTH_REVOKE_FAILED');
      expect(res.json().error?.message).toBe('Failed to revoke token');
    });
  });
});

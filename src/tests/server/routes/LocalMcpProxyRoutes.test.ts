import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';
import crypto from 'crypto';

const {
  mockStaticPlugin, mockCorsPlugin,
  serviceRegistryStub, authLayerStub, routerStub, adaptersStub,
  ServiceRegistryImpl, AuthenticationLayerImpl, GatewayRouterImpl, ProtocolAdaptersImpl
} = vi.hoisted(() => {
  const serviceRegistryStub = {
    getRegistryStats: vi.fn().mockResolvedValue({}),
    listServices: vi.fn().mockResolvedValue([]),
    getService: vi.fn().mockResolvedValue(null),
    setInstanceMetadata: vi.fn().mockResolvedValue(undefined),
    getTemplateManager: vi.fn().mockReturnValue({})
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
    }),
    releaseAdapter: vi.fn(),
    withAdapter: vi.fn()
  };
  adaptersStub.withAdapter.mockImplementation(async (config: any, fn: any) => {
    const a = await adaptersStub.createAdapter(config);
    await a.connect();
    try { return await fn(a); } finally { adaptersStub.releaseAdapter(config, a); }
  });
  return {
    mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
    mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
    serviceRegistryStub, authLayerStub, routerStub, adaptersStub,
    ServiceRegistryImpl: vi.fn().mockImplementation(function () { return serviceRegistryStub; }),
    AuthenticationLayerImpl: vi.fn().mockImplementation(function () { return authLayerStub; }),
    GatewayRouterImpl: vi.fn().mockImplementation(function () { return routerStub; }),
    ProtocolAdaptersImpl: vi.fn().mockImplementation(function () { return adaptersStub; }),
  };
});

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));
vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl }));
vi.mock('../../../routing/GatewayRouterImpl.js', () => ({ GatewayRouterImpl }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({
  ProtocolAdaptersImpl,
  sendRequest: async (adapter: any, message: any) => {
    if (typeof adapter.sendAndReceive === 'function') return adapter.sendAndReceive(message);
    await adapter.send(message);
    return adapter.receive?.();
  }
}));

describe('LocalMcpProxyRoutes - input validation and flow', () => {
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
    logLevel: 'info'
  };

  const logger: Logger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()
  };

  const configManagerStub = {
    getConfig: vi.fn().mockReturnValue(config),
    updateConfig: vi.fn(),
    get: vi.fn()
  } as any;

  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
  });

  it('rejects invalid handshake/init body with 400', async () => {
    const res = await (server as any).server.inject({
      method: 'POST',
      url: '/handshake/init',
      payload: {},
      headers: { Origin: 'http://localhost' }
    });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json.success).toBe(false);
  });

  it('completes handshake flow and lists tools', async () => {
    // Step 1: get current code
    const codeRes = await (server as any).server.inject({ method: 'GET', url: '/local-proxy/code' });
    expect(codeRes.statusCode).toBe(200);
    const { code } = codeRes.json();
    expect(code).toBeTruthy();

    const origin = 'http://localhost';
    const clientNonce = 'client-nonce';
    const codeProof = crypto.createHash('sha256').update(`${code}|${origin}|${clientNonce}`).digest('hex');

    // Step 2: init
    const initRes = await (server as any).server.inject({
      method: 'POST',
      url: '/handshake/init',
      headers: { Origin: origin },
      payload: { clientNonce, codeProof }
    });
    expect(initRes.statusCode).toBe(200);
    const init = initRes.json();
    const handshakeId = init.handshakeId as string;
    const serverNonce = init.serverNonce as string;
    expect(handshakeId).toBeTruthy();

    // Step 3: approve
    const approveRes = await (server as any).server.inject({
      method: 'POST', url: '/handshake/approve', payload: { handshakeId, approve: true }
    });
    expect(approveRes.statusCode).toBe(200);

    // Step 4: confirm (PBKDF2 key, HMAC)
    const key = crypto.pbkdf2Sync(code, Buffer.from(serverNonce, 'base64'), 200_000, 32, 'sha256');
    const data = `${origin}|${clientNonce}|${handshakeId}`;
    const response = crypto.createHmac('sha256', key).update(data).digest('base64');

    const confirmRes = await (server as any).server.inject({
      method: 'POST',
      url: '/handshake/confirm',
      headers: { Origin: origin },
      payload: { handshakeId, response }
    });
    expect(confirmRes.statusCode).toBe(200);
    const confirm = confirmRes.json();
    expect(confirm.success).toBe(true);
    expect(confirm.token).toBeTruthy();

    const token = confirm.token as string;

    // Prepare a running service for tools list
    (serviceRegistryStub.listServices as any).mockResolvedValueOnce([
      { id: 'svc-1', state: 'running', config: { name: 'mock', transport: 'http', version: '2024-11-26' } }
    ]);

    // Step 5: list tools with token
    const listRes = await (server as any).server.inject({
      method: 'GET', url: '/tools',
      headers: { Origin: origin, Authorization: `LocalMCP ${token}` }
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.success).toBe(true);
    expect(Array.isArray(list.tools)).toBe(true);
  });

  describe('POST /handshake/refresh', () => {
    const origin = 'http://localhost';

    afterEach(() => {
      vi.useRealTimers();
    });

    async function performHandshake() {
      const codeRes = await (server as any).server.inject({ method: 'GET', url: '/local-proxy/code' });
      const { code } = codeRes.json();
      const clientNonce = 'client-nonce';
      const codeProof = crypto.createHash('sha256').update(`${code}|${origin}|${clientNonce}`).digest('hex');

      const initRes = await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/init',
        headers: { Origin: origin },
        payload: { clientNonce, codeProof }
      });
      const { handshakeId, serverNonce } = initRes.json();

      await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/approve',
        payload: { handshakeId, approve: true }
      });

      const key = crypto.pbkdf2Sync(code, Buffer.from(serverNonce, 'base64'), 200_000, 32, 'sha256');
      const data = `${origin}|${clientNonce}|${handshakeId}`;
      const response = crypto.createHmac('sha256', key).update(data).digest('base64');

      const confirmRes = await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/confirm',
        headers: { Origin: origin },
        payload: { handshakeId, response }
      });
      return confirmRes.json().token as string;
    }

    it('successfully refreshes valid token', async () => {
      const token = await performHandshake();

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/refresh',
        headers: { Origin: origin, Authorization: `LocalMCP ${token}` }
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.token).toBeTruthy();
      expect(json.token).not.toBe(token);
      expect(json.expiresIn).toBe(600);

      // Old token should be invalidated
      const oldTokenRes = await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/refresh',
        headers: { Origin: origin, Authorization: `LocalMCP ${token}` }
      });
      expect(oldTokenRes.statusCode).toBe(401);
      expect(oldTokenRes.json().error.code).toBe('INVALID_TOKEN');
    });

    it('rejects refresh with expired token', async () => {
      const token = await performHandshake();

      // Enable fake timers after handshake completes
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/refresh',
        headers: { Origin: origin, Authorization: `LocalMCP ${token}` }
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects refresh without Authorization header', async () => {
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/refresh',
        headers: { Origin: origin }
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects refresh with invalid token', async () => {
      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/refresh',
        headers: { Origin: origin, Authorization: 'LocalMCP invalid-token-xyz' }
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('INVALID_TOKEN');
    });

    it('rejects refresh with wrong origin', async () => {
      const token = await performHandshake();
      const wrongOrigin = 'http://localhost:9999';

      const res = await (server as any).server.inject({
        method: 'POST',
        url: '/handshake/refresh',
        headers: { Origin: wrongOrigin, Authorization: `LocalMCP ${token}` }
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('ORIGIN_MISMATCH');
    });
  });
});

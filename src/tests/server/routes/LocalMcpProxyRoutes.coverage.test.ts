import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';
import crypto from 'crypto';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_i: any, _o: any, done?: (e?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

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
  })
};

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({ ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub) }));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({ AuthenticationLayerImpl: vi.fn().mockImplementation(() => authLayerStub) }));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({ GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub) }));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({ ProtocolAdaptersImpl: vi.fn().mockImplementation(() => adaptersStub) }));

describe('LocalMcpProxyRoutes – extended coverage', () => {
  const config: GatewayConfig = {
    port: 0, host: '127.0.0.1', authMode: 'local-trusted',
    routingStrategy: 'performance', loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10, requestTimeout: 1000, enableMetrics: true,
    enableHealthChecks: true, healthCheckInterval: 1000, maxRetries: 2,
    enableCors: true, corsOrigins: ['http://localhost:3000'], maxRequestSize: 1024,
    metricsRetentionDays: 1, rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
    logLevel: 'info'
  };
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cfgStub = { getConfig: vi.fn().mockReturnValue(config) } as any;
  let server: HttpApiServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, cfgStub);
  });

  // Helper to complete full handshake and get token
  async function getToken(origin = 'http://localhost') {
    const codeRes = await (server as any).server.inject({ method: 'GET', url: '/local-proxy/code' });
    const { code } = codeRes.json();
    const clientNonce = 'test-nonce';
    const codeProof = crypto.createHash('sha256').update(`${code}|${origin}|${clientNonce}`).digest('hex');
    const initRes = await (server as any).server.inject({
      method: 'POST', url: '/handshake/init',
      headers: { Origin: origin }, payload: { clientNonce, codeProof }
    });
    const { handshakeId, serverNonce } = initRes.json();
    await (server as any).server.inject({
      method: 'POST', url: '/handshake/approve', payload: { handshakeId, approve: true }
    });
    const key = crypto.pbkdf2Sync(code, Buffer.from(serverNonce, 'base64'), 200_000, 32, 'sha256');
    const data = `${origin}|${clientNonce}|${handshakeId}`;
    const response = crypto.createHmac('sha256', key).update(data).digest('base64');
    const confirmRes = await (server as any).server.inject({
      method: 'POST', url: '/handshake/confirm',
      headers: { Origin: origin }, payload: { handshakeId, response }
    });
    return confirmRes.json().token as string;
  }

  // ── Handshake edge cases ──

  it('handshake/init rejects missing Origin', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/handshake/init',
      payload: { clientNonce: 'x', codeProof: 'a'.repeat(64) }
    });
    expect(res.statusCode).toBe(400);
  });

  it('handshake/init rejects non-localhost origin', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/handshake/init',
      headers: { Origin: 'http://evil.com' },
      payload: { clientNonce: 'x', codeProof: 'a'.repeat(64) }
    });
    expect(res.statusCode).toBe(403);
  });

  it('handshake/init rejects wrong code proof', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/handshake/init',
      headers: { Origin: 'http://localhost' },
      payload: { clientNonce: 'x', codeProof: 'b'.repeat(64) }
    });
    expect(res.statusCode).toBe(401);
  });

  it('handshake/approve returns 404 for unknown id', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/handshake/approve',
      payload: { handshakeId: 'nonexistent' }
    });
    expect(res.statusCode).toBe(404);
  });

  it('handshake/confirm rejects unapproved handshake', async () => {
    const codeRes = await (server as any).server.inject({ method: 'GET', url: '/local-proxy/code' });
    const { code } = codeRes.json();
    const origin = 'http://localhost';
    const clientNonce = 'n';
    const codeProof = crypto.createHash('sha256').update(`${code}|${origin}|${clientNonce}`).digest('hex');
    const initRes = await (server as any).server.inject({
      method: 'POST', url: '/handshake/init',
      headers: { Origin: origin }, payload: { clientNonce, codeProof }
    });
    const { handshakeId, serverNonce } = initRes.json();
    // Skip approve
    const key = crypto.pbkdf2Sync(code, Buffer.from(serverNonce, 'base64'), 200_000, 32, 'sha256');
    const data = `${origin}|${clientNonce}|${handshakeId}`;
    const response = crypto.createHmac('sha256', key).update(data).digest('base64');
    const confirmRes = await (server as any).server.inject({
      method: 'POST', url: '/handshake/confirm',
      headers: { Origin: origin }, payload: { handshakeId, response }
    });
    expect(confirmRes.statusCode).toBe(403);
  });

  it('handshake/confirm rejects wrong origin', async () => {
    const codeRes = await (server as any).server.inject({ method: 'GET', url: '/local-proxy/code' });
    const { code } = codeRes.json();
    const origin = 'http://localhost';
    const clientNonce = 'n2';
    const codeProof = crypto.createHash('sha256').update(`${code}|${origin}|${clientNonce}`).digest('hex');
    const initRes = await (server as any).server.inject({
      method: 'POST', url: '/handshake/init',
      headers: { Origin: origin }, payload: { clientNonce, codeProof }
    });
    const { handshakeId } = initRes.json();
    await (server as any).server.inject({ method: 'POST', url: '/handshake/approve', payload: { handshakeId } });
    const confirmRes = await (server as any).server.inject({
      method: 'POST', url: '/handshake/confirm',
      headers: { Origin: 'http://127.0.0.1' },
      payload: { handshakeId, response: 'fake' }
    });
    expect(confirmRes.statusCode).toBe(403);
  });

  // ── Token validation ──

  it('/tools rejects missing auth', async () => {
    const res = await (server as any).server.inject({
      method: 'GET', url: '/tools',
      headers: { Origin: 'http://localhost' }
    });
    expect(res.statusCode).toBe(401);
  });

  it('/tools rejects invalid token', async () => {
    const res = await (server as any).server.inject({
      method: 'GET', url: '/tools',
      headers: { Origin: 'http://localhost', Authorization: 'LocalMCP badtoken' }
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Tool call ──

  it('/call works with valid token', async () => {
    const origin = 'http://localhost';
    const token = await getToken(origin);
    serviceRegistryStub.listServices.mockResolvedValueOnce([
      { id: 's1', state: 'running', config: { name: 'mock', transport: 'stdio', version: '2024-11-26' } }
    ]);
    const res = await (server as any).server.inject({
      method: 'POST', url: '/call',
      headers: { Origin: origin, Authorization: `LocalMCP ${token}` },
      payload: { tool: 'echo', params: { msg: 'hi' } }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('/call returns 404 when no service available', async () => {
    const origin = 'http://localhost';
    const token = await getToken(origin);
    const res = await (server as any).server.inject({
      method: 'POST', url: '/call',
      headers: { Origin: origin, Authorization: `LocalMCP ${token}` },
      payload: { tool: 'echo' }
    });
    expect(res.statusCode).toBe(404);
  });

  it('/call returns 400 for invalid body', async () => {
    const origin = 'http://localhost';
    const token = await getToken(origin);
    const res = await (server as any).server.inject({
      method: 'POST', url: '/call',
      headers: { Origin: origin, Authorization: `LocalMCP ${token}` },
      payload: {}
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Compatibility aliases ──

  it('/local-proxy/tools works', async () => {
    const origin = 'http://localhost';
    const token = await getToken(origin);
    serviceRegistryStub.listServices.mockResolvedValueOnce([
      { id: 's1', state: 'running', config: { name: 'm', transport: 'stdio', version: '2024-11-26' } }
    ]);
    const res = await (server as any).server.inject({
      method: 'GET', url: '/local-proxy/tools',
      headers: { Origin: origin, Authorization: `LocalMCP ${token}` }
    });
    expect(res.statusCode).toBe(200);
  });

  it('/local-proxy/call works', async () => {
    const origin = 'http://localhost';
    const token = await getToken(origin);
    serviceRegistryStub.listServices.mockResolvedValueOnce([
      { id: 's1', state: 'running', config: { name: 'm', transport: 'stdio', version: '2024-11-26' } }
    ]);
    const res = await (server as any).server.inject({
      method: 'POST', url: '/local-proxy/call',
      headers: { Origin: origin, Authorization: `LocalMCP ${token}` },
      payload: { tool: 'test' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('handshake/confirm returns 404 for unknown handshake', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/handshake/confirm',
      headers: { Origin: 'http://localhost' },
      payload: { handshakeId: 'nope', response: 'x' }
    });
    expect(res.statusCode).toBe(404);
  });

  it('handshake/approve rejects invalid body', async () => {
    const res = await (server as any).server.inject({
      method: 'POST', url: '/handshake/approve',
      payload: {}
    });
    expect(res.statusCode).toBe(400);
  });
});

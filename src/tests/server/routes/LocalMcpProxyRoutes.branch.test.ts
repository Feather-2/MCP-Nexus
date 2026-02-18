import Fastify, { FastifyInstance } from 'fastify';
import { LocalMcpProxyRoutes } from '../../../server/routes/LocalMcpProxyRoutes.js';
import { createHash, createHmac, pbkdf2Sync } from 'crypto';

function makeCtx(server: FastifyInstance, overrides?: any) {
  const pa: any = {
    createAdapter: vi.fn().mockResolvedValue({
      connect: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn().mockResolvedValue({ result: { tools: [] } }),
      sendAndReceive: vi.fn().mockResolvedValue({ result: { tools: [] } }),
    }),
    releaseAdapter: vi.fn(),
  };
  pa.withAdapter = vi.fn(async (config: any, fn: any) => {
    const a = await pa.createAdapter(config);
    await a.connect();
    try { return await fn(a); } finally { pa.releaseAdapter(config, a); }
  });
  return {
    server,
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serviceRegistry: {
      listServices: vi.fn().mockResolvedValue([]),
      getService: vi.fn().mockResolvedValue(null),
    } as any,
    authLayer: {} as any,
    router: {} as any,
    protocolAdapters: pa,
    configManager: { config: {} } as any,
    logBuffer: [],
    logStreamClients: new Set(),
    sandboxStreamClients: new Set(),
    sandboxStatus: {} as any,
    sandboxInstalling: false,
    addLogEntry: vi.fn(),
    respondError: vi.fn((reply: any, status: number, message: string, opts?: any) => {
      reply.code(status).send({ error: message, ...opts });
    }),
    ...overrides,
  };
}

describe('LocalMcpProxyRoutes - branch coverage', () => {
  let app: FastifyInstance;
  let routes: LocalMcpProxyRoutes;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(async () => {
    app = Fastify();
    ctx = makeCtx(app);
    routes = new LocalMcpProxyRoutes(ctx as any);
    routes.setupRoutes();
    await app.ready();
  });

  afterEach(async () => {
    routes.cleanup();
    await app.close();
  });

  // --- helpers to access private state ---
  function getCode(): string {
    return (routes as any).currentVerificationCode;
  }
  function getPrevCode(): string {
    return (routes as any).previousVerificationCode;
  }
  function setCode(code: string) {
    (routes as any).currentVerificationCode = code;
  }
  function setPrevCode(code: string) {
    (routes as any).previousVerificationCode = code;
  }
  function setCodeExpiry(ms: number) {
    (routes as any).codeExpiresAt = ms;
  }
  function insertHandshake(id: string, overrides?: any) {
    const hs = {
      id,
      origin: 'http://localhost:3000',
      clientNonce: 'cn1',
      serverNonce: Buffer.from('servernonce').toString('base64'),
      kdf: 'pbkdf2' as const,
      kdfParams: { iterations: 200_000, hash: 'SHA-256', length: 32 },
      approved: false,
      expiresAt: Date.now() + 60_000,
      ...overrides,
    };
    (routes as any).handshakeStore.set(id, hs);
    return hs;
  }
  function insertToken(token: string, origin: string, expiresAt?: number) {
    (routes as any).tokenStore.set(token, { origin, expiresAt: expiresAt ?? Date.now() + 600_000 });
  }
  function makeCodeProof(code: string, origin: string, clientNonce: string) {
    return createHash('sha256').update(`${code}|${origin}|${clientNonce}`).digest('hex');
  }
  function makeConfirmResponse(code: string, hs: any, handshakeId: string) {
    const key = pbkdf2Sync(code, Buffer.from(hs.serverNonce, 'base64'), hs.kdfParams.iterations, hs.kdfParams.length, 'sha256');
    const data = `${hs.origin}|${hs.clientNonce}|${handshakeId}`;
    return createHmac('sha256', key).update(data).digest('base64');
  }

  // ===== GET /local-proxy/code =====
  describe('GET /local-proxy/code', () => {
    it('returns current code and expiresIn', async () => {
      const res = await app.inject({ method: 'GET', url: '/local-proxy/code' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.code).toBe(getCode());
      expect(typeof body.expiresIn).toBe('number');
    });

    it('returns expiresIn=0 when code already expired', async () => {
      setCodeExpiry(Date.now() - 1000);
      const res = await app.inject({ method: 'GET', url: '/local-proxy/code' });
      expect(res.json().expiresIn).toBe(0);
    });
  });

  // ===== POST /handshake/init =====
  describe('POST /handshake/init', () => {
    it('returns 400 when origin header is missing', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/init',
        payload: { clientNonce: 'abc', codeProof: 'a'.repeat(64) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 403 for invalid origin', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/init',
        headers: { origin: 'http://evil.com' },
        payload: { clientNonce: 'abc', codeProof: 'a'.repeat(64) },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 400 for ZodError (bad body)', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/init',
        headers: { origin: 'http://localhost:3000' },
        payload: { clientNonce: '', codeProof: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    });

    it('returns 429 when rate limited', async () => {
      const origin = 'http://localhost:3000';
      const nonce = 'n1';
      const proof = makeCodeProof(getCode(), origin, nonce);
      // Pre-seed rate counter with 5 recent timestamps so next call exceeds limit
      const now = Date.now();
      const rc = (routes as any).rateCounters;
      rc.set(`init:${origin}`, [now - 400, now - 300, now - 200, now - 100, now - 50]);
      const res = await app.inject({
        method: 'POST', url: '/handshake/init',
        headers: { origin },
        payload: { clientNonce: nonce, codeProof: proof },
      });
      expect(res.statusCode).toBe(429);
    });

    it('returns 401 for invalid codeProof', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/init',
        headers: { origin: 'http://localhost:3000' },
        payload: { clientNonce: 'abc', codeProof: 'b'.repeat(64) },
      });
      expect(res.statusCode).toBe(401);
    });

    it('succeeds with valid current code proof', async () => {
      const origin = 'http://localhost:3000';
      const nonce = 'testnonce';
      const proof = makeCodeProof(getCode(), origin, nonce);
      const res = await app.inject({
        method: 'POST', url: '/handshake/init',
        headers: { origin },
        payload: { clientNonce: nonce, codeProof: proof },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.handshakeId).toBeDefined();
      expect(body.serverNonce).toBeDefined();
      expect(body.kdf).toBe('pbkdf2');
    });

    it('succeeds with previousVerificationCode proof', async () => {
      const origin = 'http://localhost:3000';
      const nonce = 'pn';
      const prevCode = getCode();
      // Rotate so current changes, previous = old current
      (routes as any).rotateVerificationCode();
      expect(getPrevCode()).toBe(prevCode);
      const proof = makeCodeProof(prevCode, origin, nonce);
      const res = await app.inject({
        method: 'POST', url: '/handshake/init',
        headers: { origin },
        payload: { clientNonce: nonce, codeProof: proof },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ===== POST /handshake/approve =====
  describe('POST /handshake/approve', () => {
    it('returns 400 for ZodError', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/approve',
        payload: { handshakeId: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when handshake not found', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/approve',
        payload: { handshakeId: 'nonexistent' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when handshake expired', async () => {
      insertHandshake('exp1', { expiresAt: Date.now() - 1000 });
      const res = await app.inject({
        method: 'POST', url: '/handshake/approve',
        payload: { handshakeId: 'exp1' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('approves handshake (approve=true)', async () => {
      insertHandshake('ok1');
      const res = await app.inject({
        method: 'POST', url: '/handshake/approve',
        payload: { handshakeId: 'ok1', approve: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('rejects handshake (approve=false)', async () => {
      insertHandshake('rej1');
      const res = await app.inject({
        method: 'POST', url: '/handshake/approve',
        payload: { handshakeId: 'rej1', approve: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ===== POST /handshake/confirm =====
  describe('POST /handshake/confirm', () => {
    it('returns 400 when origin missing', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        payload: { handshakeId: 'x', response: 'y' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for ZodError (bad body)', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        headers: { origin: 'http://localhost:3000' },
        payload: { handshakeId: '', response: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    });

    it('returns 404 when handshake not found', async () => {
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        headers: { origin: 'http://localhost:3000' },
        payload: { handshakeId: 'missing', response: 'resp' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when handshake expired', async () => {
      insertHandshake('cexp', { expiresAt: Date.now() - 1000, approved: true });
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        headers: { origin: 'http://localhost:3000' },
        payload: { handshakeId: 'cexp', response: 'resp' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 403 when not approved', async () => {
      insertHandshake('cna', { approved: false });
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        headers: { origin: 'http://localhost:3000' },
        payload: { handshakeId: 'cna', response: 'resp' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_APPROVED');
    });

    it('returns 403 on origin mismatch', async () => {
      insertHandshake('com', { approved: true, origin: 'http://localhost:9999' });
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        headers: { origin: 'http://localhost:3000' },
        payload: { handshakeId: 'com', response: 'resp' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ORIGIN_MISMATCH');
    });

    it('returns 401 for invalid response', async () => {
      insertHandshake('cinv', { approved: true });
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        headers: { origin: 'http://localhost:3000' },
        payload: { handshakeId: 'cinv', response: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('succeeds with valid response using current code', async () => {
      const hs = insertHandshake('cok', { approved: true });
      const resp = makeConfirmResponse(getCode(), hs, 'cok');
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        headers: { origin: 'http://localhost:3000' },
        payload: { handshakeId: 'cok', response: resp },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.token).toBeDefined();
      expect(body.expiresIn).toBe(600);
    });

    it('succeeds with previousVerificationCode path', async () => {
      const prevCode = getCode();
      (routes as any).rotateVerificationCode();
      const hs = insertHandshake('cprev', { approved: true });
      const resp = makeConfirmResponse(prevCode, hs, 'cprev');
      const res = await app.inject({
        method: 'POST', url: '/handshake/confirm',
        headers: { origin: 'http://localhost:3000' },
        payload: { handshakeId: 'cprev', response: resp },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().token).toBeDefined();
    });
  });

  // ===== GET /tools and /local-proxy/tools =====
  describe('GET /tools', () => {
    it('returns 401 when token missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/tools' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for invalid token', async () => {
      const res = await app.inject({
        method: 'GET', url: '/tools',
        headers: { authorization: 'LocalMCP badtoken', origin: 'http://localhost:3000' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 400 for ZodError on query', async () => {
      insertToken('tok1', 'http://localhost:3000');
      const res = await app.inject({
        method: 'GET', url: '/tools?serviceId=',
        headers: { authorization: 'LocalMCP tok1', origin: 'http://localhost:3000' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when no service found', async () => {
      insertToken('tok2', 'http://localhost:3000');
      const res = await app.inject({
        method: 'GET', url: '/tools',
        headers: { authorization: 'LocalMCP tok2', origin: 'http://localhost:3000' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('succeeds with sendAndReceive', async () => {
      insertToken('tok3', 'http://localhost:3000');
      ctx.serviceRegistry.listServices.mockResolvedValueOnce([{ id: 's1', state: 'running', config: {} }]);
      const res = await app.inject({
        method: 'GET', url: '/tools',
        headers: { authorization: 'LocalMCP tok3', origin: 'http://localhost:3000' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('falls back to adapter.send when sendAndReceive unavailable', async () => {
      insertToken('tok4', 'http://localhost:3000');
      ctx.serviceRegistry.listServices.mockResolvedValueOnce([{ id: 's1', state: 'running', config: {} }]);
      ctx.protocolAdapters.createAdapter.mockResolvedValueOnce({
        connect: vi.fn(),
        disconnect: vi.fn(),
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockResolvedValue({ result: { tools: ['t1'] } }),
      });
      const res = await app.inject({
        method: 'GET', url: '/tools',
        headers: { authorization: 'LocalMCP tok4', origin: 'http://localhost:3000' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('works via /local-proxy/tools alias', async () => {
      insertToken('tok5', 'http://localhost:3000');
      ctx.serviceRegistry.listServices.mockResolvedValueOnce([{ id: 's1', state: 'running', config: {} }]);
      const res = await app.inject({
        method: 'GET', url: '/local-proxy/tools',
        headers: { authorization: 'LocalMCP tok5', origin: 'http://localhost:3000' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ===== POST /call and /local-proxy/call =====
  describe('POST /call', () => {
    it('returns 401 when token missing', async () => {
      const res = await app.inject({ method: 'POST', url: '/call', payload: { tool: 'x' } });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for invalid token', async () => {
      const res = await app.inject({
        method: 'POST', url: '/call',
        headers: { authorization: 'LocalMCP bad', origin: 'http://localhost:3000' },
        payload: { tool: 'x' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 400 for ZodError on body', async () => {
      insertToken('ct1', 'http://localhost:3000');
      const res = await app.inject({
        method: 'POST', url: '/call',
        headers: { authorization: 'LocalMCP ct1', origin: 'http://localhost:3000' },
        payload: { tool: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when no service found', async () => {
      insertToken('ct2', 'http://localhost:3000');
      const res = await app.inject({
        method: 'POST', url: '/call',
        headers: { authorization: 'LocalMCP ct2', origin: 'http://localhost:3000' },
        payload: { tool: 'mytool' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('succeeds with valid call', async () => {
      insertToken('ct3', 'http://localhost:3000');
      ctx.serviceRegistry.listServices.mockResolvedValueOnce([{ id: 's1', state: 'running', config: {} }]);
      const res = await app.inject({
        method: 'POST', url: '/call',
        headers: { authorization: 'LocalMCP ct3', origin: 'http://localhost:3000' },
        payload: { tool: 'mytool', params: { a: 1 } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns 500 when adapter throws', async () => {
      insertToken('ct4', 'http://localhost:3000');
      ctx.serviceRegistry.listServices.mockResolvedValueOnce([{ id: 's1', state: 'running', config: {} }]);
      ctx.protocolAdapters.createAdapter.mockRejectedValueOnce(new Error('adapter fail'));
      const res = await app.inject({
        method: 'POST', url: '/call',
        headers: { authorization: 'LocalMCP ct4', origin: 'http://localhost:3000' },
        payload: { tool: 'mytool' },
      });
      expect(res.statusCode).toBe(500);
    });

    it('works via /local-proxy/call alias', async () => {
      insertToken('ct5', 'http://localhost:3000');
      ctx.serviceRegistry.listServices.mockResolvedValueOnce([{ id: 's1', state: 'running', config: {} }]);
      const res = await app.inject({
        method: 'POST', url: '/local-proxy/call',
        headers: { authorization: 'LocalMCP ct5', origin: 'http://localhost:3000' },
        payload: { tool: 'mytool' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ===== Private method branches =====
  describe('private method branches', () => {
    it('rotateVerificationCode sets previous and new code', () => {
      const oldCode = getCode();
      (routes as any).rotateVerificationCode();
      expect(getPrevCode()).toBe(oldCode);
      expect(getCode()).not.toBe(oldCode);
    });

    it('extractLocalMcpToken returns undefined for no auth header', () => {
      const req = { headers: {} } as any;
      expect((routes as any).extractLocalMcpToken(req)).toBeUndefined();
    });

    it('extractLocalMcpToken returns undefined for wrong prefix', () => {
      const req = { headers: { authorization: 'Bearer xyz' } } as any;
      expect((routes as any).extractLocalMcpToken(req)).toBeUndefined();
    });

    it('extractLocalMcpToken extracts token with correct prefix', () => {
      const req = { headers: { authorization: 'LocalMCP mytoken123' } } as any;
      expect((routes as any).extractLocalMcpToken(req)).toBe('mytoken123');
    });

    it('validateToken returns false when token not found', () => {
      expect((routes as any).validateToken('notoken', 'http://localhost')).toBe(false);
    });

    it('validateToken returns false on origin mismatch', () => {
      insertToken('vt1', 'http://localhost:3000');
      expect((routes as any).validateToken('vt1', 'http://localhost:9999')).toBe(false);
    });

    it('validateToken returns false and deletes expired token', () => {
      insertToken('vt2', 'http://localhost:3000', Date.now() - 1000);
      expect((routes as any).validateToken('vt2', 'http://localhost:3000')).toBe(false);
      expect((routes as any).tokenStore.has('vt2')).toBe(false);
    });

    it('validateToken returns true for valid token', () => {
      insertToken('vt3', 'http://localhost:3000');
      expect((routes as any).validateToken('vt3', 'http://localhost:3000')).toBe(true);
    });

    it('findTargetService uses getService when serviceId provided', async () => {
      ctx.serviceRegistry.getService.mockResolvedValueOnce({ id: 'svc1' });
      const svc = await (routes as any).findTargetService('svc1');
      expect(svc).toEqual({ id: 'svc1' });
      expect(ctx.serviceRegistry.getService).toHaveBeenCalledWith('svc1');
    });

    it('findTargetService falls back to first running service', async () => {
      ctx.serviceRegistry.listServices.mockResolvedValueOnce([
        { id: 'a', state: 'stopped' },
        { id: 'b', state: 'running' },
      ]);
      const svc = await (routes as any).findTargetService();
      expect(svc.id).toBe('b');
    });

    it('findTargetService returns null when no running services', async () => {
      ctx.serviceRegistry.listServices.mockResolvedValueOnce([{ id: 'a', state: 'stopped' }]);
      const svc = await (routes as any).findTargetService();
      expect(svc).toBeNull();
    });

    it('checkRateLimit allows when no recent entries', () => {
      expect((routes as any).checkRateLimit('test-key', 5, 60_000)).toBe(true);
    });

    it('checkRateLimit allows within limit', () => {
      const rc = (routes as any).rateCounters;
      rc.set('rl-key', [Date.now() - 100, Date.now() - 50]);
      expect((routes as any).checkRateLimit('rl-key', 5, 60_000)).toBe(true);
    });

    it('checkRateLimit blocks when exceeded', () => {
      const now = Date.now();
      const rc = (routes as any).rateCounters;
      rc.set('rl-full', [now - 100, now - 90, now - 80, now - 70, now - 60]);
      expect((routes as any).checkRateLimit('rl-full', 5, 60_000)).toBe(false);
    });

    it('cleanupRateCounters removes empty entries', () => {
      const rc = (routes as any).rateCounters;
      rc.set('old-key', [Date.now() - 120_000]);
      (routes as any).cleanupRateCounters();
      expect(rc.has('old-key')).toBe(false);
    });

    it('cleanupRateCounters trims old timestamps', () => {
      const rc = (routes as any).rateCounters;
      const now = Date.now();
      rc.set('mix-key', [now - 120_000, now - 100]);
      (routes as any).cleanupRateCounters();
      expect(rc.get('mix-key')).toHaveLength(1);
    });

    it('cleanup clears intervals', () => {
      // Already called in afterEach; verify no throw on double-call
      routes.cleanup();
    });
  });
});

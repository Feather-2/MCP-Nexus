import Fastify, { type FastifyInstance } from 'fastify';
import { LogRoutes } from '../../../server/routes/LogRoutes.js';
import type { RouteContext } from '../../../server/routes/RouteContext.js';

function makeCtx(server: FastifyInstance, overrides?: Partial<RouteContext>): RouteContext {
  return {
    server,
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serviceRegistry: {} as any,
    authLayer: {} as any,
    router: {} as any,
    protocolAdapters: {} as any,
    configManager: { config: {} } as any,
    logBuffer: [] as any[],
    logStreamClients: new Set(),
    sandboxStreamClients: new Set(),
    sandboxStatus: { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} },
    sandboxInstalling: false,
    addLogEntry: vi.fn(),
    respondError: vi.fn((reply: any, status: number, message: string, opts?: any) => {
      reply.code(status).send({ error: message, ...opts });
    }),
    ...overrides,
  } as RouteContext;
}

function makeMockReplyAndSocket() {
  const socketListeners: Record<string, Function[]> = {};
  const writeChunks: string[] = [];
  const mockSocket = {
    on: vi.fn((event: string, cb: Function) => {
      if (!socketListeners[event]) socketListeners[event] = [];
      socketListeners[event].push(cb);
    }),
  };
  const mockRaw = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => { writeChunks.push(chunk); return true; }),
    end: vi.fn(),
  };
  return { socketListeners, writeChunks, mockSocket, mockRaw };
}

describe('LogRoutes - branch coverage', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try { await app.close(); } catch { /* ignored */ }
  });

  // --- GET /api/logs ---

  describe('GET /api/logs', () => {
    it('returns logs with default limit (50)', async () => {
      app = Fastify();
      const logs = Array.from({ length: 60 }, (_, i) => ({ timestamp: `t${i}`, level: 'info', message: `msg${i}` }));
      const ctx = makeCtx(app, { logBuffer: logs });
      new LogRoutes(ctx).setupRoutes();

      const res = await app.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(50);
      expect(body[0].message).toBe('msg10');
    });

    it('returns logs with custom limit', async () => {
      app = Fastify();
      const logs = Array.from({ length: 20 }, (_, i) => ({ timestamp: `t${i}`, level: 'info', message: `msg${i}` }));
      const ctx = makeCtx(app, { logBuffer: logs });
      new LogRoutes(ctx).setupRoutes();

      const res = await app.inject({ method: 'GET', url: '/api/logs?limit=5' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(5);
      expect(body[0].message).toBe('msg15');
    });

    it('returns empty array when logBuffer is empty', async () => {
      app = Fastify();
      const ctx = makeCtx(app, { logBuffer: [] });
      new LogRoutes(ctx).setupRoutes();

      const res = await app.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns 400 for negative limit (ZodError)', async () => {
      app = Fastify();
      const ctx = makeCtx(app, { logBuffer: [] });
      new LogRoutes(ctx).setupRoutes();

      const res = await app.inject({ method: 'GET', url: '/api/logs?limit=-1' });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Invalid query');
      expect(body.code).toBe('BAD_REQUEST');
      expect(body.recoverable).toBe(true);
    });

    it('returns 400 for non-numeric limit (ZodError)', async () => {
      app = Fastify();
      const ctx = makeCtx(app, { logBuffer: [] });
      new LogRoutes(ctx).setupRoutes();

      const res = await app.inject({ method: 'GET', url: '/api/logs?limit=abc' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    });
    it('returns 400 for limit exceeding max (1001)', async () => {
      app = Fastify();
      const ctx = makeCtx(app, { logBuffer: [] });
      new LogRoutes(ctx).setupRoutes();

      const res = await app.inject({ method: 'GET', url: '/api/logs?limit=1001' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    });

    it('returns 500 for non-Zod error (logBuffer.slice throws)', async () => {
      app = Fastify();
      const badBuffer = { slice: () => { throw new Error('boom'); } } as any;
      const ctx = makeCtx(app, { logBuffer: badBuffer });
      new LogRoutes(ctx).setupRoutes();

      const res = await app.inject({ method: 'GET', url: '/api/logs' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('boom');
      expect(res.json().code).toBe('LOG_ERROR');
    });
  });
  // --- GET /api/logs/stream (SSE) ---
  // SSE routes never call reply.send(), so inject() hangs.
  // We test by capturing the registered handler and calling it with mocks.

  describe('GET /api/logs/stream', () => {
    let sseHandler: (request: any, reply: any) => Promise<void>;

    function setupSseHandler(ctxOverrides?: Partial<RouteContext>) {
      app = Fastify();
      let captured: any;
      const origGet = app.get.bind(app);
      (app as any).get = function (path: string, handler: any) {
        if (path === '/api/logs/stream') {
          captured = handler;
        }
        return origGet(path, handler);
      };
      const ctx = makeCtx(app, ctxOverrides);
      new LogRoutes(ctx).setupRoutes();
      sseHandler = captured;
      return ctx;
    }

    it('sends SSE headers, initial message, adds client, and sends buffered logs', async () => {
      const { socketListeners, writeChunks, mockSocket, mockRaw } = makeMockReplyAndSocket();
      const clients = new Set<any>();
      const logs = [
        { timestamp: 't1', level: 'info', message: 'old1' },
        { timestamp: 't2', level: 'warn', message: 'old2' },
      ];
      setupSseHandler({ logBuffer: logs, logStreamClients: clients as any });

      const mockReply = { raw: mockRaw } as any;
      const mockRequest = { headers: {}, socket: mockSocket } as any;
      await sseHandler(mockRequest, mockReply);

      // writeSseHeaders called writeHead
      expect(mockRaw.writeHead).toHaveBeenCalledTimes(1);
      // Initial connection message sent
      expect(writeChunks[0]).toContain('monitor');
      // Client added to set
      expect(clients.has(mockReply)).toBe(true);
      // Buffered logs sent (last 10, we have 2)
      expect(writeChunks.some(c => c.includes('old1'))).toBe(true);
      expect(writeChunks.some(c => c.includes('old2'))).toBe(true);
      // Socket listeners registered
      expect(mockSocket.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith('end', expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('sends at most 10 recent logs from buffer', async () => {
      const { writeChunks, mockSocket, mockRaw } = makeMockReplyAndSocket();
      const logs = Array.from({ length: 15 }, (_, i) => ({
        timestamp: `t${i}`, level: 'info', message: `log${i}`,
      }));
      setupSseHandler({ logBuffer: logs, logStreamClients: new Set() as any });

      await sseHandler({ headers: {}, socket: mockSocket } as any, { raw: mockRaw } as any);

      // 1 initial message + 10 buffered = 11 writes
      expect(mockRaw.write).toHaveBeenCalledTimes(11);
      // Should contain log5..log14 (last 10), not log4
      expect(writeChunks.some(c => c.includes('"log4"'))).toBe(false);
      expect(writeChunks.some(c => c.includes('"log5"'))).toBe(true);
      expect(writeChunks.some(c => c.includes('"log14"'))).toBe(true);
    });
    it('cleanup on socket close removes client from set', async () => {
      const { socketListeners, mockSocket, mockRaw } = makeMockReplyAndSocket();
      const clients = new Set<any>();
      setupSseHandler({ logBuffer: [], logStreamClients: clients as any });

      const mockReply = { raw: mockRaw } as any;
      await sseHandler({ headers: {}, socket: mockSocket } as any, mockReply);
      expect(clients.size).toBe(1);

      socketListeners['close'][0]();
      expect(clients.size).toBe(0);
    });

    it('cleanup on socket end removes client from set', async () => {
      const { socketListeners, mockSocket, mockRaw } = makeMockReplyAndSocket();
      const clients = new Set<any>();
      setupSseHandler({ logBuffer: [], logStreamClients: clients as any });

      const mockReply = { raw: mockRaw } as any;
      await sseHandler({ headers: {}, socket: mockSocket } as any, mockReply);
      expect(clients.size).toBe(1);

      socketListeners['end'][0]();
      expect(clients.size).toBe(0);
    });

    it('cleanup on socket error removes client from set', async () => {
      const { socketListeners, mockSocket, mockRaw } = makeMockReplyAndSocket();
      const clients = new Set<any>();
      setupSseHandler({ logBuffer: [], logStreamClients: clients as any });

      const mockReply = { raw: mockRaw } as any;
      await sseHandler({ headers: {}, socket: mockSocket } as any, mockReply);
      expect(clients.size).toBe(1);

      socketListeners['error'][0]();
      expect(clients.size).toBe(0);
    });
    it('catch block: writes error event and ends stream when writeSseHeaders throws', async () => {
      const { writeChunks, mockSocket, mockRaw } = makeMockReplyAndSocket();
      // Make writeSseHeaders throw by making config access throw
      const ctx = setupSseHandler({ logBuffer: [], logStreamClients: new Set() as any });
      Object.defineProperty(ctx.configManager, 'config', {
        get() { throw new Error('cfg boom'); },
      });

      await sseHandler({ headers: {}, socket: mockSocket } as any, { raw: mockRaw } as any);

      // Catch block writes error SSE event
      expect(writeChunks.some(c => c.includes('cfg boom'))).toBe(true);
      // Catch block calls reply.raw.end()
      expect(mockRaw.end).toHaveBeenCalled();
    });

    it('catch block: inner reply.raw.write failure is silently ignored', async () => {
      const { mockSocket } = makeMockReplyAndSocket();
      const ctx = setupSseHandler({ logBuffer: [], logStreamClients: new Set() as any });
      Object.defineProperty(ctx.configManager, 'config', {
        get() { throw new Error('cfg boom'); },
      });

      const failRaw = {
        writeHead: vi.fn(),
        write: vi.fn(() => { throw new Error('write also fails'); }),
        end: vi.fn(),
      };

      // Should not throw
      await sseHandler({ headers: {}, socket: mockSocket } as any, { raw: failRaw } as any);
      expect(failRaw.end).toHaveBeenCalled();
    });

    it('catch block: inner reply.raw.end failure is silently ignored', async () => {
      const { mockSocket } = makeMockReplyAndSocket();
      const ctx = setupSseHandler({ logBuffer: [], logStreamClients: new Set() as any });
      Object.defineProperty(ctx.configManager, 'config', {
        get() { throw new Error('cfg boom'); },
      });

      const failRaw = {
        writeHead: vi.fn(),
        write: vi.fn(() => { throw new Error('write fails'); }),
        end: vi.fn(() => { throw new Error('end also fails'); }),
      };

      // Should not throw even when both write and end fail
      await sseHandler({ headers: {}, socket: mockSocket } as any, { raw: failRaw } as any);
      expect(failRaw.end).toHaveBeenCalled();
    });

    it('handles empty logBuffer in stream (no buffered writes)', async () => {
      const { writeChunks, mockSocket, mockRaw } = makeMockReplyAndSocket();
      setupSseHandler({ logBuffer: [], logStreamClients: new Set() as any });

      await sseHandler({ headers: {}, socket: mockSocket } as any, { raw: mockRaw } as any);

      // Only the initial connection message, no buffered logs
      expect(mockRaw.write).toHaveBeenCalledTimes(1);
      expect(writeChunks[0]).toContain('monitor');
    });
  });
});

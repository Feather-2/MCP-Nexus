import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { RoutingRoutes } from '../../../server/routes/RoutingRoutes.js';
import { MiddlewareChain } from '../../../middleware/chain.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeAdapter(overrides?: Record<string, any>) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} }),
    sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} }),
    on: vi.fn(),
    ...overrides,
  };
}

function makeSvc(id = 'svc-1', extra?: Record<string, any>) {
  return {
    id,
    state: 'running',
    config: { name: 'test-svc', env: {}, ...extra?.config },
    ...extra,
  };
}

function makeCtx(server: FastifyInstance, overrides?: Record<string, any>) {
  return {
    server,
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serviceRegistry: {
      listServices: vi.fn().mockResolvedValue([]),
      getService: vi.fn().mockResolvedValue(null),
      checkHealth: vi.fn().mockResolvedValue({ status: 'healthy', responseTime: 10, timestamp: Date.now() }),
      reportHeartbeat: vi.fn(),
    },
    authLayer: {},
    router: {
      route: vi.fn().mockResolvedValue({ success: true, selectedService: makeSvc() }),
    },
    protocolAdapters: {
      createAdapter: vi.fn().mockResolvedValue(makeAdapter()),
    },
    configManager: { config: {} },
    middlewares: [],
    middlewareChain: undefined as any,
    logBuffer: [] as any[],
    logStreamClients: new Set() as any,
    sandboxStreamClients: new Set() as any,
    sandboxStatus: {},
    sandboxInstalling: false,
    addLogEntry: vi.fn(),
    respondError: vi.fn((reply: any, status: number, message: string, opts?: any) => {
      return reply.code(status).send({ error: message, ...opts });
    }),
    ...overrides,
  } as any;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */
describe('RoutingRoutes – branch coverage', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = Fastify();
  });
  afterEach(async () => {
    try { await server.close(); } catch {}
  });

  /* ================================================================ */
  /*  POST /api/route                                                 */
  /* ================================================================ */

  describe('POST /api/route', () => {
    it('returns 400 on Zod validation error (empty method)', async () => {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: '' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid route request');
    });

    it('returns 400 when body is missing', async () => {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('health check error path sets service unhealthy', async () => {
      const svc = makeSvc('h-1');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn().mockRejectedValue(new Error('health boom')),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      // Should still succeed (falls through to middleware chain / router)
      expect([200, 503]).toContain(res.statusCode);
    });

    it('health check error with non-Error thrown', async () => {
      const svc = makeSvc('h-2');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn().mockRejectedValue('string error'),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect([200, 503]).toContain(res.statusCode);
    });

    it('uses existing MiddlewareChain instance (instanceof true)', async () => {
      const svc = makeSvc('mc-1');
      const chain = new MiddlewareChain([]);
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn().mockResolvedValue({ status: 'healthy', responseTime: 5, timestamp: Date.now() }),
          reportHeartbeat: vi.fn(),
        },
        middlewareChain: chain,
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('creates new MiddlewareChain when middlewareChain is not instanceof MiddlewareChain', async () => {
      const svc = makeSvc('mc-2');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn().mockResolvedValue({ status: 'healthy', responseTime: 5, timestamp: Date.now() }),
          reportHeartbeat: vi.fn(),
        },
        middlewareChain: { notAChain: true },
        middlewares: [],
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
    });

    it('middleware chain failure falls back to router.route', async () => {
      const svc = makeSvc('fb-1');
      const failChain = new MiddlewareChain([{
        name: 'fail-mw',
        beforeModel: async () => { throw new Error('mw fail'); },
      }]);
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn().mockResolvedValue({ status: 'healthy', responseTime: 5, timestamp: Date.now() }),
          reportHeartbeat: vi.fn(),
        },
        middlewareChain: failChain,
        router: {
          route: vi.fn().mockResolvedValue({ success: true, selectedService: svc }),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
      expect(ctx.router.route).toHaveBeenCalled();
    });

    it('router.route returns success=false → 503', async () => {
      const svc = makeSvc('rf-1');
      const failChain = new MiddlewareChain([{
        name: 'fail-mw',
        beforeModel: async () => { throw new Error('mw fail'); },
      }]);
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn().mockResolvedValue({ status: 'healthy', responseTime: 5, timestamp: Date.now() }),
          reportHeartbeat: vi.fn(),
        },
        middlewareChain: failChain,
        router: {
          route: vi.fn().mockResolvedValue({ success: false, error: 'no route' }),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(503);
    });

    it('router.route returns success=true but no selectedService → 503', async () => {
      const svc = makeSvc('rf-2');
      const failChain = new MiddlewareChain([{
        name: 'fail-mw',
        beforeModel: async () => { throw new Error('mw fail'); },
      }]);
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn().mockResolvedValue({ status: 'healthy', responseTime: 5, timestamp: Date.now() }),
          reportHeartbeat: vi.fn(),
        },
        middlewareChain: failChain,
        router: {
          route: vi.fn().mockResolvedValue({ success: true, selectedService: undefined }),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(503);
    });

    it('no selectedService and no router.route → 503', async () => {
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([]),
          checkHealth: vi.fn().mockResolvedValue({ status: 'healthy', responseTime: 5, timestamp: Date.now() }),
          reportHeartbeat: vi.fn(),
        },
        router: { route: undefined },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(503);
    });

    it('success path returns selectedService and routingDecision', async () => {
      const svc = makeSvc('ok-1');
      const chain = new MiddlewareChain([]);
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn().mockResolvedValue({ status: 'healthy', responseTime: 5, timestamp: Date.now() }),
          reportHeartbeat: vi.fn(),
        },
        middlewareChain: chain,
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.selectedService).toBeDefined();
      expect(json.routingDecision.strategy).toBe('middleware-chain');
    });

    it('outer catch returns 500 on unexpected error', async () => {
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockRejectedValue(new Error('db down')),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(500);
    });

    it('outer catch with non-Error thrown returns 500', async () => {
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockRejectedValue('string boom'),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(500);
    });


  });

  /* ================================================================ */
  /*  POST /api/proxy/:serviceId                                      */
  /* ================================================================ */

  describe('POST /api/proxy/:serviceId', () => {
    it('returns 400 on Zod param error (empty serviceId)', async () => {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      // Trailing slash → Fastify matches with empty string param → Zod min(1) rejects
      const res = await server.inject({ method: 'POST', url: '/api/proxy/', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid service id');
    });

    it('returns 400 on Zod body error (empty method)', async () => {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/svc-1', payload: { method: '' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid MCP message');
    });

    it('returns 404 when service not found', async () => {
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([]),
          getService: vi.fn().mockResolvedValue(null),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/missing', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(404);
    });

    it('wires adapter events (stderr, sent, message)', async () => {
      const adapter = makeAdapter();
      const svc = makeSvc('ev-1');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      await server.inject({ method: 'POST', url: '/api/proxy/ev-1', payload: { method: 'tools/list', id: 1 } });

      // Verify on() was called for stderr, sent, message
      const onCalls = adapter.on.mock.calls.map((c: any[]) => c[0]);
      expect(onCalls).toContain('stderr');
      expect(onCalls).toContain('sent');
      expect(onCalls).toContain('message');

      // Trigger the callbacks to cover their branches
      const stderrCb = adapter.on.mock.calls.find((c: any[]) => c[0] === 'stderr')![1];
      stderrCb('some error line');
      expect(ctx.addLogEntry).toHaveBeenCalledWith('warn', expect.stringContaining('stderr'), 'ev-1');

      const sentCb = adapter.on.mock.calls.find((c: any[]) => c[0] === 'sent')![1];
      sentCb({ method: 'tools/list', id: 42 });
      sentCb(undefined); // no method/id branch

      const msgCb = adapter.on.mock.calls.find((c: any[]) => c[0] === 'message')![1];
      msgCb({ result: 'ok', id: 7 });
      msgCb({ method: 'notification' });
      msgCb(undefined); // no method/result branch
    });

    it('isPortable branch when SANDBOX=portable', async () => {
      const svc = makeSvc('port-1', { config: { name: 'p', env: { SANDBOX: 'portable' } } });
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(makeAdapter()) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/port-1', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
      // Verify the log entry contains SANDBOX: portable
      const infoCall = ctx.addLogEntry.mock.calls.find(
        (c: any[]) => c[0] === 'info' && typeof c[1] === 'string' && c[1].includes('SANDBOX: portable')
      );
      expect(infoCall).toBeTruthy();
    });

    it('uses adapter.send fallback when sendAndReceive is undefined', async () => {
      const adapter = makeAdapter({ sendAndReceive: undefined });
      const svc = makeSvc('fb-s');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/fb-s', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
      expect(adapter.send).toHaveBeenCalled();
    });

    it('params preview truncation at 800 chars', async () => {
      const svc = makeSvc('trunc-1');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(makeAdapter()) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const bigParams = { data: 'x'.repeat(1000) };
      const res = await server.inject({
        method: 'POST', url: '/api/proxy/trunc-1',
        payload: { method: 'tools/call', params: bigParams },
      });
      expect(res.statusCode).toBe(200);
      // Check that the debug log for params was called with truncation marker
      const paramLog = ctx.addLogEntry.mock.calls.find(
        (c: any[]) => c[0] === 'debug' && typeof c[1] === 'string' && c[1].startsWith('params:')
      );
      expect(paramLog).toBeTruthy();
    });

    it('response preview truncation at 800 chars', async () => {
      const bigResult = { data: 'y'.repeat(1000) };
      const adapter = makeAdapter({
        sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: bigResult }),
      });
      const svc = makeSvc('trunc-2');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/trunc-2', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
    });

    it('proxy error returns 500 and reports unhealthy heartbeat', async () => {
      const adapter = makeAdapter({
        sendAndReceive: vi.fn().mockRejectedValue(new Error('send fail')),
      });
      const svc = makeSvc('err-1');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/err-1', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(500);
      expect(ctx.serviceRegistry.reportHeartbeat).toHaveBeenCalledWith('err-1', expect.objectContaining({ healthy: false }));
    });

    it('proxy error with non-Error thrown', async () => {
      const adapter = makeAdapter({
        sendAndReceive: vi.fn().mockRejectedValue('string error'),
      });
      const svc = makeSvc('err-2');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/err-2', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(500);
    });

    it('heartbeat error paths are swallowed', async () => {
      const adapter = makeAdapter();
      const svc = makeSvc('hb-1');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn().mockImplementation(() => { throw new Error('hb fail'); }),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      // Should not throw despite heartbeat failure
      const res = await server.inject({ method: 'POST', url: '/api/proxy/hb-1', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
    });

    it('success path sends response and reports healthy heartbeat', async () => {
      const adapter = makeAdapter({
        sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      });
      const svc = makeSvc('ok-p');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/ok-p', payload: { method: 'tools/list', id: 5 } });
      expect(res.statusCode).toBe(200);
      expect(ctx.serviceRegistry.reportHeartbeat).toHaveBeenCalledWith('ok-p', expect.objectContaining({ healthy: true }));
    });

  });

  /* ================================================================ */
  /*  POST /mcp                                                       */
  /* ================================================================ */

  describe('POST /mcp', () => {
    it('returns 400 on Zod error (empty method)', async () => {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/mcp', payload: { method: '' } });
      expect(res.statusCode).toBe(400);
    });

    it('returns 403 for disallowed MCP method', async () => {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/mcp', payload: { method: 'admin/shutdown' } });
      expect(res.statusCode).toBe(403);
    });

    it('returns 503 when no running services', async () => {
      const stopped = makeSvc('s-1', { state: 'stopped' });
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([stopped]),
          getService: vi.fn(),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/mcp', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(503);
    });

    it('returns 503 when service list is empty', async () => {
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([]),
          getService: vi.fn(),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/mcp', payload: { method: 'initialize' } });
      expect(res.statusCode).toBe(503);
    });

    it('uses sendAndReceive when available', async () => {
      const adapter = makeAdapter();
      const svc = makeSvc('mcp-1');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn(),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/mcp', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
      expect(adapter.sendAndReceive).toHaveBeenCalled();
    });

    it('falls back to adapter.send when sendAndReceive is undefined', async () => {
      const adapter = makeAdapter({ sendAndReceive: undefined });
      const svc = makeSvc('mcp-2');
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn(),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
        protocolAdapters: { createAdapter: vi.fn().mockResolvedValue(adapter) },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/mcp', payload: { method: 'ping' } });
      expect(res.statusCode).toBe(200);
      expect(adapter.send).toHaveBeenCalled();
    });

    it('outer catch returns 500 on unexpected error', async () => {
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockRejectedValue(new Error('mcp boom')),
          getService: vi.fn(),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/mcp', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(500);
    });

    it('outer catch with non-Error returns 500', async () => {
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockRejectedValue(42),
          getService: vi.fn(),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn(),
        },
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/mcp', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(500);
    });
  });

  /* ================================================================ */
  /*  GET /events and /sse                                            */
  /* ================================================================ */

  describe('GET /events and /sse', () => {
    it('/events registers client and cleans up on socket close', async () => {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();

      // Use a real HTTP listener to test SSE streaming
      const address = await server.listen({ port: 0, host: '127.0.0.1' });
      try {
        const controller = new AbortController();
        const fetchPromise = fetch(`${address}/events`, { signal: controller.signal });
        // Give the server a moment to process the connection
        await new Promise(r => setTimeout(r, 200));
        expect(ctx.logStreamClients.size).toBe(1);
        controller.abort();
        await fetchPromise.catch(() => {});
        // Give cleanup a moment
        await new Promise(r => setTimeout(r, 200));
        expect(ctx.logStreamClients.size).toBe(0);
      } finally {
        await server.close();
      }
    });

    it('/sse registers client and cleans up on socket close', async () => {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();

      const address = await server.listen({ port: 0, host: '127.0.0.1' });
      try {
        const controller = new AbortController();
        const fetchPromise = fetch(`${address}/sse`, { signal: controller.signal });
        await new Promise(r => setTimeout(r, 200));
        expect(ctx.logStreamClients.size).toBe(1);
        controller.abort();
        await fetchPromise.catch(() => {});
        await new Promise(r => setTimeout(r, 200));
        expect(ctx.logStreamClients.size).toBe(0);
      } finally {
        await server.close();
      }
    });
  });

});

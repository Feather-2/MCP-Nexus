import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { RoutingRoutes } from '../../../server/routes/RoutingRoutes.js';
import { MiddlewareChain } from '../../../middleware/chain.js';
import type { ServiceInstance, McpServiceConfig } from '../../../types/index.js';

function makeTemplate(name: string, overrides: Partial<McpServiceConfig> = {}): McpServiceConfig {
  return { name, version: '2024-11-26', transport: 'stdio', command: 'node', args: ['-v'], timeout: 5000, retries: 1, ...overrides };
}

function makeInstance(id: string, templateName: string, state: ServiceInstance['state'] = 'running'): ServiceInstance {
  return { id, config: makeTemplate(templateName), state, startedAt: new Date(), errorCount: 0, metadata: {} };
}

function respondError(reply: any, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: any }) {
  return reply.code(status).send({ success: false, error: { message, code: opts?.code || 'INTERNAL_ERROR', recoverable: opts?.recoverable ?? false, meta: opts?.meta } });
}

describe('RoutingRoutes – branch coverage', () => {
  function makeCtx(server: any, overrides: any = {}) {
    const services = overrides.services ?? [makeInstance('svc-1', 'tpl-a')];
    const adapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      receive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      on: vi.fn(),
      ...overrides.adapter
    };
    return {
      server,
      logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      serviceRegistry: {
        listServices: vi.fn().mockResolvedValue(services),
        getService: vi.fn().mockResolvedValue(services[0] ?? null),
        checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date(), status: 'healthy', responseTime: 10 }),
        reportHeartbeat: vi.fn(),
        ...overrides.serviceRegistry
      },
      authLayer: {} as any,
      router: { route: vi.fn().mockResolvedValue({ success: false, error: 'no services' }), ...overrides.router },
      protocolAdapters: (() => {
        const pa: any = { createAdapter: vi.fn().mockResolvedValue(adapter), ...overrides.protocolAdapters };
        if (!pa.withAdapter) {
          pa.withAdapter = vi.fn(async (cfg: any, fn: any) => {
            const a = await pa.createAdapter(cfg);
            await a.connect();
            try { return await fn(a); } finally { pa.releaseAdapter?.(cfg, a); }
          });
        }
        return pa;
      })(),
      configManager: { getConfig: vi.fn().mockReturnValue({ corsOrigins: [] }), config: { corsOrigins: [] }, ...overrides.configManager },
      middlewareChain: overrides.middlewareChain ?? new MiddlewareChain([]),
      middlewares: overrides.middlewares,
      logBuffer: [],
      logStreamClients: new Set(),
      sandboxStreamClients: new Set(),
      sandboxStatus: { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} },
      sandboxInstalling: false,
      addLogEntry: vi.fn(),
      respondError,
    } as any;
  }

  // ── POST /api/route ──────────────────────────────────────

  it('selects first service when middleware chain runs without setting picked', async () => {
    const server = Fastify({ logger: false });
    try {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().selectedService.id).toBe('svc-1');
    } finally { await server.close(); }
  });

  it('falls back to router.route when middleware chain throws', async () => {
    const server = Fastify({ logger: false });
    try {
      const failChain = new MiddlewareChain([{
        name: 'fail-mw',
        beforeModel: vi.fn().mockRejectedValue(new Error('chain fail'))
      } as any]);
      const router = { route: vi.fn().mockResolvedValue({ success: true, selectedService: makeInstance('router-pick', 'tpl') }) };
      const ctx = makeCtx(server, { middlewareChain: failChain, router });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().selectedService.id).toBe('router-pick');
    } finally { await server.close(); }
  });

  it('returns 503 when middleware fails and router.route also fails', async () => {
    const server = Fastify({ logger: false });
    try {
      const failChain = new MiddlewareChain([{
        name: 'fail-mw',
        beforeModel: vi.fn().mockRejectedValue(new Error('chain fail'))
      } as any]);
      const ctx = makeCtx(server, { middlewareChain: failChain });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(503);
    } finally { await server.close(); }
  });

  it('returns 503 when middleware fails and no router.route exists', async () => {
    const server = Fastify({ logger: false });
    try {
      const failChain = new MiddlewareChain([{
        name: 'fail-mw',
        beforeModel: vi.fn().mockRejectedValue(new Error('chain fail'))
      } as any]);
      const ctx = makeCtx(server, { middlewareChain: failChain, router: {} });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(503);
    } finally { await server.close(); }
  });

  it('returns 500 when listServices throws', async () => {
    const server = Fastify({ logger: false });
    try {
      const ctx = makeCtx(server, { serviceRegistry: { listServices: vi.fn().mockRejectedValue(new Error('db down')), checkHealth: vi.fn() } });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(500);
    } finally { await server.close(); }
  });

  it('catches health check errors per service and marks unhealthy', async () => {
    const server = Fastify({ logger: false });
    try {
      const ctx = makeCtx(server, {
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([makeInstance('s1', 't1')]),
          checkHealth: vi.fn().mockRejectedValue(new Error('probe fail'))
        }
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(res.statusCode).toBe(200);
    } finally { await server.close(); }
  });

  // ── POST /api/proxy/:serviceId ──────────────────────────

  it('proxies request successfully via sendAndReceive', async () => {
    const server = Fastify({ logger: false });
    try {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({
        method: 'POST', url: '/api/proxy/svc-1',
        payload: { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 42 }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toBeDefined();
    } finally { await server.close(); }
  });

  it('proxies via send() when sendAndReceive is unavailable', async () => {
    const server = Fastify({ logger: false });
    try {
      const ctx = makeCtx(server, { adapter: { sendAndReceive: undefined } });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({
        method: 'POST', url: '/api/proxy/svc-1',
        payload: { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }
      });
      expect(res.statusCode).toBe(200);
    } finally { await server.close(); }
  });

  it('returns 404 for unknown service', async () => {
    const server = Fastify({ logger: false });
    try {
      const ctx = makeCtx(server, { serviceRegistry: {
        listServices: vi.fn().mockResolvedValue([]),
        getService: vi.fn().mockResolvedValue(null),
        checkHealth: vi.fn()
      }});
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({
        method: 'POST', url: '/api/proxy/missing',
        payload: { jsonrpc: '2.0', method: 'tools/list', params: {} }
      });
      expect(res.statusCode).toBe(404);
    } finally { await server.close(); }
  });

  it('returns 400 for invalid MCP message body on proxy', async () => {
    const server = Fastify({ logger: false });
    try {
      const ctx = makeCtx(server);
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({ method: 'POST', url: '/api/proxy/svc-1', payload: {} });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('returns 500 and reports unhealthy heartbeat on proxy error', async () => {
    const server = Fastify({ logger: false });
    try {
      const svc = makeInstance('svc-err', 'tpl');
      const adapter = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendAndReceive: vi.fn().mockRejectedValue(new Error('adapter boom')),
        on: vi.fn()
      };
      const reportHeartbeat = vi.fn();
      const ctx = makeCtx(server, {
        services: [svc],
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat
        },
        adapter
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({
        method: 'POST', url: '/api/proxy/svc-err',
        payload: { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }
      });
      expect(res.statusCode).toBe(500);
      expect(reportHeartbeat).toHaveBeenCalledWith('svc-err', expect.objectContaining({ healthy: false }));
    } finally { await server.close(); }
  });

  it('detects portable sandbox and logs params preview truncation', async () => {
    const server = Fastify({ logger: false });
    try {
      const svc = makeInstance('svc-p', 'tpl');
      (svc.config as any).env = { SANDBOX: 'portable' };
      const bigParams = { data: 'x'.repeat(900) };
      const ctx = makeCtx(server, {
        services: [svc],
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn(),
          reportHeartbeat: vi.fn()
        }
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({
        method: 'POST', url: '/api/proxy/svc-p',
        payload: { jsonrpc: '2.0', method: 'tools/list', params: bigParams, id: 1 }
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.addLogEntry).toHaveBeenCalledWith('info', expect.stringContaining('SANDBOX: portable'), expect.any(String), expect.any(Object));
    } finally { await server.close(); }
  });

  // ── POST /mcp ──────────────────────────────────────────

  it('proxies MCP request to first running service', async () => {
    const server = Fastify({ logger: false });
    try {
      const svc = makeInstance('run-1', 'tpl', 'running');
      const ctx = makeCtx(server, {
        services: [svc],
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          getService: vi.fn().mockResolvedValue(svc),
          checkHealth: vi.fn()
        }
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({
        method: 'POST', url: '/mcp',
        payload: { jsonrpc: '2.0', method: 'tools/list', params: {} }
      });
      expect(res.statusCode).toBe(200);
    } finally { await server.close(); }
  });

  it('POST /mcp returns 500 when adapter throws', async () => {
    const server = Fastify({ logger: false });
    try {
      const svc = makeInstance('run-1', 'tpl', 'running');
      const adapter = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendAndReceive: vi.fn().mockRejectedValue(new Error('mcp boom')),
        on: vi.fn()
      };
      const ctx = makeCtx(server, {
        services: [svc],
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn()
        },
        adapter
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({
        method: 'POST', url: '/mcp',
        payload: { jsonrpc: '2.0', method: 'tools/list', params: {} }
      });
      expect(res.statusCode).toBe(500);
    } finally { await server.close(); }
  });

  it('POST /mcp via send() fallback when no sendAndReceive', async () => {
    const server = Fastify({ logger: false });
    try {
      const svc = makeInstance('run-1', 'tpl', 'running');
      const adapter = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} }),
        on: vi.fn()
      };
      const ctx = makeCtx(server, {
        services: [svc],
        serviceRegistry: {
          listServices: vi.fn().mockResolvedValue([svc]),
          checkHealth: vi.fn()
        },
        adapter
      });
      new RoutingRoutes(ctx).setupRoutes();
      const res = await server.inject({
        method: 'POST', url: '/mcp',
        payload: { jsonrpc: '2.0', method: 'initialize', params: {} }
      });
      expect(res.statusCode).toBe(200);
    } finally { await server.close(); }
  });

  // SSE endpoints (/events, /sse) write to reply.raw without reply.send(),
  // which causes inject() to hang. Covered via integration tests.
});

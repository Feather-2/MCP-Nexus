import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { MiddlewareChain } from '../../../middleware/chain.js';
import { HealthCheckMiddleware } from '../../../gateway/health-check.middleware.js';
import { LoadBalancerMiddleware } from '../../../gateway/load-balancer.middleware.js';
import { ServiceStateManager } from '../../../gateway/service-state.js';
import { RoutingRoutes } from '../../../server/routes/RoutingRoutes.js';
import { ToolRoutes } from '../../../server/routes/ToolRoutes.js';
import type { McpServiceConfig, ServiceInstance } from '../../../types/index.js';

function makeTemplate(name: string, overrides: Partial<McpServiceConfig> = {}): McpServiceConfig {
  return {
    name,
    version: '2024-11-26',
    transport: 'stdio',
    command: 'node',
    args: ['-v'],
    timeout: 5000,
    retries: 1,
    ...overrides
  };
}

function makeInstance(id: string, templateName: string, state: ServiceInstance['state'] = 'running'): ServiceInstance {
  return {
    id,
    config: makeTemplate(templateName),
    state,
    startedAt: new Date(),
    errorCount: 0,
    metadata: {}
  };
}

function respondError(reply: any, status: number, message: string, opts?: { code?: string; recoverable?: boolean; meta?: any }) {
  return reply.code(status).send({
    success: false,
    error: {
      message,
      code: opts?.code || 'INTERNAL_ERROR',
      recoverable: opts?.recoverable ?? false,
      meta: opts?.meta
    }
  });
}

describe('Routes middleware pipeline integration', () => {
  it('POST /api/route selects via middleware (round-robin)', async () => {
    const server = Fastify({ logger: false });
    try {

      const stateManager = new ServiceStateManager();
      const middlewareChain = new MiddlewareChain([
        new HealthCheckMiddleware(stateManager, { ttl: 0 }),
        new LoadBalancerMiddleware(stateManager, { strategy: 'round-robin' })
      ]);

      const services = [makeInstance('a', 'svc-a'), makeInstance('b', 'svc-a')];
      const serviceRegistry = {
        listServices: vi.fn().mockResolvedValue(services),
        checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() })
      } as any;

      const router = {
        getRoutingStrategy: vi.fn().mockReturnValue('round-robin'),
        getRoutingRules: vi.fn().mockReturnValue([])
      } as any;

      const ctx = {
        server,
        logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        serviceRegistry,
        authLayer: {} as any,
        router,
        protocolAdapters: {} as any,
        configManager: {} as any,
        middlewareChain,
        logBuffer: [],
        logStreamClients: new Set(),
        sandboxStreamClients: new Set(),
        sandboxStatus: { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} },
        sandboxInstalling: false,
        addLogEntry: vi.fn(),
        respondError
      } as any;

      new RoutingRoutes(ctx).setupRoutes();

      const r1 = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(r1.statusCode).toBe(200);
      expect(r1.json().selectedService.id).toBe('a');

      const r2 = await server.inject({ method: 'POST', url: '/api/route', payload: { method: 'tools/list' } });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().selectedService.id).toBe('b');
    } finally {
      await server.close();
    }
  });

  it('POST /api/tools/execute records metrics via afterTool', async () => {
    const server = Fastify({ logger: false });
    try {

      const stateManager = new ServiceStateManager();
      const middlewareChain = new MiddlewareChain([
        new LoadBalancerMiddleware(stateManager, { strategy: 'round-robin' })
      ]);

      const template = makeTemplate('my-tool');
      const serviceRegistry = {
        getTemplate: vi.fn().mockResolvedValue(template)
      } as any;

      const adapter = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', result: { ok: true } })
      };
      const protocolAdapters = {
        createAdapter: vi.fn().mockResolvedValue(adapter)
      } as any;

      const ctx = {
        server,
        logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        serviceRegistry,
        authLayer: {} as any,
        router: {} as any,
        protocolAdapters,
        configManager: {} as any,
        middlewareChain,
        logBuffer: [],
        logStreamClients: new Set(),
        sandboxStreamClients: new Set(),
        sandboxStatus: { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} },
        sandboxInstalling: false,
        addLogEntry: vi.fn(),
        respondError
      } as any;

      new ToolRoutes(ctx).setupRoutes();

      const res = await server.inject({
        method: 'POST',
        url: '/api/tools/execute',
        payload: { toolId: 'my-tool', params: { a: 1 }, options: { retries: 0 } }
      });
      expect(res.statusCode).toBe(200);

      const metrics = stateManager.getMetrics('my-tool');
      expect(metrics?.requestCount).toBe(1);
      expect(metrics?.errorCount).toBe(0);
      expect(typeof metrics?.avgResponseTime).toBe('number');
    } finally {
      await server.close();
    }
  });

  it('POST /api/tools/execute increments errorCount on tool failure', async () => {
    const server = Fastify({ logger: false });
    try {

      const stateManager = new ServiceStateManager();
      const middlewareChain = new MiddlewareChain([
        new LoadBalancerMiddleware(stateManager, { strategy: 'round-robin' })
      ]);

      const template = makeTemplate('my-tool');
      const serviceRegistry = {
        getTemplate: vi.fn().mockResolvedValue(template)
      } as any;

      const adapter = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendAndReceive: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'x', error: { message: 'boom' } })
      };
      const protocolAdapters = {
        createAdapter: vi.fn().mockResolvedValue(adapter)
      } as any;

      const ctx = {
        server,
        logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        serviceRegistry,
        authLayer: {} as any,
        router: {} as any,
        protocolAdapters,
        configManager: {} as any,
        middlewareChain,
        logBuffer: [],
        logStreamClients: new Set(),
        sandboxStreamClients: new Set(),
        sandboxStatus: { nodeReady: false, pythonReady: false, goReady: false, packagesReady: false, details: {} },
        sandboxInstalling: false,
        addLogEntry: vi.fn(),
        respondError
      } as any;

      new ToolRoutes(ctx).setupRoutes();

      const res = await server.inject({
        method: 'POST',
        url: '/api/tools/execute',
        payload: { toolId: 'my-tool', params: { a: 1 }, options: { retries: 0 } }
      });
      expect(res.statusCode).toBe(500);

      const metrics = stateManager.getMetrics('my-tool');
      expect(metrics?.requestCount).toBe(1);
      expect(metrics?.errorCount).toBe(1);
    } finally {
      await server.close();
    }
  });
});

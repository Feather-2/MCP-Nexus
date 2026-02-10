import { GatewayRouterImpl } from '../../routing/GatewayRouterImpl.js';
import type { Logger, ServiceInstance, ServiceHealth, RouteRequest } from '../../types/index.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeSvc(id: string, name: string, state = 'running'): ServiceInstance {
  return {
    id, config: { name, version: '2024-11-26', transport: 'stdio' as any, command: 'echo', timeout: 30000, retries: 3 }, state,
    startTime: new Date(), startedAt: new Date(), errorCount: 0, metadata: {}
  } as ServiceInstance;
}

function makeHealthMap(services: ServiceInstance[], status: string = 'healthy'): Map<string, ServiceHealth> {
  return new Map(services.map(s => [s.id, { status, responseTime: 10, lastCheck: new Date() } as ServiceHealth]));
}

describe('GatewayRouterImpl \u2013 branch coverage', () => {
  let router: GatewayRouterImpl;
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    router = new GatewayRouterImpl(logger, 'round-robin');
  });

  describe('evaluateCondition branches', () => {
    it('matches string condition against method', async () => {
      await router.addRoutingRule({
        name: 'string-cond', enabled: true, priority: 100,
        condition: 'tools/',
        action: { type: 'prefer', criteria: { name: 'a' } }
      });
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      const res = await router.route({
        method: 'tools/list', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('returns false for unmatched string condition', async () => {
      await router.addRoutingRule({
        name: 'no-match', enabled: true, priority: 100,
        condition: 'zzz-no-match',
        action: { type: 'deny' }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'tools/list', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('matches pathPattern with wildcard', async () => {
      await router.addRoutingRule({
        name: 'wildcard', enabled: true, priority: 100,
        condition: { pathPattern: '/api/*' },
        action: { type: 'prefer', criteria: { name: 'svc' } }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', path: '/api/users', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('matches exact pathPattern', async () => {
      await router.addRoutingRule({
        name: 'exact', enabled: true, priority: 100,
        condition: { pathPattern: '/health' },
        action: { type: 'prefer', criteria: { name: 'svc' } }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', path: '/health', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('matches headers condition', async () => {
      await router.addRoutingRule({
        name: 'headers', enabled: true, priority: 100,
        condition: { headers: { 'x-api-key': 'secret' } },
        action: { type: 'prefer', criteria: { name: 'svc' } }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', headers: { 'x-api-key': 'secret' }, availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('matches clientIp prefix condition', async () => {
      await router.addRoutingRule({
        name: 'ip', enabled: true, priority: 100,
        condition: { clientIp: '192.168' },
        action: { type: 'prefer', criteria: { name: 'svc' } }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', clientIp: '192.168.1.1', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('matches contentType condition', async () => {
      await router.addRoutingRule({
        name: 'ct', enabled: true, priority: 100,
        condition: { contentType: 'application/json' },
        action: { type: 'prefer', criteria: { name: 'svc' } }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'POST', contentType: 'application/json', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('returns false for non-string non-object condition', async () => {
      await router.addRoutingRule({
        name: 'num-cond', enabled: true, priority: 100,
        condition: 42 as any,
        action: { type: 'deny' }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });
  });

  describe('evaluateServiceFilter branches', () => {
    it('matches string criteria by name', async () => {
      await router.addRoutingRule({
        name: 'str-filter', enabled: true, priority: 100,
        condition: {},
        action: { type: 'filter', criteria: 'svc-a' }
      });
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
      expect(res.selectedService?.id).toBe('a');
    });

    it('matches version criteria', async () => {
      await router.addRoutingRule({
        name: 'ver-filter', enabled: true, priority: 100,
        condition: {},
        action: { type: 'filter', criteria: { version: '2025-03-26' } }
      });
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      svcs[1].config.version = '2025-03-26';
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
      expect(res.selectedService?.id).toBe('b');
    });

    it('matches transport criteria', async () => {
      await router.addRoutingRule({
        name: 'transport-filter', enabled: true, priority: 100,
        condition: {},
        action: { type: 'filter', criteria: { transport: 'http' } }
      });
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      svcs[0].config.transport = 'http' as any;
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('returns false for non-string non-object criteria', async () => {
      await router.addRoutingRule({
        name: 'bad-criteria', enabled: true, priority: 100,
        condition: {},
        action: { type: 'filter', criteria: 42 as any }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(false);
    });
  });

  describe('action type branches', () => {
    it('deny action removes all services', async () => {
      await router.addRoutingRule({
        name: 'deny-all', enabled: true, priority: 100,
        condition: {},
        action: { type: 'deny' }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(false);
    });

    it('reject action filters out matching services', async () => {
      await router.addRoutingRule({
        name: 'reject-b', enabled: true, priority: 100,
        condition: {},
        action: { type: 'reject', criteria: { name: 'svc-b' } }
      });
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
      expect(res.selectedService?.id).toBe('a');
    });

    it('redirect action logs target group', async () => {
      await router.addRoutingRule({
        name: 'redirect', enabled: true, priority: 100,
        condition: {},
        action: { type: 'redirect', targetServiceGroup: 'backup' }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('balance action is no-op', async () => {
      await router.addRoutingRule({
        name: 'balance', enabled: true, priority: 100,
        condition: {},
        action: { type: 'balance' }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });

    it('allow action is no-op', async () => {
      await router.addRoutingRule({
        name: 'allow', enabled: true, priority: 100,
        condition: {},
        action: { type: 'allow' }
      });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
    });
  });

  describe('strategy branches', () => {
    it('performance-based uses health metrics', async () => {
      router.setRoutingStrategy('performance-based');
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      const healthMap = new Map<string, ServiceHealth>([
        ['a', { status: 'healthy', responseTime: 500, lastCheck: new Date(), metrics: { cpu: 80, memory: 90 } } as any],
        ['b', { status: 'healthy', responseTime: 10, lastCheck: new Date(), metrics: { cpu: 10, memory: 20 } } as any]
      ]);
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: healthMap
      } as any);
      expect(res.success).toBe(true);
      expect(res.selectedService?.id).toBe('b');
    });

    it('cost-optimized uses cost metrics', async () => {
      router.setRoutingStrategy('cost-optimized');
      router.updateCostMetrics('a', { costPerRequest: 10 } as any);
      router.updateCostMetrics('b', { costPerRequest: 1 } as any);
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
      expect(res.selectedService?.id).toBe('b');
    });

    it('content-aware uses content analysis', async () => {
      router.setRoutingStrategy('content-aware');
      router.updateContentAnalysis('a', {
        supportedContentTypes: ['application/json'],
        specializedMethods: ['tools/call'],
        maxContentLength: 1024
      } as any);
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      const res = await router.route({
        method: 'tools/call', contentType: 'application/json', contentLength: 100,
        availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
      expect(res.selectedService?.id).toBe('a');
    });

    it('content-aware penalizes oversized content', async () => {
      router.setRoutingStrategy('content-aware');
      router.updateContentAnalysis('a', { maxContentLength: 100 } as any);
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      const res = await router.route({
        method: 'POST', contentLength: 9999,
        availableServices: svcs, serviceHealthMap: makeHealthMap(svcs)
      } as any);
      expect(res.success).toBe(true);
      expect(res.selectedService?.id).toBe('b');
    });

    it('returns null when all services are unhealthy', async () => {
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({
        method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs, 'unhealthy')
      } as any);
      expect(res.success).toBe(false);
    });
  });

  describe('normalizeRule with test-style input', () => {
    it('converts id/conditions/actions to standard rule', async () => {
      await router.addRoutingRule({
        id: 'test-rule',
        conditions: { method: 'tools/call' },
        actions: { routeTo: ['svc-a'] },
        priority: 50
      } as any);
      const rules = router.getRoutingRules();
      expect(rules.find(r => r.name === 'test-rule')).toBeDefined();
    });
  });

  describe('addRoutingRule validation', () => {
    it('rejects rule with missing name', async () => {
      await expect(router.addRoutingRule({ condition: {}, action: { type: 'allow' } } as any)).rejects.toThrow('missing required');
    });

    it('rejects duplicate rule name', async () => {
      await router.addRoutingRule({ name: 'dup', condition: {}, action: { type: 'allow' }, enabled: true, priority: 0 });
      await expect(router.addRoutingRule({ name: 'dup', condition: {}, action: { type: 'allow' }, enabled: true, priority: 0 })).rejects.toThrow('already exists');
    });
  });

  describe('removeRoutingRule', () => {
    it('returns false for non-existent rule', async () => {
      const result = await router.removeRoutingRule('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('disable/enable routing rule', () => {
    it('disables and enables rule', async () => {
      await router.addRoutingRule({ name: 'toggle', condition: {}, action: { type: 'allow' }, enabled: true, priority: 0 });
      router.disableRoutingRule('toggle');
      expect(router.getRoutingRules().find(r => r.name === 'toggle')?.enabled).toBe(false);
      router.enableRoutingRule('toggle');
      expect(router.getRoutingRules().find(r => r.name === 'toggle')?.enabled).toBe(true);
    });
  });

  describe('metrics and request history', () => {
    it('recordRequest and getRequestHistory', () => {
      router.recordRequest('svc-1', 50, true);
      router.recordRequest('svc-1', 100, false);
      const history = router.getRequestHistory();
      expect(history).toHaveLength(2);
    });

    it('updateRequestResult updates recent request', async () => {
      const svcs = [makeSvc('a', 'svc')];
      await router.route({ method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs) } as any);
      router.updateRequestResult('a', 42, true);
      const history = router.getRequestHistory();
      expect(history.find(r => r.responseTime === 42)).toBeDefined();
    });

    it('getServiceMetrics returns metrics', () => {
      router.updateServiceMetrics('x', { requestCount: 5 } as any);
      expect(router.getServiceMetrics('x')).toBeDefined();
    });

    it('getCostMetrics returns undefined for unknown', () => {
      expect(router.getCostMetrics('unknown')).toBeUndefined();
    });

    it('getContentAnalysis returns undefined for unknown', () => {
      expect(router.getContentAnalysis('unknown')).toBeUndefined();
    });

    it('getAllMetrics returns all service metrics', () => {
      router.updateServiceMetrics('a', { requestCount: 1 } as any);
      const all = router.getAllMetrics();
      expect(all.a).toBeDefined();
    });

    it('resetMetrics clears all', async () => {
      router.recordRequest('a', 10, true);
      router.updateServiceMetrics('a', { requestCount: 1 } as any);
      await router.resetMetrics();
      expect(router.getMetrics().totalRequests).toBe(0);
    });
  });

  describe('getRoutingReason branches', () => {
    it('round-robin reason', async () => {
      router.setRoutingStrategy('round-robin');
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({ method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs) } as any);
      expect(res.routingDecision?.reason).toContain('round-robin');
    });

    it('cost-optimized reason', async () => {
      router.setRoutingStrategy('cost-optimized');
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({ method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs) } as any);
      expect(res.routingDecision?.reason).toContain('cost');
    });

    it('content-aware reason', async () => {
      router.setRoutingStrategy('content-aware');
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({ method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs) } as any);
      expect(res.routingDecision?.reason).toContain('content');
    });
  });

  describe('route error handling', () => {
    it('returns failure when no services available', async () => {
      const res = await router.route({ method: 'GET', availableServices: [], serviceHealthMap: new Map() } as any);
      expect(res.success).toBe(false);
    });

    it('handles route() exception gracefully', async () => {
      vi.spyOn(router as any, 'applyRoutingRules').mockImplementation(() => { throw new Error('boom'); });
      const svcs = [makeSvc('a', 'svc')];
      const res = await router.route({ method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs) } as any);
      expect(res.success).toBe(false);
    });
  });

  describe('addRoute/removeRoute', () => {
    it('adds and removes route handler', () => {
      const handler = vi.fn();
      router.addRoute('/test', handler);
      router.removeRoute('/test');
      router.removeRoute('/nonexistent');
    });
  });

  describe('performance-based with successRate and preferred', () => {
    it('boosts score for preferred services', async () => {
      router.setRoutingStrategy('performance-based');
      await router.addRoutingRule({
        name: 'prefer-a', enabled: true, priority: 100,
        condition: {},
        action: { type: 'prefer', criteria: { name: 'svc-a' } }
      });
      router.updateServiceMetrics('a', { successRate: 0.5, requestCount: 10, averageResponseTime: 100, lastUsed: new Date() } as any);
      router.updateServiceMetrics('b', { successRate: 0.9, requestCount: 10, averageResponseTime: 10, lastUsed: new Date() } as any);
      const svcs = [makeSvc('a', 'svc-a'), makeSvc('b', 'svc-b')];
      const res = await router.route({ method: 'GET', availableServices: svcs, serviceHealthMap: makeHealthMap(svcs) } as any);
      expect(res.success).toBe(true);
    });
  });
});

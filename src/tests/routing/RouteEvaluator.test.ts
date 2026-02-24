import { RouteEvaluator } from '../../routing/RouteEvaluator.js';
import type { RoutingRule } from '../../types/index.js';
import {
  createLogger,
  createRouteRequest,
  createService
} from './helpers.js';

describe('routing/RouteEvaluator', () => {
  it('applies only first filter rule and skips later filter actions', () => {
    const logger = createLogger();
    const evaluator = new RouteEvaluator(logger);
    const services = [
      createService('fs-1', { name: 'filesystem-core' }),
      createService('search-1', { name: 'search-core' })
    ];
    const request = createRouteRequest(services, { method: 'files/read' });
    const rules: RoutingRule[] = [
      {
        name: 'filter-filesystem',
        enabled: true,
        condition: { method: 'files/read' },
        action: { type: 'filter', criteria: { name: 'filesystem' } }
      },
      {
        name: 'filter-search',
        enabled: true,
        condition: { method: 'files/read' },
        action: { type: 'filter', criteria: { name: 'search' } }
      }
    ];

    const result = evaluator.applyRoutingRules(request, rules);

    expect(result.filteredServices.map(service => service.id)).toEqual(['fs-1']);
    expect(result.appliedRules).toEqual(['filter-filesystem', 'filter-search']);
    expect(logger.debug).toHaveBeenCalledWith('Applied filter rule: filter-filesystem');
  });

  it('handles prefer/reject/redirect/allow/balance actions', () => {
    const logger = createLogger();
    const evaluator = new RouteEvaluator(logger);
    const services = [
      createService('search-1', { name: 'search-main' }),
      createService('search-legacy', { name: 'search-legacy' }),
      createService('misc-1', { name: 'misc-tool' })
    ];
    const request = createRouteRequest(services, { method: 'search' });
    const rules: RoutingRule[] = [
      {
        name: 'prefer-search',
        enabled: true,
        condition: 'search',
        action: { type: 'prefer', criteria: { name: 'search' } }
      },
      {
        name: 'reject-legacy',
        enabled: true,
        condition: 'search',
        action: { type: 'reject', criteria: { name: 'legacy' } }
      },
      {
        name: 'redirect-search',
        enabled: true,
        condition: 'search',
        action: { type: 'redirect', targetServiceGroup: 'search-group' }
      },
      {
        name: 'allow-all',
        enabled: true,
        condition: 'search',
        action: { type: 'allow' }
      },
      {
        name: 'balance-all',
        enabled: true,
        condition: 'search',
        action: { type: 'balance' }
      }
    ];

    const result = evaluator.applyRoutingRules(request, rules);

    expect(result.filteredServices.map(service => service.id)).toEqual(['search-1', 'misc-1']);
    expect(result.preferredServiceIds).toEqual(new Set(['search-1', 'search-legacy']));
    expect(result.appliedRules).toEqual([
      'prefer-search',
      'reject-legacy',
      'redirect-search',
      'allow-all',
      'balance-all'
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      'Redirect rule applied: redirect-search',
      { targetServiceGroup: 'search-group' }
    );
  });

  it('deny action clears all filtered services', () => {
    const logger = createLogger();
    const evaluator = new RouteEvaluator(logger);
    const services = [createService('svc-1'), createService('svc-2')];
    const request = createRouteRequest(services, { method: 'tools/call' });

    const result = evaluator.applyRoutingRules(request, [
      {
        name: 'deny-tools',
        enabled: true,
        condition: { method: 'tools/call' },
        action: { type: 'deny' }
      }
    ]);

    expect(result.filteredServices).toEqual([]);
    expect(result.appliedRules).toEqual(['deny-tools']);
  });

  it('evaluateCondition supports string/object matching, path patterns and headers', () => {
    const evaluator = new RouteEvaluator(createLogger());
    const request = createRouteRequest([createService('svc')], {
      method: 'tools/search',
      serviceGroup: 'search-group',
      contentType: 'application/json',
      clientIp: '10.0.2.5',
      path: '/api/v1/search/tools',
      headers: { 'x-env': 'prod', 'x-region': 'us-east' }
    });

    expect(evaluator.evaluateCondition('tools/search', request)).toBe(true);
    expect(evaluator.evaluateCondition('search-group', request)).toBe(true);
    expect(evaluator.evaluateCondition('not-match', request)).toBe(false);

    expect(evaluator.evaluateCondition({
      method: 'tools/search',
      serviceGroup: 'search-group',
      contentType: 'application/json',
      clientIp: '10.0',
      pathPattern: '/api/v1/search/*',
      headers: { 'x-env': 'prod' }
    }, request)).toBe(true);

    expect(evaluator.evaluateCondition({
      pathPattern: '/api/v1/search/tools'
    }, request)).toBe(true);

    expect(evaluator.evaluateCondition({
      pathPattern: '/api/v1/search/other'
    }, request)).toBe(false);

    expect(evaluator.evaluateCondition({
      headers: { 'x-env': 'staging' }
    }, request)).toBe(false);
  });

  it('evaluateServiceFilter supports string and object criteria', () => {
    const evaluator = new RouteEvaluator(createLogger());
    const service = createService('svc-search', {
      name: 'search-engine',
      config: { version: '2025-06-18', transport: 'streamable-http' }
    });

    expect(evaluator.evaluateServiceFilter('search', service)).toBe(true);
    expect(evaluator.evaluateServiceFilter('missing', service)).toBe(false);
    expect(evaluator.evaluateServiceFilter({
      name: 'search',
      version: '2025-06-18',
      transport: 'streamable-http'
    }, service)).toBe(true);
    expect(evaluator.evaluateServiceFilter({
      name: 'search',
      version: '2024-11-26'
    }, service)).toBe(false);
  });

  it('returns readable routing reasons for each strategy and fallback', () => {
    const evaluator = new RouteEvaluator(createLogger());

    expect(evaluator.getRoutingReason('round-robin')).toContain('round-robin');
    expect(evaluator.getRoutingReason('performance-based')).toContain('performance');
    expect(evaluator.getRoutingReason('cost-optimized')).toContain('cost');
    expect(evaluator.getRoutingReason('content-aware')).toContain('content');
    expect(evaluator.getRoutingReason('unknown' as never)).toContain('default');
  });
});


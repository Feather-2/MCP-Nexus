import { LoadBalancer } from '../../routing/LoadBalancer.js';
import type {
  LoadBalancingStrategy,
  ServiceContentAnalysis,
  ServiceCostMetrics,
  ServiceLoadMetrics
} from '../../types/index.js';
import {
  createHealth,
  createRouteRequest,
  createService
} from './helpers.js';

describe('routing/LoadBalancer', () => {
  let loadBalancer: LoadBalancer;

  beforeEach(() => {
    loadBalancer = new LoadBalancer();
  });

  function emptyMetrics() {
    return {
      serviceMetrics: new Map<string, ServiceLoadMetrics>(),
      costMetrics: new Map<string, ServiceCostMetrics>(),
      contentAnalysis: new Map<string, ServiceContentAnalysis>()
    };
  }

  it('returns null when all services are unhealthy in request map', () => {
    const services = [createService('a'), createService('b')];
    const request = createRouteRequest(services, {
      serviceHealthMap: new Map([
        ['a', createHealth('unhealthy')],
        ['b', createHealth('unhealthy')]
      ])
    });

    const selected = loadBalancer.selectService(
      services,
      request,
      'round-robin',
      new Map(),
      new Map(),
      new Map()
    );

    expect(selected).toBeNull();
  });

  it('returns the only healthy service immediately', () => {
    const services = [createService('a'), createService('b')];
    const request = createRouteRequest(services, {
      serviceHealthMap: new Map([
        ['a', createHealth('healthy')],
        ['b', createHealth('unhealthy')]
      ])
    });

    const selected = loadBalancer.selectService(
      services,
      request,
      'content-aware',
      new Map(),
      new Map(),
      new Map()
    );

    expect(selected?.id).toBe('a');
  });

  it('rotates services per serviceGroup with round-robin strategy', () => {
    const services = [createService('a'), createService('b')];
    const alphaReq = createRouteRequest(services, { serviceGroup: 'alpha' });
    const betaReq = createRouteRequest(services, { serviceGroup: 'beta' });
    const { serviceMetrics, costMetrics, contentAnalysis } = emptyMetrics();

    const pick1 = loadBalancer.selectService(
      services,
      alphaReq,
      'round-robin',
      serviceMetrics,
      costMetrics,
      contentAnalysis
    );
    const pick2 = loadBalancer.selectService(
      services,
      alphaReq,
      'round-robin',
      serviceMetrics,
      costMetrics,
      contentAnalysis
    );
    const pick3 = loadBalancer.selectService(
      services,
      alphaReq,
      'round-robin',
      serviceMetrics,
      costMetrics,
      contentAnalysis
    );
    const pickBeta = loadBalancer.selectService(
      services,
      betaReq,
      'round-robin',
      serviceMetrics,
      costMetrics,
      contentAnalysis
    );

    expect([pick1?.id, pick2?.id, pick3?.id]).toEqual(['a', 'b', 'a']);
    expect(pickBeta?.id).toBe('a');
  });

  it('prefers preferredServiceIds under performance-based strategy', () => {
    const services = [createService('a'), createService('b')];
    const request = createRouteRequest(services, {
      serviceHealthMap: new Map([
        ['a', createHealth('healthy', { responseTime: 100 })],
        ['b', createHealth('healthy', { responseTime: 30 })]
      ])
    });
    const serviceMetrics = new Map<string, ServiceLoadMetrics>([
      ['a', { requestCount: 10, successRate: 0.1, averageResponseTime: 100, lastUsed: new Date() }],
      ['b', { requestCount: 10, successRate: 0.2, averageResponseTime: 40, lastUsed: new Date() }]
    ]);

    const selected = loadBalancer.selectService(
      services,
      request,
      'performance-based',
      serviceMetrics,
      new Map(),
      new Map(),
      new Set(['a'])
    );

    expect(selected?.id).toBe('a');
  });

  it('selects lowest cost service and treats missing cost as 1.0', () => {
    const services = [createService('a'), createService('b')];
    const request = createRouteRequest(services);
    const costMetrics = new Map<string, ServiceCostMetrics>([
      ['a', { costPerRequest: 0.25, totalCost: 100, costEfficiency: 0.8 }]
      // b intentionally missing -> default 1.0
    ]);

    const selected = loadBalancer.selectService(
      services,
      request,
      'cost-optimized',
      new Map(),
      costMetrics,
      new Map()
    );

    expect(selected?.id).toBe('a');
  });

  it('applies content-aware scoring including content-length penalty', () => {
    const services = [
      createService('small-json'),
      createService('large-generic')
    ];
    const contentAnalysis = new Map<string, ServiceContentAnalysis>([
      ['small-json', {
        supportedContentTypes: ['application/json'],
        specializedMethods: ['tools/search'],
        maxContentLength: 100,
        averageProcessingTime: 30
      }],
      ['large-generic', {
        supportedContentTypes: ['text/plain'],
        specializedMethods: ['tools/search'],
        maxContentLength: 5_000,
        averageProcessingTime: 40
      }]
    ]);

    const shortPayloadReq = createRouteRequest(services, {
      method: 'tools/search',
      contentType: 'application/json',
      contentLength: 50
    });
    const longPayloadReq = createRouteRequest(services, {
      method: 'tools/search',
      contentType: 'application/json',
      contentLength: 1_000
    });

    const selectedForShort = loadBalancer.selectService(
      services,
      shortPayloadReq,
      'content-aware',
      new Map(),
      new Map(),
      contentAnalysis
    );
    const selectedForLong = loadBalancer.selectService(
      services,
      longPayloadReq,
      'content-aware',
      new Map(),
      new Map(),
      contentAnalysis
    );

    expect(selectedForShort?.id).toBe('small-json');
    expect(selectedForLong?.id).toBe('large-generic');
  });

  it('falls back to first healthy service for unknown strategy', () => {
    const services = [createService('a'), createService('b')];
    const request = createRouteRequest(services);
    const unknown = 'made-up-strategy' as LoadBalancingStrategy;

    const selected = loadBalancer.selectService(
      services,
      request,
      unknown,
      new Map(),
      new Map(),
      new Map()
    );

    expect(selected?.id).toBe('a');
  });

  it('filterHealthyServices keeps only running services', () => {
    const services = [
      createService('running', { state: 'running' }),
      createService('starting', { state: 'starting' }),
      createService('error', { state: 'error' })
    ];

    const filtered = loadBalancer.filterHealthyServices(services);

    expect(filtered.map(service => service.id)).toEqual(['running']);
  });
});


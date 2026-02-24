import Fastify from 'fastify';
import { registerHealthRoutes } from '../../server/HealthRoutes.js';

describe('HealthRoutes', () => {
  it('registers /health and /api/health with quick status payload', async () => {
    const app = Fastify({ logger: false });
    registerHealthRoutes(app, {
      serviceRegistry: { getRegistryStats: vi.fn().mockResolvedValue({ totalInstances: 0 }) } as any,
      authLayer: { getActiveTokenCount: vi.fn().mockReturnValue(0), getActiveApiKeyCount: vi.fn().mockReturnValue(0) },
      router: { getMetrics: vi.fn().mockReturnValue({ totalRequests: 0 }) } as any
    });
    await app.ready();

    const a = await app.inject({ method: 'GET', url: '/health' });
    const b = await app.inject({ method: 'GET', url: '/api/health' });

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual(expect.objectContaining({ status: 'ok', ts: expect.any(Number) }));
    expect(b.json()).toEqual(expect.objectContaining({ status: 'ok', ts: expect.any(Number) }));

    await app.close();
  });

  it('registers /health/detailed and aggregates component metrics', async () => {
    const getRegistryStats = vi.fn().mockResolvedValue({ totalTemplates: 1, totalInstances: 2, healthyInstances: 2, instancesByState: {} });
    const getActiveTokenCount = vi.fn().mockReturnValue(3);
    const getActiveApiKeyCount = vi.fn().mockReturnValue(4);
    const getMetrics = vi.fn().mockReturnValue({ totalRequests: 11, successRate: 1, averageResponseTime: 10, serviceDistribution: {}, strategyEffectiveness: {} });

    const app = Fastify({ logger: false });
    registerHealthRoutes(app, {
      serviceRegistry: { getRegistryStats } as any,
      authLayer: { getActiveTokenCount, getActiveApiKeyCount },
      router: { getMetrics } as any
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health/detailed' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({
      status: 'healthy',
      version: '1.0.0',
      services: expect.objectContaining({
        registry: expect.objectContaining({ totalInstances: 2 }),
        auth: { activeTokens: 3, activeApiKeys: 4 }
      })
    }));
    expect(getRegistryStats).toHaveBeenCalledTimes(1);
    expect(getMetrics).toHaveBeenCalledTimes(1);

    await app.close();
  });
});


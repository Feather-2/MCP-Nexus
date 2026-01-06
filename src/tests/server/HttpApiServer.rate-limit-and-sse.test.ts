import { HttpApiServer } from '../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../types/index.js';

function makeLogger(): Logger {
  const noop = () => {};
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const base: any = {
    port: 0,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    routingStrategy: 'performance',
    loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 50,
    requestTimeout: 30000,
    enableMetrics: false,
    enableHealthChecks: false,
    healthCheckInterval: 30000,
    maxRetries: 1,
    enableCors: true,
    corsOrigins: ['http://allowed.com'],
    maxRequestSize: 10 * 1024 * 1024,
    metricsRetentionDays: 1,
    rateLimiting: { enabled: true, maxRequests: 1, windowMs: 60000, store: 'memory' },
    logLevel: 'error',
    ai: { provider: 'none' }
  };
  return { ...base, ...overrides } as GatewayConfig;
}

// Minimal config manager stub
const cfgManagerStub: any = {
  get: async (key: string) => {
    if (key === 'ai') return { provider: 'none' };
    return null;
  }
};

describe('HttpApiServer - SSE CORS and Rate Limit', () => {
  let server: any;
  let api: any;

  beforeEach(() => {
    const s = new HttpApiServer(makeConfig(), makeLogger(), cfgManagerStub as any);
    api = s as any;
    server = (s as any).server;
  });

  it('SSE headers helper reflects allowed Origin', () => {
    const captured: any = {};
    const fakeReply: any = { raw: { writeHead: (_code: number, headers: any) => Object.assign(captured, headers) } };
    const fakeReq: any = { headers: { origin: 'http://allowed.com' } };
    api.writeSseHeaders(fakeReply, fakeReq);
    expect(captured['Content-Type']).toContain('text/event-stream');
    expect(captured['Access-Control-Allow-Origin']).toBe('http://allowed.com');
    expect(captured['Vary']).toBe('Origin');
  });

  it('SSE headers helper omits ACAO for disallowed Origin', () => {
    const captured: any = {};
    const fakeReply: any = { raw: { writeHead: (_code: number, headers: any) => Object.assign(captured, headers) } };
    const fakeReq: any = { headers: { origin: 'http://evil.com' } };
    api.writeSseHeaders(fakeReply, fakeReq);
    expect(captured['Content-Type']).toContain('text/event-stream');
    expect(captured['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('rate-limits repeated requests by API key, different keys are independent', async () => {
    // First key A - first request ok
    let res = await server.inject({ method: 'GET', url: '/api/logs', headers: { 'x-api-key': 'A-key-123' } });
    expect(res.statusCode).toBe(200);
    // Second with same key should be 429
    res = await server.inject({ method: 'GET', url: '/api/logs', headers: { 'x-api-key': 'A-key-123' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error?.code).toBe('RATE_LIMITED');
    // Another key B - should be allowed separately
    const resB = await server.inject({ method: 'GET', url: '/api/logs', headers: { 'x-api-key': 'B-key-456' } });
    expect(resB.statusCode).toBe(200);
  });

  it('rate-limits repeated requests without API key (IP bucket)', async () => {
    const res1 = await server.inject({ method: 'GET', url: '/api/logs' });
    expect(res1.statusCode).toBe(200);
    const res2 = await server.inject({ method: 'GET', url: '/api/logs' });
    expect(res2.statusCode).toBe(429);
    expect(res2.json().error?.code).toBe('RATE_LIMITED');
  });
});

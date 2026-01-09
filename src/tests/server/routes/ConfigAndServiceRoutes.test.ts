import { HttpApiServer } from '../../../server/HttpApiServer.js';
import type { GatewayConfig, Logger } from '../../../types/index.js';

const { mockStaticPlugin, mockCorsPlugin } = vi.hoisted(() => ({
  mockStaticPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.()),
  mockCorsPlugin: vi.fn((_instance: any, _opts: any, done?: (err?: Error) => void) => done?.())
}));

vi.mock('@fastify/static', () => ({ default: mockStaticPlugin }));
vi.mock('@fastify/cors', () => ({ default: mockCorsPlugin }));

const serviceRegistryStub = {
  getRegistryStats: vi.fn().mockResolvedValue({}),
  listServices: vi.fn().mockResolvedValue([]),
  getService: vi.fn().mockResolvedValue(null),
  createServiceFromTemplate: vi.fn().mockResolvedValue('svc-1'),
  stopService: vi.fn().mockResolvedValue(true),
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, timestamp: new Date() })
};

const authLayerStub = {
  authenticate: vi.fn().mockResolvedValue({ success: true }),
  getActiveTokenCount: vi.fn().mockReturnValue(0),
  getActiveApiKeyCount: vi.fn().mockReturnValue(0)
};

const routerStub = { getMetrics: vi.fn().mockReturnValue({}) };
const adaptersStub = {};

vi.mock('../../../gateway/ServiceRegistryImpl.js', () => ({
  ServiceRegistryImpl: vi.fn().mockImplementation(() => serviceRegistryStub)
}));
vi.mock('../../../auth/AuthenticationLayerImpl.js', () => ({
  AuthenticationLayerImpl: vi.fn().mockImplementation(() => authLayerStub)
}));
vi.mock('../../../router/GatewayRouterImpl.js', () => ({
  GatewayRouterImpl: vi.fn().mockImplementation(() => routerStub)
}));
vi.mock('../../../adapters/ProtocolAdaptersImpl.js', () => ({
  ProtocolAdaptersImpl: vi.fn().mockImplementation(() => adaptersStub)
}));

describe('ConfigRoutes and ServiceRoutes - validation', () => {
  const config: GatewayConfig = {
    port: 0,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    routingStrategy: 'performance',
    loadBalancingStrategy: 'performance-based',
    maxConcurrentServices: 10,
    requestTimeout: 1000,
    enableMetrics: true,
    enableHealthChecks: true,
    healthCheckInterval: 1000,
    maxRetries: 2,
    enableCors: true,
    corsOrigins: ['http://localhost:3000'],
    maxRequestSize: 1024,
    metricsRetentionDays: 1,
    rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000 },
    logLevel: 'info'
  };
  const logger: Logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const configManagerStub = {
    getConfig: vi.fn().mockReturnValue(config),
    get: vi.fn().mockResolvedValue(null),
    updateConfig: vi.fn().mockImplementation(async (patch: Partial<GatewayConfig>) => ({ ...config, ...patch }))
  } as any;

  let server: HttpApiServer;
  const inject = (req: any) => (server as any).server.inject(req);
  const logBuffer = () => (server as any).logBuffer as any[];
  beforeEach(() => {
    vi.clearAllMocks();
    server = new HttpApiServer(config, logger, configManagerStub);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET /api/config returns configuration', async () => {
    const res = await inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().host).toBe('127.0.0.1');
  });

  it('PUT /api/config rejects invalid payload', async () => {
    const bad = await inject({ method: 'PUT', url: '/api/config', payload: { port: 'not-number' } });
    expect(bad.statusCode).toBe(400);
    const ok = await inject({ method: 'PUT', url: '/api/config', payload: { port: 9999 } });
    expect(ok.statusCode).toBe(200);
  });

  it('GET /api/config/:key validates key and returns 404 for missing', async () => {
    const bad = await inject({ method: 'GET', url: '/api/config/' });
    expect([400,404]).toContain(bad.statusCode);
    const res = await inject({ method: 'GET', url: '/api/config/not-exist' });
    expect(res.statusCode).toBe(404);
  });

  describe('ServiceRoutes', () => {
    it('GET /api/services returns services with redacted config', async () => {
      serviceRegistryStub.listServices.mockResolvedValueOnce([
        {
          id: 'svc-1',
          state: 'running',
          config: { name: 'demo', env: { TOKEN: 'secret123456', NORMAL: 'ok' } }
        }
      ]);

      const res = await inject({ method: 'GET', url: '/api/services' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].config.env.TOKEN).toBe('secr…3456');
      expect(body[0].config.env.NORMAL).toBe('ok');
    });

    it('GET /api/services keeps config undefined when absent', async () => {
      serviceRegistryStub.listServices.mockResolvedValueOnce([{ id: 'svc-1', state: 'running' }]);
      const res = await inject({ method: 'GET', url: '/api/services' });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0].config).toBeUndefined();
    });

    describe('GET /api/services/:id', () => {
      it('returns service with redacted config', async () => {
        serviceRegistryStub.getService.mockResolvedValueOnce({
          id: 'svc-1',
          state: 'running',
          config: { name: 'demo', env: { TOKEN: 'secret123456', NORMAL: 'ok' } }
        });

        const res = await inject({ method: 'GET', url: '/api/services/svc-1' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.service.id).toBe('svc-1');
        expect(body.service.config.env.TOKEN).toBe('secr…3456');
        expect(body.service.config.env.NORMAL).toBe('ok');
      });

      it('returns service when config is missing', async () => {
        serviceRegistryStub.getService.mockResolvedValueOnce({ id: 'svc-1', state: 'running' });
        const res = await inject({ method: 'GET', url: '/api/services/svc-1' });
        expect(res.statusCode).toBe(200);
        expect(res.json().service.config).toBeUndefined();
      });

      it('returns 400 for invalid id format', async () => {
        const res = await inject({ method: 'GET', url: '/api/services/bad$id' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      });

      it('returns 404 when service does not exist', async () => {
        serviceRegistryStub.getService.mockResolvedValueOnce(null);
        const res = await inject({ method: 'GET', url: '/api/services/not-found' });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('NOT_FOUND');
      });
    });

    describe('POST /api/services', () => {
      it('creates service from template (201)', async () => {
        serviceRegistryStub.createServiceFromTemplate.mockResolvedValueOnce('svc-created');
        const res = await inject({ method: 'POST', url: '/api/services', payload: { templateName: 'demo' } });
        expect(res.statusCode).toBe(201);
        expect(res.json().serviceId).toBe('svc-created');
        expect(serviceRegistryStub.createServiceFromTemplate).toHaveBeenCalledWith('demo', {});
      });

      it('returns 400 when templateName is missing', async () => {
        const res = await inject({ method: 'POST', url: '/api/services', payload: {} });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      });

      it('returns 400 when body is missing entirely', async () => {
        const res = await inject({ method: 'POST', url: '/api/services' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      });

      it('creates service with instanceArgs', async () => {
        serviceRegistryStub.createServiceFromTemplate.mockResolvedValueOnce('svc-with-args');
        const instanceArgs = { env: { A: '1' }, foo: 'bar' };
        const res = await inject({ method: 'POST', url: '/api/services', payload: { templateName: 'demo', instanceArgs } });
        expect(res.statusCode).toBe(201);
        expect(res.json().serviceId).toBe('svc-with-args');
        expect(serviceRegistryStub.createServiceFromTemplate).toHaveBeenCalledWith('demo', instanceArgs);
      });

      it('returns 400 when createServiceFromTemplate throws', async () => {
        serviceRegistryStub.createServiceFromTemplate.mockRejectedValueOnce(new Error('boom'));
        const res = await inject({ method: 'POST', url: '/api/services', payload: { templateName: 'demo' } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('CREATE_FAILED');
      });

      it('returns 400 when createServiceFromTemplate rejects non-Error', async () => {
        serviceRegistryStub.createServiceFromTemplate.mockRejectedValueOnce('boom');
        const res = await inject({ method: 'POST', url: '/api/services', payload: { templateName: 'demo' } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('CREATE_FAILED');
        expect(res.json().error.message).toBe('Failed to create service');
      });
    });

    describe('PATCH /api/services/:id/env', () => {
      it('updates env and restarts service', async () => {
        serviceRegistryStub.getService.mockResolvedValueOnce({
          id: 'svc-1',
          config: { name: 'demo' }
        });
        serviceRegistryStub.stopService.mockResolvedValueOnce(true);
        serviceRegistryStub.createServiceFromTemplate.mockResolvedValueOnce('svc-restarted');

        vi.useFakeTimers();
        const pending = inject({ method: 'PATCH', url: '/api/services/svc-1/env', payload: { env: { A: '1' } } });
        await vi.advanceTimersByTimeAsync(1000);
        const res = await pending;

        expect(res.statusCode).toBe(200);
        expect(res.json().serviceId).toBe('svc-restarted');
        expect(serviceRegistryStub.stopService).toHaveBeenCalledWith('svc-1');
        expect(serviceRegistryStub.createServiceFromTemplate).toHaveBeenCalledWith('demo', { env: { A: '1' } });
      });

      it('returns 400 for invalid request format', async () => {
        const res = await inject({ method: 'PATCH', url: '/api/services/svc-1/env', payload: { env: { A: 1 } } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      });

      it('returns 400 when body is missing entirely', async () => {
        const res = await inject({ method: 'PATCH', url: '/api/services/svc-1/env' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      });

      it('returns 404 when service does not exist', async () => {
        serviceRegistryStub.getService.mockResolvedValueOnce(null);
        const res = await inject({ method: 'PATCH', url: '/api/services/missing/env', payload: { env: { A: '1' } } });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('NOT_FOUND');
      });

      it('returns 500 when stopService fails', async () => {
        serviceRegistryStub.getService.mockResolvedValueOnce({ id: 'svc-1', config: { name: 'demo' } });
        serviceRegistryStub.stopService.mockResolvedValueOnce(false);
        const res = await inject({ method: 'PATCH', url: '/api/services/svc-1/env', payload: { env: { A: '1' } } });
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('RESTART_FAILED');
        expect(serviceRegistryStub.createServiceFromTemplate).not.toHaveBeenCalled();
      });

      it('returns 500 when createServiceFromTemplate fails', async () => {
        serviceRegistryStub.getService.mockResolvedValueOnce({ id: 'svc-1', config: { name: 'demo' } });
        serviceRegistryStub.stopService.mockResolvedValueOnce(true);
        serviceRegistryStub.createServiceFromTemplate.mockRejectedValueOnce(new Error('boom'));

        vi.useFakeTimers();
        const pending = inject({ method: 'PATCH', url: '/api/services/svc-1/env', payload: { env: { A: '1' } } });
        await vi.advanceTimersByTimeAsync(1000);
        const res = await pending;

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('UPDATE_ENV_FAILED');
      });

      it('returns 500 when createServiceFromTemplate rejects non-Error', async () => {
        serviceRegistryStub.getService.mockResolvedValueOnce({ id: 'svc-1', config: { name: 'demo' } });
        serviceRegistryStub.stopService.mockResolvedValueOnce(true);
        serviceRegistryStub.createServiceFromTemplate.mockRejectedValueOnce('boom');

        vi.useFakeTimers();
        const pending = inject({ method: 'PATCH', url: '/api/services/svc-1/env', payload: { env: { A: '1' } } });
        await vi.advanceTimersByTimeAsync(1000);
        const res = await pending;

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('UPDATE_ENV_FAILED');
        expect(res.json().error.message).toBe('Failed to update service environment variables');
      });
    });

    describe('DELETE /api/services/:id', () => {
      it('stops service successfully', async () => {
        serviceRegistryStub.stopService.mockResolvedValueOnce(true);
        const res = await inject({ method: 'DELETE', url: '/api/services/svc-1' });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
      });

      it('returns 400 for invalid id', async () => {
        const res = await inject({ method: 'DELETE', url: '/api/services/bad$id' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      });

      it('returns 404 when service does not exist', async () => {
        serviceRegistryStub.stopService.mockResolvedValueOnce(false);
        const res = await inject({ method: 'DELETE', url: '/api/services/not-found' });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('NOT_FOUND');
      });

      it('returns 500 when stopService throws', async () => {
        serviceRegistryStub.stopService.mockRejectedValueOnce(new Error('boom'));
        const res = await inject({ method: 'DELETE', url: '/api/services/svc-1' });
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('STOP_FAILED');
      });

      it('returns 500 when stopService rejects non-Error', async () => {
        serviceRegistryStub.stopService.mockRejectedValueOnce('boom');
        const res = await inject({ method: 'DELETE', url: '/api/services/svc-1' });
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('STOP_FAILED');
        expect(res.json().error.message).toBe('Failed to stop service');
      });
    });

    describe('GET /api/services/:id/health', () => {
      it('returns health status', async () => {
        serviceRegistryStub.checkHealth.mockResolvedValueOnce({ healthy: true, timestamp: new Date('2020-01-01') });
        const res = await inject({ method: 'GET', url: '/api/services/svc-1/health' });
        expect(res.statusCode).toBe(200);
        expect(res.json().health.healthy).toBe(true);
      });

      it('returns 400 for invalid id', async () => {
        const res = await inject({ method: 'GET', url: '/api/services/bad$id/health' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      });

      it('returns 500 when checkHealth throws', async () => {
        serviceRegistryStub.checkHealth.mockRejectedValueOnce(new Error('boom'));
        const res = await inject({ method: 'GET', url: '/api/services/svc-1/health' });
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('HEALTH_FAILED');
      });

      it('returns 500 with fallback message when checkHealth rejects non-Error', async () => {
        serviceRegistryStub.checkHealth.mockRejectedValueOnce({});
        const res = await inject({ method: 'GET', url: '/api/services/svc-1/health' });
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('HEALTH_FAILED');
        expect(res.json().error.message).toBe('Failed to check service health');
      });
    });

    describe('GET /api/services/:id/logs', () => {
      it('returns logs when available', async () => {
        logBuffer().push(
          { timestamp: 't1', level: 'info', message: 'm1', service: 'svc-logs' },
          { timestamp: 't2', level: 'info', message: 'm2', service: 'svc-logs' }
        );
        const res = await inject({ method: 'GET', url: '/api/services/svc-logs/logs' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveLength(2);
        expect(body[0].message).toBe('m1');
      });

      it('returns demo logs when none available', async () => {
        const res = await inject({ method: 'GET', url: '/api/services/svc-empty/logs' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveLength(3);
        expect(body[0].service).toBe('svc-empty');
      });

      it('supports limit query parameter', async () => {
        for (let i = 1; i <= 5; i++) {
          logBuffer().push({ timestamp: `t${i}`, level: 'info', message: `m${i}`, service: 'svc-limit' });
        }
        const res = await inject({ method: 'GET', url: '/api/services/svc-limit/logs?limit=2' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveLength(2);
        expect(body[0].message).toBe('m4');
        expect(body[1].message).toBe('m5');
      });

      it('returns 400 for invalid limit', async () => {
        const res = await inject({ method: 'GET', url: '/api/services/svc-1/logs?limit=0' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      });

      it('returns 500 when getting logs throws', async () => {
        (logBuffer() as any).filter = vi.fn(() => { throw new Error('boom'); });
        const res = await inject({ method: 'GET', url: '/api/services/svc-1/logs' });
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('LOGS_FAILED');
      });

      it('returns 500 when logBuffer throws non-Error', async () => {
        (logBuffer() as any).filter = vi.fn(() => { throw 'boom'; });
        const res = await inject({ method: 'GET', url: '/api/services/svc-1/logs' });
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('LOGS_FAILED');
        expect(res.json().error.message).toBe('Failed to get service logs');
      });
    });
  });
});

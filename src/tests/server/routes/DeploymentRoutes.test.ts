import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../types/index.js';
import { DeploymentRoutes } from '../../../server/routes/DeploymentRoutes.js';

const {
  resolveMock,
  installMock,
  dirSizeMock
} = vi.hoisted(() => ({
  resolveMock: vi.fn(),
  installMock: vi.fn(),
  dirSizeMock: vi.fn()
}));

vi.mock('../../../gateway/GitHubPackageResolver.js', () => ({
  GitHubPackageResolver: vi.fn().mockImplementation(function () {
    return { resolve: resolveMock };
  })
}));

vi.mock('../../../gateway/SandboxPackageInstaller.js', () => ({
  SandboxPackageInstaller: vi.fn().mockImplementation(function () {
    return { install: installMock };
  })
}));

vi.mock('../../../utils/SandboxUtils.js', () => ({
  SandboxPaths: { base: '/tmp/mcp-sandbox' },
  dirSize: dirSizeMock
}));

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makePolicy(overrides?: Record<string, unknown>) {
  return {
    setAuthorizationMode: vi.fn(),
    getLimits: vi.fn().mockReturnValue({
      maxSandboxDiskBytes: 1024 * 1024,
      maxConcurrentProcesses: 3
    }),
    getAuthorizationMode: vi.fn().mockReturnValue('interactive'),
    getActiveProcessCount: vi.fn().mockReturnValue(0),
    ...(overrides || {})
  };
}

function makePersistence(overrides?: Record<string, unknown>) {
  return {
    getAllEntries: vi.fn().mockReturnValue({}),
    setAutostart: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    ...(overrides || {})
  };
}

function makeRouteContext(server: FastifyInstance, options?: { deploymentPolicy?: any; instancePersistence?: any }) {
  return {
    server,
    logger: makeLogger(),
    deploymentPolicy: options?.deploymentPolicy,
    instancePersistence: options?.instancePersistence,
    respondError: (reply: any, status: number, message: string, opts?: any) => {
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
  } as any;
}

describe('DeploymentRoutes', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    server = Fastify({ logger: false });
  });

  afterEach(async () => {
    await server.close();
  });

  it('POST /api/deploy/resolve returns 503 when deployment policy is missing', async () => {
    new DeploymentRoutes(makeRouteContext(server)).setupRoutes();

    const res = await server.inject({ method: 'POST', url: '/api/deploy/resolve', payload: { source: 'owner/repo' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('POST /api/deploy/resolve resolves package and sets api auth mode', async () => {
    const policy = makePolicy();
    resolveMock.mockResolvedValueOnce({ templateName: 'demo-template', source: 'npm' });
    new DeploymentRoutes(makeRouteContext(server, { deploymentPolicy: policy })).setupRoutes();

    const res = await server.inject({ method: 'POST', url: '/api/deploy/resolve', payload: { source: 'demo-package' } });
    expect(res.statusCode).toBe(200);
    expect(policy.setAuthorizationMode).not.toHaveBeenCalled();
    expect(resolveMock).toHaveBeenCalledWith('demo-package');
    expect(res.json().success).toBe(true);
  });

  it('POST /api/deploy/install returns 400 when installer reports failure', async () => {
    const policy = makePolicy();
    installMock.mockResolvedValueOnce({ success: false, error: 'install failed', packageName: 'demo', installDir: '' });
    new DeploymentRoutes(makeRouteContext(server, { deploymentPolicy: policy })).setupRoutes();

    const res = await server.inject({ method: 'POST', url: '/api/deploy/install', payload: { packageSpec: 'demo@1.0.0' } });
    expect(res.statusCode).toBe(400);
    expect(policy.setAuthorizationMode).not.toHaveBeenCalled();
    expect(res.json().error.code).toBe('INSTALL_FAILED');
    expect(res.json().error.message).toContain('install failed');
  });

  it('GET /api/deploy/policy returns policy snapshot', async () => {
    const policy = makePolicy({
      getAuthorizationMode: vi.fn().mockReturnValue('api'),
      getActiveProcessCount: vi.fn().mockReturnValue(2)
    });
    new DeploymentRoutes(makeRouteContext(server, { deploymentPolicy: policy })).setupRoutes();

    const res = await server.inject({ method: 'GET', url: '/api/deploy/policy' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      limits: { maxSandboxDiskBytes: 1024 * 1024, maxConcurrentProcesses: 3 },
      authorizationMode: 'api',
      activeProcesses: 2
    });
  });

  it('GET /api/deploy/status returns disk usage only when policy is missing', async () => {
    dirSizeMock.mockResolvedValueOnce(12345);
    new DeploymentRoutes(makeRouteContext(server)).setupRoutes();

    const res = await server.inject({ method: 'GET', url: '/api/deploy/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ diskUsageBytes: 12345 });
  });

  it('GET /api/deploy/status includes policy process and limits when configured', async () => {
    dirSizeMock.mockResolvedValueOnce(888);
    const policy = makePolicy({
      getActiveProcessCount: vi.fn().mockReturnValue(4),
      getLimits: vi.fn().mockReturnValue({ maxSandboxDiskBytes: 4096, maxConcurrentProcesses: 9 })
    });
    new DeploymentRoutes(makeRouteContext(server, { deploymentPolicy: policy })).setupRoutes();

    const res = await server.inject({ method: 'GET', url: '/api/deploy/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      diskUsageBytes: 888,
      activeProcesses: 4,
      limits: { maxSandboxDiskBytes: 4096, maxConcurrentProcesses: 9 }
    });
  });

  it('GET /api/instances/persisted returns instances and autostart count', async () => {
    const persistence = makePersistence({
      getAllEntries: vi.fn().mockReturnValue({
        a: { templateName: 't1', autostart: true, createdAt: '2026-01-01T00:00:00Z' },
        b: { templateName: 't2', autostart: false, createdAt: '2026-01-01T00:00:00Z' },
        c: { templateName: 't3', autostart: true, createdAt: '2026-01-01T00:00:00Z' }
      })
    });
    new DeploymentRoutes(makeRouteContext(server, { instancePersistence: persistence })).setupRoutes();

    const res = await server.inject({ method: 'GET', url: '/api/instances/persisted' });
    expect(res.statusCode).toBe(200);
    expect(res.json().autostartCount).toBe(2);
    expect(Object.keys(res.json().instances)).toHaveLength(3);
  });

  it('PUT /api/instances/:id/autostart returns 404 for missing persisted instance', async () => {
    const persistence = makePersistence({
      getAllEntries: vi.fn().mockReturnValue({})
    });
    new DeploymentRoutes(makeRouteContext(server, { instancePersistence: persistence })).setupRoutes();

    const res = await server.inject({
      method: 'PUT',
      url: '/api/instances/missing/autostart',
      payload: { autostart: true }
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('PUT /api/instances/:id/autostart updates autostart and flushes persistence', async () => {
    const persistence = makePersistence({
      getAllEntries: vi.fn().mockReturnValue({
        'service-1': { templateName: 't1', autostart: false, createdAt: '2026-01-01T00:00:00Z' }
      })
    });
    new DeploymentRoutes(makeRouteContext(server, { instancePersistence: persistence })).setupRoutes();

    const res = await server.inject({
      method: 'PUT',
      url: '/api/instances/service-1/autostart',
      payload: { autostart: true }
    });

    expect(res.statusCode).toBe(200);
    expect(persistence.setAutostart).toHaveBeenCalledWith('service-1', true);
    expect(persistence.flush).toHaveBeenCalledTimes(1);
    expect(res.json()).toEqual({ success: true });
  });
});

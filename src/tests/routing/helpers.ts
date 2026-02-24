import type {
  Logger,
  McpServiceConfig,
  RouteRequest,
  ServiceHealth,
  ServiceInstance
} from '../../types/index.js';
import type { ServiceState } from '../../types/mcp.js';

export function createLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

export function createService(
  id: string,
  options: {
    name?: string;
    state?: ServiceState;
    config?: Partial<McpServiceConfig>;
    metadata?: Record<string, unknown>;
  } = {}
): ServiceInstance {
  const {
    name = id,
    state = 'running',
    config = {},
    metadata = {}
  } = options;

  return {
    id,
    config: {
      name,
      version: '2024-11-26',
      transport: 'http',
      timeout: 30_000,
      retries: 3,
      ...config
    },
    state,
    startedAt: new Date(),
    errorCount: 0,
    metadata
  };
}

export function createHealth(
  status: ServiceHealth['status'] = 'healthy',
  overrides: Partial<ServiceHealth> = {}
): ServiceHealth {
  return {
    status,
    responseTime: 30,
    lastCheck: new Date(),
    ...overrides
  };
}

export function createRouteRequest(
  services: ServiceInstance[],
  overrides: Partial<RouteRequest> = {}
): RouteRequest {
  const availableServices = overrides.availableServices ?? services;
  const serviceHealthMap = overrides.serviceHealthMap ?? new Map(
    availableServices.map(service => [service.id, createHealth('healthy')])
  );

  return {
    method: 'tools/call',
    clientIp: '127.0.0.1',
    availableServices,
    serviceHealthMap,
    ...overrides
  };
}

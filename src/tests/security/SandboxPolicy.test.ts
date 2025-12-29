import { applyGatewaySandboxPolicy } from '../../security/SandboxPolicy.js';
import { ProtocolAdaptersImpl } from '../../adapters/ProtocolAdaptersImpl.js';
import { ContainerTransportAdapter } from '../../adapters/ContainerTransportAdapter.js';
import type { GatewayConfig, Logger, McpServiceConfig } from '../../types/index.js';

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

describe('SandboxPolicy', () => {
  const baseTemplate: McpServiceConfig = {
    name: 'test-svc',
    version: '2024-11-26',
    transport: 'stdio',
    command: 'npm',
    args: ['exec', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: {},
    timeout: 30000,
    retries: 3
  };

  it('does not enforce container by default', () => {
    const res = applyGatewaySandboxPolicy(baseTemplate, undefined);
    expect(res.applied).toBe(false);
    expect(res.config.env?.SANDBOX).toBeUndefined();
  });

  it('enforces container quarantine when requiredForUntrusted=true and trustLevel missing', () => {
    const gatewayConfig: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 1,
      requestTimeout: 1000,
      enableMetrics: false,
      enableHealthChecks: false,
      healthCheckInterval: 1000,
      maxRetries: 0,
      enableCors: false,
      corsOrigins: [],
      maxRequestSize: 1024,
      metricsRetentionDays: 1,
      rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
      logLevel: 'info',
      sandbox: { container: { requiredForUntrusted: true } } as any
    };

    const res = applyGatewaySandboxPolicy(baseTemplate, gatewayConfig);
    expect(res.applied).toBe(true);
    expect(res.reasons.join('|')).toContain('trustLevel=untrusted');
    expect(res.config.env?.SANDBOX).toBe('container');
    expect((res.config as any).container?.image).toBeDefined();
    expect((res.config as any).container?.network).toBe('none');
    expect((res.config as any).container?.readonlyRootfs).toBe(true);
  });

  it('does not quarantine when trustLevel=trusted even if requiredForUntrusted=true', () => {
    const gatewayConfig: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 1,
      requestTimeout: 1000,
      enableMetrics: false,
      enableHealthChecks: false,
      healthCheckInterval: 1000,
      maxRetries: 0,
      enableCors: false,
      corsOrigins: [],
      maxRequestSize: 1024,
      metricsRetentionDays: 1,
      rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
      logLevel: 'info',
      sandbox: { container: { requiredForUntrusted: true } } as any
    };

    const trusted = { ...baseTemplate, security: { trustLevel: 'trusted' } } as any as McpServiceConfig;
    const res = applyGatewaySandboxPolicy(trusted, gatewayConfig);
    expect(res.applied).toBe(false);
  });

  it('forces container in locked-down profile regardless of trustLevel', () => {
    const gatewayConfig: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 1,
      requestTimeout: 1000,
      enableMetrics: false,
      enableHealthChecks: false,
      healthCheckInterval: 1000,
      maxRetries: 0,
      enableCors: false,
      corsOrigins: [],
      maxRequestSize: 1024,
      metricsRetentionDays: 1,
      rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
      logLevel: 'info',
      sandbox: { profile: 'locked-down' } as any
    };

    const trusted = { ...baseTemplate, security: { trustLevel: 'trusted' } } as any as McpServiceConfig;
    const res = applyGatewaySandboxPolicy(trusted, gatewayConfig);
    expect(res.applied).toBe(true);
    expect(res.reasons.join('|')).toContain('sandbox.profile=locked-down');
    expect(res.config.env?.SANDBOX).toBe('container');
  });

  it('rejects disallowed container volumes per policy allowlist', () => {
    const gatewayConfig: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 1,
      requestTimeout: 1000,
      enableMetrics: false,
      enableHealthChecks: false,
      healthCheckInterval: 1000,
      maxRetries: 0,
      enableCors: false,
      corsOrigins: [],
      maxRequestSize: 1024,
      metricsRetentionDays: 1,
      rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
      logLevel: 'info',
      sandbox: { profile: 'locked-down', container: { allowedVolumeRoots: ['./data'] } } as any
    };

    const withBadVolume = {
      ...baseTemplate,
      container: { image: 'node:20-alpine', volumes: [{ hostPath: '/tmp', containerPath: '/data', readOnly: true }] }
    } as any as McpServiceConfig;

    expect(() => applyGatewaySandboxPolicy(withBadVolume, gatewayConfig)).toThrow(/Volume hostPath not allowed/i);
  });
});

describe('ProtocolAdaptersImpl sandbox enforcement', () => {
  it('returns a ContainerTransportAdapter when quarantine policy applies', async () => {
    const gatewayConfig: GatewayConfig = {
      port: 0,
      host: '127.0.0.1',
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 1,
      requestTimeout: 1000,
      enableMetrics: false,
      enableHealthChecks: false,
      healthCheckInterval: 1000,
      maxRetries: 0,
      enableCors: false,
      corsOrigins: [],
      maxRequestSize: 1024,
      metricsRetentionDays: 1,
      rateLimiting: { enabled: false, maxRequests: 100, windowMs: 60000, store: 'memory' },
      logLevel: 'info',
      sandbox: { container: { requiredForUntrusted: true } } as any
    };

    const adapters = new ProtocolAdaptersImpl(logger, () => gatewayConfig);
    const adapter = await adapters.createAdapter({
      name: 't',
      version: '2024-11-26',
      transport: 'stdio',
      command: 'npm',
      args: ['--version'],
      timeout: 1000,
      retries: 0
    } as any);
    expect(adapter).toBeInstanceOf(ContainerTransportAdapter);
  });
});


import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Save original env
const origEnv = { ...process.env };

// Mock the OTel SDK so we don't need real infrastructure
const { mockStart, mockShutdown } = vi.hoisted(() => ({
  mockStart: vi.fn().mockResolvedValue(undefined),
  mockShutdown: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn().mockImplementation(function () { return { start: mockStart, shutdown: mockShutdown }; })
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(function () { return {}; })
}));
vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn().mockReturnValue({})
}));
vi.mock('@opentelemetry/semantic-conventions', () => ({
  SemanticResourceAttributes: { SERVICE_NAME: 'service.name' }
}));

describe('otel', () => {
  const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state between tests
    vi.resetModules();
    // Clean env
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.PB_OTEL_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_SERVICE_NAME;
  });

  afterEach(() => {
    Object.assign(process.env, origEnv);
  });

  it('isOpenTelemetryEnabled returns false by default', async () => {
    const mod = await import('../../observability/otel.js');
    expect(mod.isOpenTelemetryEnabled()).toBe(false);
  });

  it('startOpenTelemetry does nothing when no endpoint configured', async () => {
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(false);
  });

  it('startOpenTelemetry does nothing when OTEL_SDK_DISABLED=true', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(false);
  });

  it('startOpenTelemetry does nothing when PB_OTEL_ENABLED=false', async () => {
    process.env.PB_OTEL_ENABLED = 'false';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(false);
  });

  it('startOpenTelemetry enables when PB_OTEL_ENABLED=1', async () => {
    process.env.PB_OTEL_ENABLED = '1';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('OpenTelemetry enabled', expect.any(Object));
    // Cleanup
    await mod.shutdownOpenTelemetry(logger);
  });

  it('startOpenTelemetry enables when endpoint is set', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger, { serviceName: 'test-svc' });
    expect(mod.isOpenTelemetryEnabled()).toBe(true);
    await mod.shutdownOpenTelemetry(logger);
  });

  it('startOpenTelemetry uses TRACES_ENDPOINT over base endpoint', async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://traces:4318/v1/traces';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://base:4318';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(true);
    await mod.shutdownOpenTelemetry(logger);
  });

  it('startOpenTelemetry parses headers from env', async () => {
    process.env.PB_OTEL_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer tok,X-Key=val';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(true);
    await mod.shutdownOpenTelemetry(logger);
  });

  it('startOpenTelemetry is idempotent', async () => {
    process.env.PB_OTEL_ENABLED = '1';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    await mod.startOpenTelemetry(logger); // second call should be no-op
    expect(mod.isOpenTelemetryEnabled()).toBe(true);
    await mod.shutdownOpenTelemetry(logger);
  });

  it('shutdownOpenTelemetry when not started is no-op', async () => {
    const mod = await import('../../observability/otel.js');
    await mod.shutdownOpenTelemetry(logger); // should not throw
  });

  it('shutdownOpenTelemetry disables and cleans up', async () => {
    process.env.PB_OTEL_ENABLED = '1';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(true);
    await mod.shutdownOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(false);
  });

  it('handles start failure gracefully', async () => {
    process.env.PB_OTEL_ENABLED = '1';
    mockStart.mockRejectedValueOnce(new Error('connect fail'));
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    expect(mod.isOpenTelemetryEnabled()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('Failed to start OpenTelemetry', expect.any(Object));
  });

  it('handles shutdown failure gracefully', async () => {
    process.env.PB_OTEL_ENABLED = '1';
    const mod = await import('../../observability/otel.js');
    await mod.startOpenTelemetry(logger);
    mockShutdown.mockRejectedValueOnce(new Error('shutdown fail'));
    await mod.shutdownOpenTelemetry(logger); // should not throw
    expect(logger.warn).toHaveBeenCalledWith('Failed to shutdown OpenTelemetry', expect.any(Object));
  });
});

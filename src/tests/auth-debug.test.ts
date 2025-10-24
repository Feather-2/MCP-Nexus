import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthenticationLayerImpl } from '../auth/AuthenticationLayerImpl.js';
import { AuthRequest, Logger, GatewayConfig } from '../types/index.js';

describe('AuthenticationLayerImpl API Key Fix', () => {
  let authLayer: AuthenticationLayerImpl;
  let mockLogger: Logger;
  let mockConfig: GatewayConfig;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    mockConfig = {
      port: 19233,
      host: '127.0.0.1',
      authMode: 'external-secure',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 50,
      requestTimeout: 30000,
      enableMetrics: true,
      enableHealthChecks: true,
      healthCheckInterval: 30000,
      maxRetries: 3,
      enableCors: true,
      corsOrigins: ['http://localhost:3000'],
      maxRequestSize: 10 * 1024 * 1024,
      metricsRetentionDays: 7,
      rateLimiting: {
        enabled: false,
        maxRequests: 100,
        windowMs: 60000
      },
      logLevel: 'info'
    };

    authLayer = new AuthenticationLayerImpl(mockConfig, mockLogger);
  });

  it('should create default API key and validate it', async () => {
    // Get the API key created during initialization
    const apiKeys = authLayer.listApiKeys();
    expect(apiKeys.length).toBe(1);
    expect(apiKeys[0].name).toBe('default-dev');
    expect(apiKeys[0].permissions).toEqual(['*']);
    
    // Get the actual API key from the logger calls
    const loggerCalls = vi.mocked(mockLogger.info).mock.calls;
    const apiKeyCall = loggerCalls.find(call => call[0] === 'Created default development API key');
    expect(apiKeyCall).toBeDefined();
    const apiKey = apiKeyCall?.[1]?.apiKey;
    expect(apiKey).toBeDefined();

    // Test authentication with this API key
    const request: AuthRequest = {
      clientIp: '8.8.8.8',
      apiKey: apiKey,
      method: 'GET',
      resource: '/api/templates'
    };

    const response = await authLayer.authenticate(request);
    console.log('Authentication response:', response);
    console.log('API Keys:', apiKeys);
    console.log('API Key used:', apiKey);

    expect(response.success).toBe(true);
    expect(response.context?.apiKey).toBe(apiKey);
    expect(response.context?.permissions).toContain('*');
  });
});
import { AuthenticationLayerImpl } from '../../auth/AuthenticationLayerImpl.js';
import { AuthRequest, AuthMode, Logger, GatewayConfig } from '../../types/index.js';

describe('AuthenticationLayerImpl', () => {
  let authLayer: AuthenticationLayerImpl;
  let mockLogger: Logger;
  let mockConfig: GatewayConfig;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn()
    };

    mockConfig = {
      port: 19233,
      host: '127.0.0.1',
      authMode: 'local-trusted' as AuthMode,
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

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with correct config', () => {
      expect(authLayer).toBeDefined();
      expect(authLayer).toBeInstanceOf(AuthenticationLayerImpl);
    });

    it('should create default development API key during initialization', () => {
      // Default API key should be created
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Created default development API key',
        expect.objectContaining({
          apiKey: expect.stringMatching(/^pbk_[a-f0-9]{48}$/)
        })
      );
    });
  });

  describe('local trusted authentication', () => {
    beforeEach(() => {
      mockConfig.authMode = 'local-trusted';
      authLayer = new AuthenticationLayerImpl(mockConfig, mockLogger);
    });

    it('should authenticate localhost requests', async () => {
      const request: AuthRequest = {
        clientIp: '127.0.0.1',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(true);
      expect(response.context?.trusted).toBe(true);
      expect(response.context?.permissions).toContain('*');
    });

    it('should authenticate IPv6 localhost requests', async () => {
      const request: AuthRequest = {
        clientIp: '::1',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(true);
      expect(response.context?.trusted).toBe(true);
    });

    it('should authenticate private network requests', async () => {
      const privateIps = ['192.168.1.100', '10.0.0.5', '172.16.0.10'];

      for (const ip of privateIps) {
        const request: AuthRequest = {
          clientIp: ip,
          method: 'GET',
          resource: '/api/templates'
        };

        const response = await authLayer.authenticate(request);
        expect(response.success).toBe(true);
      }
    });

    it('should reject public IP addresses', async () => {
      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Access denied from untrusted network');
    });
  });

  describe('external secure authentication', () => {
    beforeEach(() => {
      mockConfig.authMode = 'external-secure';
      authLayer = new AuthenticationLayerImpl(mockConfig, mockLogger);
    });

    it('should authenticate with valid API key', async () => {
      // Get the API keys directly from the auth layer
      const apiKeys = authLayer.listApiKeys();
      expect(apiKeys.length).toBeGreaterThan(0);
      
      // Create a new API key for testing to be sure
      const testApiKey = await authLayer.createApiKey('test-key', ['*']);
      
      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        apiKey: testApiKey,
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(true);
      expect(response.context?.apiKey).toBe(testApiKey);
      expect(response.context?.permissions).toContain('*');
    });

    it('should reject invalid API key', async () => {
      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        apiKey: 'invalid-key',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Invalid API key');
    });

    it('should authenticate with valid token', async () => {
      // Generate a token first
      const token = await authLayer.generateToken('test-user', ['read', 'write']);

      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        token,
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(true);
      expect(response.context?.userId).toBe('test-user');
      expect(response.context?.permissions).toEqual(['read', 'write']);
    });

    it('should reject expired token', async () => {
      // Create a fresh authentication layer for this test
      const freshAuthLayer = new AuthenticationLayerImpl(mockConfig, mockLogger);
      
      // Generate a token that expires in -1 hours (already expired)
      const token = await freshAuthLayer.generateToken('test-user', ['read'], -1); // Force expired
      
      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        token,
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await freshAuthLayer.authenticate(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Token expired');
    });

    it('should reject request without credentials', async () => {
      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('No valid credentials provided');
    });
  });

  describe('dual authentication mode', () => {
    beforeEach(() => {
      mockConfig.authMode = 'dual';
      authLayer = new AuthenticationLayerImpl(mockConfig, mockLogger);
    });

    it('should use local trusted for local requests', async () => {
      const request: AuthRequest = {
        clientIp: '127.0.0.1',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(true);
      expect(response.context?.trusted).toBe(true);
    });

    it('should require external authentication for public IPs', async () => {
      // Create a test API key for this test
      const testApiKey = await authLayer.createApiKey('dual-test-key', ['*']);

      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        apiKey: testApiKey,
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(true);
      expect(response.context?.apiKey).toBe(testApiKey);
    });

    it('should reject public IP without credentials', async () => {
      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await authLayer.authenticate(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('No valid credentials provided');
    });
  });

  describe('token management', () => {
    it('should generate valid token', async () => {
      const token = await authLayer.generateToken('test-user', ['read', 'write'], 1);

      expect(token).toMatch(/^[a-f0-9]{64}$/); // 32 bytes hex = 64 chars
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Generated token for user: test-user'
      );
    });

    it('should validate valid token', async () => {
      const token = await authLayer.generateToken('test-user', ['read'], 1);
      
      const isValid = await authLayer.validateToken(token);

      expect(isValid).toBe(true);
    });

    it('should invalidate expired token', async () => {
      const token = await authLayer.generateToken('test-user', ['read'], 0);
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const isValid = await authLayer.validateToken(token);

      expect(isValid).toBe(false);
    });

    it('should revoke token', async () => {
      const token = await authLayer.generateToken('test-user', ['read'], 1);
      
      await authLayer.revokeToken(token);
      
      const isValid = await authLayer.validateToken(token);
      expect(isValid).toBe(false);
    });

    it('should clean up expired tokens', async () => {
      // Generate multiple tokens with immediate expiration
      const tokens = await Promise.all([
        authLayer.generateToken('user1', ['read'], 0),
        authLayer.generateToken('user2', ['write'], 0),
        authLayer.generateToken('user3', ['admin'], 0)
      ]);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10));
      
      await authLayer.cleanupExpiredTokens();

      // All tokens should be invalid after cleanup
      for (const token of tokens) {
        const isValid = await authLayer.validateToken(token);
        expect(isValid).toBe(false);
      }

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cleaned up 3 expired tokens'
      );
    });
  });

  describe('API key management', () => {
    it('should create API key', async () => {
      const apiKey = await authLayer.createApiKey('test-key', ['read', 'write']);

      expect(apiKey).toMatch(/^pbk_[a-f0-9]{48}$/);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Created API key: test-key',
        expect.objectContaining({
          permissions: ['read', 'write']
        })
      );
    });

    it('should validate valid API key', async () => {
      const apiKey = await authLayer.createApiKey('test-key', ['read']);
      
      const isValid = await authLayer.validateApiKey(apiKey);

      expect(isValid).toBe(true);
    });

    it('should invalidate non-existent API key', async () => {
      const isValid = await authLayer.validateApiKey('invalid-key');

      expect(isValid).toBe(false);
    });

    it('should revoke API key', async () => {
      const apiKey = await authLayer.createApiKey('test-key', ['read']);
      
      await authLayer.revokeApiKey(apiKey);
      
      const isValid = await authLayer.validateApiKey(apiKey);
      expect(isValid).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('Revoked API key: test-key');
    });

    it('should list API keys', async () => {
      await authLayer.createApiKey('key1', ['read']);
      await authLayer.createApiKey('key2', ['write']);

      const apiKeys = await authLayer.listApiKeys();

      expect(apiKeys).toHaveLength(3); // 2 created + 1 default
      expect(apiKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'key1', permissions: ['read'] }),
          expect.objectContaining({ name: 'key2', permissions: ['write'] })
        ])
      );
    });
  });

  describe('permission checking', () => {
    it('should check resource permissions', async () => {
      const hasPermission = await authLayer.hasPermission(['read'], 'GET', '/api/templates');
      expect(hasPermission).toBe(true);

      const noPermission = await authLayer.hasPermission(['write'], 'GET', '/api/templates');
      expect(noPermission).toBe(false);
    });

    it('should handle wildcard permissions', async () => {
      const hasWildcard = await authLayer.hasPermission(['*'], 'POST', '/api/admin');
      expect(hasWildcard).toBe(true);
    });

    it('should handle admin permissions', async () => {
      const hasAdmin = await authLayer.hasPermission(['admin'], 'DELETE', '/api/services');
      expect(hasAdmin).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle invalid authentication mode', async () => {
      const invalidConfig = { ...mockConfig, authMode: 'invalid' as AuthMode };
      const invalidAuthLayer = new AuthenticationLayerImpl(invalidConfig, mockLogger);

      const request: AuthRequest = {
        clientIp: '127.0.0.1',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await invalidAuthLayer.authenticate(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Invalid authentication mode');
    });

    it('should handle authentication errors gracefully', async () => {
      // Change to external-secure mode for this test to reach token validation
      const externalSecureConfig = { ...mockConfig, authMode: 'external-secure' as AuthMode };
      const externalSecureAuthLayer = new AuthenticationLayerImpl(externalSecureConfig, mockLogger);
      
      // Mock an error in token validation by mocking the internal method
      const originalValidateTokenInternal = (externalSecureAuthLayer as any).validateTokenInternal;
      vi.spyOn(externalSecureAuthLayer as any, 'validateTokenInternal').mockImplementation(() => {
        throw new Error('Database error');
      });

      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        token: 'some-token',
        method: 'GET',
        resource: '/api/templates'
      };

      const response = await externalSecureAuthLayer.authenticate(request);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Authentication failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Authentication error:',
        expect.any(Error)
      );

      // Restore original method
      (externalSecureAuthLayer as any).validateTokenInternal = originalValidateTokenInternal;
    });
  });

  describe('rate limiting', () => {
    it('should check rate limits when enabled', async () => {
      const rateLimitConfig = {
        ...mockConfig,
        rateLimiting: {
          enabled: true,
          maxRequests: 10,
          windowMs: 60000
        }
      };
      
      const rateLimitAuthLayer = new AuthenticationLayerImpl(rateLimitConfig, mockLogger);

      const allowed = await rateLimitAuthLayer.checkRateLimit('127.0.0.1');
      expect(allowed).toBe(true);
    });

    it('should pass rate limit check when disabled', async () => {
      const allowed = await authLayer.checkRateLimit('127.0.0.1');
      expect(allowed).toBe(true);
    });
  });

  describe('audit logging', () => {
    it('should log authentication events', async () => {
      const request: AuthRequest = {
        clientIp: '127.0.0.1',
        method: 'GET',
        resource: '/api/templates'
      };

      await authLayer.authenticate(request);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Authentication successful',
        expect.objectContaining({
          clientIp: '127.0.0.1',
          method: 'GET',
          resource: '/api/templates'
        })
      );
    });

    it('should log failed authentication attempts', async () => {
      const request: AuthRequest = {
        clientIp: '8.8.8.8',
        method: 'GET',
        resource: '/api/templates'
      };

      await authLayer.authenticate(request);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Authentication failed',
        expect.objectContaining({
          clientIp: '8.8.8.8',
          error: 'Access denied from untrusted network'
        })
      );
    });
  });
});
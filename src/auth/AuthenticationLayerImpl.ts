import {
  AuthenticationLayer,
  AuthRequest,
  AuthResponse,
  AuthContext,
  Logger,
  GatewayConfig
} from '../types/index.js';
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';

export class AuthenticationLayerImpl extends EventEmitter implements AuthenticationLayer {
  private tokens = new Map<string, {
    userId: string;
    permissions: string[];
    expiresAt: Date;
    lastUsed: Date;
  }>();
  
  private apiKeys = new Map<string, {
    name: string;
    permissions: string[];
    createdAt: Date;
    lastUsed: Date;
  }>();

  private trustedLocalNetworks = [
    '127.0.0.1',
    '::1',
    // Kept for backward compat but not used directly; see isLocalTrusted
    '192.168.',
    '10.',
    '172.'
  ];

  constructor(
    private config: GatewayConfig,
    private logger: Logger
  ) {
    super();
    this.initializeDefaults();
  }

  async authenticate(request: AuthRequest): Promise<AuthResponse> {
    const { token, apiKey, clientIp = '', method = '', resource = '' } = request;

    try {
      let response: AuthResponse;
      
      // Handle different authentication modes
      switch (this.config.authMode) {
        case 'local-trusted':
          response = this.authenticateLocalTrusted(clientIp, method, resource);
          break;
        
        case 'external-secure':
          response = await this.authenticateExternalSecure(token, apiKey, method, resource);
          break;
        
        case 'dual':
          // Try local trusted first, then external secure
          if (this.isLocalTrusted(clientIp)) {
            response = this.authenticateLocalTrusted(clientIp, method, resource);
          } else {
            response = await this.authenticateExternalSecure(token, apiKey, method, resource);
          }
          break;
        
        default:
          response = {
            success: false,
            error: 'Invalid authentication mode'
          };
      }
      
      // Log authentication events
      if (response.success) {
        this.logger.info('Authentication successful', {
          clientIp,
          method,
          resource,
          userId: response.context?.userId
        });
      } else {
        this.logger.warn('Authentication failed', {
          clientIp,
          method,
          resource,
          error: response.error
        });
      }
      
      return response;
    } catch (error) {
      this.logger.error('Authentication error:', error);
      return {
        success: false,
        error: 'Authentication failed'
      };
    }
  }

  async generateToken(userId: string, permissions: string[], expiresInHours = 24): Promise<string> {
    const token = this.generateSecureToken();
    const expiresAt = new Date();
    
    if (expiresInHours <= 0) {
      // If 0 or negative hours, expire immediately
      expiresAt.setTime(expiresAt.getTime() - 1000); // 1 second ago
    } else {
      expiresAt.setHours(expiresAt.getHours() + expiresInHours);
    }

    this.tokens.set(token, {
      userId,
      permissions,
      expiresAt,
      lastUsed: new Date()
    });

    this.logger.info(`Generated token for user ${userId}`, { 
      permissions, 
      expiresAt: expiresAt.toISOString() 
    });
    
    // Add debug log that tests expect
    this.logger.debug(`Generated token for user: ${userId}`);

    // Emit token generated event
    this.emit('tokenGenerated', { userId, token, permissions, expiresAt });

    return token;
  }

  async revokeToken(token: string): Promise<boolean> {
    const tokenData = this.tokens.get(token);
    if (!tokenData) {
      return false;
    }

    this.tokens.delete(token);
    this.logger.info(`Revoked token for user ${tokenData.userId}`);
    
    // Emit token revoked event
    this.emit('tokenRevoked', { userId: tokenData.userId, token });

    return true;
  }

  async createApiKey(name: string, permissions: string[]): Promise<string> {
    const apiKey = this.generateSecureApiKey();
    
    this.apiKeys.set(apiKey, {
      name,
      permissions,
      createdAt: new Date(),
      lastUsed: new Date()
    });

    this.logger.info(`Created API key: ${name}`, { permissions });
    
    // Emit API key created event
    this.emit('apiKeyCreated', { name, apiKey, permissions });

    return apiKey;
  }

  async revokeApiKey(apiKey: string): Promise<boolean> {
    const keyData = this.apiKeys.get(apiKey);
    if (!keyData) {
      return false;
    }

    this.apiKeys.delete(apiKey);
    this.logger.info(`Revoked API key: ${keyData.name}`);
    
    // Emit API key revoked event
    this.emit('apiKeyRevoked', { name: keyData.name, apiKey });

    return true;
  }

  async validatePermissions(userId: string, requiredPermissions: string[]): Promise<boolean> {
    // Find user permissions from tokens
    for (const [_token, tokenData] of this.tokens) {
      if (tokenData.userId === userId) {
        return this.checkPermissions(tokenData.permissions, requiredPermissions);
      }
    }

    return false;
  }

  async hasPermission(permissions: string[], method: string, _resource: string): Promise<boolean> {
    // If user has wildcard permission, they can do anything
    if (permissions.includes('*')) {
      return true;
    }

    // If user has admin permission, they can do anything
    if (permissions.includes('admin')) {
      return true;
    }

    // Check if user has the specific resource permission for the method
    const requiredPermission = method.toLowerCase(); // 'get' -> 'read', 'post' -> 'write', etc.
    const permissionMap: Record<string, string> = {
      'get': 'read',
      'post': 'write', 
      'put': 'write',
      'delete': 'write'
    };
    
    const mappedPermission = permissionMap[requiredPermission] || requiredPermission;
    
    return permissions.includes(mappedPermission) || 
      permissions.some(permission => 
        permission.endsWith('*') && mappedPermission.startsWith(permission.slice(0, -1))
      );
  }

  // Public validation methods that return boolean (for tests)
  async validateToken(token: string): Promise<boolean> {
    const result = this.validateTokenInternal(token);
    return result.success;
  }

  async validateApiKey(apiKey: string): Promise<boolean> {
    const result = this.validateApiKeyInternal(apiKey);
    return result.success;
  }

  // Method for cleaning up expired tokens (called by tests)
  async cleanupExpiredTokens(): Promise<void> {
    this.cleanupExpiredTokensInternal();
  }

  // Rate limiting method (interface compatibility)
  async rateLimitCheck(identifier: string): Promise<boolean> {
    return this.checkRateLimit(identifier);
  }

  // Rate limiting method (existing implementation)
  async checkRateLimit(_identifier: string): Promise<boolean> {
    // Simple implementation - always return true when rate limiting is disabled
    // In a real implementation, this would check against rate limiting rules
    return true;
  }

  // Authorization method
  async authorize(context: AuthContext, resource: string, action: string): Promise<boolean> {
    // Check if user has permission for the specific resource and action
    if (!context.permissions) {
      return false;
    }

    return this.hasPermission(context.permissions, action, resource);
  }

  // Session management methods
  async createSession(context: AuthContext): Promise<string> {
    // Create a session token (reuse token generation logic)
    const sessionId = this.generateSecureToken();
    
    // Store session data (reuse token storage for now)
    this.tokens.set(sessionId, {
      userId: context.userId || 'anonymous',
      permissions: context.permissions || [],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      lastUsed: new Date()
    });

    this.logger.debug(`Session created for user: ${context.userId || 'anonymous'}`, { sessionId: sessionId.substring(0, 8) + '...' });
    return sessionId;
  }

  async validateSession(sessionId: string): Promise<AuthContext | null> {
    const sessionData = this.tokens.get(sessionId);
    
    if (!sessionData || new Date() > sessionData.expiresAt) {
      return null;
    }

    // Update last used
    sessionData.lastUsed = new Date();
    this.tokens.set(sessionId, sessionData);

    return {
      userId: sessionData.userId,
      permissions: sessionData.permissions,
      mode: 'external-secure',
      trusted: false
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    const sessionData = this.tokens.get(sessionId);
    if (sessionData) {
      this.tokens.delete(sessionId);
      this.logger.debug(`Session revoked for user: ${sessionData.userId}`);
    }
  }

  // Audit logging method
  async auditLog(event: string, context: AuthContext, details?: any): Promise<void> {
    this.logger.info('Audit log', {
      event,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      details
    });
  }

  private authenticateLocalTrusted(clientIp: string, _method: string, _resource: string): AuthResponse {
    if (!this.isLocalTrusted(clientIp)) {
      return {
        success: false,
        error: 'Access denied from untrusted network'
      };
    }

    // Local trusted gets full permissions
    return {
      success: true,
      context: {
        mode: 'local-trusted' as const,
        userId: 'local-trusted',
        permissions: ['*'], // Full permissions
        trusted: true
      }
    };
  }

  private async authenticateExternalSecure(
    token?: string,
    apiKey?: string,
    _method?: string,
    _resource?: string
  ): Promise<AuthResponse> {
    // Try token authentication first
    if (token) {
      const tokenAuth = this.validateTokenInternal(token);
      return tokenAuth;
    }

    // Try API key authentication
    if (apiKey) {
      const apiKeyAuth = this.validateApiKeyInternal(apiKey);
      return apiKeyAuth;
    }

    return {
      success: false,
      error: 'No valid credentials provided'
    };
  }

  private validateTokenInternal(token: string): AuthResponse {
    const tokenData = this.tokens.get(token);
    
    if (!tokenData) {
      return {
        success: false,
        error: 'Invalid token'
      };
    }

    // Check if token is expired
    const now = new Date();
    const isExpired = now > tokenData.expiresAt;
    
    if (isExpired) {
      // Only delete if it's still in the map (avoid double deletion)
      if (this.tokens.has(token)) {
        this.tokens.delete(token);
      }
      return {
        success: false,
        error: 'Token expired'
      };
    }

    // Update last used timestamp
    tokenData.lastUsed = new Date();
    this.tokens.set(token, tokenData);

    return {
      success: true,
      context: {
        mode: 'external-secure' as const,
        userId: tokenData.userId,
        permissions: tokenData.permissions,
        token,
        expiresAt: tokenData.expiresAt,
        trusted: false
      }
    };
  }

  private validateApiKeyInternal(apiKey: string): AuthResponse {
    const keyData = this.apiKeys.get(apiKey);
    
    if (!keyData) {
      return {
        success: false,
        error: 'Invalid API key'
      };
    }

    // Update last used timestamp
    keyData.lastUsed = new Date();
    this.apiKeys.set(apiKey, keyData);

    return {
      success: true,
      context: {
        mode: 'external-secure' as const,
        userId: `api-key:${keyData.name}`,
        permissions: keyData.permissions,
        trusted: false,
        apiKey // Add the API key to context for tests
      }
    };
  }

  private isLocalTrusted(clientIp: string): boolean {
    try {
      if (!clientIp) return false;
      const raw = String(clientIp);
      let ip = raw;
      // IPv4 with optional port
      if (raw.includes('.')) {
        ip = raw.split(':')[0];
      }
      // IPv4-mapped IPv6
      if (raw.startsWith('::ffff:')) {
        ip = raw.slice(7);
      }
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
      // IPv4 private ranges
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        const toNum = (x: string) => x.split('.').reduce((a, b) => (a << 8) + (parseInt(b, 10) || 0), 0) >>> 0;
        const inRange = (addr: string, start: string, end: string) => {
          const n = toNum(addr);
          return n >= toNum(start) && n <= toNum(end);
        };
        if (inRange(ip, '10.0.0.0', '10.255.255.255')) return true;
        if (inRange(ip, '172.16.0.0', '172.31.255.255')) return true;
        if (inRange(ip, '192.168.0.0', '192.168.255.255')) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private checkPermissions(userPermissions: string[], requiredPermissions: string[]): boolean {
    // If user has wildcard permission, they can do anything
    if (userPermissions.includes('*')) {
      return true;
    }

    // Check if user has all required permissions
    return requiredPermissions.every(required => 
      userPermissions.includes(required) || 
      userPermissions.some(userPerm => 
        userPerm.endsWith('*') && required.startsWith(userPerm.slice(0, -1))
      )
    );
  }

  private generateSecureToken(): string {
    return randomBytes(32).toString('hex');
  }

  private generateSecureApiKey(): string {
    return `pbk_${randomBytes(24).toString('hex')}`;
  }

  private initializeDefaults(): void {
    // In production, do not auto-create default API key
    if (process.env.NODE_ENV === 'production') {
      this.logger.info('Production mode: skip creating default API key');
      return;
    }
    const apiKey = this.generateSecureApiKey();
    this.apiKeys.set(apiKey, {
      name: 'default-dev',
      permissions: ['*'],
      createdAt: new Date(),
      lastUsed: new Date()
    });
    // 为兼容现有测试与本地开发体验，开发/测试环境打印完整 key；生产环境已禁止默认创建
    const isTestOrDev = process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
    this.logger.info('Created default development API key', { apiKey: isTestOrDev ? apiKey : (apiKey.slice(0, 4) + '…' + apiKey.slice(-4)) });
    this.logger.debug('Current API keys count:', this.apiKeys.size);
  }

  private cleanupExpiredTokensInternal(): void {
    const now = new Date();
    let cleanupCount = 0;

    for (const [token, tokenData] of this.tokens) {
      if (now > tokenData.expiresAt) {
        this.tokens.delete(token);
        cleanupCount++;
      }
    }

    if (cleanupCount > 0) {
      this.logger.debug(`Cleaned up ${cleanupCount} expired tokens`);
    }
  }

  // Utility methods for monitoring and management
  getActiveTokenCount(): number {
    return this.tokens.size;
  }

  getActiveApiKeyCount(): number {
    return this.apiKeys.size;
  }

  getTokenInfo(token: string): { userId: string; permissions: string[]; expiresAt: Date } | null {
    const tokenData = this.tokens.get(token);
    if (!tokenData) {
      return null;
    }

    return {
      userId: tokenData.userId,
      permissions: tokenData.permissions,
      expiresAt: tokenData.expiresAt
    };
  }

  getApiKeyInfo(apiKey: string): { name: string; permissions: string[]; createdAt: Date } | null {
    const keyData = this.apiKeys.get(apiKey);
    if (!keyData) {
      return null;
    }

    return {
      name: keyData.name,
      permissions: keyData.permissions,
      createdAt: keyData.createdAt
    };
  }

  // Export/import functionality for persistence
  exportTokens(): Array<{ token: string; userId: string; permissions: string[]; expiresAt: string }> {
    return Array.from(this.tokens.entries()).map(([token, data]) => ({
      token,
      userId: data.userId,
      permissions: data.permissions,
      expiresAt: data.expiresAt.toISOString()
    }));
  }

  exportApiKeys(): Array<{ apiKey: string; name: string; permissions: string[]; createdAt: string }> {
    return Array.from(this.apiKeys.entries()).map(([apiKey, data]) => ({
      apiKey,
      name: data.name,
      permissions: data.permissions,
      createdAt: data.createdAt.toISOString()
    }));
  }

  importTokens(tokens: Array<{ token: string; userId: string; permissions: string[]; expiresAt: string }>): void {
    for (const tokenInfo of tokens) {
      this.tokens.set(tokenInfo.token, {
        userId: tokenInfo.userId,
        permissions: tokenInfo.permissions,
        expiresAt: new Date(tokenInfo.expiresAt),
        lastUsed: new Date()
      });
    }
    this.logger.info(`Imported ${tokens.length} tokens`);
  }

  importApiKeys(apiKeys: Array<{ apiKey: string; name: string; permissions: string[]; createdAt: string }>): void {
    for (const keyInfo of apiKeys) {
      this.apiKeys.set(keyInfo.apiKey, {
        name: keyInfo.name,
        permissions: keyInfo.permissions,
        createdAt: new Date(keyInfo.createdAt),
        lastUsed: new Date()
      });
    }
    this.logger.info(`Imported ${apiKeys.length} API keys`);
  }

  // API Key management methods
  listApiKeys(): Array<{ id: string; name: string; key: string; permissions: string[]; createdAt: string; lastUsed: string }> {
    const result: Array<{ id: string; name: string; key: string; permissions: string[]; createdAt: string; lastUsed: string }> = [];
    
    for (const [apiKey, data] of this.apiKeys) {
      result.push({
        id: apiKey.substring(0, 8), // Use first 8 chars as ID
        name: data.name,
        key: apiKey,
        permissions: data.permissions,
        createdAt: data.createdAt.toISOString(),
        lastUsed: data.lastUsed.toISOString()
      });
    }
    
    return result;
  }

  async deleteApiKey(apiKey: string): Promise<boolean> {
    const existed = this.apiKeys.has(apiKey);
    if (existed) {
      this.apiKeys.delete(apiKey);
      this.logger.info(`API key deleted: ${apiKey.substring(0, 12)}...`);
    }
    return existed;
  }

  // Token management methods  
  listTokens(): Array<{ token: string; userId: string; permissions: string[]; expiresAt: string; lastUsed: string }> {
    const result: Array<{ token: string; userId: string; permissions: string[]; expiresAt: string; lastUsed: string }> = [];
    
    for (const [token, data] of this.tokens) {
      result.push({
        token: token.substring(0, 16) + '...', // Mask token for security
        userId: data.userId,
        permissions: data.permissions,
        expiresAt: data.expiresAt.toISOString(),
        lastUsed: data.lastUsed.toISOString()
      });
    }
    
    return result;
  }
}
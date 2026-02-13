import { GatewayConfig, McpServiceConfig, AuthMode, Logger } from '../types/index.js';
import { ConfigValidator } from './ConfigValidator.js';

/**
 * Configuration merging and environment variable resolution
 */
export class ConfigMerger {
  /**
   * Create default gateway configuration
   */
  static createDefaultConfig(): GatewayConfig {
    return {
      host: '127.0.0.1',
      port: 19233,
      authMode: 'local-trusted',
      routingStrategy: 'performance',
      loadBalancingStrategy: 'performance-based',
      maxConcurrentServices: 50,
      logLevel: 'info',
      enableHealthChecks: true,
      healthCheckInterval: 30000,
      requestTimeout: 30000,
      maxRetries: 3,
      enableMetrics: true,
      metricsRetentionDays: 7,
      enableCors: true,
      corsOrigins: ['http://localhost:3000'],
      maxRequestSize: 10 * 1024 * 1024, // 10MB
      rateLimiting: {
        enabled: false,
        maxRequests: 100,
        windowMs: 60000, // 1 minute
        store: 'memory'
      },
      sandbox: {
        profile: 'default',
        container: { requiredForUntrusted: false, prefer: false }
      }
    };
  }

  /**
   * Apply environment variable overrides to configuration
   */
  static applyEnvOverrides(config: GatewayConfig, logger: Logger): GatewayConfig {
    const overrides: Partial<GatewayConfig> = {};

    // Support both PBMCP_* and PB_GATEWAY_* env names
    const envHost = process.env.PBMCP_HOST || process.env.PB_GATEWAY_HOST;
    if (envHost) {
      overrides.host = envHost;
    }

    const envPort = process.env.PBMCP_PORT || process.env.PB_GATEWAY_PORT;
    if (envPort) {
      const port = parseInt(envPort, 10);
      if (!Number.isNaN(port) && ConfigValidator.isValidPort(port)) {
        overrides.port = port;
      }
    }

    const envAuth = process.env.PBMCP_AUTH_MODE || process.env.PB_GATEWAY_AUTH_MODE;
    if (envAuth) {
      const authMode = envAuth as AuthMode;
      if (['local-trusted', 'external-secure', 'dual'].includes(authMode)) {
        overrides.authMode = authMode;
      }
    }

    const envLevel = process.env.PBMCP_LOG_LEVEL || process.env.PB_GATEWAY_LOG_LEVEL;
    if (envLevel && ConfigValidator.isValidLogLevel(envLevel)) {
      overrides.logLevel = envLevel;
    }

    if (Object.keys(overrides).length > 0) {
      logger.info('Applying environment variable overrides', overrides);
      return { ...config, ...overrides };
    }

    return config;
  }

  /**
   * Resolve environment variables in service configuration
   */
  static resolveEnvironmentVariables(config: McpServiceConfig): McpServiceConfig {
    const resolved = { ...config };

    if (resolved.env) {
      const resolvedEnv: Record<string, string> = {};

      for (const [key, value] of Object.entries(resolved.env)) {
        if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
          const envVar = value.slice(2, -1);
          resolvedEnv[key] = process.env[envVar] || value;
        } else {
          resolvedEnv[key] = value as string;
        }
      }

      resolved.env = resolvedEnv;
    }

    if (resolved.args) {
      resolved.args = resolved.args.map(arg => {
        if (typeof arg === 'string' && arg.startsWith('${') && arg.endsWith('}')) {
          const envVar = arg.slice(2, -1);
          return process.env[envVar] || arg;
        }
        return arg;
      });
    }

    return resolved;
  }
}

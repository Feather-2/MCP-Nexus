import { GatewayConfig, AuthMode, LoadBalancingStrategy } from '../types/index.js';

/**
 * Configuration validation utilities
 */
export class ConfigValidator {
  /**
   * Validate configuration strictly, throwing on any validation errors
   */
  static validateStrict(config: Partial<GatewayConfig>): void {
    const errors: string[] = [];

    // Validate port
    if (config.port !== undefined) {
      if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        errors.push('Port must be an integer between 1 and 65535');
      }
    }

    // Validate host
    if (config.host !== undefined) {
      if (typeof config.host !== 'string' || config.host.trim().length === 0) {
        errors.push('Host must be a non-empty string');
      }
    }

    // Validate auth mode
    if (config.authMode !== undefined) {
      const validAuthModes: AuthMode[] = ['local-trusted', 'external-secure', 'dual'];
      if (!validAuthModes.includes(config.authMode)) {
        errors.push(`Auth mode must be one of: ${validAuthModes.join(', ')}`);
      }
    }

    // Validate load balancing strategy
    if (config.loadBalancingStrategy !== undefined) {
      const validStrategies: LoadBalancingStrategy[] = [
        'round-robin', 'performance-based', 'cost-optimized', 'content-aware'
      ];
      if (!validStrategies.includes(config.loadBalancingStrategy)) {
        errors.push(`Load balancing strategy must be one of: ${validStrategies.join(', ')}`);
      }
    }

    // Validate log level
    if (config.logLevel !== undefined) {
      const validLogLevels = ['error', 'warn', 'info', 'debug', 'trace'];
      if (!validLogLevels.includes(config.logLevel)) {
        errors.push(`Log level must be one of: ${validLogLevels.join(', ')}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Validate and merge configuration with defaults
   */
  static validateAndMerge(loadedConfig: unknown): GatewayConfig {
    if (!loadedConfig || typeof loadedConfig !== 'object') {
      throw new Error('Configuration must be an object');
    }
    this.validateStrict(loadedConfig as Partial<GatewayConfig>);
    return { ...loadedConfig } as GatewayConfig;
  }

  /**
   * Check if port is valid
   */
  static isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }

  /**
   * Check if host is valid
   */
  static isValidHost(host: string): boolean {
    return typeof host === 'string' && host.trim().length > 0;
  }

  /**
   * Check if log level is valid
   */
  static isValidLogLevel(level: string): level is GatewayConfig['logLevel'] {
    return ['error', 'warn', 'info', 'debug', 'trace'].includes(level);
  }
}

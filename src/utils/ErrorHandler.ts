import { Logger } from '../types/index.js';

export class UnifiedErrorHandler {
  private stats = {
    totalErrors: 0,
    recentErrors: [] as Array<{ message: string; name?: string; category: string; timestamp: Date; serviceId?: string }>,
    errorsByCategory: {} as Record<string, number>,
    errorsByService: {} as Record<string, number>,
    recoveryAttempts: 0,
    recoveryAttemptsByService: {} as Record<string, number>
  };

  constructor(private logger: Logger) {}

  private categorize(error: unknown, context?: Record<string, unknown>): { category: string; recoverable: boolean } {
    const name = (error instanceof Error && error.name) || '';
    if (name.includes('Network')) return { category: 'network', recoverable: true };
    if (name.includes('Validation')) return { category: 'validation', recoverable: false };
    if (name.includes('Timeout')) return { category: 'timeout', recoverable: true };
    if (name.includes('Authentication')) return { category: 'authentication', recoverable: false };
    const op = context?.operation as string | undefined;
    const recover = op === 'start' || op === 'execute' || op === 'connect';
    return { category: 'unknown', recoverable: recover };
  }

  private redact(message?: string): string | undefined {
    if (!message) return message;
    return message
      .replace(/password=[^\s]+/gi, 'password=[REDACTED]')
      .replace(/token=[^\s]+/gi, 'token=[REDACTED]')
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
      .replace(/api[_-]?key=[^\s]+/gi, 'apikey=[REDACTED]');
  }

  handleError(error: unknown, context?: Record<string, unknown>): { suggestion: string; recoverable: boolean; autoRecoveryAttempted: boolean } {
    let info: Record<string, unknown> = {};
    if (error instanceof Error) {
      info = {
        message: this.redact(error.message),
        stack: error.stack,
        name: error.name,
        context,
        timestamp: new Date().toISOString()
      };
    } else if (typeof error === 'string') {
      info = { message: error, type: 'string', context };
    } else if (typeof error === 'object') {
      info = { message: (error as Record<string, unknown>)?.message || 'Unknown', context, error, type: 'object' };
    }

    const { category, recoverable } = this.categorize(error, context);
    info.category = category;
    info.recoverable = recoverable;

    // Stats
    this.stats.totalErrors++;
    this.stats.recentErrors.push({ message: String(info.message ?? ''), name: info.name as string | undefined, category, timestamp: new Date(), serviceId: context?.serviceId as string | undefined });
    if (this.stats.recentErrors.length > 100) this.stats.recentErrors.splice(0, this.stats.recentErrors.length - 100);
    this.stats.errorsByCategory[category] = (this.stats.errorsByCategory[category] || 0) + 1;
    const svcId = context?.serviceId as string | undefined;
    if (svcId) this.stats.errorsByService[svcId] = (this.stats.errorsByService[svcId] || 0) + 1;

    // Suggestions
    let suggestion = 'check logs';
    if (category === 'network') suggestion = 'retry connection';
    else if (category === 'validation') suggestion = 'fix input parameters';
    else if (context?.operation === 'start' || context?.operation === 'execute') suggestion = 'restart service';

    // Logging per category
    const prefix = (
      context?.operation ? `Error in operation ${context.operation}:` :
      category === 'network' && context?.serviceId ? `Network error in service ${context.serviceId}:` :
      category === 'validation' ? 'Validation error:' :
      category === 'timeout' ? 'Timeout error:' :
      category === 'authentication' ? 'Authentication error:' :
      'Unhandled error:'
    );
    this.logger.error(prefix, info);

    const recoveryKey = svcId || 'global';
    if (!this.stats.recoveryAttemptsByService) this.stats.recoveryAttemptsByService = {};
    const svcRecoveries = this.stats.recoveryAttemptsByService[recoveryKey] || 0;
    const autoRecoveryAttempted = !!context?.autoRecover && recoverable && (svcRecoveries < 3);
    if (autoRecoveryAttempted) {
      this.stats.recoveryAttemptsByService[recoveryKey] = svcRecoveries + 1;
      this.stats.recoveryAttempts++;
    }
    return { suggestion, recoverable, autoRecoveryAttempted };
  }

  wrapAsync<T extends unknown[], R>(
    fn: (...args: T) => Promise<R>,
    context?: Record<string, unknown>
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        this.handleError(error, context);
        throw error;
      }
    };
  }

  wrapSync<T extends unknown[], R>(
    fn: (...args: T) => R,
    context?: Record<string, unknown>
  ): (...args: T) => R {
    return (...args: T): R => {
      try {
        return fn(...args);
      } catch (error) {
        this.handleError(error, context);
        throw error;
      }
    };
  }

  // Stats and reports
  getErrorStatistics() {
    return {
      totalErrors: this.stats.totalErrors,
      recentErrors: [...this.stats.recentErrors],
      errorsByCategory: { ...this.stats.errorsByCategory },
      errorsByService: { ...this.stats.errorsByService }
    };
  }

  getRecoveryStatistics() {
    return { recoveryAttempts: this.stats.recoveryAttempts };
  }

  detectErrorPatterns() {
    const patterns: Array<{ type: string; category: string; count: number; serviceId: string }> = [];
    // simple pattern: repeated network errors for a service
    for (const [serviceId, count] of Object.entries(this.stats.errorsByService)) {
      if (count >= 5) {
        patterns.push({ type: 'repeated_error', category: 'mixed', count, serviceId });
      }
    }
    return patterns;
  }

  generateErrorReport() {
    const now = new Date();
    return {
      summary: {
        totalErrors: this.stats.totalErrors,
        timeRange: { end: now }
      },
      categories: { ...this.stats.errorsByCategory },
      services: { ...this.stats.errorsByService },
      recommendations: ['review network stability', 'validate inputs']
    };
  }

  formatError(error: Error, context?: Record<string, unknown>) {
    const { category } = this.categorize(error);
    return {
      message: this.redact(error.message),
      name: error.name,
      stack: error.stack,
      context,
      timestamp: new Date(),
      category
    };
  }

  serializeError(error: Error, extras?: Record<string, unknown>): string {
    const seen = new WeakSet();
    const safe = JSON.stringify({ ...this.formatError(error), extras }, function (_key, value) {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    return safe;
  }

  triggerAlert(level: 'critical' | 'warning', payload: unknown): void {
    // Placeholder: in production this would integrate with alerting systems
    this.logger.warn(`Alert(${level})`, payload);
  }

  handleCriticalError(error: Error): void {
    this.triggerAlert('critical', { message: error.message, name: error.name });
  }

  cleanup(): void {
    // Keep only the last 50 errors
    if (this.stats.recentErrors.length > 50) {
      this.stats.recentErrors = this.stats.recentErrors.slice(-50);
    }
  }

  resetStatistics(): void {
    this.stats = { totalErrors: 0, recentErrors: [], errorsByCategory: {}, errorsByService: {}, recoveryAttempts: 0, recoveryAttemptsByService: {} };
  }
}

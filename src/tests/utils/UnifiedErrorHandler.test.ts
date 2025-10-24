import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnifiedErrorHandler } from '../../utils/ErrorHandler.js';
import { Logger } from '../../types/index.js';

describe('UnifiedErrorHandler', () => {
  let errorHandler: UnifiedErrorHandler;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn()
    };

    errorHandler = new UnifiedErrorHandler(mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('basic error handling', () => {
    it('should handle simple errors', () => {
      const error = new Error('Test error');
      
      errorHandler.handleError(error);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Unhandled error:',
        expect.objectContaining({
          message: 'Test error',
          stack: expect.any(String)
        })
      );
    });

    it('should handle errors with context', () => {
      const error = new Error('Service error');
      const context = { serviceId: 'test-service', operation: 'start' };
      
      errorHandler.handleError(error, context);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error in operation start:',
        expect.objectContaining({
          message: 'Service error',
          context: { serviceId: 'test-service', operation: 'start' }
        })
      );
    });

    it('should handle string errors', () => {
      errorHandler.handleError('String error message');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Unhandled error:',
        expect.objectContaining({
          message: 'String error message',
          type: 'string'
        })
      );
    });

    it('should handle non-error objects', () => {
      const errorObj = { code: 500, message: 'Server error' };
      
      errorHandler.handleError(errorObj as any);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Unhandled error:',
        expect.objectContaining({
          error: errorObj,
          type: 'object'
        })
      );
    });
  });

  describe('error categorization', () => {
    it('should categorize network errors', () => {
      const networkError = new Error('ECONNREFUSED');
      networkError.name = 'NetworkError';
      
      errorHandler.handleError(networkError, { serviceId: 'test' });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Network error in service test:',
        expect.objectContaining({
          category: 'network',
          recoverable: true
        })
      );
    });

    it('should categorize validation errors', () => {
      const validationError = new Error('Invalid input');
      validationError.name = 'ValidationError';
      
      errorHandler.handleError(validationError);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Validation error:',
        expect.objectContaining({
          category: 'validation',
          recoverable: false
        })
      );
    });

    it('should categorize timeout errors', () => {
      const timeoutError = new Error('Operation timed out');
      timeoutError.name = 'TimeoutError';
      
      errorHandler.handleError(timeoutError);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Timeout error:',
        expect.objectContaining({
          category: 'timeout',
          recoverable: true
        })
      );
    });

    it('should categorize authentication errors', () => {
      const authError = new Error('Unauthorized');
      authError.name = 'AuthenticationError';
      
      errorHandler.handleError(authError);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Authentication error:',
        expect.objectContaining({
          category: 'authentication',
          recoverable: false
        })
      );
    });

    it('should handle unknown error types as generic', () => {
      const genericError = new Error('Unknown error');
      genericError.name = 'UnknownError';
      
      errorHandler.handleError(genericError);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Unhandled error:',
        expect.objectContaining({
          category: 'unknown',
          recoverable: false
        })
      );
    });
  });

  describe('error recovery suggestions', () => {
    it('should suggest retry for network errors', () => {
      const networkError = new Error('Connection failed');
      networkError.name = 'NetworkError';
      
      const result = errorHandler.handleError(networkError);

      expect(result.suggestion).toContain('retry');
      expect(result.recoverable).toBe(true);
    });

    it('should suggest restart for service errors', () => {
      const serviceError = new Error('Service crashed');
      const context = { serviceId: 'test-service', operation: 'execute' };
      
      const result = errorHandler.handleError(serviceError, context);

      expect(result.suggestion).toContain('restart');
      expect(result.recoverable).toBe(true);
    });

    it('should suggest validation fixes for validation errors', () => {
      const validationError = new Error('Invalid parameters');
      validationError.name = 'ValidationError';
      
      const result = errorHandler.handleError(validationError);

      expect(result.suggestion).toContain('input');
      expect(result.recoverable).toBe(false);
    });
  });

  describe('error tracking and statistics', () => {
    it('should track error counts', () => {
      errorHandler.handleError(new Error('Error 1'));
      errorHandler.handleError(new Error('Error 2'));
      errorHandler.handleError(new Error('Error 3'));

      const stats = errorHandler.getErrorStatistics();

      expect(stats.totalErrors).toBe(3);
      expect(stats.recentErrors).toHaveLength(3);
    });

    it('should track errors by category', () => {
      const networkError = new Error('Network error');
      networkError.name = 'NetworkError';
      
      const validationError = new Error('Validation error');
      validationError.name = 'ValidationError';

      errorHandler.handleError(networkError);
      errorHandler.handleError(validationError);
      errorHandler.handleError(networkError);

      const stats = errorHandler.getErrorStatistics();

      expect(stats.errorsByCategory.network).toBe(2);
      expect(stats.errorsByCategory.validation).toBe(1);
    });

    it('should track errors by service', () => {
      errorHandler.handleError(new Error('Error 1'), { serviceId: 'service-a' });
      errorHandler.handleError(new Error('Error 2'), { serviceId: 'service-a' });
      errorHandler.handleError(new Error('Error 3'), { serviceId: 'service-b' });

      const stats = errorHandler.getErrorStatistics();

      expect(stats.errorsByService['service-a']).toBe(2);
      expect(stats.errorsByService['service-b']).toBe(1);
    });

    it('should limit recent errors history', () => {
      // Add more than the limit (assume limit is 100)
      for (let i = 0; i < 150; i++) {
        errorHandler.handleError(new Error(`Error ${i}`));
      }

      const stats = errorHandler.getErrorStatistics();

      expect(stats.recentErrors.length).toBeLessThanOrEqual(100);
      expect(stats.totalErrors).toBe(150);
    });
  });

  describe('error reporting and alerts', () => {
    it('should trigger alerts for critical errors', () => {
      const criticalError = new Error('System failure');
      const alertSpy = vi.spyOn(errorHandler, 'triggerAlert');

      errorHandler.handleCriticalError(criticalError);

      expect(alertSpy).toHaveBeenCalledWith(
        'critical',
        expect.objectContaining({
          message: 'System failure'
        })
      );
    });

    it('should detect error patterns', () => {
      // Simulate repeated network errors
      for (let i = 0; i < 10; i++) {
        const networkError = new Error('Connection failed');
        networkError.name = 'NetworkError';
        errorHandler.handleError(networkError, { serviceId: 'service-1' });
      }

      const patterns = errorHandler.detectErrorPatterns();

      expect(patterns).toContainEqual(
        expect.objectContaining({
          type: 'repeated_error',
          category: 'network',
          count: 10,
          serviceId: 'service-1'
        })
      );
    });

    it('should generate error reports', () => {
      errorHandler.handleError(new Error('Test error 1'));
      errorHandler.handleError(new Error('Test error 2'));

      const report = errorHandler.generateErrorReport();

      expect(report).toMatchObject({
        summary: {
          totalErrors: 2,
          timeRange: expect.any(Object)
        },
        categories: expect.any(Object),
        services: expect.any(Object),
        recommendations: expect.any(Array)
      });
    });
  });

  describe('error recovery', () => {
    it('should attempt automatic recovery for recoverable errors', async () => {
      const recoverableError = new Error('Temporary failure');
      recoverableError.name = 'NetworkError';
      
      const context = { 
        serviceId: 'test-service',
        operation: 'connect',
        autoRecover: true 
      };

      const result = errorHandler.handleError(recoverableError, context);

      expect(result.recoverable).toBe(true);
      expect(result.autoRecoveryAttempted).toBe(true);
    });

    it('should not attempt recovery for non-recoverable errors', () => {
      const nonRecoverableError = new Error('Invalid configuration');
      nonRecoverableError.name = 'ValidationError';
      
      const result = errorHandler.handleError(nonRecoverableError);

      expect(result.recoverable).toBe(false);
      expect(result.autoRecoveryAttempted).toBe(false);
    });

    it('should limit recovery attempts', () => {
      const error = new Error('Flaky service');
      const context = { serviceId: 'flaky-service', autoRecover: true };

      // Attempt recovery multiple times
      for (let i = 0; i < 5; i++) {
        errorHandler.handleError(error, context);
      }

      const stats = errorHandler.getRecoveryStatistics();
      expect(stats.recoveryAttempts).toBeLessThanOrEqual(3); // Max attempts
    });
  });

  describe('error formatting and serialization', () => {
    it('should format errors for logging', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.js:1:1';
      
      const formatted = errorHandler.formatError(error, { serviceId: 'test' });

      expect(formatted).toMatchObject({
        message: 'Test error',
        name: 'Error',
        stack: expect.any(String),
        context: { serviceId: 'test' },
        timestamp: expect.any(Date),
        category: expect.any(String)
      });
    });

    it('should sanitize sensitive information from errors', () => {
      const error = new Error('Database connection failed: password=secret123');
      
      const formatted = errorHandler.formatError(error);

      expect(formatted.message).not.toContain('secret123');
      expect(formatted.message).toContain('[REDACTED]');
    });

    it('should serialize errors to JSON safely', () => {
      const error = new Error('Test error');
      const circular = { error };
      circular.self = circular; // Create circular reference
      
      const serialized = errorHandler.serializeError(error, { circular });

      expect(() => JSON.parse(serialized)).not.toThrow();
      expect(JSON.parse(serialized)).toMatchObject({
        message: 'Test error',
        name: 'Error'
      });
    });
  });

  describe('cleanup and maintenance', () => {
    it('should clean up old error records', () => {
      // Add some old errors
      for (let i = 0; i < 50; i++) {
        errorHandler.handleError(new Error(`Old error ${i}`));
      }

      const statsBefore = errorHandler.getErrorStatistics();
      errorHandler.cleanup();
      const statsAfter = errorHandler.getErrorStatistics();

      expect(statsAfter.recentErrors.length).toBeLessThanOrEqual(statsBefore.recentErrors.length);
    });

    it('should reset error statistics', () => {
      errorHandler.handleError(new Error('Test error'));
      
      errorHandler.resetStatistics();
      
      const stats = errorHandler.getErrorStatistics();
      expect(stats.totalErrors).toBe(0);
      expect(stats.recentErrors).toHaveLength(0);
      expect(Object.keys(stats.errorsByCategory)).toHaveLength(0);
    });
  });
});
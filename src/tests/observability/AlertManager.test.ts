import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertManager, AlertMetrics } from '../../observability/AlertManager.js';
import { Logger } from '../../types/index.js';

describe('AlertManager', () => {
  let alertManager: AlertManager;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn()
    } as unknown as Logger;
    alertManager = new AlertManager(mockLogger);
  });

  describe('default rules', () => {
    it('should initialize with default alert rules', () => {
      const rules = alertManager.getRules();
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.some(r => r.name === 'high_error_rate')).toBe(true);
      expect(rules.some(r => r.name === 'high_memory_usage')).toBe(true);
      expect(rules.some(r => r.name === 'service_unavailable')).toBe(true);
      expect(rules.some(r => r.name === 'high_response_time')).toBe(true);
    });
  });

  describe('checkAndAlert', () => {
    it('should trigger high_error_rate alert when success rate is low', async () => {
      const metrics: AlertMetrics = {
        successRate: 0.5,
        averageResponseTime: 100,
        totalRequests: 20,
        memoryUsageMB: 100,
        servicesError: 0,
        servicesTotal: 5
      };

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[ALERT]'),
        expect.objectContaining({ rule: 'high_error_rate' })
      );
    });

    it('should trigger high_memory_usage alert when memory exceeds threshold', async () => {
      const metrics: AlertMetrics = {
        successRate: 1.0,
        averageResponseTime: 100,
        totalRequests: 5,
        memoryUsageMB: 600,
        servicesError: 0,
        servicesTotal: 5
      };

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[ALERT]'),
        expect.objectContaining({ rule: 'high_memory_usage' })
      );
    });

    it('should trigger service_unavailable alert when services are in error state', async () => {
      const metrics: AlertMetrics = {
        successRate: 1.0,
        averageResponseTime: 100,
        totalRequests: 5,
        memoryUsageMB: 100,
        servicesError: 2,
        servicesTotal: 5
      };

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[ALERT]'),
        expect.objectContaining({ rule: 'service_unavailable' })
      );
    });

    it('should trigger high_response_time alert when response time is high', async () => {
      const metrics: AlertMetrics = {
        successRate: 1.0,
        averageResponseTime: 6000,
        totalRequests: 10,
        memoryUsageMB: 100,
        servicesError: 0,
        servicesTotal: 5
      };

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[ALERT]'),
        expect.objectContaining({ rule: 'high_response_time' })
      );
    });

    it('should not trigger alerts when metrics are healthy', async () => {
      const metrics: AlertMetrics = {
        successRate: 0.95,
        averageResponseTime: 100,
        totalRequests: 20,
        memoryUsageMB: 100,
        servicesError: 0,
        servicesTotal: 5
      };

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('cooldown mechanism', () => {
    it('should respect cooldown period and not trigger duplicate alerts', async () => {
      const metrics: AlertMetrics = {
        successRate: 0.5,
        averageResponseTime: 100,
        totalRequests: 20,
        memoryUsageMB: 100,
        servicesError: 0,
        servicesTotal: 5
      };

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('should allow alerts after cooldown is cleared', async () => {
      const metrics: AlertMetrics = {
        successRate: 0.5,
        averageResponseTime: 100,
        totalRequests: 20,
        memoryUsageMB: 100,
        servicesError: 0,
        servicesTotal: 5
      };

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      alertManager.clearCooldowns();

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('custom rules', () => {
    it('should allow adding custom alert rules', async () => {
      alertManager.addRule({
        name: 'custom_rule',
        condition: (m) => m.totalRequests > 1000,
        severity: 'info',
        cooldown: 60000
      });

      const rules = alertManager.getRules();
      expect(rules.some(r => r.name === 'custom_rule')).toBe(true);

      const metrics: AlertMetrics = {
        successRate: 1.0,
        averageResponseTime: 100,
        totalRequests: 1500,
        memoryUsageMB: 100,
        servicesError: 0,
        servicesTotal: 5
      };

      await alertManager.checkAndAlert(metrics);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[ALERT]'),
        expect.objectContaining({ rule: 'custom_rule' })
      );
    });
  });
});

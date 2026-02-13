import { Logger } from '../types/index.js';

export interface AlertMetrics {
  successRate: number;
  averageResponseTime: number;
  totalRequests: number;
  memoryUsageMB: number;
  servicesError: number;
  servicesTotal: number;
}

export interface AlertRule {
  name: string;
  condition: (metrics: AlertMetrics) => boolean;
  severity: 'critical' | 'warning' | 'info';
  cooldown: number;
}

interface AlertCooldown {
  lastTriggered: number;
}

export class AlertManager {
  private rules: AlertRule[] = [];
  private cooldowns = new Map<string, AlertCooldown>();

  constructor(private logger: Logger) {
    this.initializeDefaultRules();
  }

  private initializeDefaultRules(): void {
    this.rules = [
      {
        name: 'high_error_rate',
        condition: (m) => m.totalRequests > 10 && m.successRate < 0.8,
        severity: 'critical',
        cooldown: 300000
      },
      {
        name: 'high_memory_usage',
        condition: (m) => m.memoryUsageMB > 512,
        severity: 'warning',
        cooldown: 600000
      },
      {
        name: 'service_unavailable',
        condition: (m) => m.servicesError > 0,
        severity: 'critical',
        cooldown: 180000
      },
      {
        name: 'high_response_time',
        condition: (m) => m.totalRequests > 5 && m.averageResponseTime > 5000,
        severity: 'warning',
        cooldown: 300000
      }
    ];
  }

  addRule(rule: AlertRule): void {
    this.rules.push(rule);
  }

  async checkAndAlert(metrics: AlertMetrics): Promise<void> {
    for (const rule of this.rules) {
      if (rule.condition(metrics) && !this.isInCooldown(rule)) {
        await this.sendAlert(rule, metrics);
        this.setCooldown(rule);
      }
    }
  }

  private isInCooldown(rule: AlertRule): boolean {
    const cooldown = this.cooldowns.get(rule.name);
    if (!cooldown) return false;
    return Date.now() - cooldown.lastTriggered < rule.cooldown;
  }

  private setCooldown(rule: AlertRule): void {
    this.cooldowns.set(rule.name, { lastTriggered: Date.now() });
  }

  private async sendAlert(rule: AlertRule, metrics: AlertMetrics): Promise<void> {
    this.logger.warn(`[ALERT] ${rule.severity.toUpperCase()}: ${rule.name}`, {
      rule: rule.name,
      severity: rule.severity,
      metrics
    });
  }

  getRules(): AlertRule[] {
    return [...this.rules];
  }

  clearCooldowns(): void {
    this.cooldowns.clear();
  }
}

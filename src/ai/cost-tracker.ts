import type { AiUsage, CostConfig, ModelPricing } from './types.js';

// 默认定价 (USD per 1K tokens)
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-20250514': { promptPer1kTokens: 0.003, completionPer1kTokens: 0.015 },
  'claude-haiku-4-20250514': { promptPer1kTokens: 0.00025, completionPer1kTokens: 0.00125 },
  'gpt-4o': { promptPer1kTokens: 0.0025, completionPer1kTokens: 0.01 },
  'gpt-4o-mini': { promptPer1kTokens: 0.00015, completionPer1kTokens: 0.0006 },
  'gemini-1.5-pro': { promptPer1kTokens: 0.00125, completionPer1kTokens: 0.005 },
  'gemini-1.5-flash': { promptPer1kTokens: 0.000075, completionPer1kTokens: 0.0003 },
};

type BudgetPeriod = NonNullable<CostConfig['budgetPeriod']>;

type ModelUsageStats = {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
};

type UsageSnapshot = {
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  budgetUsd?: number;
  budgetRemaining?: number;
  periodStart: Date;
  periodEnd?: Date;
};

function safeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value);
}

function startOfUtcHour(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), 0, 0, 0));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

function getBudgetPeriodBounds(now: Date, period: BudgetPeriod): { start: Date; end: Date } {
  if (period === 'hour') {
    const start = startOfUtcHour(now);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return { start, end };
  }

  if (period === 'day') {
    const start = startOfUtcDay(now);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  const start = startOfUtcMonth(now);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

export class CostTracker {
  private readonly pricing: Record<string, ModelPricing>;
  private readonly budgetUsd?: number;
  private readonly budgetPeriod?: BudgetPeriod;

  private periodStart: Date;
  private periodEnd?: Date;

  private totalCostUsd = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;

  private readonly usageByModel = new Map<string, ModelUsageStats>();

  constructor(config?: CostConfig) {
    this.pricing = { ...DEFAULT_PRICING, ...(config?.pricing ?? {}) };
    this.budgetUsd = config?.budgetUsd;
    this.budgetPeriod = config?.budgetPeriod;

    const now = new Date();
    if (this.budgetPeriod) {
      const { start, end } = getBudgetPeriodBounds(now, this.budgetPeriod);
      this.periodStart = start;
      this.periodEnd = end;
    } else {
      this.periodStart = now;
      this.periodEnd = undefined;
    }
  }

  estimate(model: string, promptTokens: number, completionTokens: number): number {
    const pricing = this.pricing[model];
    if (!pricing) return 0;

    const safePrompt = safeNonNegativeInteger(promptTokens);
    const safeCompletion = safeNonNegativeInteger(completionTokens);

    return (safePrompt / 1000) * pricing.promptPer1kTokens + (safeCompletion / 1000) * pricing.completionPer1kTokens;
  }

  record(model: string, usage: AiUsage): void {
    this.ensureCurrentPeriod();

    const promptTokens = safeNonNegativeInteger(usage.promptTokens);
    const completionTokens = safeNonNegativeInteger(usage.completionTokens);
    const costUsd = this.estimate(model, promptTokens, completionTokens);

    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalCostUsd += costUsd;

    const existing = this.usageByModel.get(model);
    if (existing) {
      existing.requests += 1;
      existing.promptTokens += promptTokens;
      existing.completionTokens += completionTokens;
      existing.costUsd += costUsd;
    } else {
      this.usageByModel.set(model, {
        requests: 1,
        promptTokens,
        completionTokens,
        costUsd,
      });
    }
  }

  isOverBudget(): boolean {
    this.ensureCurrentPeriod();
    if (this.budgetUsd === undefined) return false;
    return this.totalCostUsd > this.budgetUsd;
  }

  getUsage(): UsageSnapshot {
    this.ensureCurrentPeriod();

    const snapshot: UsageSnapshot = {
      totalCostUsd: this.totalCostUsd,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      periodStart: new Date(this.periodStart.getTime()),
      periodEnd: this.periodEnd ? new Date(this.periodEnd.getTime()) : undefined,
    };

    if (this.budgetUsd !== undefined) {
      snapshot.budgetUsd = this.budgetUsd;
      snapshot.budgetRemaining = this.budgetUsd - this.totalCostUsd;
    }

    return snapshot;
  }

  getUsageByModel(): Record<string, ModelUsageStats> {
    this.ensureCurrentPeriod();
    const out: Record<string, ModelUsageStats> = {};

    for (const [model, stats] of this.usageByModel.entries()) {
      out[model] = { ...stats };
    }

    return out;
  }

  reset(): void {
    const now = new Date();
    if (this.budgetPeriod) {
      const { start, end } = getBudgetPeriodBounds(now, this.budgetPeriod);
      this.periodStart = start;
      this.periodEnd = end;
    } else {
      this.periodStart = now;
      this.periodEnd = undefined;
    }

    this.totalCostUsd = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.usageByModel.clear();
  }

  private ensureCurrentPeriod(): void {
    if (!this.budgetPeriod) return;

    const now = new Date();
    const { start, end } = getBudgetPeriodBounds(now, this.budgetPeriod);
    if (start.getTime() === this.periodStart.getTime()) return;

    this.periodStart = start;
    this.periodEnd = end;
    this.totalCostUsd = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.usageByModel.clear();
  }
}


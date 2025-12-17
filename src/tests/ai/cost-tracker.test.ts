import { describe, expect, it, vi } from 'vitest';

import { CostTracker, DEFAULT_PRICING } from '../../ai/cost-tracker.js';

describe('CostTracker', () => {
  it('estimate calculates cost correctly', () => {
    const tracker = new CostTracker();
    const cost = tracker.estimate('gpt-4o', 1000, 2000);
    expect(cost).toBeCloseTo(0.0225, 10);
  });

  it('estimate returns 0 for unknown models', () => {
    const tracker = new CostTracker();
    expect(tracker.estimate('unknown-model', 1000, 1000)).toBe(0);
  });

  it('record accumulates usage and cost', () => {
    const tracker = new CostTracker();

    tracker.record('gpt-4o', { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 });
    tracker.record('gpt-4o', { promptTokens: 0, completionTokens: 1000, totalTokens: 1000 });

    const usage = tracker.getUsage();
    expect(usage.totalPromptTokens).toBe(1000);
    expect(usage.totalCompletionTokens).toBe(1000);
    expect(usage.totalCostUsd).toBeCloseTo(0.0125, 10);
  });

  it('isOverBudget returns true when cost exceeds budget', () => {
    const tracker = new CostTracker({
      pricing: DEFAULT_PRICING,
      budgetUsd: 0.01,
      budgetPeriod: 'day',
    });

    tracker.record('gpt-4o', { promptTokens: 5000, completionTokens: 0, totalTokens: 5000 });
    expect(tracker.isOverBudget()).toBe(true);
  });

  it('getUsage returns correct snapshot fields', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-01-01T00:30:00.000Z'));

      const tracker = new CostTracker({
        pricing: DEFAULT_PRICING,
        budgetUsd: 1,
        budgetPeriod: 'day',
      });

      tracker.record('gpt-4o-mini', { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 });

      const usage = tracker.getUsage();
      expect(usage.totalPromptTokens).toBe(1000);
      expect(usage.totalCompletionTokens).toBe(1000);
      expect(usage.budgetUsd).toBe(1);
      expect(usage.budgetRemaining).toBeCloseTo(1 - 0.00075, 12);
      expect(usage.periodStart.getTime()).toBe(new Date('2025-01-01T00:00:00.000Z').getTime());
      expect(usage.periodEnd?.getTime()).toBe(new Date('2025-01-02T00:00:00.000Z').getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('getUsageByModel groups usage by model', () => {
    const tracker = new CostTracker();

    tracker.record('gpt-4o', { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 });
    tracker.record('gpt-4o-mini', { promptTokens: 0, completionTokens: 1000, totalTokens: 1000 });
    tracker.record('gpt-4o-mini', { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 });

    const byModel = tracker.getUsageByModel();
    expect(Object.keys(byModel).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);

    expect(byModel['gpt-4o']).toEqual({
      requests: 1,
      promptTokens: 1000,
      completionTokens: 0,
      costUsd: tracker.estimate('gpt-4o', 1000, 0),
    });

    expect(byModel['gpt-4o-mini']).toEqual({
      requests: 2,
      promptTokens: 1000,
      completionTokens: 1000,
      costUsd:
        tracker.estimate('gpt-4o-mini', 0, 1000) + tracker.estimate('gpt-4o-mini', 1000, 0),
    });
  });

  it('budget period automatically resets stats', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-01-01T00:30:00.000Z'));

      const tracker = new CostTracker({
        pricing: DEFAULT_PRICING,
        budgetUsd: 10,
        budgetPeriod: 'hour',
      });

      tracker.record('gpt-4o', { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 });
      expect(tracker.getUsage().totalPromptTokens).toBe(1000);
      expect(tracker.getUsage().periodStart.getTime()).toBe(new Date('2025-01-01T00:00:00.000Z').getTime());

      vi.setSystemTime(new Date('2025-01-01T01:00:00.000Z'));
      tracker.record('gpt-4o', { promptTokens: 500, completionTokens: 0, totalTokens: 500 });

      const usage = tracker.getUsage();
      expect(usage.totalPromptTokens).toBe(500);
      expect(usage.totalCompletionTokens).toBe(0);
      expect(usage.periodStart.getTime()).toBe(new Date('2025-01-01T01:00:00.000Z').getTime());
      expect(usage.periodEnd?.getTime()).toBe(new Date('2025-01-01T02:00:00.000Z').getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset clears all counters', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-01-01T00:30:00.000Z'));

      const tracker = new CostTracker();
      tracker.record('gpt-4o', { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 });
      expect(tracker.getUsage().totalCostUsd).toBeGreaterThan(0);
      expect(Object.keys(tracker.getUsageByModel()).length).toBe(1);

      vi.setSystemTime(new Date('2025-01-01T00:31:00.000Z'));
      tracker.reset();
      expect(tracker.getUsage().totalCostUsd).toBe(0);
      expect(tracker.getUsage().totalPromptTokens).toBe(0);
      expect(tracker.getUsage().totalCompletionTokens).toBe(0);
      expect(Object.keys(tracker.getUsageByModel()).length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset recalculates budget period bounds', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));

      const tracker = new CostTracker({
        pricing: DEFAULT_PRICING,
        budgetUsd: 10,
        budgetPeriod: 'day',
      });

      tracker.record('gpt-4o', { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 });
      vi.setSystemTime(new Date('2025-01-02T10:00:00.000Z'));

      tracker.reset();
      const usage = tracker.getUsage();
      expect(usage.totalCostUsd).toBe(0);
      expect(usage.periodStart.getTime()).toBe(new Date('2025-01-02T00:00:00.000Z').getTime());
      expect(usage.periodEnd?.getTime()).toBe(new Date('2025-01-03T00:00:00.000Z').getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('month budget period uses UTC month boundaries', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2025-02-15T10:00:00.000Z'));

      const tracker = new CostTracker({
        pricing: DEFAULT_PRICING,
        budgetUsd: 10,
        budgetPeriod: 'month',
      });

      const usage = tracker.getUsage();
      expect(usage.periodStart.getTime()).toBe(new Date('2025-02-01T00:00:00.000Z').getTime());
      expect(usage.periodEnd?.getTime()).toBe(new Date('2025-03-01T00:00:00.000Z').getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('custom pricing overrides defaults', () => {
    const tracker = new CostTracker({
      pricing: {
        'gpt-4o': { promptPer1kTokens: 1, completionPer1kTokens: 1 },
      },
    });

    expect(tracker.estimate('gpt-4o', 1000, 0)).toBe(1);
    expect(tracker.estimate('gpt-4o-mini', 1000, 0)).toBeCloseTo(0.00015, 12);
  });
});

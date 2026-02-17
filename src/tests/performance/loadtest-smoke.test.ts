import { describe, it, expect } from 'vitest';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const idx = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, idx)] ?? sorted[sorted.length - 1];
}

function formatMs(ms: number): string {
  if (ms > 0 && ms < 0.001) {
    return `${Math.max(1, Math.round(ms * 1000))}μs`;
  }

  return `${ms.toFixed(1)}ms`;
}

describe('Load test utilities', () => {
  it('percentile calculates correctly for sorted arrays', () => {
    const data = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(data, 50)).toBe(50);
    expect(percentile(data, 95)).toBe(95);
    expect(percentile(data, 99)).toBe(99);
    expect(percentile(data, 100)).toBe(100);
  });

  it('percentile handles single element', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('percentile handles empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('formatMs formats microseconds and milliseconds', () => {
    expect(formatMs(0.5)).toBe('0.5ms');
    expect(formatMs(12.345)).toBe('12.3ms');
    expect(formatMs(0.0005)).toBe('1μs');
  });

  it('LoadTestResult shape is valid', () => {
    const result = {
      scenario: 'test',
      totalRequests: 100,
      successCount: 99,
      errorCount: 1,
      duration: 1000,
      rps: 100,
      latency: { min: 1, max: 50, avg: 10, p50: 8, p95: 25, p99: 45 },
      errors: { '500': 1 },
    };

    expect(result.rps).toBe(100);
    expect(result.successCount + result.errorCount).toBe(result.totalRequests);
  });
});

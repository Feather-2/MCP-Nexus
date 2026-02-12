import { SkillRiskAccumulator } from './SkillRiskAccumulator.js';
import type { RiskFlag } from './SkillDiffAnalyzer.js';

function createRiskFlag(
  severity: RiskFlag['severity'],
  overrides: Partial<RiskFlag> = {}
): RiskFlag {
  return {
    type: 'code',
    description: `risk-${severity}`,
    severity,
    isEscalation: false,
    details: {},
    ...overrides
  };
}

describe('SkillRiskAccumulator', () => {
  it('accumulates recent flags and groups by severity', () => {
    const base = 1_700_000_000_000;
    const accumulator = new SkillRiskAccumulator({
      nowProvider: () => base + 5_000
    });

    const first = createRiskFlag('medium');
    const second = createRiskFlag('low');
    const snapshot = accumulator.accumulateRisk('demo-skill', [first, second], base);

    expect(snapshot.skillId).toBe('demo-skill');
    expect(snapshot.recentChanges).toHaveLength(1);
    expect(snapshot.mediumFlags).toHaveLength(1);
    expect(snapshot.lowFlags).toHaveLength(1);
    expect(snapshot.criticalFlags).toHaveLength(0);
    expect(snapshot.highFlags).toHaveLength(0);
    expect(snapshot.escalationCount).toBe(0);
  });

  it('triggers threshold when critical risk exists', () => {
    const base = 1_700_000_000_000;
    const accumulator = new SkillRiskAccumulator({
      nowProvider: () => base
    });

    accumulator.accumulateRisk('demo-skill', [createRiskFlag('critical')], base);
    const result = accumulator.checkThreshold('demo-skill');

    expect(result.exceedsThreshold).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'Critical risk flags detected: 1'
    ]));
  });

  it('triggers threshold when high risk count is greater than 3', () => {
    const base = 1_700_000_000_000;
    const accumulator = new SkillRiskAccumulator({
      nowProvider: () => base
    });

    accumulator.accumulateRisk('demo-skill', [
      createRiskFlag('high'),
      createRiskFlag('high'),
      createRiskFlag('high'),
      createRiskFlag('high')
    ], base);

    const result = accumulator.checkThreshold('demo-skill');
    expect(result.exceedsThreshold).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'High severity risk flags exceed threshold (>3): 4'
    ]));
  });

  it('triggers threshold when escalation is detected', () => {
    const base = 1_700_000_000_000;
    const accumulator = new SkillRiskAccumulator({
      nowProvider: () => base
    });

    accumulator.accumulateRisk('demo-skill', [
      createRiskFlag('low', { isEscalation: true, type: 'permission' })
    ], base);

    const result = accumulator.checkThreshold('demo-skill');
    expect(result.exceedsThreshold).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'Escalation risk detected: 1'
    ]));
  });

  it('triggers threshold for medium/low accumulation above 10', () => {
    const base = 1_700_000_000_000;
    const accumulator = new SkillRiskAccumulator({
      nowProvider: () => base
    });

    const mediumLowFlags = Array.from({ length: 11 }, (_, index) =>
      index % 2 === 0 ? createRiskFlag('medium') : createRiskFlag('low'));

    accumulator.accumulateRisk('demo-skill', mediumLowFlags, base);

    const result = accumulator.checkThreshold('demo-skill');
    expect(result.exceedsThreshold).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'Medium/low risk flags exceed threshold (>10): 11'
    ]));
  });

  it('applies 24h sliding window when accumulating changes', () => {
    const base = 1_700_000_000_000;
    let now = base;
    const accumulator = new SkillRiskAccumulator({
      nowProvider: () => now
    });

    accumulator.accumulateRisk('demo-skill', [createRiskFlag('high')], base);
    now = base + 25 * 60 * 60 * 1000;
    accumulator.accumulateRisk('demo-skill', [createRiskFlag('low')], now);

    const snapshot = accumulator.getAccumulatedRisk('demo-skill');
    expect(snapshot.recentChanges).toHaveLength(1);
    expect(snapshot.highFlags).toHaveLength(0);
    expect(snapshot.lowFlags).toHaveLength(1);
  });

  it('returns empty threshold result for unknown skill', () => {
    const accumulator = new SkillRiskAccumulator();
    const snapshot = accumulator.getAccumulatedRisk('unknown-skill');
    const threshold = accumulator.checkThreshold('unknown-skill');

    expect(snapshot).toEqual({
      skillId: 'unknown-skill',
      recentChanges: [],
      criticalFlags: [],
      highFlags: [],
      mediumFlags: [],
      lowFlags: [],
      escalationCount: 0
    });
    expect(threshold).toEqual({
      exceedsThreshold: false,
      reasons: []
    });
  });
});

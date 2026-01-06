import { HARD_REJECT, RiskScorer } from '../../security/RiskScorer.js';
import type { RiskSignal } from '../../security/types.js';

describe('RiskScorer', () => {
  it('hard-rejects immediately when a HARD_REJECT signal is present', () => {
    const scorer = new RiskScorer();

    const signals: RiskSignal[] = [
      {
        source: `rule:${HARD_REJECT[0]}`,
        weight: 1,
        score: -999,
        confidence: 1,
        evidence: '  matched curl|bash  '
      },
      {
        source: 'reputation',
        weight: 0.3,
        score: 20,
        confidence: 1,
        evidence: 'trusted author'
      }
    ];

    const result = scorer.score(signals);
    expect(result.decision).toBe('reject');
    expect(result.reviewRequired).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reason).toContain('Hard reject');
    expect(result.reason).toContain('curl|bash');
  });

  it('multiplies AI signals by confidence', () => {
    const scorer = new RiskScorer();

    const result = scorer.score([
      {
        source: 'ai',
        weight: 0.5,
        score: -50,
        confidence: 0.6,
        evidence: 'malicious intent'
      }
    ]);

    expect(result.score).toBeCloseTo(85, 8); // 100 + (-50 * 0.5 * 0.6)
    expect(result.decision).toBe('approve');
    expect(result.reviewRequired).toBe(false);
  });

  it('uses thresholds at 70 and 40', () => {
    const scorer = new RiskScorer();

    const at70 = scorer.score([
      { source: 'entropy', weight: 1, score: -30, confidence: 1, evidence: 'entropy anomaly' }
    ]);
    expect(at70.score).toBe(70);
    expect(at70.decision).toBe('approve');
    expect(at70.reviewRequired).toBe(false);

    const at40 = scorer.score([
      { source: 'behavior', weight: 1, score: -60, confidence: 1, evidence: 'capability mismatch' }
    ]);
    expect(at40.score).toBe(40);
    expect(at40.decision).toBe('review');
    expect(at40.reviewRequired).toBe(true);

    const below40 = scorer.score([
      { source: 'behavior', weight: 1, score: -61, confidence: 1, evidence: 'capability mismatch' }
    ]);
    expect(below40.score).toBe(39);
    expect(below40.decision).toBe('reject');
    expect(below40.reviewRequired).toBe(false);
  });

  it('clamps scores to [0, 100] and handles empty input', () => {
    const scorer = new RiskScorer();

    expect(scorer.score([])).toEqual({
      decision: 'approve',
      score: 100,
      reviewRequired: false,
      reason: 'no signals provided'
    });

    const hugePositive = scorer.score([
      { source: 'reputation', weight: 10, score: 50, confidence: 1, evidence: 'trusted author' }
    ]);
    expect(hugePositive.score).toBe(100);
    expect(hugePositive.decision).toBe('approve');

    const atZero = scorer.score([{ source: 'entropy', weight: 1, score: -100, confidence: 1, evidence: 'penalty' }]);
    expect(atZero.score).toBe(0);
    expect(atZero.decision).toBe('reject');
  });

  it('handles malformed signals and edge-case confidence values', () => {
    const scorer = new RiskScorer();

    expect(scorer.score(undefined as any)).toEqual({
      decision: 'approve',
      score: 100,
      reviewRequired: false,
      reason: 'no signals provided'
    });

    const hardWithNonStringEvidence = scorer.score([{ source: 'canary_triggered', evidence: 123 } as any]);
    expect(hardWithNonStringEvidence.decision).toBe('reject');
    expect(hardWithNonStringEvidence.reason).toBe('Hard reject: canary_triggered');

    const hardWithoutEvidence = scorer.score([
      { source: 'hard_rule', weight: 1, score: -999, confidence: 1, evidence: '   ' }
    ]);
    expect(hardWithoutEvidence.decision).toBe('reject');
    expect(hardWithoutEvidence.reason).toBe('Hard reject: hard_rule');

    const result = scorer.score([
      null as any, // skipped
      { source: 'ai:malicious', weight: 0.5, score: -50, confidence: 2, evidence: 'clamped to 1' },
      { source: '   ', weight: 0, score: -10, confidence: 1, evidence: 'empty source' },
      { source: 'ai', weight: 0.5, score: -50, confidence: -1, evidence: 'clamped to 0' },
      { source: 'entropy', weight: Number.NaN, score: Number.NaN, confidence: 1, evidence: 'ignored' }
    ] as any);

    // impact = (-50 * 0.5 * 1) + (-10 * 0 * 1) + (-50 * 0.5 * 0) + 0 = -25
    expect(result.score).toBe(75);
    expect(result.decision).toBe('approve');
  });
});
